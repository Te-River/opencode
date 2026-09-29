import { describe, expect } from "bun:test"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Global } from "@opencode/util/global"
import { TeamPlugin } from "@opencode/core/plugin/team"
import { SessionMessage } from "@opencode/core/session/message"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "../lib/effect"
import { host } from "./host"

/**
 * The two things that would fail silently rather than loudly:
 *
 *  1. the six roles never reaching the agent editor — a throw inside a registration
 *     callback leaves a build that still loads with no Team in it; and
 *  2. the cap applying to nothing, or to everything: a governance layer scoped by
 *     accident instead of by rule is the failure this feature exists to avoid.
 *
 * Both are checked by running the plugin's own effect against the host fixture and
 * then firing the hook it registered, so the assertions are about the plugin rather
 * than about a copy of its logic written here.
 */

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-team-test"))
const sessionID = Session.ID.make("ses_team_test")
const team = Agent.ID.make("team")
const architect = Agent.ID.make("architect")
const implementer = Agent.ID.make("implementer")
const build = Agent.ID.make("build")

const snapshot = [
  ...Array.from({ length: 120 }, (_, index) => `row ${index} ${"y".repeat(90)}`),
  "[ref=b12] Submit order",
  "[ref=b77] Total 12.00",
].join("\n")

/** The registry the Agent domain hands a transform callback, backed by a map. */
function editor(agents: Map<Agent.ID, ReturnType<typeof fresh>>) {
  return {
    list: () => Array.from(agents.values()),
    get: (id: Agent.ID) => agents.get(id),
    default: () => {},
    update: (id: Agent.ID, update: (item: ReturnType<typeof fresh>) => void) => {
      const current = agents.get(id) ?? fresh(id)
      agents.set(id, current)
      update(current)
    },
    remove: (id: Agent.ID) => {
      agents.delete(id)
    },
  }
}

function fresh(id: Agent.ID) {
  return {
    id,
    name: Agent.Name.make(String(id)),
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary" as const,
    hidden: false,
    permissions: [] as { action: string; resource: string; effect: "allow" | "ask" | "deny" }[],
    system: undefined as string | undefined,
  }
}

const run = Effect.fnUntraced(function* () {
  const registered = new Map<Agent.ID, ReturnType<typeof fresh>>()
  const definitions = new Map<string, Command.Definition>()
  const switched = new Array<string>()
  const prompts = new Array<string>()
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  yield* TeamPlugin.Plugin.effect(
    host({
      agent: {
        get: (id: Agent.ID) => registered.get(id),
        list: () => Array.from(registered.values()),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback(editor(registered))
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      command: {
        list: () => Array.from(definitions.keys(), (name) => Command.Info.make({ name })),
        reload: () => Effect.die("unused command.reload"),
        transform: (callback) => {
          callback({ add: (definition) => definitions.set(definition.name, definition) })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name, callback) => {
          // Hook names and callbacks are correlated, but TypeScript does not narrow
          // this generic registration API.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          if (name === "execute.after") toolHook = callback as typeof toolHook
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      session: {
        switchAgent: (input) => {
          switched.push(String(input.agent))
          return Effect.void
        },
        prompt: (input) => {
          prompts.push(input.text)
          return Effect.void
        },
      },
    }),
  ).pipe(Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), data })))
  if (!toolHook) return yield* Effect.die("team plugin did not register an execute.after hook")
  return { registered, definitions, switched, prompts, fire: toolHook }
})

function completed(agent: Agent.ID, callID: string, content: Tool.Result["content"]): ToolHooks["execute.after"] {
  return {
    tool: "read",
    input: {},
    sessionID,
    agent,
    messageID: SessionMessage.ID.make("msg_team_tool"),
    id: Tool.CallID.make(callID),
    status: "completed",
    result: { content, metadata: {} },
  }
}

