export * as TeamCap from "./cap.js"

/**
 * Content-aware capping for the six Team roles.
 *
 * The host already bounds any oversized tool result (`ToolOutput`: line/byte
 * caps, the full text left on disk, `read` pages it back). What it cannot know is
 * WHICH lines of a result the next call depends on — so a browser snapshot
 * truncated by head-only keeps the prose and loses the `[ref=…]` markers, and the
 * agent then clicks a reference it can no longer see. This module decides which
 * lines to keep; the host's own file is left untouched and the full payload still
 * lands in the Team output directory so nothing dropped here is unrecoverable.
 *
 * Only the six Team agents are capped, and the global `tool_output` thresholds
 * are not configured: a governance choice that changes every other session's
 * default behaviour is not this feature's to make.
 */

/** Same cost basis the Team's own accounting uses: a CJK glyph is ~1 token, other text ~4 chars. */
export const estimateTokens = (text: string) => {
  const cjk = cjkCount(text)
  return cjk + Math.ceil((text.length - cjk) / 4)
}

const cjkCount = (text: string) => (text.match(cjkGlobal) ?? []).length

const cjkRange = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const cjkGlobal = new RegExp(cjkRange.source, "g")

/**
 * Bracketed tokens the next call addresses a page or a table row by. Deliberately
 * narrow: `[INFO]` in a build log is not a reference, so this only ever decides the
 * strategy for a tool whose output the model addresses WITH — see `browserTool`.
 */
const REF_TOKEN = /\[(?:ref|uid|e)[^\]]*\]|(?:ref|uid)=[\w-]+/
const TABLE_LINE = /^\s*\|.*\|\s*$/

/** Tier thresholds, in tokens: structured payloads are costlier per line than prose. */
export const THRESHOLD_TEXT = 4_000
export const THRESHOLD_DATA = 2_000

/** How much prose survives a plain summary cap — a sample to recognise, not a reading copy. */
export const PREVIEW_TOKENS = 120

export type Strategy = "addressing" | "table" | "summary"

export interface Capped {
  readonly strategy: Strategy
  readonly rendered: string
  readonly keptLines: number
  readonly droppedLines: number
  readonly tokensBefore: number
  readonly tokensAfter: number
}

/**
 * Returns undefined when the text should reach the model unchanged — including
 * when it is large but has no structure worth preserving (a short result is never
 * rewritten to save a rounding error).
 *
 * `tool` is part of the decision, not a label: keeping "reference-looking" lines is
 * only right for output the model addresses WITH, so the caller names the tool.
 */
export function cap(text: string, tool?: string): Capped | undefined {
  // A token count never exceeds the character count, so anything shorter than the
  // cheapest tier cannot possibly be over any threshold. That is the whole cost of
  // the common case: no per-line scan, no match array, no split.
  if (text.length < THRESHOLD_DATA) return undefined
  const lines = text.split("\n")
  const tokensBefore = estimateTokens(text)
  const strategy = choose(lines, tokensBefore, tool)
  if (!strategy) return undefined
  // The kept lines are bounded by the tier they were measured against, so a cap
  // can never re-introduce a result as large as the one it replaced.
  const budget = strategy === "addressing" ? THRESHOLD_DATA : strategy === "table" ? THRESHOLD_TEXT : PREVIEW_TOKENS
  const kept = keep(strategy, lines, budget)
  if (kept.length === 0) return undefined
  const rendered = render(strategy, lines, kept, tokensBefore)
  return {
    strategy,
    rendered,
    keptLines: kept.length,
    droppedLines: lines.length - kept.length,
    tokensBefore,
    tokensAfter: estimateTokens(rendered),
  }
}

function choose(lines: readonly string[], tokens: number, tool?: string): Strategy | undefined {
  // Addressing lines are load-bearing for the NEXT call, so this fires at the data
  // tier: a snapshot nobody can address by is worth nothing at any size. Outside a
  // browser tool the same pattern would be `[INFO]` in a build log, and keeping
  // "ref-like" lines there would drop exactly the prose the reader came for.
  if (browserTool(tool) && lines.some((line) => REF_TOKEN.test(line)))
    return tokens >= THRESHOLD_DATA ? "addressing" : undefined
  const tables = lines.filter((line) => TABLE_LINE.test(line)).length
  if (tables >= 3) return tokens >= THRESHOLD_TEXT ? "table" : undefined
  return tokens >= THRESHOLD_TEXT ? "summary" : undefined
}

/** The host's browser tools are namespaced, so the effective name starts with it. */
const browserTool = (tool?: string) => tool !== undefined && /^browser/.test(tool)

function keep(strategy: Strategy, lines: string[], budget: number) {
  if (strategy === "addressing")
    // A snapshot whose refs still exceed the budget keeps the head of the list;
    // the dropped remainder is in the spill file, which the render names.
    return limit(lines.filter((line) => REF_TOKEN.test(line)), budget)
  if (strategy === "table") {
    const tables = lines.filter((line) => TABLE_LINE.test(line))
    const first = lines.findIndex((line) => TABLE_LINE.test(line))
    const heading = first > 0 ? lines.slice(0, first).filter((line) => /^#{1,4}\s/.test(line)) : []
    // A table with a row missing is not smaller, it is broken — so rows are kept in
    // full and the prose around them is what pays.
    return [...heading, ...limit(tables, budget)]
  }
  const sample = limit(lines, budget)
  if (sample.length > 0) return sample
  // A payload with no line boundary at all (minified code, a one-line log) is the
  // case a per-line budget cannot reach, and it is the one that hurts most: slice a
  // head so the model at least recognises what it is looking at.
  const first = lines.find((line) => line.trim() !== "")
  return first === undefined ? [] : [truncate(first, budget)]
}

function truncate(text: string, budget: number) {
  let out = ""
  let used = 0
  for (const char of text) {
    used += cjkRange.test(char) ? 1 : 0.25
    if (used > budget) return `${out}…`
    out += char
  }
  return out
}

function limit(lines: string[], budget: number) {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    used += estimateTokens(line)
    if (used > budget) return out
    out.push(line)
  }
  return out
}

function render(strategy: Strategy, lines: string[], kept: string[], tokensBefore: number) {
  const head = lines.find((line) => line.trim() !== "") ?? ""
  return [
    `[team cap] oversized result narrowed in place: ${strategy} · kept ${kept.length}/${lines.length} lines · ${tokensBefore} tokens did not enter the context`,
    `first line of the original: ${head.slice(0, 160)}`,
    "The full text is the file named below — page it with `read` and its offset/limit.",
    "",
    ...kept,
  ].join("\n")
}
