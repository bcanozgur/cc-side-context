import type { Color, EngineInterface, RenderChildren } from 'claude-code'

import type { Guard, Item, Live, Picker, Row, Snapshot } from '../types'
import { GUARD_FLOOR, agoOf, eaterLabel, fitWidth, fmt, guardOf, isGuarded, limitName, tipOf, widthOf } from './analysis'

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

// The bar's parts, and the marks of the In context rows they stand for
export const SETUP_COLOR: Color = 'suggestion'
export const CONVERSATION_COLOR: Color = 'claude'
export const TURN_COLOR: Color = 'text'

export const ruleOf = (name: string): Rule | undefined => RULES.find(r => r.test.test(name.replace(/\s*\(deferred\)\s*$/i, '')))
export const labelOf = (name: string) => ruleOf(name)?.label ?? name.replace(/\s*\(deferred\)\s*$/i, '')

// Where the pane starts to worry: auto-compact, or sooner the quality budget,
// past which long conversations tend to lose track of early details
export const budgetOf = (snap: Pick<Snapshot, 'compactAt' | 'window'>, quality: number): number => {
  const compact = snap.compactAt ?? snap.window
  return quality > 0 ? Math.min(compact, quality) : compact
}

// The verdict the page's pane and the strip both lead with
export const statusOf = (snap: Snapshot, quality: number, compacting: boolean): { color: Color; text: string; pressure: number } => {
  const budget = budgetOf(snap, quality)
  const isQualityFirst = budget < (snap.compactAt ?? snap.window)
  const pressure = budget > 0 ? snap.tokens / budget : 0
  if (compacting) return { color: 'claude', text: 'Compacting', pressure }
  if (pressure >= 1) return { color: 'error', text: 'Over the limit', pressure }
  if (pressure >= 0.8) return { color: 'error', text: isQualityFirst ? 'Time to compact' : 'Near auto-compact', pressure }
  if (pressure >= 0.5) return { color: 'warning', text: 'Filling up', pressure }
  return { color: 'success', text: 'Healthy', pressure }
}

