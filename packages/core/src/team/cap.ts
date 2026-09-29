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
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (cjkRange.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

const cjkRange = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** Bracketed tokens the next call addresses a page or a table row by. */
const ADDRESSING = /\[(?:ref|uid|e)\s*=?[^\]]*\]|\[[A-Za-z0-9_-]{2,}\]/
const TABLE_LINE = /^\s*\|.*\|\s*$/

/** Tier thresholds, in tokens: structured payloads are costlier per line than prose. */
export const THRESHOLD_TEXT = 4_000
export const THRESHOLD_DATA = 2_000

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
 */
export function cap(text: string): Capped | undefined {
  const tokensBefore = estimateTokens(text)
  const strategy = choose(text, tokensBefore)
  if (!strategy) return undefined
  // The kept lines are bounded by the tier they were measured against, so a cap
  // can never re-introduce a result as large as the one it replaced.
  const budget = strategy === "addressing" ? THRESHOLD_DATA : THRESHOLD_TEXT
  const lines = text.split("\n")
  const kept = strategy === "table" ? keepTables(lines, budget) : keepAddressing(lines, budget)
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

function choose(text: string, tokens: number): Strategy | undefined {
  const lines = text.split("\n")
  // Addressing lines are load-bearing for the NEXT call, so this fires at the
  // data tier: a snapshot nobody can address by is worth nothing at any size.
  if (lines.some((line) => ADDRESSING.test(line))) return tokens >= THRESHOLD_DATA ? "addressing" : undefined
  const tables = lines.filter((line) => TABLE_LINE.test(line)).length
  if (tables >= 3) return tokens >= THRESHOLD_TEXT ? "table" : undefined
  return tokens >= THRESHOLD_TEXT ? "summary" : undefined
}

function keepAddressing(lines: string[], budget: number) {
  // A snapshot whose refs still exceed the budget keeps the head of the list; the
  // dropped remainder is in the spill file, which the render names.
  return limit(lines.filter((line) => ADDRESSING.test(line)), budget)
}

function keepTables(lines: string[], budget: number) {
  const tables = lines.filter((line) => TABLE_LINE.test(line))
  const first = lines.findIndex((line) => TABLE_LINE.test(line))
  const heading = first > 0 ? lines.slice(0, first).filter((line) => /^#{1,4}\s/.test(line)) : []
  // A table with a row missing is not smaller, it is broken — so rows are kept in
  // full and the prose around them is what pays.
  return [...heading, ...limit(tables, budget)]
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
