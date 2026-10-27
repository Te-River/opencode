import { describe, expect } from "bun:test"
import { gunzipSync, zstdDecompressSync } from "node:zlib"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, Message, ToolCallPart, type RequestEncoding } from "../src/effect.js"
import { LLMClient } from "../src/route.js"
import { compileRequest } from "../src/route/client.js"
import { configure } from "../src/providers/openai.js"
import { findUnencodable } from "../src/utils/json.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")

const send = (prompt: string, encoding?: RequestEncoding) =>
  Effect.gen(function* () {
    const seen: { encoding: string | null; body: Uint8Array }[] = []
    const server = dynamicResponse((input) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
        seen.push({
          encoding: web.headers.get("content-encoding"),
          body: new Uint8Array(yield* Effect.promise(() => web.arrayBuffer())),
        })
        return input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    )
    yield* LLMClient.generate(ai.request({ model, prompt, http: encoding ? { encoding } : undefined })).pipe(
      Effect.provide(server),
    )
    return seen[0]
  })

describe("HTTP request encoding", () => {
  it.effect("compresses the JSON body with the requested encoding", () =>
    Effect.gen(function* () {
      const zstd = yield* send("Hello", "zstd")
      expect(zstd.encoding).toBe("zstd")
      expect(JSON.parse(zstdDecompressSync(zstd.body).toString())).toMatchObject({ model: "gpt-4.1-mini" })

      const gzip = yield* send("Hello", "gzip")
      expect(gzip.encoding).toBe("gzip")
      expect(JSON.parse(gunzipSync(gzip.body).toString())).toMatchObject({ model: "gpt-4.1-mini" })
    }),
  )

  it.effect("sends plain JSON when unset or none", () =>
    Effect.gen(function* () {
      for (const sent of [yield* send("Hello"), yield* send("Hello", "none")]) {
        expect(sent.encoding).toBeNull()
        expect(JSON.parse(new TextDecoder().decode(sent.body))).toMatchObject({ model: "gpt-4.1-mini" })
      }
    }),
  )
})

describe("findUnencodable", () => {
  it.effect("names a cycle by path", () =>
    Effect.sync(() => {
      const value: Record<string, unknown> = { ok: true }
      value.self = value
      expect(findUnencodable({ messages: [{ result: value }] })).toBe("messages[0].result.self (circular)")
    }),
  )

  it.effect("reports bigint and functions, and ignores undefined members", () =>
    Effect.sync(() => {
      expect(findUnencodable({ a: 1n })).toBe("a (bigint)")
      expect(findUnencodable({ a: () => 1 })).toBe("a (function)")
      expect(findUnencodable({ a: undefined, b: [1, "two", null] })).toBeUndefined()
    }),
  )

  it.effect("treats a shape shared by two siblings as encodable", () =>
    Effect.sync(() => {
      // `JSON.stringify` only fails on a repeated ancestor; a reused object (a shared `cache`) is a DAG.
      const shared = { ttl: 1 }
      expect(findUnencodable({ tools: [{ cache: shared }, { cache: shared }] })).toBeUndefined()
    }),
  )
})

describe("compile rejects a request it cannot encode", () => {
  it.effect("returns a typed error that names the offending path", () =>
    Effect.gen(function* () {
      const cycle: Record<string, unknown> = { note: "tool output" }
      cycle.self = cycle

      const error = yield* Effect.flip(
        compileRequest(
          ai.request({
            model,
            messages: [
              Message.assistant(ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })),
              Message.tool({
                type: "tool-result",
                id: "call_1",
                name: "lookup",
                result: { type: "json", value: cycle },
              }),
            ],
          }),
        ),
      )

      expect(String(error)).toContain("cannot encode this request as JSON")
      expect(String(error)).toContain("circular")
    }),
  )

  it.effect("leaves an ordinary request alone", () =>
    Effect.gen(function* () {
      const compiled = yield* compileRequest(
        ai.request({
          model,
          messages: [
            Message.assistant(ToolCallPart.make({ id: "call_1", name: "lookup", input: { q: "x" } })),
            Message.tool({
              type: "tool-result",
              id: "call_1",
              name: "lookup",
              result: { type: "json", value: { ok: true } },
            }),
          ],
        }),
      )
      expect(compiled.body.messages.length).toBeGreaterThan(0)
    }),
  )
})
