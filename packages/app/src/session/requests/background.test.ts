import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createSessionBackground } from "./background"

const session = (input: { id: string; parentID?: string; title?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    title: input.title,
  }) as SessionInfo

// The memo only treats an assistant message without a completion time as the current turn, so these
// fixtures stay open and carry exactly one tool part.
const assistant = (input: {
  name: "subagent" | "shell"
  status: "running" | "completed"
  request?: Record<string, string>
  metadata?: Record<string, string>
}): SessionMessageAssistant => ({
  id: "msg_1",
  type: "assistant",
  agent: "build",
  model: { providerID: "provider-1", id: "model-1" },
  time: { created: 0 },
  content: [
    {
      type: "tool",
      id: "msg_1:part",
      name: input.name,
      time: { created: 0 },
      state:
        input.status === "running"
          ? { status: "running", input: input.request ?? {}, metadata: input.metadata ?? {} }
          : {
              status: "completed",
              input: input.request ?? {},
              content: [{ type: "text", text: "" }],
              metadata: input.metadata ?? {},
            },
    },
  ],
})

function background(input: {
  messages: SessionMessageInfo[]
  sessions?: SessionInfo[]
  status: (id: string) => "idle" | "running"
}) {
  return createRoot((dispose) => ({
    background: createSessionBackground({
      sessionID: () => "parent",
      messages: () => input.messages,
      sessions: () => input.sessions ?? [],
      status: input.status,
      shells: () => [],
    }),
    dispose,
  }))
}

describe("session background", () => {
  const staleShell = assistant({
    name: "shell",
    status: "running",
    request: { command: "ls" },
    metadata: { shellID: "sh_1" },
  })
  const expectedShell = [{ type: "shell" as const, partID: "msg_1:part", id: "sh_1", label: "ls" }]

  const blockingCases: ["idle" | "running", typeof expectedShell][] = [
    // A parent the durable status says is idle cannot still be running a tool: the part is stale.
    ["idle", []],
    ["running", expectedShell],
  ]

  test.each(blockingCases)("reports %s blocking from a running tool part", (status, expected) => {
    const { background: value, dispose } = background({ messages: [staleShell], status: () => status })

    expect(value.blocking()).toEqual(expected)
    dispose()
  })

  const completedSubagent = assistant({
    name: "subagent",
    status: "completed",
    request: { description: "review" },
    metadata: { status: "running", sessionID: "child-1" },
  })
  const child = session({ id: "child-1", parentID: "parent", title: "review" })
  const expectedSubagent = [{ id: "child-1", type: "subagent" as const, label: "review" }]

  const subagentCases: ["idle" | "running", typeof expectedSubagent][] = [
    // The exit event for a child can be lost; its durable status is the completion fact.
    ["idle", []],
    ["running", expectedSubagent],
  ]

  test.each(subagentCases)("lists a subagent whose child is %s", (status, expected) => {
    const { background: value, dispose } = background({
      messages: [completedSubagent],
      sessions: [child],
      status: (id) => (id === "parent" ? "running" : status),
    })

    expect(value.tasks()).toEqual(expected)
    dispose()
  })
})
