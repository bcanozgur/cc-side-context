import type { Color } from 'claude-code'

import type { Item, Picker, Row } from '../types'
import { agoOf, eaterLabel, fitWidth, fmt, guardOf, isGuarded, limitName, tipOf } from './analysis'
import {
  type PaneActions,
  type PaneData,
  type Ui,
  budgetOf,
  isHeavy,
  labelOf,
  nextGuard,
  ruleOf,
  scaled,
  shownEaters,
  top,
} from './pane'

// The pane as the desktop app, the editor and the phone draw it: HTML in a
// proportional font, laid out by the page rather than in counted cells.
// One fact per row, in the host's own idiom (a dot, a name, a size, a share);
// the advice behind a row shows under the pointer, the next step is one
// sentence and one primary button, and the rest of the actions sit quietly
// at the foot.

// What a card shows before "Show all"
const ROWS = 6
const EATERS = 3

// Each part of the context has a colour of its own, shared by its dot and its
// stretch of the meter, in the host's own hues where it has one (tools blue,
// MCP orange, messages green, the system prompt amber). The meter is an Svg,
// drawn as an image that cannot follow the theme: mid tones that read on a
// light and a dark pane alike.
const PART: Record<string, string> = {
  Conversation: '#3fa877',
  'Built-in tools': '#4f86e8',
  'MCP tools': '#e2703f',
  'System prompt': '#d9a521',
  Skills: '#9a72d8',
  'MCP instructions': '#d4679e',
  'Memory (CLAUDE.md, rules)': '#2ea5bd',
  Subagents: '#b5835a',
  'Slash commands': '#7b8fa6',
}
const OTHER = '#8c939c'
const colorOf = (name: string): string => PART[labelOf(name)] ?? OTHER

const HEX = { error: '#d0453a', mark: '#9a9a9a' } as const

// A share of a whole, as the host's own context list writes it
const shareOf = (part: number, whole: number) => {
  if (whole <= 0 || part <= 0) return ''
  const p = (part / whole) * 100
  return p < 1 ? '<1%' : `${Math.min(100, Math.round(p))}%`
}

