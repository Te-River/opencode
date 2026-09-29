import { describe, expect, test } from "bun:test"
import { TeamBoard } from "@opencode/core/team/board"
import { TeamCommands } from "@opencode/core/team/commands"
import { TeamLedger } from "@opencode/core/team/ledger"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * The ledger is the lead's plan of record, so its two failure modes are the ones
 * worth pinning: a requirement that vanishes, and an item that reads as settled
 * when it is only stuck. Both are checked against the real functions.
 */
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
    expect(TeamLedger.add(at(TeamLedger.MAX_ITEMS), "one more")).toEqual({
      refusal: expect.stringContaining("cap"),
    })
  })

  test("names the live ids when an id does not exist", () => {
    expect(TeamLedger.change(at(3), "T9", { status: "done" })).toEqual({
      refusal: expect.stringContaining("T1, T2, T3"),
    })
  })

  test("an unknown status is refused and the item keeps its state", () => {
    expect(TeamLedger.change(at(1), "T1", { status: "cancelled" as never })).toEqual({
      refusal: expect.stringContaining("pending"),
    })
  })

  test("blocked is a state, not an exit", () => {
    const changed = TeamLedger.change(at(1), "T1", { status: "blocked", note: "needs the API key" })
    if ("refusal" in changed) throw new Error(changed.refusal)
    expect(changed.items[0].status).toBe("blocked")
    expect(changed.items[0].note).toBe("needs the API key")
    // The count the lead reports its run against.
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
