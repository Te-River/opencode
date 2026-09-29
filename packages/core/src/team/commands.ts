export * as TeamCommands from "./commands.js"

import IMPLEMENT from "./command/team-implement.txt"
import PLAN from "./command/team-plan.txt"
import RESEARCH from "./command/team-research.txt"
import REVIEW from "./command/team-review.txt"
import RUN from "./command/team-run.txt"
import TEST from "./command/team-test.txt"

/**
 * A built-in command runs in whatever agent the user selected, so the template
 * cannot name its own executor the way a config file could.  What it does own is
 * the ROUTING: the entry line says which role owes the deliverable, and the
 * lead's routing table turns that into a dispatch.  Without the line a `/team-plan`
 * typed in a `build` session would silently be answered by `build` itself.
 */
export interface Command {
  readonly name: string
  readonly description: string
  readonly role: string
  readonly template: string
}

export const commands: readonly Command[] = [
  {
    name: "team-run",
    description:
      "Full team workflow — deterministic routing, approval gate on >=2 dispatches, structured handoffs.",
    role: "team",
    template: RUN,
  },
  {
    name: "team-plan",
    description: "Create a comprehensive implementation plan — architecture, task breakdown, and risk analysis.",
    role: "architect",
    template: PLAN,
  },
  {
    name: "team-implement",
    description: "Implement a feature or task — write production code following the project's conventions.",
    role: "implementer",
    template: IMPLEMENT,
  },
  {
    name: "team-review",
    description:
      "Review code with a single focused dimension — completeness, correctness, or impact (default: correctness).",
    role: "reviewer",
    template: REVIEW,
  },
  {
    name: "team-test",
    description: "Generate comprehensive tests — unit, integration, and edge-case coverage.",
    role: "tester",
    template: TEST,
  },
  {
    name: "team-research",
    description:
      "Research a topic — grounded in the local repository (code, configs, installed packages, shipped docs).",
    role: "researcher",
    template: RESEARCH,
  },
]

export function render(command: Command, argument: string) {
  const text = argument.trim()
  const body = command.template.includes("$ARGUMENTS")
    ? command.template.replaceAll("$ARGUMENTS", () => text)
    : [command.template, text].filter(Boolean).join("\n\n")
  return [routing(command), body].join("\n\n").trim()
}

function routing(command: Command) {
  if (command.role === "team")
    return "Run this as the Team lead: state the GOAL and ACCEPTANCE criteria, then follow the routing table and the approval gate."
  return `This deliverable belongs to the \`${command.role}\` specialist. If you are that role, produce it; otherwise dispatch it there and synthesize the reply — do not answer it from your own reasoning.`
}
