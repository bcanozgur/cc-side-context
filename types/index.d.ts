export type Kind = 'used' | 'free' | 'buffer' | 'deferred'

export type Row = { name: string; tokens: number; color: string; kind: Kind }

export type Item = { name: string; tokens: number }

// One square of /context's grid, already turned into its glyph
export type Square = { glyph: string; color: string }

// A row beside the grid: its glyph and share of the window, as /context lists it
export type Legend = { name: string; tokens: number; percent: number; color: string; glyph: string }

// A rate-limit window as the last response reported it
export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Snapshot = {
  at: number
  detail: 'summary' | 'full'
  tokens: number
  window: number
  percent: number
  compactAt?: number
  rows: Row[]
  memory: Item[]
  mcp: Item[]
  skills: Item[]
  model: string
  grid: Square[][]
  legend: Legend[]
  // What the breakdown itself counts, which need not equal `tokens`
  counted: number
  measuredAgainst: number
  limits: Limit[]
  cost?: number
}

// Tool results still in the conversation, sized from their text: one call, or
// the same call repeated (`count` times), such as one file read again
export type Eater = { tool: string; target: string; tokens: number; count: number; raw?: string }

// A call the model is asked to narrow next time: a Read of `key` without a
// range, or the Bash command `key` without its output trimmed
export type Guard = { tool: 'Read' | 'Bash'; key: string; label: string; tokens: number }

// Running figures for /side-context stats
export type Stats = { turns: number; peak: number; compactions: number; colds: number }

declare module 'claude-code' {
  interface PluginState {
    'cc-side-context': {
      snapshot: Snapshot | null
      delta: number
      last: number | null
      expanded: boolean
      storage: boolean
      // Context after each turn, oldest first
      history: number[]
      eaters: Eater[]
      // When the main thread's last response came back, for the prompt cache
      lastReply: number | null
      tick: number
      warned: { cold: boolean; quality: boolean }
      // A compaction the pane started and has not heard back from yet
      compacting: boolean
      // This project's guards, mirrored from the store so the pane redraws
      guards: Guard[]
      stats: Stats
    }
  }
}
