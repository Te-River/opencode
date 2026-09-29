export * as TeamPlugin from "./team.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import path from "path"
import { TeamBoard } from "../team/board.js"
import { TeamCommands } from "../team/commands.js"
import { TeamGovern } from "../team/govern.js"
import { TeamRoles } from "../team/roles.js"

/**
 * The Team mode built in.
 *
 * It is an internal plugin because that is how this codebase expresses a
 * built-in extension (`PlanPlugin` is the neighbour): one `define`d effect over
 * the same agent / command / tool editors a user plugin gets, registered in
 * `plugin/internal.ts`.
 *
 * What it does NOT do is take over the session. The lead is a normal `primary`
 * agent the user selects, the five specialists are `subagent`-only so they never
 * appear as a mode the user can accidentally type into, and nothing here writes a
 * default agent. A build session that runs `/team-plan` still gets routed, because
 * the command names the role that owes the deliverable.
 */
export const Plugin = define({
  id: "opencode.team",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const team = TeamBoard.teamRoot(global.data)
    const board = TeamBoard.rootFor(global.data)
    const outputs = TeamGovern.outputRoot(global.data)
    const trajectory = TeamGovern.trajectoryRoot(global.data)

    yield* ctx.agent.transform((editor) => {
      for (const role of TeamRoles.roles) {
        editor.update(Agent.ID.make(role.id), (item) => {
          item.name = Agent.Name.make(role.name)
          item.description = role.description
          item.mode = role.mode
          item.color = role.color
          // The lead is the only role that can know the root: a specialist with no
          // shell cannot stamp a session folder, so the dispatch passes it instead.
          item.system = role.id === "team" ? role.system + TeamBoard.note(board, TeamBoard.TTL_DAYS) : role.system
          // Format discipline for the reply skeleton, not a creative temperature. A request
          // that already carries one (a user model variant) outranks this.
          if (item.request.settings.temperature === undefined) item.request.settings.temperature = 0.2
          item.permissions.push(...role.permissions)
          // Every role reads the Team's own files (a capped result points at one);
          // only the board subdirectory is writable, and only by the roles that
          // have no other file grant — a spilled payload is an audit trail, and a
          // role that can edit it can manufacture its own evidence.
          item.permissions.push({ action: "external_directory", resource: path.join(team, "*"), effect: "allow" })
          if (role.board)
            item.permissions.push(
              { action: "edit", resource: path.join(board, "*"), effect: "allow" },
              { action: "external_directory", resource: path.join(board, "*"), effect: "allow" },
            )
        })
      }
    })

    yield* ctx.command.transform((editor) => {
      for (const command of TeamCommands.commands) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: TeamCommands.render(command, input.prompt.text),
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        })
      }
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return Effect.void
      if (!TeamGovern.scoped(String(event.agent))) return Effect.void
      return TeamGovern.govern({
        outputs,
        trajectory,
        tool: event.tool,
        agent: String(event.agent),
        sessionID: String(event.sessionID),
        callID: String(event.id),
        content: event.result.content,
      }).pipe(
        Effect.flatMap((capped) => {
          if (!capped) return Effect.void
          // The first text part carries the cap and the rest go empty rather than
          // disappearing: a result that silently lost a part is a claim the
          // trajectory cannot describe.
          event.result = {
            ...event.result,
            content: event.result.content.map((item, index) =>
              index === 0 ? { type: "text" as const, text: capped.rendered } : { type: "text" as const, text: "" },
            ),
            metadata: { ...event.result.metadata, team_capped: capped.strategy },
          }
          return Effect.void
        }),
      )
    })

    yield* TeamBoard.maintenance(board)
    yield* TeamGovern.maintenance(outputs, trajectory)
  }),
})
