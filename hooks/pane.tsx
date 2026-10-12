import type { Color, EngineInterface, RenderChildren } from 'claude-code'

import type { Guard, Item, Live, Picker, Row, Snapshot } from '../types'
import { agoOf, eaterLabel, fitWidth, fmt, guardOf, isGuarded, limitName, padWidth, sparkline, tipOf, widthOf } from './analysis'

// Drawing the pane: everything here is read from the figures handed in, and
// every press goes back through `actions`

export const TITLE = 'Context'
const LIST_SIZE = 8

// What each /context row is called, the size past which it is unusually
// large, and what to do about it. Matched on the row's name with "(deferred)" stripped.
type Rule = { test: RegExp; label: string; limit?: number; fix?: string }
const RULES: Rule[] = [
  { test: /^system prompt/i, label: 'System prompt', limit: 8_000, fix: 'Long output style or --append-system-prompt' },
  { test: /^system tools/i, label: 'Built-in tools', limit: 40_000, fix: 'Many tool schemas loaded up front' },
  { test: /^mcp tools/i, label: 'MCP tools', limit: 10_000, fix: 'Disable unused servers in /mcp' },
  { test: /^mcp server instructions/i, label: 'MCP instructions', limit: 3_000, fix: 'An MCP server sends long instructions' },
  { test: /^custom agents/i, label: 'Subagents', limit: 3_000, fix: 'Shorten agent descriptions' },
  { test: /^memory files/i, label: 'Memory (CLAUDE.md, rules)', limit: 8_000, fix: 'Trim large CLAUDE.md / rules files' },
  { test: /^skills/i, label: 'Skills', limit: 8_000, fix: 'Disable unused plugins in /plugin' },
  { test: /^slash commands/i, label: 'Slash commands', limit: 3_000 },
  { test: /^messages/i, label: 'Conversation', fix: 'Press c to compact, or w to hand off and /clear' },
  { test: /^autocompact buffer/i, label: 'Compact reserve' },
  { test: /^free space/i, label: 'Free' },
]
const ITEM_LIMIT = { memory: 3_000, mcp: 1_500, skills: 800 } as const

const ruleOf = (name: string): Rule | undefined => RULES.find(r => r.test.test(name.replace(/\s*\(deferred\)\s*$/i, '')))
const labelOf = (name: string) => ruleOf(name)?.label ?? name.replace(/\s*\(deferred\)\s*$/i, '')

// Where the pane starts to worry: auto-compact, or sooner the quality budget,
// past which long conversations tend to lose track of early details
export const budgetOf = (snap: Pick<Snapshot, 'compactAt' | 'window'>, quality: number): number => {
  const compact = snap.compactAt ?? snap.window
  return quality > 0 ? Math.min(compact, quality) : compact
}

// Conversation is "too big" once it holds over half of the budget
const isHeavy = (r: Row, snap: Snapshot, quality: number): boolean => {
  if (r.kind !== 'used') return false
  if (/^messages/i.test(r.name)) return r.tokens > budgetOf(snap, quality) * 0.5
  const limit = ruleOf(r.name)?.limit
  return limit !== undefined && r.tokens > limit
}

// /context's glyphs: a full square, a partly full one (under 0.7), free, reserve
const GLYPH = { full: '⛁', partial: '⛀', free: '⛶', buffer: '⛝' } as const
export const glyphOf = (kind: Row['kind'] | undefined, fullness = 1): string =>
  kind === 'free' ? GLYPH.free : kind === 'buffer' ? GLYPH.buffer : fullness < 0.7 ? GLYPH.partial : GLYPH.full

export const top = (items: Item[]): Item[] => [...items].sort((a, b) => b.tokens - a.tokens).slice(0, LIST_SIZE)

// The eaters at the size the last exact count suggests
export const scaled = (live: Pick<Live, 'eaters' | 'scale'>) => live.eaters.map(e => ({ ...e, tokens: Math.round(e.tokens * live.scale) }))

// The biggest eater that can be guarded and is not yet
export const nextGuard = (eaten: readonly Parameters<typeof guardOf>[0][], gs: readonly Guard[]): Guard | undefined =>
  eaten.map(guardOf).find(g => g !== undefined && !isGuarded(gs, g))

export type PaneData = {
  live: Live
  expanded: boolean
  storage: boolean
  compacting: boolean
  guards: Guard[]
  picker: Picker
  now: number
  columns: number
  // The rows a docked pane has, so the actions can sit at its foot
  rows?: number
  quality: number
  // How long the prompt cache lives, in ms
  ttl: number
}

