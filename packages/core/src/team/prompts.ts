export * as TeamPrompts from "./prompts.js"

import ARCHITECT from "./prompt/architect.txt"
import IMPLEMENTER from "./prompt/implementer.txt"
import RESEARCHER from "./prompt/researcher.txt"
import REVIEWER from "./prompt/reviewer.txt"
import SHARED from "./prompt/shared.txt"
import TEAM_LEAD from "./prompt/team.txt"
import TESTER from "./prompt/tester.txt"

/**
 * The specialists' prompts are three parts: their own role text, the reply
 * skeleton, and the rules every role shares.  The shared tail is one file
 * instead of five copies, so a rule change cannot land in one role and be
 * missing from another.
 */
export const lead = TEAM_LEAD
export const specialists = {
  architect: ARCHITECT + SHARED,
  implementer: IMPLEMENTER + SHARED,
  reviewer: REVIEWER + SHARED,
  tester: TESTER + SHARED,
  researcher: RESEARCHER + SHARED,
} as const
