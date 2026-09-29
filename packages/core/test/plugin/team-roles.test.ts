import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Global } from "@opencode/util/global"
import { Session } from "@opencode/core/session"
import { TeamPlugin } from "@opencode/core/plugin/team"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { host } from "./host"

/**
 * The failure this pins is the one that would not announce itself: a throw inside a
 * registration callback leaves a build that still loads, with no Team anywhere in
 * it. So the test runs the plugin's own effect against the host fixture and asserts
 * what reached the two editors it was handed — plus the entry path, because a lead
 * the user cannot arrive at is the same as no lead.
 *
 * Two shape notes, both learned from the domain types rather than guessed:
 * `AgentEditor` addresses agents by plain `string` (a stub demanding the branded
 * `Agent.ID` is a contravariant mismatch), and the editor's own methods are
 * synchronous while the domain's return Effects — so the unused domain members die
 * the way the Plan plugin's test does instead of inventing return values.
 */

const sessionID = Session.ID.make("ses_team_test")

function fresh(id: string) {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary" as const,
    hidden: false,
    permissions: [] as { action: string; resource: string; effect: "allow" | "ask" | "deny" }[],
    system: undefined as string | undefined,
  }
}

const run = Effect.fnUntraced(function* () {
  // The board root comes from Global.data, so the temp directory is scoped: a test
  // that left one behind per run is how a CI runner fills up.
  const tmp = yield* tmpdirScoped()
  const registered = new Map<string, ReturnType<typeof fresh>>()
  const definitions = new Map<string, Command.Definition>()
  const switched = new Array<string>()
  yield* TeamPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({
            list: () => Array.from(registered.values()),
            get: (id) => registered.get(id),
            default: () => {},
            update: (id, update) => {
              const current = registered.get(id) ?? fresh(id)
              registered.set(id, current)
              update(current)
            },
            remove: (id) => {
              registered.delete(id)
            },
          })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      command: {
        list: () => Effect.die("unused command.list"),
        reload: () => Effect.die("unused command.reload"),
        transform: (callback) => {
          callback({ add: (definition) => definitions.set(definition.name, definition) })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      session: {
        switchAgent: (input) => {
          switched.push(input.agent)
          return Effect.void
        },
        // The plugin discards the prompt's returned inbox item, so this stub returns
        // nothing rather than fabricating a `SessionInbox.User`.
        prompt: () => Effect.succeed(undefined as never),
      },
    }),
  ).pipe(Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), data: tmp.path })))
  return { registered, definitions, switched }
})

const invoke = (text: string): Command.Invocation => ({
  sessionID,
  prompt: { text },
  delivery: "steer",
})

describe("TeamPlugin", () => {
  it.effect("registers all six roles with the lead as the only primary", () =>
    Effect.gen(function* () {
      const { registered, definitions } = yield* run()
      expect(Array.from(registered.keys()).sort()).toEqual(
        ["architect", "implementer", "researcher", "reviewer", "team", "tester"].sort(),
      )
      expect(registered.get("team")?.mode).toBe("primary")
      expect(registered.get("team")?.system).toContain("Team board")
      expect(registered.get("architect")?.mode).toBe("subagent")
      // A child that can dispatch is a team the user cannot see.
      expect(
        registered
          .get("implementer")
          ?.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny"),
      ).toBe(true)
      // The board is the one directory a file-less role may write.
      expect(
        registered.get("architect")?.permissions.some((rule) => rule.action === "edit" && rule.effect === "allow"),
      ).toBe(true)
      // Temperature is a format constraint here, and it lands because nothing set one first.
      expect(registered.get("team")?.request.settings.temperature).toBe(0.2)
      expect(Array.from(definitions.keys()).sort()).toEqual(
        ["team-implement", "team-plan", "team-research", "team-review", "team-run", "team-test"].sort(),
      )
    }),
  )

  it.effect("/team-run moves the session onto the lead", () =>
    Effect.gen(function* () {
      const { definitions, switched } = yield* run()
      yield* definitions.get("team-run")!.execute(invoke("ship the ledger")).pipe(Effect.orDie)
      expect(switched).toEqual(["team"])
      // A specialist is `subagent` mode and cannot BE a session's agent, so its
      // command routes the work instead of switching the user onto it.
      yield* definitions.get("team-plan")!.execute(invoke("add retry")).pipe(Effect.orDie)
      expect(switched).toEqual(["team"])
    }),
  )
})
