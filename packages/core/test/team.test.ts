import { describe, expect, test } from "bun:test"
import { TeamBoard } from "@opencode/core/team/board"
import { TeamCap } from "@opencode/core/team/cap"
import { TeamGovern } from "@opencode/core/team/govern"
import { TeamLedger } from "@opencode/core/team/ledger"

/**
 * These are the two claims the Team's governance layer makes about itself: that a
 * result was narrowed to the lines the next call needs, and that nothing was
 * dropped that the caller could not get back. Both are checked against the real
 * functions on inputs sized past the tiers, because a claim that only holds while
 * the fixture is small is not a claim.
 */

const filler = (lines: number, width: number) =>
  Array.from({ length: lines }, (_, index) => `line ${index} ${"x".repeat(width)}`).join("\n")

describe("TeamCap", () => {
  test("leaves a result under the tier alone", () => {
    expect(TeamCap.cap("a short answer with one [ref=a1] token")).toBeUndefined()
  })

  test("keeps the addressing lines a snapshot is clicked by", () => {
    const refs = ["[ref=b12] Submit order", "[ref=b40] Cancel", "[ref=b77] Total 12.00"]
    const text = [filler(120, 90), ...refs].join("\n")
    const capped = TeamCap.cap(text)
    expect(capped?.strategy).toBe("addressing")
    expect(capped?.keptLines).toBe(refs.length)
    for (const ref of refs) expect(capped?.rendered).toContain(ref)
    expect(capped!.tokensAfter).toBeLessThan(capped!.tokensBefore)
    expect(capped!.droppedLines).toBe(120)
  })

  test("keeps every table row and pays with the prose", () => {
    const rows = Array.from({ length: 60 }, (_, index) => `| item-${index} | ${index * 7} | ok |`)
    const text = ["# Report", filler(300, 60), "## Findings", ...rows].join("\n")
    const capped = TeamCap.cap(text)
    expect(capped?.strategy).toBe("table")
    // A table with a row missing is not smaller, it is broken.
    expect(rows.every((row) => capped!.rendered.includes(row))).toBe(true)
    expect(capped!.rendered).toContain("## Findings")
    expect(capped!.droppedLines).toBeGreaterThan(0)
  })

  test("summarises prose it cannot structure", () => {
    const capped = TeamCap.cap(filler(300, 60))
    expect(capped?.strategy).toBe("summary")
    expect(capped!.keptLines).toBeLessThan(30)
    expect(capped!.rendered).toContain("[team cap]")
  })

  test("measures a CJK result by the glyph, not by four characters", () => {
    const text = "记".repeat(TeamCap.THRESHOLD_TEXT)
    expect(TeamCap.estimateTokens(text)).toBe(TeamCap.THRESHOLD_TEXT)
    expect(TeamCap.cap(text)?.tokensBefore).toBe(TeamCap.THRESHOLD_TEXT)
    // The same character count in Latin is four times cheaper, and would not fire.
    expect(TeamCap.estimateTokens("x".repeat(TeamCap.THRESHOLD_TEXT))).toBe(1_000)
  })

  test("a cap is never as large as the result it replaced", () => {
    const inputs = [
      `${filler(120, 90)}\n[ref=b1] go`,
      ["# R", filler(200, 60), "| a | b |", "| c | d |", "| e | f |"].join("\n"),
    ]
    for (const text of inputs) {
      const capped = TeamCap.cap(text)
      if (!capped) continue
      expect(capped.tokensAfter).toBeLessThan(capped.tokensBefore)
    }
  })
})

describe("TeamGovern scope", () => {
  test("applies to exactly the six Team roles", () => {
    expect(["team", "architect", "implementer", "reviewer", "tester", "researcher"].map(TeamGovern.scoped)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    // A foreign agent is left alone: a governance layer that quietly widened itself
    // onto every session is the same class of failure as one that stopped applying.
    for (const agent of ["build", "plan", "explore", "general", "compaction"])
      expect(TeamGovern.scoped(agent)).toBe(false)
  })

  test("lives under the Team root", () => {
    expect(TeamGovern.outputRoot("/data")).toBe("/data/team/output")
    expect(TeamGovern.trajectoryRoot("/data")).toBe("/data/team/trajectory")
  })
})

describe("TeamLedger", () => {
  const at = (count: number) => ({
    items: Array.from({ length: count }, (_, index) => ({
      id: `T${index + 1}`,
      text: `item ${index}`,
      status: "pending" as const,
    })),
  })

  test("an interruption is an insertion, not a duplicate item", () => {
    const added = TeamLedger.add(TeamLedger.EMPTY, "ship the cap")
    if ("refusal" in added) throw new Error(added.refusal)
    expect(added.item.id).toBe("T1")
    const again = TeamLedger.add(added.ledger, "ship the cap")
    if ("refusal" in again) throw new Error(again.refusal)
    expect(again.item.id).toBe("T1")
    expect(again.ledger.items.length).toBe(1)
  })

  test("refuses past the cap instead of dropping a requirement", () => {
    const full = TeamLedger.add(at(TeamLedger.MAX_ITEMS), "one more")
    expect(full).toEqual({ refusal: expect.stringContaining("cap") })
  })

  test("names the live ids when an id does not exist", () => {
    const changed = TeamLedger.change(at(3), "T9", { status: "done" })
    expect(changed).toEqual({ refusal: expect.stringContaining("T1, T2, T3") })
  })

  test("an unknown status is refused and the item keeps its state", () => {
    const changed = TeamLedger.change(at(1), "T1", { status: "cancelled" as never })
    expect(changed).toEqual({ refusal: expect.stringContaining("pending") })
  })

  test("blocked is a state, not an exit", () => {
    const changed = TeamLedger.change(at(1), "T1", { status: "blocked", note: "needs the API key" })
    if ("refusal" in changed) throw new Error(changed.refusal)
    expect(changed.items[0].status).toBe("blocked")
    expect(changed.items[0].note).toBe("needs the API key")
    expect(TeamLedger.render(changed)).toContain("1 open of 1")
  })

  test("renders an empty list as a sentence, not a header row", () => {
    expect(TeamLedger.render(TeamLedger.EMPTY)).toBe("(ledger is empty)")
  })
})

describe("TeamBoard", () => {
  test("the note promises the cleanup this process actually runs", () => {
    const note = TeamBoard.note("/data/team/board", 14)
    expect(note).toContain("/data/team/board")
    expect(note).toContain("idle for more than 14 days")
    expect(note).toContain("never delete task or")
  })

  test("roots stay inside the Team directory", () => {
    expect(TeamBoard.teamRoot("/data")).toBe("/data/team")
    expect(TeamBoard.rootFor("/data")).toBe("/data/team/board")
  })
})