// Conversation is "too big" once it holds over half of the budget
export const isHeavy = (r: Row, snap: Snapshot, quality: number): boolean => {
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

// The eaters worth a row: a hundredth of the budget, and never under what a
// guard takes, so x only ever guards a row in the list
export const shownEaters = (live: Pick<Live, 'eaters' | 'scale' | 'snapshot'>, quality: number) => {
  const floor = live.snapshot ? Math.max(GUARD_FLOOR, budgetOf(live.snapshot, quality) * 0.01) : GUARD_FLOOR
  return scaled(live).filter(e => e.tokens >= floor)
}

// The biggest eater that can be guarded and is not yet
export const nextGuard = (eaten: readonly Parameters<typeof guardOf>[0][], gs: readonly Guard[]): Guard | undefined =>
  eaten.map(guardOf).find(g => g !== undefined && !isGuarded(gs, g))

// The terminal's bar, cut into runs of one glyph and colour: what was loaded
// at the start, the conversation, and the latest turn at its growing end,
// then the track to the budget's mark and the pale window past it. The pane
// and the strip above the prompt draw the same one; `parts` is its key
export type BarRun = { glyph: string; color: Color; count: number }

export const barOf = (
  snap: Snapshot,
  o: { setupTokens: number; change: number; budget: number; cells: number; mark: string; markColor: Color; glyph?: string; pale?: string },
): { runs: BarRun[]; parts: { name: string; color: Color; cells: number }[] } => {
  const { setupTokens, change, budget, cells, mark } = o
  const glyph = o.glyph ?? '█'
  const pale = o.pale ?? '░'
  const span = Math.max(snap.window, snap.tokens, 1)
  const cellsOf = (tokens: number) => Math.round((tokens / span) * cells)
  const setupPart = Math.min(setupTokens, snap.tokens)
  const turnPart = Math.max(0, Math.min(change, snap.tokens - setupPart))
  const conversationPart = snap.tokens - setupPart - turnPart
  // Each part ends where its running sum rounds to, so rounding leaves no
  // stray cell between them; one of 1k or more gets a cell even when too
  // small for one, so every part the key names can be seen
  const endOf = (tokens: number, sum: number, from: number) => Math.min(cells, Math.max(tokens >= 1_000 ? from + 1 : from, cellsOf(sum)))
  const setupEnd = endOf(setupPart, setupPart, 0)
  const turnStart = endOf(conversationPart, setupPart + conversationPart, setupEnd)
  const filled = endOf(turnPart, snap.tokens, turnStart)
  const parts = [
    { name: 'setup', color: SETUP_COLOR, cells: setupEnd },
    { name: 'conversation', color: CONVERSATION_COLOR, cells: turnStart - setupEnd },
    { name: 'turn', color: TURN_COLOR, cells: filled - turnStart },
  ].filter(p => p.cells > 0)
  // The mark has a cell of its own, never the first or the last, laid over
  // the fill once the context is past it
  const hasMark = budget < snap.window
  const markAt = hasMark ? Math.min(cells - 1, Math.max(1, cellsOf(budget))) : undefined
  const runs: BarRun[] = []
  for (let i = 0; i < cells; i++) {
    const [g, color]: [string, Color] =
      i === markAt
        ? [mark, o.markColor]
        : i < filled
          ? [glyph, i < setupEnd ? SETUP_COLOR : i < turnStart ? CONVERSATION_COLOR : TURN_COLOR]
          : markAt === undefined || i < markAt
            ? [glyph, 'subtle']
            : [pale, 'subtle']
    const last = runs[runs.length - 1]
    if (last && last.glyph === g && last.color === color) last.count++
    else runs.push({ glyph: g, color, count: 1 })
  }
  return { runs, parts }
}

export type PaneData = {
  live: Live
  expanded: boolean
  storage: boolean
  compacting: boolean
  guards: Guard[]
  picker: Picker
  now: number
  columns: number
  // Drawn in the desktop app, whose proportional font runs glyphs wider than a cell
  desktop?: boolean
  // The surface drawing it: every one but the terminal lays the tree out as
  // HTML, and gets the page's own layout (pane-web.tsx)
  surface?: string
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

export type Ui = ReturnType<EngineInterface['ui']['resolve']>

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
    // The gap is laid out by flex, not padded with spaces, so the number stays
    // flush right in a proportional font too
    return (
      <Box width={width} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text color={props.markColor}>{mark}</Text>
          <Text dimColor={props.dim} wrap="truncate-end">
            {props.label}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={props.flag ? flagColor : undefined} dimColor={props.dim && !props.flag} bold={props.flag}>
            {value}
          </Text>
        </Box>
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

  // Pressure is measured against the budget, not the raw window; the bar is
  // the whole window, with the budget a mark on it
  const budget = budgetOf(snap, d.quality)
  const isQualityFirst = budget < (snap.compactAt ?? snap.window)
  const hasMark = budget < snap.window
  const markLabel = isQualityFirst ? 'quality limit' : 'auto-compact'
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
  const inUse = inWindow.filter(r => r.kind === 'used')
  const conversation = inUse.find(r => /^messages/i.test(r.name))
  const setup = inUse.filter(r => r !== conversation).sort((a, b) => b.tokens - a.tokens)
  const setupTokens = setup.reduce((sum, r) => sum + r.tokens, 0)
  const change = d.live.delta

  // One bar as long as the window, so its end reads as the window's end, split
  // by what can be done about each part: what was loaded at the start (trimmed
  // in settings), the conversation (c and w act on it), and what the latest
  // turn added, at its growing end. Ten categories in /context's colours would
  // be a cell or less each on a large window; the In context card lists them,
  // its marks in these colours. The budget is a mark on the bar: the room
  // before it is a track, the window past it pale.
  // A run of solid cells, the parts told apart by colour alone: a half block
  // left a gap in every cell, and the bar read as stripes. The desktop app
  // sets its glyphs in a proportional font, █ about 1.6 cells wide and ░ about
  // 1.16, so there the bar gets as many as fit, and the mark is a square of
  // its own.
  const glyph = '█'
  const pale = '░'
  const mark = d.desktop ? '█' : '┃'
  const cells = d.desktop ? Math.max(1, Math.floor((width * 0.95) / 1.6)) : width
  const { runs, parts } = barOf(snap, { setupTokens, change, budget, cells, mark, markColor: status.color as Color })
  const room = budget - snap.tokens

  // Every message sends the whole conversation again: cheap while the prompt
  // cache holds it, paid in full once it lapses
  const replied = d.live.lastReply
  const left = replied === null ? 0 : replied + d.ttl - d.now
  const isCold = replied !== null && left <= 0
  const meter = [
    ...(replied === null ? [] : [isCold ? 'cache cold' : `cache ${Math.max(1, Math.ceil(left / 60_000))}m`]),
    ...snap.limits.map(l => `${limitName(l.kind)} ${Math.round(l.percent)}%`),
    ...(snap.cost !== undefined && snap.cost >= 0.01 ? [`$${snap.cost.toFixed(2)}`] : []),
    ...(snap.compactAt === undefined ? ['auto-compact off'] : []),
  ]

  // A group of the pane: a rounded frame with its title as the first row. The
  // title is a row of its own, not set in the top edge: a renderer that draws
  // the frame's edge thinner than a text row would lay it over the card above.
  // A card's title, with a figure flush right when it has one
  const heading = (title: string, color?: Color, aside?: string) =>
    aside ? (
      <Box width={width} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text bold color={color} wrap="truncate-end">
            {title}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text dimColor>{aside}</Text>
        </Box>
      </Box>
    ) : (
      <Text bold color={color} wrap="truncate-end">
        {title}
      </Text>
    )
  const card = (title: string, children: RenderChildren, color?: Color, aside?: string) =>
    isFramed ? (
      // Apart in the desktop app, where the frames' thin edges would otherwise
      // touch; in a terminal the edges already keep the cards apart. The gap
      // goes above each card but the first, so none is left under the last.
      <Box flexDirection="column" width={outer} borderStyle="round" borderColor={color ?? 'subtle'} paddingX={1} flexShrink={0} marginTop={d.desktop && title !== TITLE ? 1 : 0}>
        {heading(title, color, aside)}
        {children}
      </Box>
    ) : (
      <Box flexDirection="column" width={outer} marginTop={1} flexShrink={0}>
        {heading(title, color, aside)}
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

  const all = scaled(d.live)
  const eaten = shownEaters(d.live, d.quality)
  // What x would guard, marked on its row so the press has a visible target
  const guardTarget = isStorage ? undefined : nextGuard(eaten, d.guards)
  const canGuard = guardTarget !== undefined
  const time = new Date(snap.at).toTimeString().slice(0, 5)
  const footer = `${isExact ? 'Exact count' : 'Estimate'} · ${time}`
  // Of the window, as Claude Code's own status line counts it
  const percent = Math.round((snap.tokens / (snap.window || 1)) * 100)
  // What is left before the mark, or how far past it; the window's room when
  // there is no mark
  const roomText = (before: number) =>
    before >= 0 ? <Text dimColor>{`${fmt(before)} left`}</Text> : <Text bold color="error">{`${fmt(-before)} over`}</Text>

  // The bar, two rows tall so it reads at a glance; one in the desktop app,
  // where rows sit apart and two copies would read as two bars. There the
  // pale run gets as many ░ as fill the room its cells stand for.
  const bar = (
    <Text wrap="truncate">
      {runs.map(r => (
        <Text color={r.color}>{r.glyph.repeat(d.desktop && r.glyph === pale ? Math.floor((r.count * 1.6) / 1.16) : r.count)}</Text>
      ))}
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
          {/* What the latest turn added, in the colour of the bar's end it is */}
          <Text color={change > 0 ? TURN_COLOR : 'success'}>{change === 0 ? '' : ` ${change > 0 ? '+' : '−'}${fmt(Math.abs(change))}`}</Text>
        </Box>
      </Box>
      <Box width={width} justifyContent="space-between" marginTop={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold>{fmt(snap.tokens)}</Text>
            <Text dimColor>{` / ${fmt(snap.window)} window`}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold>{` ${percent}%`}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        {bar}
        {!d.desktop && bar}
      </Box>
      {/* The bar's key; with no mark, the window's room beside it */}
      <Box width={width} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {parts.map((p, i) => (
              <Text>
                <Text color={p.color}>{`${i > 0 ? '  ' : ''}■ `}</Text>
                <Text dimColor>{p.name}</Text>
              </Text>
            ))}
          </Text>
        </Box>
        {!hasMark && (
          <Box flexShrink={0} paddingLeft={1}>
            {roomText(room)}
          </Box>
        )}
      </Box>
      {/* The mark, in the status colour: where the pane warns, and the room before it */}
      {hasMark && (
        <Box width={width} justifyContent="space-between">
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={status.color}>{`${d.desktop ? '■' : mark} `}</Text>
              <Text dimColor>{`${markLabel} ${fmt(budget)}`}</Text>
            </Text>
          </Box>
          <Box flexShrink={0} paddingLeft={1}>
            {roomText(room)}
          </Box>
        </Box>
      )}
      {/* Set apart from the bar and its key: these are the session's, not the window's */}
      {meter.length > 0 && (
        <Box width={width} marginTop={1}>
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

  // What is in the window, as the bar splits it and in its colours: the
  // conversation first, as the part that grows and the one c and w act on;
  // then what was loaded at the start under its sum, each part beneath it,
  // biggest first. Every size in thousands, 407 as 0.4k, so the column lines
  // up on the point
  const kilo = (n: number) => (n > 0 && n < 1000 ? `${Math.max(0.1, n / 1000).toFixed(1)}k` : fmt(n))
  const row = (r: Row, isPart: boolean) => {
    const heavy = isHeavy(r, snap, d.quality)
    return (
      <Box flexDirection="column">
        {line({
          mark: isPart ? '    ' : '■ ',
          markColor: CONVERSATION_COLOR,
          label: labelOf(r.name),
          value: kilo(r.tokens),
          flag: heavy,
          dim: isPart,
        })}
        {heavy && advice(ruleOf(r.name)?.fix ?? 'Bigger than usual')}
      </Box>
    )
  }
  const breakdown = card(
    'In context',
    <Box flexDirection="column">
      {conversation && row(conversation, false)}
      {setup.length > 0 && line({ mark: '■ ', markColor: SETUP_COLOR, label: 'Setup, loaded at start', value: kilo(setupTokens) })}
      {setup.map(r => row(r, true))}
    </Box>,
    undefined,
    fmt(inUse.reduce((sum, r) => sum + r.tokens, 0)),
  )

  // Each eater as a share of the conversation, the part it can be cut from
  const shareOf = (tokens: number) =>
    conversation && conversation.tokens > 0 ? `${String(Math.min(100, Math.round((tokens / conversation.tokens) * 100))).padStart(4)}%` : ''
  const eaters = card(
    'Top context eaters',
    <Box flexDirection="column">
      {eaten.length === 0 && all[0] && hint(`Nothing large yet · the biggest is ~${fmt(all[0].tokens)}`)}
      {eaten.map(t => {
        const g = guardOf(t)
        const isTarget = g !== undefined && guardTarget !== undefined && g.tool === guardTarget.tool && g.key === guardTarget.key
        return line({
          mark: g !== undefined && isGuarded(d.guards, g) ? '⊘ ' : isTarget ? '▸ ' : '  ',
          markColor: isTarget ? 'claude' : 'success',
          label: eaterLabel(t),
          value: `~${fmt(t.tokens)}${shareOf(t.tokens)}`,
          dim: !isTarget,
        })
      })}
      {/* The tip is for Claude; what the person can do about it is the guard */}
      {guardTarget
        ? advice(`x guards ▸: next time Claude is asked to ${guardTarget.tool === 'Read' ? 'read a range' : 'trim its output'}`)
        : eaten[0] && advice(tipOf(eaten[0].tool))}
    </Box>,
    undefined,
    conversation && eaten.length > 0 ? 'of conversation' : undefined,
  )

  // What to do now, one line read from the state; its button is drawn at
  // full strength and the rest dim, so the next step stands out
  const next: { text: string; color?: Color; press?: string } = d.compacting
    ? { text: 'Compacting…', color: 'claude' }
    : canResume && picker.state === 'closed'
      ? { text: 'New session · pick up a past one?', press: 'resume' }
    : pressure >= 0.8
      ? { text: `Time to compact${conversation ? ` · conversation ${fmt(conversation.tokens)}` : ''}`, color: 'error', press: 'compact' }
      : flagged.length > 0 && !isExact
        ? { text: '? rows may be large: count exactly', color: 'warning', press: 'exact' }
        : pressure >= 0.5 && canGuard
          ? { text: 'Filling · guard the biggest output', color: 'warning', press: 'guard' }
          : pressure >= 0.5
            ? { text: 'Filling · hand off before it gets tight', color: 'warning', press: 'handoff' }
            : { text: 'Nothing to do now' }

  // Plain buttons, `c: compact`: the hotkey in the accent colour, no brackets.
  // Guard stays in its place when there is nothing to guard, drawn dim, so
  // the row does not shift as eaters come and go.
  const button = (key: string, hotkey: string, label: string, onPress: () => void, isIdle = false) => (
    <Box marginRight={2}>
      <Button key={key} hotkey={hotkey} label={label} plain dimColor={isIdle || (next.press !== undefined && next.press !== key)} onPress={onPress} />
    </Box>
  )

  // The actions as a toolbar at the pane's foot, under a rule rather than in
  // a frame: the room above them then reads as the pane's own, not as a card
  // left empty. Its rows line up with the cards' insides.
  const controls = (
    <Box flexDirection="column" width={outer} flexShrink={0} marginTop={1}>
      <Text color="subtle" wrap="truncate">
        {'─'.repeat(outer)}
      </Text>
      <Box flexDirection="column" paddingX={isFramed ? 2 : 0}>
        <Box width={width}>
          <Text color={next.color} dimColor={next.color === undefined} wrap="truncate-end">
            {`${next.press ? '▶ ' : ''}${next.text}`}
          </Text>
        </Box>
        <Box width={width} flexWrap="wrap">
          {button('compact', 'c', d.compacting ? 'compacting…' : 'compact', actions.compact)}
          {button('handoff', 'w', 'handoff', actions.handoff)}
          {!isStorage && button('guard', 'x', 'guard', actions.guard, !canGuard)}
          {button('details', 'e', d.expanded ? 'less' : 'more', actions.toggleExpanded)}
          {/* The finer tools wait behind "more", so the everyday row stays short */}
          {(d.expanded || isStorage) && button('storage', 's', isStorage ? 'list' : 'grid', actions.toggleStorage)}
          {(d.expanded || flagged.length > 0) && button('exact', 'r', 'exact', actions.exact)}
          {canResume && button('resume', 'p', picker.state === 'closed' ? 'resume' : 'close', actions.resume)}
        </Box>
        <Box width={width}>
          <Text dimColor wrap="truncate-end">
            {footer}
          </Text>
        </Box>
      </Box>
    </Box>
  )

  // Docked, the pane is at least as tall as its room and the actions sit at
  // its foot; a taller tree scrolls and they come last
  return (
    <Box flexDirection="column" width={outer} minHeight={d.rows}>
      {summary}
      {!isStorage && inUse.length > 0 && breakdown}
      {isStorage && storageView()}
      {picker.state !== 'closed' && resumeView()}
      {!isStorage && all.length > 0 && eaters}
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
