export * as TeamTools from "./team.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { TeamLedger } from "../../team/ledger.js"

const STATUSES = ["pending", "doing", "done", "blocked"] as const

export const LedgerInput = Schema.Struct({
  action: Schema.Literals(["add", "update", "list"]).annotate({
    description: "add a requirement to the list, change one item, or read the whole list back.",
  }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "The requirement, in the user's terms. Adding the same text again returns the existing item.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "Item id for update, e.g. T3." }),
  status: Schema.optionalKey(Schema.Literals(STATUSES)).annotate({
    description:
      "blocked is a state, not an exit: an item stays on the list with what blocks it in `note`. The run ends when nothing is open, not when it is convenient.",
  }),
  note: Schema.optionalKey(Schema.String).annotate({ description: "What blocks the item, or what unblocks it." }),
})

const LedgerOutput = Schema.Struct({ text: Schema.String })


/**
 * The Team helper the host does not already provide.
 *
 * Fetching, searching, browsing, paging a truncated result back, and writing a
 * board file are all left to the host's own tools on purpose — a second mechanism
 * for a job the platform already does is how a feature stops being reviewable.
 * What is missing is a task list an agent may own: there is no todo, plan, or
 * task resource for a lead to write its plan into.
 */
export const Plugin = {
  id: "opencode.team.tools",
  effect: Effect.fn("TeamTools.Plugin")(function* (ctx: Context) {
    const readLedger = (key: string) =>
      ctx.storage.get(key).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Unable to read the ledger", error })),
        Effect.map((stored) => (TeamLedger.isLedger(stored) ? stored : TeamLedger.EMPTY)),
      )
    const writeLedger = (key: string, ledger: TeamLedger.Ledger) =>
      // A readonly array does not satisfy the storage codec's JSON shape, and the
      // copy is cheap next to a write.
      ctx.storage.set(key, { items: [...ledger.items] }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Unable to write the ledger", error })),
      )

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "team",
          description:
            "Team-mode helpers. The lead's own task list; oversized tool results are bounded by the host and page back with `read`.",
        })
        editor.add({
          name: "ledger",
          description:
            "The lead's task list for this session. Every new requirement becomes an item BEFORE the work; an interruption is an insertion, not a replacement. Re-read it after a resume or a compaction.",
          input: LedgerInput,
          output: LedgerOutput,
          options: { namespace: "team", codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              // The permission rules deny this for the five specialists, and this is the
              // second lock: a user rule that hands `team_ledger` back to a child should
              // not let that child rewrite the list its own work is judged against.
              if (String(context.agent) !== "team")
                return yield* new ToolFailure({
                  message: "The ledger is the lead's. Report your item in HANDOFF instead.",
                })
              const key = `team/ledger/${context.sessionID}`
              const current = yield* readLedger(key)
              if (input.action === "list") return { output: { text: TeamLedger.render(current) } }
              // A refusal is the answer the model needs; re-wrapping it would hide the reason.
              if (input.action === "add") {
                const added = TeamLedger.add(current, input.text ?? "")
                if ("refusal" in added) return yield* new ToolFailure({ message: added.refusal })
                yield* writeLedger(key, added.ledger)
                return { output: { text: added.message } }
              }
              const changed = TeamLedger.change(current, input.id ?? "", {
                status: input.status,
                text: input.text,
                note: input.note,
              })
              if ("refusal" in changed) return yield* new ToolFailure({ message: changed.refusal })
              yield* writeLedger(key, changed)
              return { output: { text: TeamLedger.render(changed) } }
            }),
        })
      })
      .pipe(Effect.orDie)
  }),
}

