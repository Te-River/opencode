export * as TeamBoard from "./board.js"

import { readdir, rm, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "path"
import { Duration, Effect, Schedule } from "effect"

/**
 * Boards are the Team's only file channel, so they are also the only Team state
 * that can grow without bound: every oversized deliverable lands here. The
 * sweep is therefore part of the feature, not a nicety — and the prompt tells
 * the agents so, which is what makes "never delete a directory yourself" a
 * rule they can trust rather than a hope.
 */
export const TTL_DAYS = 14

export const teamRoot = (data: string) => path.join(data, "team")

export const rootFor = (data: string) => path.join(teamRoot(data), "board")

export function note(root: string, ttlDays: number) {
  return [
    "",
    "",
    "## Team board — resolved for this workspace",
    `Root directory: \`${root}\``,
    `- Hybrid channel: specialist replies (the STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`,
    `  skeleton) are the PRIMARY transport — normal work needs no files at all.`,
    `- Board files exist ONLY for oversized deliverables (>~50 lines), and they go`,
    `  under this root as \`<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md\`.`,
    `  Every role may write HERE and nowhere else, including the three that hold no`,
    `  file grant elsewhere; report the PATH, never paste the content back.`,
    `  On the FIRST board write of a conversation use a session folder made from a`,
    `  compact clock timestamp (\`yyyyMMdd-HHmmss\`) and reuse it for every later task.`,
    `  A role with no shell cannot stamp a date: the dispatch must pass the folder.`,
    `- Auto-cleanup: this process sweeps session directories idle for more than ${ttlDays} days`,
    `  (at startup and hourly).  This is the ONLY cleanup path — never delete task or`,
    `  session directories yourself, because a finished board stays readable for audit.`,
  ].join("\n")
}

const DAY_MS = 86_400_000

/** A directory that cannot be stat'ed is not stale — an unreadable path must not be deleted. */
const expired = (directory: string, ttlMs: number) =>
  Effect.promise(() =>
    stat(directory)
      .then((info) => Date.now() - info.mtimeMs > ttlMs)
      .catch(() => false),
  )

export const sweep = Effect.fn("TeamBoard.sweep")(function* (root: string, ttlDays: number) {
  const sessions = yield* Effect.promise(() =>
    readdir(root, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()))
      .catch(() => [] as Dirent[]),
  )
  yield* Effect.forEach(
    sessions,
    (entry) =>
      expired(path.join(root, entry.name), ttlDays * DAY_MS).pipe(
        Effect.flatMap((stale) =>
          stale ? Effect.promise(() => rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)) : Effect.void,
        ),
      ),
    { discard: true },
  )
})

/** Boot-and-hourly, forked into the plugin's scope so a reload cannot leave a second sweeper running. */
export const maintenance = (root: string, ttlDays: number = TTL_DAYS) =>
  sweep(root, ttlDays).pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
