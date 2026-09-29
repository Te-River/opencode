import { describe, expect, test } from "bun:test"
import { TeamBoard } from "@opencode/core/team/board"
import { TeamCap } from "@opencode/core/team/cap"
import { TeamCommands } from "@opencode/core/team/commands"
import { TeamGovern } from "@opencode/core/team/govern"
import { TeamLedger } from "@opencode/core/team/ledger"
import { TeamPrompts } from "@opencode/core/team/prompts"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
    const capped = TeamCap.cap(text, "browser.snapshot")
    expect(capped?.strategy).toBe("addressing")
    expect(capped?.keptLines).toBe(refs.length)
    for (const ref of refs) expect(capped?.rendered).toContain(ref)
    expect(capped!.tokensAfter).toBeLessThan(capped!.tokensBefore)
    expect(capped!.droppedLines).toBe(120)
  })

  test("does not treat bracketed log tokens as references", () => {
    // `[INFO]`/`[WARN]` are prose markers and this payload sits under the text tier,
    // so it reaches the model whole no matter which tool produced it.
    const log = [
      filler(120, 90),
      "[INFO] compiled 42 modules",
      "[WARN] bundle size grew 8%",
    ].join("\n")
    expect(TeamCap.cap(log, "shell")).toBeUndefined()
    expect(TeamCap.cap(log, "browser.snapshot")).toBeUndefined()
  })

  test("keeps reference lines only for the tool whose output they address", () => {
    const snapshot = [filler(120, 90), "[ref=b12] Submit order"].join("\n")
    expect(TeamCap.cap(snapshot, "browser.snapshot")?.strategy).toBe("addressing")
    // The same bytes from another tool: nothing here is addressed BY a reference, so
    // keeping only the ref line would throw away what the agent came to read.
    expect(TeamCap.cap(snapshot, "shell")).toBeUndefined()
  })

  test("keeps every table row and pays with the prose", () => {
    const rows = Array.from({ length: 60 }, (_, index) => `| item-${index} | ${index * 7} | ok |`)
    const text = ["# Report", filler(300, 60), "## Findings", ...rows].join("\n")
    const capped = TeamCap.cap(text, "webfetch")
    expect(capped?.strategy).toBe("table")
    // A table with a row missing is not smaller, it is broken.
    expect(rows.every((row) => capped!.rendered.includes(row))).toBe(true)
    expect(capped!.rendered).toContain("## Findings")
    expect(capped!.droppedLines).toBeGreaterThan(0)
  })

  test("summarises prose it cannot structure", () => {
    const capped = TeamCap.cap(filler(300, 60), "shell")
    expect(capped?.strategy).toBe("summary")
    expect(capped!.keptLines).toBeLessThan(30)
    expect(capped!.rendered).toContain("[team cap]")
  })

  test("measures a CJK result by the glyph, not by four characters", () => {
    const text = "记".repeat(TeamCap.THRESHOLD_TEXT)
    expect(TeamCap.estimateTokens(text)).toBe(TeamCap.THRESHOLD_TEXT)
    expect(TeamCap.cap(text, "read")?.tokensBefore).toBe(TeamCap.THRESHOLD_TEXT)
    // The same character count in Latin is four times cheaper, and would not fire.
    expect(TeamCap.estimateTokens("x".repeat(TeamCap.THRESHOLD_TEXT))).toBe(1_000)
  })

  test("a cap is never as large as the result it replaced", () => {
    const inputs = [
      [`${filler(120, 90)}\n[ref=b1] go`, "browser.snapshot"] as const,
      [["# R", filler(200, 60), "| a | b |", "| c | d |", "| e | f |"].join("\n"), "read"] as const,
    ]
    for (const [text, tool] of inputs) {
      const capped = TeamCap.cap(text, tool)
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
    // Compared through path, not a slash literal: `path.join` yields this platform's
    // separator, so `"/data/team/output"` would fail on a Windows runner.
    const team = TeamBoard.teamRoot("/data")
    expect(path.dirname(TeamGovern.outputRoot("/data"))).toBe(team)
    expect(path.dirname(TeamGovern.trajectoryRoot("/data"))).toBe(team)
    expect(path.basename(TeamGovern.outputRoot("/data"))).toBe("output")
    expect(path.basename(TeamGovern.trajectoryRoot("/data"))).toBe("trajectory")
  })

  test("a call id cannot steer the spill path", () => {
    // The id comes from the provider and lands in a filename the agent is told to
    // read, so the properties that matter are asserted rather than a hand-counted
    // rewrite of one sample.
    for (const callID of ["../../etc/passwd", "a/b/c", "..", "id.with.dots", ""]) {
      const name = TeamGovern.spillName(callID)
      expect(name).not.toContain("/")
      expect(name).not.toContain("..")
      expect(name.endsWith(".txt")).toBe(true)
    }
    expect(TeamGovern.spillName("")).toBe("call.txt")
    expect(TeamGovern.spillName("call_abc-123")).toBe("call_abc-123.txt")
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
    // The two outcomes have to read differently: an item that was already there must
    // not be reported as a new addition, which is what the shared item id made easy.
    expect(added.message).toBe("added T1: ship the cap")
    expect(again.message).toBe("already on the list T1: ship the cap")
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
    const team = TeamBoard.teamRoot("/data")
    expect(path.basename(team)).toBe("team")
    // Compared through path: `path.join` yields this platform's separator, so a
    // slash literal would fail on a Windows runner.
    expect(path.dirname(TeamBoard.rootFor("/data"))).toBe(team)
    expect(path.basename(TeamBoard.rootFor("/data"))).toBe("board")
  })

  test("a session is judged idle by the newest write anywhere in it", async () => {
    // The prompt tells every role the sweep is the ONLY cleanup path, so a board the
    // lead is still revising must survive it. A revision lands at
    // `<session>/<task>/NN-<role>-<topic>.md`, which does not move the session
    // directory's own mtime.
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-board-"))
    try {
      const session = path.join(root, "20260101-000000")
      const file = path.join(session, "auth-design", "01-architect-design.md")
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, "# design\n", "utf8")
      const past = new Date(Date.now() - 20 * 86_400_000)
      await utimes(session, past, past)
      await Effect.runPromise(TeamBoard.sweep(root, TeamBoard.TTL_DAYS))
      expect(existsSync(file)).toBe(true)

      // Now genuinely idle: everything down to the file is old.
      await utimes(path.dirname(file), past, past)
      await utimes(file, past, past)
      await Effect.runPromise(TeamBoard.sweep(root, TeamBoard.TTL_DAYS))
      expect(existsSync(session)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("TeamCommands", () => {
  const named = (name: string) => TeamCommands.commands.find((command) => command.name === name)!

  test("the argument lands where the template asks for it", () => {
    const text = TeamCommands.render(named("team-plan"), "add retry handling")
    expect(text).toContain("add retry handling")
    expect(text).not.toContain("$ARGUMENTS")
    // The routing line is what stops a `build` session answering a Team command itself.
    expect(text).toContain("`architect`")
  })

  test("the lead command names the lead", () => {
    expect(TeamCommands.render(named("team-run"), "ship it")).toContain("Team lead")
  })

  test("an empty argument still yields a usable prompt", () => {
    expect(TeamCommands.render(named("team-test"), "   ").length).toBeGreaterThan(40)
  })
})

/**
 * The prompts are assets, not prose. A stale tool name in them is an agent calling a
 * tool that does not exist, and an absolute date is a claim that goes wrong while the
 * process is still running — the drifts that survive a careful port, so they fail a
 * test rather than depend on a reader remembering to check.
 */
describe("Team prompt assets", () => {
  const texts: [string, string][] = [
    ["lead", TeamPrompts.lead],
    ...Object.entries(TeamPrompts.specialists),
    ...TeamCommands.commands.map((command) => [command.name, command.template] as [string, string]),
  ]

  const rules: [string, RegExp][] = [
    ["names no tool with a tm_ prefix", /tm_[a-z]/],
    ["names only tools this build registers", /team_fetch|team_join|tm_memory|board_write/],
    ["bakes in no absolute date", /20\d\d-\d\d-\d\d|20\d\d年\d+月/],
    ["carries no non-ASCII report wording", /[\u3400-\u9fff]/],
    ["has no unfilled placeholder", /\bTODO\b|\bFIXME\b|\bXXX\b|<[A-Z]{3,}>/],
    ["refers to no plugin-only knob or gate verb", /TM_[A-Z_]+|\bR6\b|PROBE-OK|allow_host/],
  ]

  for (const [label, pattern] of rules) {
    test(label, () => {
      const offender = texts.find(([, text]) => pattern.test(text))
      // Name the asset and quote the match, so the failure says where to look.
      expect(offender === undefined ? "" : `${offender[0]}: ${pattern.exec(offender[1])?.[0]}`).toBe("")
    })
  }
})