export type PaneActions = {
  compact: () => void
  handoff: () => void
  guard: () => void
  toggleExpanded: () => void
  toggleStorage: () => void
  exact: () => void
  // Opens the resume list, or closes it
  resume: () => void
  pick: (id: string) => void
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

export const drawPane = ({ Box, Text, Button }: Ui, d: PaneData, actions: PaneActions) => {
  // The pane's full body, so dragging the divider either way moves the right
  // edge with it. Each group is a framed card; too narrow for a frame and its
  // padding, the groups just stack. `width` is what a card holds inside.
  const outer = Math.max(1, d.columns)
  const isFramed = outer >= 20
  const width = isFramed ? outer - 4 : outer
  const snap = d.live.snapshot
  const isStorage = d.storage

  if (!snap) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold>{TITLE}</Text>
        <Text dimColor>Measuring…</Text>
      </Box>
    )
  }

  // An estimate counts some rows well above what /context finds (tool schemas
  // most), so only the exact count may say a row is too large; an estimate
  // can only raise the question
  const isExact = snap.detail === 'full'
  const flagGlyph = isExact ? '*' : '?'
  const flagColor = isExact ? 'error' : 'warning'

  // Lines truncate rather than wrap, so resizing keeps the pane's height;
  // only advice wraps, as cutting it loses the point.
  // Each row is label then number, the number flush with the pane's right
  // edge; a flag sits just before the number and colours it.
  const line = (props: { label: string; value?: string; flag?: boolean; mark?: string; markColor?: string; dim?: boolean }) => {
    const mark = props.mark ?? '  '
    const value = `${props.flag ? `${flagGlyph} ` : ''}${props.value ?? ''}`
    const fit = Math.max(1, width - widthOf(mark) - widthOf(value) - 1)
    return (
      <Box width={width}>
        <Text color={props.markColor}>{mark}</Text>
        <Text dimColor={props.dim}>{padWidth(fitWidth(props.label, fit), fit + 1)}</Text>
        <Text color={props.flag ? flagColor : undefined} dimColor={props.dim && !props.flag} bold={props.flag}>
          {value}
        </Text>
      </Box>
    )
  }
  // Advice under a row: the arrow hangs, the text wraps beside it
  const advice = (text: string) => (
    <Box width={width} paddingLeft={2}>
      <Text dimColor>{'↳ '}</Text>
      <Box width={Math.max(1, width - 4)}>
        <Text dimColor wrap="wrap">
          {text}
        </Text>
      </Box>
    </Box>
  )
  const hint = (text: string) => (
    <Box width={width} paddingLeft={2}>
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )

  // Pressure is measured against the budget, not the raw window
  const budget = budgetOf(snap, d.quality)
  const isQualityFirst = budget < (snap.compactAt ?? snap.window)
  const pressure = budget > 0 ? snap.tokens / budget : 0
  const status = d.compacting
    ? { color: 'claude', text: '◌ Compacting' }
    : pressure >= 0.8
      ? { color: 'error', text: isQualityFirst ? '● Time to compact' : '● Near compact' }
      : pressure >= 0.5
        ? { color: 'warning', text: '● Filling' }
        : { color: 'success', text: '● Healthy' }

  const inWindow = snap.rows.filter(r => r.kind !== 'deferred')
  const deferred = snap.rows.filter(r => r.kind === 'deferred')
  const flagged = inWindow.filter(r => isHeavy(r, snap, d.quality))
  const total = inWindow.reduce((sum, r) => sum + r.tokens, 0) || snap.window

  // One bar, each category a run of cells in /context's own colours
  let used = 0
  const segments = inWindow.map(r => {
    const cells = Math.round(((used + r.tokens) / total) * width) - Math.round((used / total) * width)
    used += r.tokens
    return { ...r, cells }
  })

  // How far it may still grow, and where the trend has been
  const trend = d.live.history
  const room =
    snap.compactAt === undefined
      ? 'auto-compact off'
      : isQualityFirst
        ? `${fmt(Math.max(0, budget - snap.tokens))} to quality limit`
        : `${fmt(Math.max(0, snap.compactAt - snap.tokens))} to auto-compact`
  const spark = trend.length >= 1 ? `${sparkline(trend, Math.max(budget, ...trend), Math.max(6, width - room.length - 2))}  ` : ''

  // Every message sends the whole conversation again: cheap while the prompt
  // cache holds it, paid in full once it lapses
  const replied = d.live.lastReply
  const left = replied === null ? 0 : replied + d.ttl - d.now
  const isCold = replied !== null && left <= 0
  const meter = [
    ...(replied === null ? [] : [isCold ? 'cache cold' : `cache ${Math.max(1, Math.ceil(left / 60_000))}m`]),
    ...snap.limits.map(l => `${limitName(l.kind)} ${Math.round(l.percent)}%`),
    ...(snap.cost !== undefined && snap.cost >= 0.01 ? [`$${snap.cost.toFixed(2)}`] : []),
  ]

  // A group of the pane: a rounded frame with its title set in the top edge
  const card = (title: string, children: RenderChildren, color?: Color) =>
    isFramed ? (
      <Box flexDirection="column" width={outer} borderStyle="round" borderColor={color ?? 'subtle'} paddingX={1} flexShrink={0}>
        <Box position="absolute" top={-1} left={0}>
          <Text bold color={color}>{fitWidth(` ${title} `, width)}</Text>
        </Box>
        {children}
      </Box>
    ) : (
      <Box flexDirection="column" width={outer} marginTop={1} flexShrink={0}>
        <Text bold color={color} wrap="truncate-end">
          {title}
        </Text>
        {children}
      </Box>
    )

  const list = (title: string, items: Item[], limit: number) =>
    card(
      title,
      items.length === 0 ? hint('none') : items.map(i => line({ label: i.name, value: fmt(i.tokens), flag: i.tokens > limit, dim: true })),
    )

  // /context's grid and the rows beside it, stacked: the pane is too narrow
  // to hold them side by side
  const storageView = () => {
    const cols = snap.grid[0]?.length ?? 0
    const gap = width >= cols * 2 ? ' ' : ''
    return card(
      'Context Usage',
      <Box flexDirection="column">
        <Box width={width}>
          <Text dimColor wrap="truncate-end">
            {`${snap.model ? `${snap.model} · ` : ''}${fmt(snap.counted)}/${fmt(snap.measuredAgainst)} tokens (${Math.round((snap.counted / (snap.measuredAgainst || 1)) * 100)}%)`}
          </Text>
        </Box>
        {snap.grid.length === 0 ? (
          hint('No grid yet')
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {snap.grid.map(row => (
              <Box width={width}>
                <Text wrap="truncate-end">
                  {row.map(sq => (
                    <Text color={sq.color}>{`${sq.glyph}${gap}`}</Text>
                  ))}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Estimated usage by category</Text>
          {snap.legend.map(l => (
            <Box width={width}>
              <Text wrap="truncate-end">
                <Text color={l.color}>{`${l.glyph} `}</Text>
                <Text>{`${l.name}: `}</Text>
                <Text dimColor>{`${fmt(l.tokens)}${/^free/i.test(l.name) ? '' : ' tokens'} (${l.percent.toFixed(1)}%)`}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      </Box>,
    )
  }

  // Past sessions to resume, offered only before the first message
  const canResume = d.live.fresh === true
  const picker = canResume ? d.picker : ({ state: 'closed' } as Picker)
  const resumeView = () =>
    card(
      'Resume a session',
      <Box flexDirection="column">
        {picker.state === 'loading' && hint('Reading past sessions…')}
        {picker.state === 'open' && picker.sessions.length === 0 && hint('No past sessions in this project')}
        {picker.state === 'open' &&
          picker.sessions.map((r, i) => {
            const when = agoOf(d.now - r.at)
            const room = Math.max(1, width - widthOf(when) - 9)
            return (
              <Box width={width}>
                <Button key={`resume-${i + 1}`} hotkey={String(i + 1)} label={`${i + 1} ${fitWidth(r.title, room)}`} onPress={() => actions.pick(r.id)} />
                <Text dimColor>{` ${when}`}</Text>
              </Box>
            )
          })}
        {picker.state === 'open' && picker.sessions.length > 0 && hint('Press a number to continue that session')}
      </Box>,
      'claude',
    )

  const eaten = scaled(d.live)
  const inUse = inWindow.filter(r => r.kind === 'used')
  const canGuard = !isStorage && nextGuard(eaten, d.guards) !== undefined
  const time = new Date(snap.at).toTimeString().slice(0, 5)
  const footer = isExact ? `Exact count · ${time}` : flagged.length > 0 ? `Estimate · ? may be large, r to check · ${time}` : `Estimate · ${time}`
  const change = d.live.delta
  const percent = Math.round((snap.tokens / (snap.window || 1)) * 100)

  // The bar, two rows tall so it reads at a glance
  const bar = (
    <Text>
      {segments.map(s =>
        s.cells > 0 ? (
          <Text color={s.kind === 'free' ? 'subtle' : s.color}>{(s.kind === 'free' ? '░' : s.kind === 'buffer' ? '▒' : '█').repeat(s.cells)}</Text>
        ) : null,
      )}
    </Text>
  )

  const summary = card(
    TITLE,
    <Box flexDirection="column">
      <Box width={width} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text bold color={status.color} wrap="truncate-end">
            {status.text}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={change > 0 ? 'warning' : 'success'}>{change === 0 ? '' : ` ${change > 0 ? '+' : '−'}${fmt(Math.abs(change))}`}</Text>
        </Box>
      </Box>
      <Box width={width} justifyContent="space-between" marginTop={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold>{fmt(snap.tokens)}</Text>
            <Text dimColor>{` / ${fmt(snap.window)}`}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={status.color}>{` ${percent}%`}</Text>
        </Box>
      </Box>
      {!isStorage && (
        <Box flexDirection="column">
          {bar}
          {bar}
        </Box>
      )}
      <Box width={width} marginTop={1}>
        <Text wrap="truncate-end">
          <Text color="claude">{spark}</Text>
          <Text dimColor>{room}</Text>
        </Text>
      </Box>
      {meter.length > 0 && (
        <Box width={width}>
          <Text wrap="truncate-end">
            {meter.map((m, i) => (
              <Text color={m === 'cache cold' ? 'warning' : undefined} dimColor={m !== 'cache cold'}>
                {`${i > 0 ? ' · ' : ''}${m}`}
              </Text>
            ))}
          </Text>
        </Box>
      )}
    </Box>,
    status.color,
  )

  // What is in the window; free space and the reserve are the bar's pale end
  const breakdown = card(
    'In context',
    inUse.map(r => {
      const heavy = isHeavy(r, snap, d.quality)
      return (
        <Box flexDirection="column">
          {line({ mark: '■ ', markColor: r.color, label: labelOf(r.name), value: fmt(r.tokens), flag: heavy })}
          {heavy && advice(ruleOf(r.name)?.fix ?? 'Bigger than usual')}
        </Box>
      )
    }),
  )

  const eaters = card(
    'Top context eaters',
    <Box flexDirection="column">
      {eaten.map(t => {
        const g = guardOf(t)
        return line({
          mark: g !== undefined && isGuarded(d.guards, g) ? '⊘ ' : '  ',
          markColor: 'success',
          label: eaterLabel(t),
          value: `~${fmt(t.tokens)}`,
          dim: true,
        })
      })}
      {eaten[0] && advice(tipOf(eaten[0].tool))}
    </Box>,
  )

  const controls = card(
    'Actions',
    <Box flexDirection="column">
      <Box width={width} gap={1} flexWrap="wrap">
        <Button key="compact" hotkey="c" label={`${d.compacting ? 'compacting…' : 'compact'} [c]`} onPress={actions.compact} />
        <Button key="handoff" hotkey="w" label="handoff [w]" onPress={actions.handoff} />
        {canGuard && <Button key="guard" hotkey="x" label="guard [x]" onPress={actions.guard} />}
        <Button key="details" hotkey="e" label={`${d.expanded ? 'less' : 'more'} [e]`} onPress={actions.toggleExpanded} />
        {/* The finer tools wait behind "more", so the everyday row stays short */}
        {(d.expanded || isStorage) && <Button key="storage" hotkey="s" label={`${isStorage ? 'list' : 'grid'} [s]`} onPress={actions.toggleStorage} />}
        {(d.expanded || flagged.length > 0) && <Button key="exact" hotkey="r" label="exact [r]" onPress={actions.exact} />}
        {canResume && <Button key="resume" hotkey="p" label={`${picker.state === 'closed' ? 'resume' : 'close'} [p]`} onPress={actions.resume} />}
      </Box>
      <Box width={width}>
        <Text dimColor wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>,
  )

  // Docked, the pane is at least as tall as its room and the actions sit at
  // its foot; a taller tree scrolls and they come last
  return (
    <Box flexDirection="column" width={outer} minHeight={d.rows}>
      {summary}
      {!isStorage && inUse.length > 0 && breakdown}
      {isStorage && storageView()}
      {picker.state !== 'closed' && resumeView()}
      {!isStorage && eaten.length > 0 && eaters}
      {!isStorage &&
        d.expanded &&
        deferred.length > 0 &&
        card(
          'Loaded on demand',
          deferred.map(r => line({ label: labelOf(r.name), value: fmt(r.tokens), dim: true })),
        )}
      {!isStorage && d.expanded && list('Memory files', snap.memory, ITEM_LIMIT.memory)}
      {!isStorage && d.expanded && list('Loaded MCP tools', snap.mcp, ITEM_LIMIT.mcp)}
      {!isStorage && d.expanded && list('Largest skills', snap.skills, ITEM_LIMIT.skills)}
      <Box flexGrow={1} />
      {controls}
    </Box>
  )
}
