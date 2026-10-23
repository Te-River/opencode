import type { Data } from "@opencode/client/solid"
import { Schema } from "effect"
import { createEffect, on } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import type { ServerApi } from "@/runtime/server/api"
import { showToast } from "@/shell/notifications/toast"

/**
 * The last phase transition this client saw. The durable goal read model has no phase-change
 * time, so the dock freezes a stopped goal's elapsed time on the server event that carried the
 * phase, and this record keeps that value across a reload of the same goal.
 */
const PhaseChange = Schema.Struct({
  sessionID: Schema.String,
  goalID: Schema.String,
  phase: Schema.String,
  at: Schema.Number,
})

/**
 * The goal indicator's view model. Durable state comes from the client's goal read
 * model; every action is one `session.goal.update` call, and the read model
 * re-reads once it settles so the dock never renders a guess.
 */
export function createSessionGoalModel(input: {
  sessionID: () => string | undefined
  connected: () => boolean
  data: Data
  api: ServerApi
}) {
  const language = useLanguage()
  const [phaseChange, setPhaseChange] = persisted(Persist.global("session-goal-phase"), PhaseChange, {
    sessionID: "",
    goalID: "",
    phase: "",
    at: 0,
  })

  createEffect(
    on([input.sessionID, input.connected], ([sessionID, connected]) => {
      if (!sessionID || !connected) return
      void input.data.session.goal.sync(sessionID).catch(() => undefined)
    }),
  )

  createEffect(() => {
    const sessionID = input.sessionID()
    const change = sessionID ? input.data.session.goal.phaseChange(sessionID) : undefined

    if (!sessionID || !change) return
    setPhaseChange({ sessionID, goalID: change.goalID, phase: change.phase, at: change.at })
  })

  const update = (action: "pause" | "resume" | "clear" | "edit", objective?: string) => {
    const sessionID = input.sessionID()

    if (!sessionID) return
    return input.api.session.goal
      .update({ sessionID, action, objective })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        input.data.session.goal.invalidate(sessionID)
        void input.data.session.goal.sync(sessionID).catch(() => undefined)
      })
  }

  return {
    state: () => {
      const sessionID = input.sessionID()

      return sessionID ? input.data.session.goal.list(sessionID) : undefined
    },
    /**
     * When the goal entered its current phase, as observed by this client. Recorded for the
     * same goal instance only, so a replaced or cleared goal never inherits an older time.
     */
    phaseChangedAt: () => {
      const sessionID = input.sessionID()
      const goal = sessionID ? input.data.session.goal.list(sessionID)?.goal : undefined

      if (!sessionID || !goal) return
      if (phaseChange.sessionID !== sessionID) return
      if (phaseChange.goalID !== goal.id || phaseChange.phase !== goal.phase) return

      return phaseChange.at
    },
    /**
     * The last turn ended because the user interrupted it, so a goal that is still active
     * will silently resume on the next message. Any later turn boundary clears this.
     */
    interrupted: () => {
      const sessionID = input.sessionID()

      if (!sessionID) return false
      const idle = input.data.session.message.list(sessionID).filter((item) => item.type === "idle").at(-1)

      return idle?.type === "idle" && idle.outcome === "interrupted"
    },
    pause: () => update("pause"),
    resume: () => update("resume"),
    edit: (objective: string) => update("edit", objective),
    clear: () => update("clear"),
  }
}

export type SessionGoalModel = ReturnType<typeof createSessionGoalModel>
