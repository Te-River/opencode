import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Deferred, Effect, Layer } from "effect"

// The layer only composes the host, so the host and the main-process modules around it are stubbed:
// the test observes when `createHost` runs, and nothing here needs the full main process.
const created: Array<{ state: unknown }> = []

mock.module("./host", () => ({
  createHost: (input: { state: unknown }) => {
    created.push({ state: input.state })

    return { dispose: () => {} }
  },
}))
mock.module("./assets", () => ({ extensionAsset: () => undefined }))
mock.module("../windows", () => ({ setAppQuitting: () => {} }))
mock.module("../windows/protocol", () => ({ setExtensionAssets: () => {} }))

const CliService = Context.Service<{
  readonly resolve: Effect.Effect<{ readonly version: string; readonly command: readonly string[] }>
}>()("test/DesktopCli")
const LifecycleService = Context.Service<{ readonly prepareToRestart: Effect.Effect<void> }>()(
  "test/ApplicationLifecycle",
)

mock.module("../service/desktop-cli", () => ({ DesktopCli: { Service: CliService } }))
mock.module("../lifecycle", () => ({ ApplicationLifecycle: { Service: LifecycleService } }))

const { DesktopStorage } = await import("../storage")
const { Shutdown } = await import("../lifecycle/shutdown")
const { Extensions } = await import(".")

const roots: string[] = []

afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined))),
)

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-extensions-layer-"))
  roots.push(root)

  return root
}

describe("extensions layer", () => {
  test("the host loads only after the storage import committed", async () => {
    const ready = await Effect.runPromise(Deferred.make<void>())
    const storage = DesktopStorage.make(path.join(tempRoot(), "drafts.sqlite"))

    // The host builds its stores over `state` and reads them on first use, so it must not load while
    // the legacy import is still running: a read would cache the pre-import value for the process
    // lifetime and a later write would then overwrite the imported one.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Extensions.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(DesktopStorage.Service, { ...storage, ready: Deferred.await(ready) }),
                  Layer.succeed(Shutdown.Service, { add: () => Effect.succeed(() => {}), run: Effect.void }),
                  Layer.succeed(CliService, { resolve: Effect.succeed({ version: "0.0.0", command: [] }) }),
                  Layer.succeed(LifecycleService, { prepareToRestart: Effect.void }),
                ),
              ),
            ),
          )
          const loading = Context.get(context, Extensions.Service).host()
          const loadedBeforeReady = yield* Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25))

            return created.length
          })
          yield* Deferred.succeed(ready, undefined)

          return { loading: yield* Effect.promise(() => loading), loadedBeforeReady }
        }),
      ),
    )

    expect(result.loadedBeforeReady).toBe(0)
    expect(created).toEqual([{ state: storage.state }])
    expect(result.loading).toBeDefined()
  })
})
