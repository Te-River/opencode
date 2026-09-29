import { describe, expect, test } from "bun:test"
import { TeamBoard } from "@opencode/core/team/board"
import { TeamCommands } from "@opencode/core/team/commands"
import { TeamLedger } from "@opencode/core/team/ledger"

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
