export * as TeamGovern from "./govern.js"

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "path"
import { Duration, Effect, Schedule } from "effect"
import { TeamCap } from "./cap.js"

/**
 * The Team's own governance seam: cap a Team agent's oversized tool result, leave
 * the full text where `read` can reach it, and write down what was done so the
 * claim stays checkable.
 *
 * Scope is the six roles (`scoped`), not every session in the process: a
 * governance layer that quietly stopped applying is the failure this feature
 * exists to avoid, so the decision is an explicit agent set, and the results it
 * did NOT touch stay countable from the trajectory.
 */
const TEAM_AGENTS = new Set(["team", "architect", "implementer", "reviewer", "tester", "researcher"])

export const scoped = (agent: string) => TEAM_AGENTS.has(agent)

export const outputRoot = (data: string) => path.join(data, "team", "output")
export const trajectoryRoot = (data: string) => path.join(data, "team", "trajectory")

const DAY_MS = 86_400_000
export const RETENTION_DAYS = 7

export interface Entry {
  readonly at: number
  readonly tool: string
  readonly agent: string
  readonly sessionID: string
  readonly strategy: TeamCap.Strategy
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly keptLines: number
  readonly droppedLines: number
  readonly file: string
}

/**
 * Returns the replacement text plus the spill path, or undefined when the result
 * goes to the model untouched. A result carrying a non-text part (a screenshot)
 * is never re-rendered: dropping an image to save tokens is a bad trade, and the
 * kept text would no longer describe what the model was actually shown.
 */
export const govern = Effect.fn("TeamGovern.govern")(function* (input: {
  readonly outputs: string
  readonly trajectory: string
  readonly tool: string
  readonly agent: string
  readonly sessionID: string
  readonly callID: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}) {
  if (input.content.some((item) => item.type !== "text")) return undefined
  const text = input.content.map((item) => item.text ?? "").join("\n")
  const capped = TeamCap.cap(text, input.tool)
  if (!capped) return undefined
  const file = path.join(input.outputs, spillName(input.callID))
  // A spill that failed is not a cap: pointing the agent at a file that does not
  // exist would send it looking for nothing, so the original text stands.
  const written = yield* Effect.promise(() =>
    mkdir(input.outputs, { recursive: true })
      .then(() => writeFile(file, text, "utf8"))
      .then(() => true)
      .catch(() => false),
  )
  if (!written) return undefined
  const entry: Entry = {
    at: Date.now(),
    tool: input.tool,
    agent: input.agent,
    sessionID: input.sessionID,
    strategy: capped.strategy,
    tokensBefore: capped.tokensBefore,
    tokensAfter: capped.tokensAfter,
    keptLines: capped.keptLines,
    droppedLines: capped.droppedLines,
    file,
  }
  // Accounting is an extra, never a reason to fail a tool call.
  yield* Effect.promise(() =>
    mkdir(input.trajectory, { recursive: true })
      .then(() => appendFile(path.join(input.trajectory, day(entry.at)), `${JSON.stringify(entry)}\n`, "utf8"))
      .catch(() => undefined),
  )
  return { rendered: `${capped.rendered}\n\nfull text: ${file}`, file, entry }
})

/**
 * A provider's tool-call id is an unvalidated string — `Tool.CallID` is only a
 * branded `string` — and the spill file sits where the agent can read it back, so
 * the name is ours to make safe. Dots are folded away entirely rather than escaped:
 * a `..` surviving as a path step would write the payload outside the output
 * directory, and the extension is added here instead of trusted from the id.
 */
export const spillName = (callID: string) => `${callID.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "call"}.txt`

/** One file per day, so a long-lived process cannot grow one unbounded line. */
export const day = (at: number) => {  const stamp = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.jsonl`
}

/** Newest first, torn tail lines skipped rather than guessed at. */
export const readTrajectory = Effect.fn("TeamGovern.readTrajectory")(function* (trajectory: string, files: number) {
  const names = yield* Effect.promise(() =>
    readdir(trajectory)
      .then((entries) => entries.filter((name) => name.endsWith(".jsonl")).toSorted().reverse().slice(0, files))
      .catch(() => [] as string[]),
  )
  const lines = yield* Effect.forEach(
    names,
    (name) =>
      Effect.promise(() =>
        readFile(path.join(trajectory, name), "utf8")
          .then((text) => text.split("\n").filter(Boolean))
          .catch(() => [] as string[]),
      ),
    { concurrency: "unbounded" },
  )
  return lines.flat().map(parse).filter((entry): entry is Entry => entry !== undefined)
})

function parse(line: string): Entry | undefined {
  try {
    const value = JSON.parse(line) as Entry
    if (typeof value?.at !== "number" || typeof value?.tool !== "string") return undefined
    return value
  } catch {
    return undefined
  }
}

export const sweep = Effect.fn("TeamGovern.sweep")(function* (directory: string, days: number) {
  const stale = yield* Effect.promise(() => expired(directory, days))
  yield* Effect.forEach(
    stale,
    (entry) => Effect.promise(() => rm(entry, { force: true }).catch(() => undefined)),
    { discard: true },
  )
})

/**
 * The cap leaves a file behind for every result it narrowed, so cleanup is part
 * of the feature rather than a follow-up: the prompt tells the agents they must
 * never delete these themselves, and that promise is only true while this runs.
 */
export const maintenance = (outputs: string, trajectory: string, days: number = RETENTION_DAYS) =>
  Effect.gen(function* () {
    yield* sweep(outputs, days)
    yield* sweep(trajectory, days)
  }).pipe(Effect.repeat(Schedule.spaced(Duration.hours(6))), Effect.forkScoped)

/** A path that cannot be stat'ed is never deleted. */
async function expired(directory: string, days: number) {
  try {
    const cutoff = Date.now() - days * DAY_MS
    const paths = (await readdir(directory)).map((name) => path.join(directory, name))
    const infos = await Promise.all(paths.map((name) => stat(name).catch(() => undefined)))
    return paths.filter((_, index) => infos[index] !== undefined && Date.now() - infos[index]!.mtimeMs > cutoff)
  } catch {
    return [] as string[]
  }
}
