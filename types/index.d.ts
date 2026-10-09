/** Where a subagent's loop stands, folded from the engine's AgentStatus. */
export type AgentPhase = 'running' | 'waiting' | 'completed' | 'failed' | 'killed'

/** One entry of a subagent's activity timeline. */
export type AgentStep = {
  /** `tool` a tool call, `say` the agent's own narration, `you` a message the person sent it. */
  kind: 'tool' | 'say' | 'you'
  /** The tool call's id, so its outcome lands on its own entry. */
  id?: string
  /** For a tool call, its tool's name. */
  tool?: string
  text: string
  /** Milliseconds since the agent started. */
  at: number
  /** For a tool call: still running, done, or failed. */
  state?: 'running' | 'done' | 'error'
}

export type AgentRow = {
  id: string
  description: string
  type: string
  model?: string
  prompt: string
  phase: AgentPhase
  startedAt: number
  endedAt?: number
  /** The one-line summary of what it is doing now. */
  current: string
  toolCount: number
  steps: AgentStep[]
  /** Its final report, once it has one. */
  answer?: string
  /** Rebuilt from the transcript after a resume; `startedAt` is 0 when its times were not kept. */
  restored?: boolean
  /** How long it ran, when only the Agent call's record says so (a resume without kept times). */
  durationMs?: number
  /** Why its steps are not shown: the engine's own reason, when it would not read the agent's transcript. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'subagents-panel': {
      agents: AgentRow[]
      selected: string | null
      showActive: boolean
      showDone: boolean
      /** Keys of the tool groups and task blocks the person expanded or collapsed. */
      toggled: string[]
      autoOpened: boolean
      tick: number
      /** The overview's search text; empty shows every agent. */
      query: string
      /** The pane element holding the focus ring, from `ui.focus`; null when none of ours does. */
      focusedKey: string | null
      /** The person closed the band above the prompt; `/subagents` brings it back. */
      bandHidden: boolean
    }
  }
}
