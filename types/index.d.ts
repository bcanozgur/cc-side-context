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
// `at` when it was set, `lastHit` when it last sent a call back, `hits` how
// often: a guard idle for 30 days is dropped
export type Guard = { tool: 'Read' | 'Bash'; key: string; label: string; tokens: number; at?: number; lastHit?: number; hits?: number }

// What compactions took out of the transcript: the person's first request,
// and the openings of the summaries they wrote (which read as user messages)
export type Memo = { goal?: string; summaries: string[] }

// Running figures for /side-context stats, counted from launch: the
// transcript keeps no sizes or cache times
export type Stats = { peak: number; compactions: number; colds: number }

// Everything measured about the conversation, in one value so a reading
// lands (and redraws the pane) at once. /clear and /resume start it over.
export type Live = {
  snapshot: Snapshot | null
  delta: number
  last: number | null
  // Context after each turn, oldest first
  history: number[]
  eaters: Eater[]
  // When the main thread's last response came back, for the prompt cache
  lastReply: number | null
  warned: { cold: boolean; quality: boolean }
  stats: Stats
  // Exact tokens over estimated ones, from the last exact count: scales the eaters
  scale: number
  // When the last exact count was taken
  exactAt: number | null
  memo: Memo
  // Whether nobody has typed anything in this conversation yet; null until
  // the transcript has been read. Only a fresh conversation offers a resume.
  fresh: boolean | null
}

// A past session of this project, as the resume list shows it
export type Recent = { id: string; title: string; at: number }

// The resume list: closed, being read, or showing what it found
export type Picker = { state: 'closed' } | { state: 'loading' } | { state: 'open'; sessions: Recent[] }

declare module 'claude-code' {
  interface PluginState {
    'cc-side-context': {
      live: Live
      expanded: boolean
      storage: boolean
      tick: number
      // A compaction the pane started and has not heard back from yet
      compacting: boolean
      // This project's guards, mirrored from the store so the pane redraws
      guards: Guard[]
      picker: Picker
    }
  }
}
