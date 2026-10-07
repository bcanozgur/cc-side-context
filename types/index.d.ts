export type Kind = 'used' | 'free' | 'buffer' | 'deferred'

export type Row = { name: string; tokens: number; color: string; kind: Kind }

export type Item = { name: string; tokens: number }

// One square of /context's grid, already turned into its glyph
export type Square = { glyph: string; color: string }

// A row beside the grid: its glyph and share of the window, as /context lists it
export type Legend = { name: string; tokens: number; percent: number; color: string; glyph: string }

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
}

declare module 'claude-code' {
  interface PluginState {
    'cc-side-context': {
      snapshot: Snapshot | null
      delta: number
      last: number | null
      expanded: boolean
      help: boolean
      storage: boolean
    }
  }
}
