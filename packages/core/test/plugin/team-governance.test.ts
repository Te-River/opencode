import { describe, expect } from "bun:test"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/core/agent"
import { Global } from "@opencode/util/global"
import { TeamPlugin } from "@opencode/core/plugin/team"
import { SessionMessage } from "@opencode/core/session/message"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { host } from "./host"

/**
 * The cap's two failure modes are silent ones: it applies to nothing (every Team
 * result still arrives whole), or it applies to everything (a `build` session gets
 * rewritten content it was never promised). So the hook is fired with both kinds of
 * agent, and with the three shapes a built-in tool actually returns — one string, a
 * part list, and a part list carrying an image.
 *
 * The file each cap writes is opened back and compared, because "the full text is
 * still retrievable" is the claim that makes narrowing legitimate at all.
 */

const sessionID = Session.ID.make("ses_team_governance_test")
const team = Agent.ID.make("team")
const build = Agent.ID.make("build")

const snapshot = [
  ...Array.from({ length: 120 }, (_, index) => `row ${index} ${"y".repeat(90)}`),
  "[ref=b12] Submit order",
  "[ref=b77] Total 12.00",
].join("\n")

const run = Effect.fnUntraced(function* () {
  // Each cap writes its full text under Global.data/team/output, so the directory is
  // scoped: the assertion that the spill is readable is also the thing that must
  // not accumulate one per test run.
  const tmp = yield* tmpdirScoped()
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  yield* TeamPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            default: () => {},
            update: () => {},
            remove: () => {},
          })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      command: {
        list: () => Effect.die("unused command.list"),
        reload: () => Effect.die("unused command.reload"),
        transform: (callback) => {
          callback({ add: () => {} })
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
    }),
  ).pipe(Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), data: tmp.path })))
  if (!toolHook) return yield* Effect.die("team plugin did not register an execute.after hook")
  return { fire: toolHook }
})

function completed(
  agent: Agent.ID,
  callID: string,
  content: Tool.Result["content"],
  tool = "browser.snapshot",
): ToolHooks["execute.after"] {
  return {
    tool,
    input: {},
    sessionID,
    agent,
    messageID: SessionMessage.ID.make("msg_team_governance_tool"),
    id: Tool.CallID.make(callID),
    status: "completed",
    result: { content, metadata: {} },
  }
}

function textOf(event: ToolHooks["execute.after"]) {
  if (event.status !== "completed") throw new Error("the hook turned a completed result into an error")
  const content = event.result.content
  if (typeof content === "string") return content
  return (content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n")
}

const spillPath = (text: string) => text.slice(text.lastIndexOf("full text:") + "full text:".length).trim()

async function spill(file: string) {
  const { readFile } = await import("node:fs/promises")
  return readFile(file, "utf8")
}

describe("TeamPlugin cap", () => {
  it.effect("caps a part-list result and keeps the lines the next call addresses", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(team, "call_parts", [{ type: "text", text: snapshot }])
      yield* fire(event)
      const text = textOf(event)
      expect(text).toContain("[team cap] addressing")
      expect(text).toContain("[ref=b12] Submit order")
      // A middle prose line is dropped from the context and only in the file: the cap
      // render echoes the FIRST line on purpose, so that one proves nothing.
      expect(text).not.toContain("row 77 ")
      // `Effect.gen` is a generator, not an async function: the spill is read with
      // `yield* Effect.promise`, and `await` here would not parse.
      const spilled = yield* Effect.promise(() => spill(spillPath(text)))
      expect(spilled).toContain("row 77 ")
    }),
  )

  it.effect("caps a string-shaped result in the same shape", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(team, "call_string", snapshot)
      yield* fire(event)
      // `session_rename` and friends return one string, and a cap that read only part
      // lists would have skipped every one of them without saying so.
      if (event.status !== "completed") throw new Error("the hook rewrote a completed result")
      expect(typeof event.result.content).toBe("string")
      expect(textOf(event).startsWith("[team cap]")).toBe(true)
      const spilled = yield* Effect.promise(() => spill(spillPath(textOf(event))))
      expect(spilled).toContain("row 0 ")
    }),
  )

  it.effect("leaves a result carrying an image alone", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const parts = [
        { type: "text" as const, text: snapshot },
        { type: "file" as const, uri: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
      ]
      const event = completed(team, "call_image", parts)
      yield* fire(event)
      if (event.status !== "completed") throw new Error("the hook rewrote a completed result")
      // Pixels are the point of that call, and no text cap can describe them.
      expect(event.result.content).toEqual(parts)
    }),
  )

  it.effect("leaves a foreign agent's result byte-exact", () =>
    Effect.gen(function* () {
      const { fire } = yield* run()
      const event = completed(build, "call_build", [{ type: "text", text: snapshot }])
      yield* fire(event)
      expect(textOf(event)).toBe(snapshot)
    }),
  )
})
