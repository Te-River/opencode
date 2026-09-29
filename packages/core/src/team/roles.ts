export * as TeamRoles from "./roles.js"

import { TeamPrompts } from "./prompts.js"

/**
 * The Team's six roles as data, so the permission matrix is one readable table
 * instead of six look-alike blocks.  `board` marks the roles that get a write
 * grant for the board directory ONLY: architect, researcher and reviewer hold no
 * file tool otherwise, and a >50-line deliverable from those roles has nowhere
 * else to go — putting it in the reply is what the board exists to prevent.
 *
 * Rule order is load-bearing: the host resolves a ruleset with last-match-wins,
 * so a broad `deny` has to precede the narrower `allow` it is meant to carve an
 * exception out of.
 */
export interface Role {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly color: string
  readonly mode: "primary" | "subagent"
  readonly system: string
  readonly board: boolean
  readonly permissions: readonly Permission[]
}

export interface Permission {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

const refuse = (actions: string[], effect: Permission["effect"] = "deny") =>
  actions.map((action) => ({ action, resource: "*", effect }))

/** Denied by every role: a child must not re-open the questions the lead owns. */
const COMMON = refuse(["patch", "skill", "subagent"])

/** The Team helpers that are not the lead's: collecting work is routing, and routing is the lead's. */
const NOT_LEADS = refuse(["team_join", "team_ledger"])

const FILE_READ = refuse(["read", "grep", "glob"], "allow")

export const roles: readonly Role[] = [
  {
    id: "team",
    name: "Team",
    description:
      "Team lead orchestrator — routes work to specialist agents (architect, implementer, reviewer, tester, researcher) via a fixed routing table, enforces the approval gate and review/test feedback loop, and synthesizes their outputs into a coherent deliverable.  Use when the task requires multi-step collaboration across different expertise areas.",
    color: "#E879F9",
    mode: "primary",
    system: TeamPrompts.lead,
    board: false,
    permissions: [
      ...refuse(["patch", "skill"]),
      { action: "question", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      ...refuse(["webfetch", "websearch", "browser"], "ask"),
      { action: "team_*", resource: "*", effect: "allow" },
    ],
  },
  {
    id: "architect",
    name: "Architect",
    description:
      "System architect — designs module structure, API contracts, data models, and technical strategy; revises designs when review or testing exposes a flaw.  Use when you need a design doc, architecture decision record, or module breakdown before implementation.",
    color: "#38BDF8",
    mode: "subagent",
    system: TeamPrompts.specialists.architect,
    board: true,
    permissions: [...COMMON, ...refuse(["question"]), ...FILE_READ, { action: "edit", resource: "*", effect: "deny" }, ...refuse(["shell", "webfetch", "websearch", "browser"]), { action: "team_fetch", resource: "*", effect: "allow" }, { action: "team_stats", resource: "*", effect: "allow" }, ...NOT_LEADS],
  },
  {
    id: "implementer",
    name: "Implementer",
    description:
      "Core implementer — writes production code, creates files, and builds features according to the architect's design; applies review-driven fix tasks.  Use when you need clean, working code written quickly.",
    color: "#4ADE80",
    mode: "subagent",
    system: TeamPrompts.specialists.implementer,
    board: true,
    permissions: [...COMMON, ...refuse(["question"]), { action: "edit", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" }, ...refuse(["webfetch", "websearch", "browser"]), { action: "team_fetch", resource: "*", effect: "allow" }, { action: "team_stats", resource: "*", effect: "allow" }, ...NOT_LEADS],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description:
      "Code reviewer — reviews ONE dimension per dispatch (completeness / correctness / impact) with severity-graded, actionable findings; the lead defaults to one correctness dispatch and escalates to three parallel dimensions only for high-risk changes.  Use before merging any non-trivial change.",
    color: "#FB923C",
    mode: "subagent",
    system: TeamPrompts.specialists.reviewer,
    board: true,
    permissions: [...COMMON, ...refuse(["question"]), ...FILE_READ, { action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "allow" }, ...refuse(["webfetch", "websearch", "browser"]), { action: "team_fetch", resource: "*", effect: "allow" }, { action: "team_stats", resource: "*", effect: "allow" }, ...NOT_LEADS],
  },
  {
    id: "tester",
    name: "Tester",
    description:
      "Test engineer — writes and runs unit/integration tests, classifies failures (product bug vs bad test vs environment), verifies via build, typecheck, static analysis and API-level tests, verifies user-visible frontend changes through the host's browser tools (UI verification of this project only), and reports a clear verdict.  Use to validate correctness or raise coverage.",
    color: "#F472B6",
    mode: "subagent",
    system: TeamPrompts.specialists.tester,
    board: true,
    permissions: [...COMMON, ...refuse(["question"]), { action: "edit", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" }, ...refuse(["webfetch", "websearch"]), { action: "browser", resource: "*", effect: "ask" }, { action: "team_fetch", resource: "*", effect: "allow" }, { action: "team_stats", resource: "*", effect: "allow" }, ...NOT_LEADS],
  },
  {
    id: "researcher",
    name: "Researcher",
    description:
      "Researcher — investigates the local repository (code, configs, installed/vendored packages, shipped documentation) and, when local sources are insufficient, the web through the host's own search, fetch, and browser tools.  Every finding carries a source (file:line or URL) and a confidence tag so the team can decide what needs verification.  Use for information that must inform a technical decision.",
    color: "#A78BFA",
    mode: "subagent",
    system: TeamPrompts.specialists.researcher,
    board: true,
    permissions: [
      ...COMMON,
      ...refuse(["question"]),
      ...FILE_READ,
      { action: "edit", resource: "*", effect: "deny" },
      ...refuse(["shell"]),
      ...refuse(["webfetch", "websearch", "browser"], "ask"),
      { action: "team_fetch", resource: "*", effect: "allow" },
      { action: "team_stats", resource: "*", effect: "allow" },
      ...NOT_LEADS,
    ],
  },
]
