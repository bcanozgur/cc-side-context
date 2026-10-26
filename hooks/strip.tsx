import type { Snapshot } from '../types'
import { fmt } from './analysis'
import { type Ui, barOf, budgetOf, statusOf } from './pane'
import { steadyMeter } from './pane-web'

// The strip above the prompt: one row with the verdict, the fill and the room
// left, so the context can be watched without the pane taking a column. The
// pane stays one press away for the breakdown.

export type StripData = {
  snapshot: Snapshot | null
  // Tokens the latest turn added, a lighter stretch on the meter
  delta: number
  compacting: boolean
  // Whether the pane is open, so the button can close it again
  paneOpen: boolean
  quality: number
  columns: number
  surface: string
  // Whether a turn of the main thread is running, so the meter holds still
  isRunning: boolean
  now: number
}

export type StripActions = {
  details: () => void
  compact: () => void
}

// The terminal's bar: the pane's, one row tall, a quarter of the row wide
const cellsOf = (columns: number) => Math.max(16, Math.min(40, Math.round(columns / 4)))
// The page's meter: the pane's, the whole window with the limit marked, and
// room above and below the bar for the lens and the readout beside it.
// The lens is broader and stronger than the pane's: the bar is short
const METER = { BH: 10, H: 28 } as const
const LENS = { zoom: 5, tall: 1.8, width: 72 } as const
// Its width in pixels, from the room the strip has
const meterWidth = (columns: number) => Math.max(240, Math.min(520, columns * 4))

export const drawStrip = (ui: Ui, d: StripData, actions: StripActions) => {
  const { Box, Text, Button } = ui
  const Svg = 'Svg' in ui ? ui.Svg : undefined
  const isWeb = d.surface !== 'terminal'
  const snap = d.snapshot
  // The terminal draws a bracketed button in the accent colour; there the
  // strip's buttons are quiet text, so the prompt under it stays the focus
  const details = (
    <Box key="details" flexShrink={0} marginLeft={isWeb ? 1 : 2}>
      {isWeb ? (
        <Button key="details" label={d.paneOpen ? 'Hide details' : 'Details'} variant="secondary" onPress={actions.details} />
      ) : (
        <Button key="details" label={d.paneOpen ? 'hide details' : 'details'} plain dimColor onPress={actions.details} />
      )}
    </Box>
  )

  if (!snap) {
    return (
      <Box width="100%" justifyContent="space-between" alignItems="center">
        <Text dimColor>Measuring context…</Text>
        {details}
      </Box>
    )
  }

  const budget = budgetOf(snap, d.quality)
  const status = statusOf(snap, d.quality, d.compacting)
  const share = Math.round((snap.tokens / Math.max(1, snap.window)) * 100)
  const room = budget - snap.tokens
  const canCompact = status.pressure >= 0.8 && !d.compacting

  const meter = () => {
    if (isWeb) {
      if (!Svg) return undefined
      const W = meterWidth(d.columns)
      return (
        <Box key="meter" flexShrink={0} marginX={1}>
          <Svg
            source={steadyMeter('strip', { snap, delta: d.delta, budget, W, ...METER, lens: LENS }, { isRunning: d.isRunning, now: d.now })}
            alt={`${share}% of the ${fmt(snap.window)} window in use, limit at ${fmt(budget)}`}
            width={W}
            height={METER.H}
            isInteractive
          />
        </Box>
      )
    }
    const inUse = snap.rows.filter(r => r.kind === 'used')
    const setupTokens = inUse.filter(r => !/^messages/i.test(r.name)).reduce((sum, r) => sum + r.tokens, 0)
    const { runs } = barOf(snap, { setupTokens, change: d.delta, budget, cells: cellsOf(d.columns), mark: '┃', markColor: status.color })
    return (
      <Box key="meter" flexShrink={0} marginX={1}>
        <Text wrap="truncate">
          {runs.map(r => (
            <Text color={r.color}>{r.glyph.repeat(r.count)}</Text>
          ))}
        </Text>
      </Box>
    )
  }

  const figures = room >= 0 ? `${fmt(snap.tokens)} of ${fmt(budget)} · ${fmt(room)} left` : `${fmt(-room)} over ${fmt(budget)}`
  // A narrow terminal keeps the verdict and the buttons, and drops the rest first
  const isNarrow = !isWeb && d.columns < 70

  return (
    <Box width="100%" justifyContent="space-between" alignItems="center">
      <Box flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
        <Text color={status.color}>{'● '}</Text>
        <Box flexShrink={isWeb ? 0 : 1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {status.text}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text bold>{`${share}%`}</Text>
        </Box>
        {!isNarrow && meter()}
        {!isNarrow && (
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {figures}
            </Text>
          </Box>
        )}
      </Box>
      <Box flexShrink={0}>
        {canCompact && (
          <Box key="compact" marginLeft={1}>
            {isWeb ? (
              <Button key="compact" label="Compact" variant="primary" onPress={actions.compact} />
            ) : (
              <Button key="compact" label="compact" plain onPress={actions.compact} />
            )}
          </Box>
        )}
        {details}
      </Box>
    </Box>
  )
}