export const drawWebPane = (ui: Ui, d: PaneData, actions: PaneActions) => {
  const { Box, Text, Button } = ui
  const Svg = 'Svg' in ui ? ui.Svg : undefined
  // A flex child that may shrink below its text, so the text truncates
  // instead of pushing the number out of the pane
  const clip = { minWidth: 0, overflow: 'hidden' as const }
  const snap = d.live.snapshot

  if (!snap) {
    return (
      <Box flexDirection="column" width="100%" paddingX={1}>
        <Text dimColor>Measuring context…</Text>
      </Box>
    )
  }

  const isExact = snap.detail === 'full'
  const budget = budgetOf(snap, d.quality)
  const isQualityFirst = budget < (snap.compactAt ?? snap.window)
  const limitLabel = isQualityFirst ? 'quality limit' : snap.compactAt !== undefined ? 'auto-compact' : 'window'
  const pressure = budget > 0 ? snap.tokens / budget : 0
  const status: { color: Color; text: string } = d.compacting
    ? { color: 'claude', text: 'Compacting' }
    : pressure >= 1
      ? { color: 'error', text: 'Over the limit' }
      : pressure >= 0.8
        ? { color: 'error', text: isQualityFirst ? 'Time to compact' : 'Near auto-compact' }
        : pressure >= 0.5
          ? { color: 'warning', text: 'Filling up' }
          : { color: 'success', text: 'Healthy' }

  const inUse = snap.rows.filter(r => r.kind === 'used')
  const conversation = inUse.find(r => /^messages/i.test(r.name))
  const setup = inUse.filter(r => r !== conversation).sort((a, b) => b.tokens - a.tokens)
  const setupTokens = setup.reduce((sum, r) => sum + r.tokens, 0)
  const total = inUse.reduce((sum, r) => sum + r.tokens, 0)
  // Only the exact count may say a row is too large; an estimate only asks
  const flagged = inUse.filter(r => isHeavy(r, snap, d.quality))
  const isLarge = (r: Row) => isExact && isHeavy(r, snap, d.quality)

  const canResume = d.live.fresh === true
  const picker: Picker = canResume ? d.picker : { state: 'closed' }
  const eaten = shownEaters(d.live, d.quality)
  const guardTarget = nextGuard(eaten, d.guards)
  const canGuard = guardTarget !== undefined

  // The card every group sits in: a neutral frame, the title a row of its own
  // with a figure flush right. Colour is kept for the data.
  const card = (key: string, title: string | undefined, aside: string | undefined, children: unknown, first = false) => (
    <Box key={key} flexDirection="column" width="100%" borderStyle="round" borderColor="subtle" paddingX={1} flexShrink={0} marginTop={first ? 0 : 1}>
      {title !== undefined && (
        <Box width="100%" justifyContent="space-between" marginBottom={1}>
          <Box flexShrink={1} {...clip}>
            <Text bold wrap="truncate-end">
              {title}
            </Text>
          </Box>
          {aside !== undefined && (
            <Box flexShrink={0} paddingLeft={1}>
              <Text dimColor>{aside}</Text>
            </Box>
          )}
        </Box>
      )}
      {children as never}
    </Box>
  )

  // One row: a dot in its part's colour, the name, the size and its share.
  // A tip, when the row has one, shows under it while the pointer is on it.
  const row = (p: { key: string; color: Color; label: string; value: string; share?: string; isWarn?: boolean; isDim?: boolean; tip?: string }) => (
    <Box key={p.key} flexDirection="column" width="100%">
      <Box width="100%" justifyContent="space-between">
        <Box flexShrink={1} {...clip}>
          <Text color={p.color}>{'■ '}</Text>
          <Text dimColor={p.isDim} wrap="truncate-end">
            {p.label}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={p.isWarn ? 'error' : undefined} dimColor={!p.isWarn}>
            {p.value}
          </Text>
          <Box width={6} justifyContent="flex-end">
            <Text bold={!p.isDim}>{p.share ?? ''}</Text>
          </Box>
        </Box>
      </Box>
      {p.tip !== undefined && (
        <Box display="none" hover={{ display: 'flex' }} width="100%" paddingLeft={2} {...clip}>
          <Text dimColor wrap="wrap">
            {p.tip}
          </Text>
        </Box>
      )}
    </Box>
  )

  // "Show all", inside the card it opens, as the host's own sections do
  const more = (key: string, hidden: number, hotkey?: string) =>
    hidden > 0 || d.expanded ? (
      <Box marginTop={1}>
        <Button key={key} hotkey={hotkey} label={d.expanded ? 'Show less' : `Show ${hidden} more`} dimColor onPress={actions.toggleExpanded} />
      </Box>
    ) : undefined

  // The meter is the whole window, as the host's own context bar: each part in
  // its colour, the latest turn a lighter stretch of the conversation, and the
  // limit the pane warns at a mark on it, the room past the mark a fainter track
  const meter = () => {
    if (!Svg) return undefined
    const VW = 1000
    const VH = 10
    const span = Math.max(snap.window, snap.tokens, 1)
    const x = (tokens: number) => Math.max(0, Math.min(VW, (tokens / span) * VW))
    // The rows are an estimate of the same whole: scaled to the measured total
    const ratio = total > 0 ? snap.tokens / total : 0
    const turn = Math.max(0, Math.min(d.live.delta, (conversation?.tokens ?? 0) * ratio))
    const parts = [
      ...setup.map(r => ({ tokens: r.tokens * ratio, color: colorOf(r.name), opacity: 1 })),
      ...(conversation ? [{ tokens: conversation.tokens * ratio - turn, color: colorOf(conversation.name), opacity: 1 }] : []),
      ...(conversation && turn > 0 ? [{ tokens: turn, color: colorOf(conversation.name), opacity: 0.5 }] : []),
    ].filter(p => p.tokens > 0)
    let at = 0
    const rects = parts
      .map(p => {
        const from = at
        at += p.tokens
        // A part of 1k or more is never thinner than a sliver
        const w = Math.max(p.tokens >= 1_000 ? 3 : 0, x(at) - x(from))
        return `<rect x="${x(from).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${VH}" fill="${p.color}" fill-opacity="${p.opacity}"/>`
      })
      .join('')
    const isMarked = budget < span
    const mark = x(budget)
    // Whatever runs past the mark keeps its part colours under a faint red veil,
    // so the list's colours still read and the overage still shows
    const over = snap.tokens > budget && isMarked ? `<rect x="${mark.toFixed(1)}" y="0" width="${(x(snap.tokens) - mark).toFixed(1)}" height="${VH}" fill="${HEX.error}" fill-opacity="0.35"/>` : ''
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none">` +
      `<defs><clipPath id="r"><rect width="${VW}" height="${VH}" rx="5" ry="5"/></clipPath></defs>` +
      `<g clip-path="url(#r)"><rect width="${VW}" height="${VH}" fill="#80808033"/>` +
      (isMarked ? `<rect x="${mark.toFixed(1)}" width="${(VW - mark).toFixed(1)}" height="${VH}" fill="#80808014"/>` : '') +
      `${rects}${over}` +
      // The mark is a separator: a dark gap with a light line down its middle,
      // so it reads against any part colour on either side
      (isMarked ? `<rect x="${(mark - 4).toFixed(1)}" width="8" height="${VH}" fill="#000000" fill-opacity="0.6"/><rect x="${(mark - 1.5).toFixed(1)}" width="3" height="${VH}" fill="#e6e6e6"/>` : '') +
      `</g></svg>`
    return (
      <Box width="100%" marginY={1}>
        <Svg source={source} alt={`${windowShare}% of the ${fmt(snap.window)} window in use${isMarked ? `, ${limitLabel} marked at ${fmt(budget)}` : ''}`} width={Math.max(160, d.columns * 10)} height={8} />
      </Box>
    )
  }

  // What to do now: a few words and one primary button, or nothing
  const next: { text: string; color?: Color; press?: 'compact' | 'exact' | 'guard' | 'handoff' | 'resume' } | undefined = d.compacting
    ? { text: 'Keeping your goal, rules and decisions…', color: 'claude' }
    : canResume && picker.state === 'closed'
      ? { text: 'Pick up a past session?', press: 'resume' }
      : pressure >= 0.8
        ? { text: 'Compact keeps your goal and decisions', color: 'error', press: 'compact' }
        : flagged.length > 0 && !isExact
          ? { text: 'Sizes are estimates', press: 'exact' }
          : pressure >= 0.5 && canGuard
            ? { text: 'One output takes a lot of room', color: 'warning', press: 'guard' }
            : pressure >= 0.5
              ? { text: 'Hand off before it gets tight', color: 'warning', press: 'handoff' }
              : undefined
  const ACTION = {
    compact: { label: d.compacting ? 'Compacting…' : 'Compact', hotkey: 'c', onPress: actions.compact },
    handoff: { label: 'Handoff', hotkey: 'w', onPress: actions.handoff },
    guard: { label: 'Guard', hotkey: 'x', onPress: actions.guard },
    exact: { label: 'Count exactly', hotkey: 'r', onPress: actions.exact },
    resume: { label: picker.state === 'closed' ? 'Resume' : 'Close', hotkey: 'p', onPress: actions.resume },
  } as const
  const action = (key: keyof typeof ACTION, isPrimary = false) => (
    <Box key={`a-${key}`} marginRight={1} marginTop={1}>
      <Button key={key} hotkey={ACTION[key].hotkey} label={ACTION[key].label} variant={isPrimary ? 'primary' : 'secondary'} onPress={ACTION[key].onPress} />
    </Box>
  )

  const room = budget - snap.tokens
  const windowShare = Math.round((snap.tokens / Math.max(1, snap.window)) * 100)
  const replied = d.live.lastReply
  const left = replied === null ? 0 : replied + d.ttl - d.now
  const isCold = replied !== null && left <= 0
  const facts = [
    ...(d.live.delta > 0 ? [`+${fmt(d.live.delta)} this turn`] : []),
    ...(replied === null ? [] : [isCold ? 'cache cold' : `cache ${Math.max(1, Math.ceil(left / 60_000))}m`]),
    ...snap.limits.map(l => `${limitName(l.kind)} ${Math.round(l.percent)}%`),
    ...(snap.cost !== undefined && snap.cost >= 0.01 ? [`$${snap.cost.toFixed(2)}`] : []),
  ]

  const summary = card(
    'summary',
    undefined,
    undefined,
    <Box flexDirection="column" width="100%">
      <Box width="100%" justifyContent="space-between">
        <Box flexShrink={1} {...clip}>
          <Text color={status.color}>{'● '}</Text>
          <Text bold wrap="truncate-end">
            {status.text}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text bold>{`${windowShare}%`}</Text>
        </Box>
      </Box>
      {meter()}
      <Box width="100%" justifyContent="space-between">
        <Box flexShrink={1} {...clip}>
          <Text dimColor wrap="truncate-end">
            {`${fmt(snap.tokens)} of ${fmt(snap.window)} window`}
          </Text>
        </Box>
        {limitLabel === 'window' && (
          <Box flexShrink={0} paddingLeft={1}>
            <Text dimColor>{`${fmt(Math.max(0, room))} left`}</Text>
          </Box>
        )}
      </Box>
      {limitLabel !== 'window' && (
        <Box width="100%" justifyContent="space-between">
          <Box flexShrink={1} {...clip}>
            <Text dimColor wrap="truncate-end">
              <Text color={HEX.mark}>{'┃ '}</Text>
              {`${limitLabel.charAt(0).toUpperCase()}${limitLabel.slice(1)} ${fmt(budget)}`}
            </Text>
          </Box>
          <Box flexShrink={0} paddingLeft={1}>
            {room >= 0 ? <Text dimColor>{`${fmt(room)} left`}</Text> : <Text color="error">{`${fmt(-room)} over`}</Text>}
          </Box>
        </Box>
      )}
      {facts.length > 0 && (
        <Box width="100%" {...clip}>
          <Text dimColor wrap="truncate-end">
            {facts.map((f, i) => (
              <Text color={f === 'cache cold' ? 'warning' : undefined}>{`${i > 0 ? ' · ' : ''}${f}`}</Text>
            ))}
          </Text>
        </Box>
      )}
      {next && (
        <Box width="100%" justifyContent="space-between" alignItems="center" flexWrap="wrap" marginTop={1}>
          <Box flexShrink={1} marginTop={1} marginRight={1} {...clip}>
            <Text color={next.color} wrap="wrap">
              {next.text}
            </Text>
          </Box>
          {next.press && action(next.press, true)}
        </Box>
      )}
    </Box>,
    true,
  )

  // What is in the window: the conversation, then what was loaded at start,
  // biggest first, each with its share of what is in context
  const rows = [
    ...(conversation ? [{ r: conversation, color: colorOf(conversation.name) }] : []),
    ...setup.map(r => ({ r, color: colorOf(r.name) })),
  ]
  const rowsShown = d.expanded ? rows : rows.filter((x, i) => i < ROWS || isLarge(x.r))
  const breakdown = card(
    'breakdown',
    'In context',
    `${isExact ? '' : '~'}${fmt(total)}`,
    <Box flexDirection="column" width="100%">
      {rowsShown.map(({ r, color }) =>
        row({
          key: `row-${labelOf(r.name)}`,
          color,
          label: labelOf(r.name),
          value: fmt(r.tokens),
          share: shareOf(r.tokens, total),
          isWarn: isLarge(r),
          tip: isLarge(r) ? (ruleOf(r.name)?.fix ?? 'Bigger than usual') : undefined,
        }),
      )}
      {more('details', rows.length - rowsShown.length, 'e')}
    </Box>,
  )

  // The tool outputs filling the conversation, the one Guard acts on marked
  const isTarget = (t: (typeof eaten)[number]) => {
    const g = guardOf(t)
    return g !== undefined && guardTarget !== undefined && g.tool === guardTarget.tool && g.key === guardTarget.key
  }
  const eatenShown = d.expanded ? eaten : eaten.filter((t, i) => i < EATERS || isTarget(t))
  const all = scaled(d.live)
  const eaters = card(
    'eaters',
    'Biggest outputs',
    conversation && eaten.length > 0 ? 'of conversation' : undefined,
    <Box flexDirection="column" width="100%">
      {eaten.length === 0 && all[0] && <Text dimColor>{`Nothing large yet · the biggest is ~${fmt(all[0].tokens)}`}</Text>}
      {eatenShown.map((t, i) => {
        const g = guardOf(t)
        const isGuard = g !== undefined && isGuarded(d.guards, g)
        const target = isTarget(t)
        return row({
          key: `eater-${i}`,
          color: target ? 'claude' : isGuard ? 'success' : 'subtle',
          label: `${eaterLabel(t)}${isGuard ? ' · guarded' : ''}`,
          value: `~${fmt(t.tokens)}`,
          share: conversation ? shareOf(t.tokens, conversation.tokens) : undefined,
          isDim: !target,
          tip: target
            ? `Guard sends it back once: Claude is asked to ${guardTarget?.tool === 'Read' ? 'read only a range' : 'trim it'} next time`
            : isGuard
              ? undefined
              : tipOf(t.tool),
        })
      })}
      {more('details-eaters', eaten.length - eatenShown.length, rows.length - rowsShown.length > 0 || d.expanded ? undefined : 'e')}
    </Box>,
  )

  const resume =
    picker.state === 'closed'
      ? undefined
      : card(
          'resume',
          'Resume a session',
          undefined,
          <Box flexDirection="column" width="100%">
            {picker.state === 'loading' && <Text dimColor>Reading past sessions…</Text>}
            {picker.state === 'open' && picker.sessions.length === 0 && <Text dimColor>No past sessions in this project</Text>}
            {picker.state === 'open' &&
              picker.sessions.map((r, i) => (
                <Box key={`resume-row-${i + 1}`} width="100%" justifyContent="space-between" marginTop={i > 0 ? 1 : 0}>
                  <Box flexShrink={1} {...clip}>
                    <Button key={`resume-${i + 1}`} hotkey={String(i + 1)} label={fitWidth(r.title, 48)} onPress={() => actions.pick(r.id)} />
                  </Box>
                  <Box flexShrink={0} paddingLeft={1}>
                    <Text dimColor>{agoOf(d.now - r.at)}</Text>
                  </Box>
                </Box>
              ))}
          </Box>,
        )

  // The finer lists, under "Show all"
  const list = (key: string, title: string, items: Item[]) =>
    items.length === 0
      ? undefined
      : card(
          key,
          title,
          fmt(items.reduce((sum, i) => sum + i.tokens, 0)),
          <Box flexDirection="column" width="100%">
            {top(items).map((i, n) => row({ key: `${key}-${n}`, color: 'subtle', label: i.name, value: fmt(i.tokens), isDim: true }))}
          </Box>,
        )

  // The actions the next step did not take, quiet, at the foot
  const rest = (['compact', 'handoff', ...(canGuard ? ['guard'] : []), ...(canResume ? ['resume'] : [])] as (keyof typeof ACTION)[]).filter(k => k !== next?.press)

  return (
    <Box flexDirection="column" width="100%">
      {summary}
      {resume}
      {inUse.length > 0 && breakdown}
      {all.length > 0 && eaters}
      {d.expanded && list('memory', 'Memory files', snap.memory)}
      {d.expanded && list('mcp', 'MCP tools', snap.mcp)}
      {d.expanded && list('skills', 'Skills', snap.skills)}
      <Box width="100%" flexWrap="wrap" marginTop={1} paddingX={1}>
        {rest.map(k => action(k))}
      </Box>
    </Box>
  )
}
