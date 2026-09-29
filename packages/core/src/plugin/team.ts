export * as TeamPlugin from "./team.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import path from "path"
import { TeamBoard } from "../team/board.js"
import { TeamCommands } from "../team/commands.js"
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
            Effect.gen(function* () {
              // `/team-run` is how you enter Team mode without hunting for it in the
              // picker, so it moves the session onto the lead before it prompts. The
              // five specialists are `subagent` mode and cannot BE a session's agent —
              // for those the text names the role that owes the work.
              if (command.role === "team")
                yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent: Agent.ID.make("team") })
              yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: TeamCommands.render(command, input.prompt.text),
                delivery: input.delivery,
              })
            }).pipe(Effect.asVoid),
        })
      }
    })

    yield* TeamBoard.maintenance(board)
  }),
})
