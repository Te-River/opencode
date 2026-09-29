export * as TeamLedger from "./ledger.js"

/**
 * The lead's task list.
 *
 * This exists because the host has no todo/plan/task resource for a plugin or an
 * agent to write into: the ledger is not a nicer-looking alternative to a native
 * list, it is the only list a Team lead can keep at all. It lives in the host's
 * own per-session storage namespace, keyed by the lead's session, and it REFUSES
 * past the cap instead of silently dropping an item — a list that quietly loses a
 * requirement is worse than no list, because the lead then reports it as done.
 */
export type Status = "pending" | "doing" | "done" | "blocked"

export interface Item {
  readonly id: string
  readonly text: string
  readonly status: Status
  readonly note?: string
}

export interface Ledger {
  readonly items: readonly Item[]
}

export const EMPTY: Ledger = { items: [] }
export const MAX_ITEMS = 200

export type Refusal = { readonly refusal: string }
export type Added = { readonly ledger: Ledger; readonly item: Item; readonly message: string }
export type Changed = { readonly ledger: Ledger; readonly message: string }

/** Re-using an exact text is an interruption arriving again, not a new ask. */
export function add(ledger: Ledger, text: string): Added | Refusal {
  const trimmed = text.trim()
  if (!trimmed) return { refusal: "ledger add needs a non-empty text" }
  const existing = ledger.items.find((item) => item.text === trimmed)
  // The sentence says which of the two happened: the caller cannot tell them apart
  // from the item, because a folded text is by definition identical to the one stored.
  if (existing) return { ledger, item: existing, message: `already on the list ${existing.id}: ${existing.text}` }
  if (ledger.items.length >= MAX_ITEMS)
    return { refusal: `ledger is at its cap (${MAX_ITEMS}); resolve or drop an item first` }
  const item: Item = { id: next(ledger.items), text: trimmed, status: "pending" }
  return { ledger: { items: [...ledger.items, item] }, item, message: `added ${item.id}: ${item.text}` }
}

export function change(
  ledger: Ledger,
  id: string,
  patch: { status?: Status; text?: string; note?: string },
): Ledger | Refusal {
  if (patch.status !== undefined && !VALID.test(patch.status))
    return { refusal: `unknown status ${JSON.stringify(patch.status)} — use ${[...STATUSES].join(" | ")}` }
  const index = ledger.items.findIndex((item) => item.id === id.trim())
  if (index < 0)
    return { refusal: `no ledger item ${JSON.stringify(id)} — live ids: ${ledger.items.map((item) => item.id).join(", ") || "(none)"}` }
  const current = ledger.items[index]
  const item: Item = {
    ...current,
    ...(patch.text === undefined || !patch.text.trim() ? {} : { text: patch.text.trim() }),
    ...(patch.note === undefined ? {} : { note: patch.note }),
    status: patch.status ?? current.status,
  }
  return { items: ledger.items.map((other, at) => (at === index ? item : other)) }
}

const STATUSES = ["pending", "doing", "done", "blocked"] as const
const VALID = new RegExp(`^(${STATUSES.join("|")})$`)

function next(items: readonly Item[]) {
  const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0)
  return `T${highest + 1}`
}

/** GFM table: the lead pastes this into its reply and the user reads it as-is. */
export function render(ledger: Ledger) {
  if (ledger.items.length === 0) return "(ledger is empty)"
  const open = ledger.items.filter((item) => item.status !== "done").length
  return [
    `| id | status | item | note |`,
    `| --- | --- | --- | --- |`,
    ...ledger.items.map(
      (item) => `| ${item.id} | ${item.status} | ${item.text.replace(/\|/g, "\\|")} | ${item.note ?? ""} |`,
    ),
    ``,
    `${open} open of ${ledger.items.length}.`,
  ].join("\n")
}

export const isLedger = (value: unknown): value is Ledger =>
  typeof value === "object" && value !== null && "items" in value && Array.isArray((value as Ledger).items)
