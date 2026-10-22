import { expect } from "bun:test"
import { Session } from "@opencode/core/session"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const ActiveResponse = Schema.Struct({
  data: Schema.Record(Session.ID, Schema.Struct({ type: Schema.Literal("running") })),
})

it.live("lists every Session holding an execution claim, including children", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      createEmbeddedRoutes({
        app: { version: "test" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const store = Context.get(context, SessionStore.Service)
    const sessions = Context.get(context, Session.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const active = () =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(new Request("http://opencode.local/api/session/active")),
        )
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(ActiveResponse)(yield* Effect.promise(() => response.json())).data
      })

    const location = { directory: AbsolutePath.make("/project") }
    const parent = yield* sessions.create({ id: Session.ID.make("ses_active_parent"), title: "Parent", location })
    const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
    yield* sessions.create({ title: "Idle", location })
    expect(Object.keys(yield* active())).toEqual([])

    yield* store.claim(parent.id)
    yield* store.claim(child.id)
    expect(Object.keys(yield* active()).toSorted()).toEqual([parent.id, child.id].toSorted())

    // Releasing the claim is what makes the Session idle again, so the endpoint and Session.Info agree.
    yield* store.release(parent.id)
    expect(Object.keys(yield* active())).toEqual([child.id])
    expect((yield* sessions.get(parent.id)).status).toBe("idle")
    expect((yield* sessions.get(child.id)).status).toBe("running")
  }).pipe(Effect.scoped),
)
