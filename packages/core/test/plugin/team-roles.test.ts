import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Global } from "@opencode/util/global"
import { TeamPlugin } from "@opencode/core/plugin/team"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "../lib/effect"
import { host } from "./host"

/**
 * The failure this pins is the one that would not announce itself: a throw inside a
 * registration callback leaves a build that still loads, with no Team anywhere in
 * it. So the test runs the plugin's own effect against the host fixture and asserts
 * what reached the two editors it was handed — plus the entry path, because a lead
 * the user cannot arrive at is the same as no lead.
 */

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-team-test"))
const sessionID = Session.ID.make("ses_team_test")
const team = Agent.ID.make("team")
const architect = Agent.ID.make("architect")
const implementer = Agent.ID.make("implementer")

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
  yield* TeamPlugin.Plugin.effect(
    host({
      agent: {
        get: (id: Agent.ID) => registered.get(id),
        list: () => Array.from(registered.values()),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({
            list: () => Array.from(registered.values()),
            get: (id: Agent.ID) => registered.get(id),
            default: () => {},
            update: (id: Agent.ID, update: (item: ReturnType<typeof fresh>) => void) => {
              const current = registered.get(id) ?? fresh(id)
              registered.set(id, current)
              update(current)
            },
            remove: (id: Agent.ID) => {
              registered.delete(id)
            },
          })
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
  return { registered, definitions, switched, prompts }
})

const invoke = (text: string): Command.Invocation => ({
  sessionID,
  prompt: { text },
  // Which delivery the host picks is the caller's business, not this test's.
  delivery: "steer" as Command.Invocation["delivery"],
})

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
      // The board is the one directory a file-less role may write.
      expect(
        registered
          .get(architect)
          ?.permissions.some((rule) => rule.action === "edit" && rule.effect === "allow"),
      ).toBe(true)
      // Temperature is a format constraint here, and it lands because nothing set one first.
      expect(registered.get(team)?.request.settings.temperature).toBe(0.2)
      expect(Array.from(definitions.keys()).sort()).toEqual(
        ["team-implement", "team-plan", "team-research", "team-review", "team-run", "team-test"].sort(),
      )
    }),
  )

  it.effect("enters Team mode from /team-run and routes the rest by role", () =>
    Effect.gen(function* () {
      const { definitions, switched, prompts } = yield* run()
      yield* definitions.get("team-run")!.execute(invoke("ship the ledger")).pipe(Effect.orDie)
      expect(switched).toEqual(["team"])
      expect(prompts[0]).toContain("Team lead")
      expect(prompts[0]).toContain("ship the ledger")
      yield* definitions.get("team-plan")!.execute(invoke("add retry")).pipe(Effect.orDie)
      // A subagent cannot BE the session, so the second command routes instead of switching.
      expect(switched).toEqual(["team"])
      expect(prompts[1]).toContain("`architect`")
      expect(prompts[1]).toContain("add retry")
    }),
  )
})
