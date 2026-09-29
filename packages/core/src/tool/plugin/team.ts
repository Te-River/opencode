export * as TeamTools from "./team.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { TeamGovern } from "../../team/govern.js"
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

export const StatsInput = Schema.Struct({
  files: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))).annotate({
    description: "Day files to read back. Defaults to 3, newest first.",
  }),
  recent: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description: "Also list this many most recent capped results, newest first.",
  }),
})

const StatsOutput = Schema.Struct({ text: Schema.String })

/**
 * The two Team helpers the host does not already provide.
 *
 * Fetching, searching, browsing, paging a truncated result back, and writing a
 * board file are all left to the host's own tools on purpose — a second mechanism
 * for a job the platform already does is how a feature stops being reviewable.
 * What is missing is a task list an agent may own (there is no todo/plan/task
 * resource to write into) and an accounting view that makes the cap's own claims
 * checkable instead of stylistic.
 */
export const Plugin = {
  id: "opencode.team.tools",
  effect: Effect.fn("TeamTools.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const trajectory = TeamGovern.trajectoryRoot(global.data)
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
            "Team-mode helpers: the lead's task list and the run's own governance accounting. Oversized tool results are capped in place and left on disk, so the host's `read` is how you page them back.",
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
        editor.add({
          name: "stats",
          description:
            "Read back what this process capped: tokens kept out of the context per tool and per strategy, newest results first. This is the answer to 'did the governance actually run?', comparable against the reply that claimed it.",
          input: StatsInput,
          output: StatsOutput,
          options: { namespace: "team", codemode: true },
          execute: (input) =>
            TeamGovern.readTrajectory(trajectory, input.files ?? 3).pipe(
              Effect.map((entries) => ({ output: { text: renderStats(entries, input.recent ?? 0) } })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}

function renderStats(entries: readonly TeamGovern.Entry[], recent: number) {
  if (entries.length === 0)
    return [
      "nothing has been capped in the files read.",
      "",
      "This is a measurement, not a verdict: a result the host bounded itself (`tool_output`) is not recorded here,",
      "because that path does not pass this layer. If a Team agent kept hitting it, that shows up as an empty table",
      "and the honest next move is to say so rather than to claim savings.",
    ].join("\n")
  const byTool = new Map<string, { calls: number; tokens: number; lines: number }>()
  for (const entry of entries) {
    const row = byTool.get(entry.tool) ?? { calls: 0, tokens: 0, lines: 0 }
    byTool.set(entry.tool, {
      calls: row.calls + 1,
      tokens: row.tokens + Math.max(0, entry.tokensBefore - entry.tokensAfter),
      lines: row.lines + entry.droppedLines,
    })
  }
  const table = [
    "| tool | capped results | tokens kept out | lines dropped |",
    "| --- | --- | --- | --- |",
    ...Array.from(byTool, ([tool, row]) => `| ${tool} | ${row.calls} | ${row.tokens} | ${row.lines} |`),
    "",
    `${entries.length} entries across ${new Set(entries.map((entry) => entry.agent)).size} agents.`,
    "Cost basis: a CJK glyph is ~1 token, other text ~4 characters per token.",
  ]
  if (recent === 0) return table.join("\n")
  const newest = entries
    .toSorted((left, right) => right.at - left.at)
    .slice(0, recent)
    .map((entry) => `| ${new Date(entry.at).toISOString()} | ${entry.tool} | ${entry.strategy} | ${entry.file} |`)
  return [
    ...table,
    "",
    "| when | tool | strategy | full text |",
    "| --- | --- | --- | --- |",
    ...newest,
  ].join("\n")
}
