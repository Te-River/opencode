import { describe, expect } from "bun:test"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Global } from "@opencode/util/global"
import { TeamPlugin } from "@opencode/core/plugin/team"
import { SessionMessage } from "@opencode/core/session/message"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Types } from "effect"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "../lib/effect"
import { host } from "./host"

/**
 * The two things that would fail silently rather than loudly:
 *
 *  1. the six roles never reaching the agent editor — a throw inside a registration
 *     callback leaves a build that loads but has no Team in it; and
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

const fresh = (id: Agent.ID): Types.DeepMutable<Agent.Info> => ({
  id,
  name: Agent.Name.make(String(id)),
  request: { settings: {}, headers: {}, body: {} },
  mode: "primary",
  hidden: false,
  permissions: [],
})

const run = Effect.fnUntraced(function* () {
  const registered = new Map<Agent.ID, Types.DeepMutable<Agent.Info>>()
  const commands = new Array<string>()
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  yield* TeamPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback: (editor: unknown) => void) => {
          callback(editor(registered))
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      command: {
        list: () => Array.from(commands, (name) => Command.Info.make({ name })),
        reload: () => Effect.die("unused command.reload"),
        transform: (callback: (editor: { add: (definition: Command.Definition) => void }) => void) => {
          callback({ add: (definition) => commands.push(definition.name) })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name: string, callback: unknown) => {
          if (name === "execute.after")
            toolHook = callback as (input: ToolHooks["execute.after"]) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    } as Parameters<typeof host>[0]),
  ).pipe(Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), data })))
  if (!toolHook) return yield* Effect.die("team plugin did not register an execute.after hook")
  return { registered, commands, fire: toolHook }
})

// The plugin receives the SAME editor shape the host hands it; this mirrors
// `Agent.Editor` without importing a private alias.
function editor(agents: Map<Agent.ID, Types.DeepMutable<Agent.Info>>) {
  return {
    list: () => Array.from(agents.values()),
    get: (id: Agent.ID) => agents.get(id),
    default: () => {},
    update: (id: Agent.ID, update: (item: Types.DeepMutable<Agent.Info>) => void) => {
      const current = agents.get(id) ?? fresh(id)
      agents.set(id, current)
      update(current)
    },
    remove: (id: Agent.ID) => {
      agents.delete(id)
    },
  }
}

const completed = (agent: Agent.ID, callID: string, text: string): ToolHooks["execute.after"] => ({
  tool: "read",
  input: {},
  sessionID,
  agent,
  messageID: SessionMessage.ID.make("msg_team_tool"),
  id: Tool.CallID.make(callID),
  status: "completed",
  result: { content: [{ type: "text", text }], metadata: {} },
})

const snapshot = [
  ...Array.from({ length: 120 }, (_, index) => `row ${index} ${"y".repeat(90)}`),
  "[ref=b12] Submit order",
  "[ref=b77] Total 12.00",
].join("\n")

describe("TeamPlugin", () => {
  it.effect("registers all six roles with the lead as the only primary", () =>
    Effect.gen(function* () {
      const { registered, commands } = yield* run()
      expect(Array.from(registered.keys(), String).sort()).toEqual(
        ["architect", "implementer", "researcher", "reviewer", "team", "tester"].sort(),
      )
      expect(registered.get(team)?.mode).toBe("primary")
      expect(registered.get(team)?.system).toContain("Team board")
      expect(registered.get(architect)?.mode).toBe("subagent")
      // A child that can dispatch is a team the user cannot see.
      expect(
        registered.get(implementer)?.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny"),
      ).toBe(true)
      // Temperature is a format constraint here; it lands because the stub carries none.
      expect(registered.get(team)?.request.settings.temperature).toBe(0.2)
      expect(commands.sort()).toEqual(
        ["team-implement", "team-plan", "team-research", "team-review", "team-run", "team-test"].sort(),
      )
    }),
  )

  it.effect("caps an oversized Team result and leaves the full text on disk", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(team, "call_team_cap", snapshot)
      yield* fire(event)
      if (event.status !== "completed") return yield* Effect.die("hook turned a completed result into an error")
      const first = event.result.content[0]
      const text = first?.type === "text" ? first.text : ""
      expect(text).toContain("[team cap] addressing")
      expect(text).toContain("full text:")
      // The kept lines are the ones the next click is addressed by.
      expect(text).toContain("[ref=b12] Submit order")
      const file = text.slice(text.lastIndexOf("full text:") + "full text:".length).trim()
      const spilled = yield* Effect.promise(() => readFile(file))
      expect(spilled).toContain("row 0")
    }),
  )

  it.effect("leaves a foreign agent's result byte-exact", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(build, "call_build_read", snapshot)
      yield* fire(event)
      if (event.status !== "completed") return yield* Effect.die("hook touched a foreign session")
      expect(event.result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")).toBe(snapshot)
    }),
  )
})

async function readFile(file: string) {
  const { readFile: read } = await import("node:fs/promises")
  return read(file, "utf8")
}