/** The cap is written into `content`, in whichever shape the tool returned it. */
function textOf(event: ToolHooks["execute.after"]) {
  if (event.status !== "completed") throw new Error("hook turned a completed result into an error")
  const content = event.result.content
  if (typeof content === "string") return content
  return (content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n")
}

async function spill(file: string) {
  const { readFile } = await import("node:fs/promises")
  return readFile(file, "utf8")
}

const pathOf = (text: string) => text.slice(text.lastIndexOf("full text:") + "full text:".length).trim()

describe("TeamPlugin", () => {
  it.effect("registers all six roles with the lead as the only primary", () =>
    Effect.gen(function* () {
      const { registered, definitions } = yield* run()
      expect(Array.from(registered.keys(), String).sort()).toEqual(
        ["architect", "implementer", "researcher", "reviewer", "team", "tester"].sort(),
      )
      expect(registered.get(team)?.mode).toBe("primary")
      expect(registered.get(team)?.system).toContain("Team board")
      expect(registered.get(architect)?.mode).toBe("subagent")
      // A child that can dispatch is a team the user cannot see.
      expect(
        registered
          .get(implementer)
          ?.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny"),
      ).toBe(true)
      // Temperature is a format constraint here; it lands because nothing set one first.
      expect(registered.get(team)?.request.settings.temperature).toBe(0.2)
      expect(Array.from(definitions.keys()).sort()).toEqual(
        ["team-implement", "team-plan", "team-research", "team-review", "team-run", "team-test"].sort(),
      )
    }),
  )

  it.effect("enters Team mode from /team-run and routes the rest by role", () =>
    Effect.gen(function* () {
      const { definitions, switched, prompts } = yield* run()
      const invoke = (text: string): Command.Invocation => ({
        sessionID,
        prompt: { text },
        // The delivery choice belongs to the host's inbox, not to this test.
        delivery: "steer" as Command.Invocation["delivery"],
      })
      yield* definitions.get("team-run")!.execute(invoke("ship the cap")).pipe(Effect.orDie)
      expect(switched).toEqual(["team"])
      expect(prompts[0]).toContain("Team lead")
      expect(prompts[0]).toContain("ship the cap")
      yield* definitions.get("team-plan")!.execute(invoke("add retry")).pipe(Effect.orDie)
      // A subagent cannot BE the session, so the second command routes instead of switching.
      expect(switched).toEqual(["team"])
      expect(prompts[1]).toContain("`architect`")
      expect(prompts[1]).toContain("add retry")
    }),
  )

  it.effect("caps an oversized part-list result and leaves the full text on disk", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(team, "call_team_parts", [{ type: "text", text: snapshot }])
      yield* fire(event)
      const text = textOf(event)
      expect(text).toContain("[team cap] addressing")
      expect(text).toContain("full text:")
      // The kept lines are the ones the next click is addressed by.
      expect(text).toContain("[ref=b12] Submit order")
      expect(await spill(pathOf(text))).toContain("row 0")
    }),
  )

  it.effect("caps a string-shaped result in the same shape", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(team, "call_team_string", snapshot)
      yield* fire(event)
      const text = textOf(event)
      // `session_rename` and friends return one string, and a cap that only read part
      // lists would have skipped them without a word.
      expect(text.startsWith("[team cap]")).toBe(true)
      expect(await spill(pathOf(text))).toContain("row 0")
    }),
  )

  it.effect("leaves a screenshot result alone", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const parts = [
        { type: "text" as const, text: snapshot },
        { type: "file" as const, uri: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
      ]
      const event = completed(team, "call_team_image", parts)
      yield* fire(event)
      if (event.status !== "completed") throw new Error("hook rewrote a completed result")
      expect(event.result.content).toEqual(parts)
    }),
  )

  it.effect("leaves a foreign agent's result byte-exact", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(build, "call_build_read", [{ type: "text", text: snapshot }])
      yield* fire(event)
      expect(textOf(event)).toBe(snapshot)
    }),
  )
})
