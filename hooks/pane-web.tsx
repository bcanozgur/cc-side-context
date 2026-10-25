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

// A part's colour lifted toward white, still opaque: a translucent fill would
// mix with the track into a murky shade the list's dot does not have
const lighter = (hex: string, by = 0.3): string =>
  '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - by) + 255 * by).toString(16).padStart(2, '0')).join('')

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
  // Only the exact count may say a row is too large
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
  // limit the pane warns at a separator on it, the room past it a fainter track.
  // Under the pointer it swells as the macOS Dock does: the bar is cut into thin
  // columns, the one under the pointer and its neighbours drawn wider and taller
  // and the rest pushed aside, so a sliver of a part grows readable. The frame
  // runs no script, so the swell is CSS :hover on the columns, not a position
  const meter = () => {
    if (!Svg) return undefined
    const W = Math.max(160, d.columns * 10)
    // Room above and below the bar for the swell
    const BH = 20
    const H = 40
    const top = (H - BH) / 2
    const span = Math.max(snap.window, snap.tokens, 1)
    const x = (tokens: number) => Math.max(0, Math.min(W, (tokens / span) * W))
    // The rows are an estimate of the same whole: scaled to the measured total
    const ratio = total > 0 ? snap.tokens / total : 0
    const turn = Math.max(0, Math.min(d.live.delta, (conversation?.tokens ?? 0) * ratio))
    const parts = [
      ...setup.map(r => ({ name: labelOf(r.name), tokens: r.tokens * ratio, color: colorOf(r.name) })),
      ...(conversation ? [{ name: 'Conversation', tokens: conversation.tokens * ratio - turn, color: colorOf(conversation.name) }] : []),
      ...(conversation && turn > 0 ? [{ name: 'Latest turn', tokens: turn, color: lighter(colorOf(conversation.name)) }] : []),
    ].filter(p => p.tokens > 0)
    let at = 0
    const spans = parts.map(p => {
      const from = at
      at += p.tokens
      // A part of 1k or more is never thinner than a sliver
      return { ...p, from: x(from), w: Math.max(p.tokens >= 1_000 ? 1.5 : 0, x(at) - x(from)) }
    })
    const rects = spans
      .map(p => `<rect x="${p.from.toFixed(1)}" width="${p.w.toFixed(1)}" height="${BH}" fill="${p.color}"/>`)
      .join('')
    const isMarked = budget < span
    const mark = x(budget)
    // Whatever runs past the mark keeps its part colours under a faint red veil,
    // so the list's colours still read and the overage still shows
    const over = snap.tokens > budget && isMarked ? `<rect x="${mark.toFixed(1)}" width="${(x(snap.tokens) - mark).toFixed(1)}" height="${BH}" fill="${HEX.error}" fill-opacity="0.35"/>` : ''
    const bar =
      `<g id="bar" clip-path="url(#r)"><rect width="${W}" height="${BH}" fill="#80808033"/>` +
      (isMarked ? `<rect x="${mark.toFixed(1)}" width="${(W - mark).toFixed(1)}" height="${BH}" fill="#80808014"/>` : '') +
      `${rects}${over}` +
      // The mark is a separator: a dark gap with a light line down its middle,
      // so it reads against any part colour on either side
      (isMarked ? `<rect x="${(mark - 2).toFixed(1)}" width="4" height="${BH}" fill="#000000" fill-opacity="0.6"/><rect x="${(mark - 0.75).toFixed(1)}" width="1.5" height="${BH}" fill="#e6e6e6"/>` : '') +
      `</g>`

    // Whole-pixel columns that tile edge to edge: overlapping slices would
    // paint the translucent track twice and show as seams
    // Thin enough that the swell's steps read as a curve, few enough that the
    // markup stays well under the Svg's size limit on a wide pane
    const col = Math.max(4, Math.ceil(W / 160))
    const N = Math.ceil(W / col)
    // The swell: the column under the pointer and seven on each side, each wider
    // (kx) and taller (ky) the nearer it is, on a bell curve as the Dock's icons
    // are; the columns beyond move out by the width the swell gained and dim, so
    // the stretch under the lens is the one in focus
    const bell = (peak: number, spread: number) => Array.from({ length: 8 }, (_, j) => +(1 + peak * Math.exp(-((j / spread) ** 2))).toFixed(3))
    const kx = bell(2, 3)
    const ky = bell(0.6, 3.6)
    const K = kx.length - 1
    // How far the column `j` steps from the pointer's moves: half the pointer's
    // column's gain, all of the gains between, and half its own
    const reach = (j: number) => {
      const gain = (k: number) => (kx[k] ?? 1) - 1
      let s = gain(0) / 2
      for (let m = 1; m < j; m++) s += gain(m)
      return (s + gain(j) / 2) * col
    }
    const shift = (j: number) => reach(j).toFixed(1)
    const swell = (sel: string, j: number, dx: string) =>
      `${sel} .s{transform:translateX(${dx}px) scale(${kx[j] ?? 1},${ky[j] ?? 1})${j > K ? ';opacity:.5' : ''}}`

    // What sits under a column's middle: its part, and whether it is past the mark
    const partAt = (px: number) => {
      const p = spans.find(s => px >= s.from && px < s.from + s.w)
      return { name: p?.name ?? 'Free', size: p ? fmt(p.tokens) : fmt(Math.max(0, snap.window - snap.tokens)), color: p?.color ?? '#80808066', isPast: p !== undefined && isMarked && px >= mark }
    }
    // The readout: a dark tag beside the lens naming the part and its size, at
    // once rather than after a tooltip's delay. One tag per distinct reading,
    // drawn on either side of the lens, beyond the swell so it hides none of it
    const LH = 18
    const gap = reach(K + 1) + 4
    const tagWidth = (t: string) => Math.ceil(t.length * 6) + 26
    const tags: string[] = []
    const tagOf = new Map<string, number>()
    const readings = Array.from({ length: N }, (_, i) => {
      const mid = i * col + col / 2
      const p = partAt(mid)
      const text = `${p.name}  ${p.size}${p.isPast ? '  · over the limit' : ''}`
      const w = tagWidth(text)
      // The side with room, else the roomier one, kept inside the bar
      const isRight = mid + gap + w <= W || (mid - gap - w < 0 && W - mid >= mid)
      const x0 = Math.round(Math.max(-mid, Math.min(W - mid - w, isRight ? gap : -gap - w)))
      const key = `${text}@${x0}`
      if (!tagOf.has(key)) {
        const n = tagOf.size
        tagOf.set(key, n)
        tags.push(
          `<g class="t" id="t${n}" transform="translate(${x0} ${(H - LH) / 2})">` +
            `<rect width="${w}" height="${LH}" rx="${LH / 2}" fill="#1c1c1e" fill-opacity=".9" stroke="#ffffff" stroke-opacity=".14"/>` +
            `<circle cx="10" cy="${LH / 2}" r="3.5" fill="${p.color}"/>` +
            `<text x="18" y="${LH / 2 + 3.5}" fill="#f5f5f7" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" xml:space="preserve">` +
            `<tspan font-weight="600">${p.name}</tspan><tspan fill-opacity=".72">  ${p.size}</tspan>` +
            (p.isPast ? `<tspan fill="#ff8a80">  · over the limit</tspan>` : '') +
            `</text></g>`,
        )
      }
      return { mid, tag: tagOf.get(key) as number }
    })

    // The lens and its tag are one layer over the columns that glides to the
    // column under the pointer, so it follows the pointer rather than jumping;
    // neither takes the pointer, or the columns under them would lose it. It
    // rests at the left end, so on the way in it slides there unseen and only
    // then shows; on the way out it fades where it is before going back
    const LW = col * kx[0] + 6
    const LHt = BH * ky[0] + 4
    const ease = 'cubic-bezier(.3,1.35,.5,1)'
    const css =
      `.s{transition:transform .26s ${ease},opacity .2s ease-out}` +
      `#lens{pointer-events:none;opacity:0;transition:transform 0s .2s,opacity .16s ease-out}` +
      `.glass{transform:scale(.55);transform-box:fill-box;transform-origin:center;transition:transform .2s ease-in}` +
      `.c:hover~#lens{opacity:1;transition:transform .18s cubic-bezier(.2,.8,.2,1),opacity .14s ease-out .1s}` +
      `.c:hover~#lens .glass{transform:scale(1);transition:transform .3s ${ease} .1s}` +
      `.t{opacity:0;transition:opacity .12s ease-out}` +
      swell('.c:hover', 0, '0') +
      Array.from({ length: K }, (_, m) => {
        const j = m + 1
        return swell(`.c:hover${'+.c'.repeat(j)}`, j, shift(j)) + swell(`.c:has(${'+.c'.repeat(j)}:hover)`, j, `-${shift(j)}`)
      }).join('') +
      swell(`.c:hover${'+.c'.repeat(K)}~.c`, K + 1, shift(K + 1)) +
      swell(`.c:has(~.c${'+.c'.repeat(K)}:hover)`, K + 1, `-${shift(K + 1)}`) +
      readings.map((r, i) => `#c${i}:hover~#lens{transform:translateX(${r.mid}px)}#c${i}:hover~#lens #t${r.tag}{opacity:1}`).join('')
    // The slices' clips sit in the defs, so the columns are siblings with
    // nothing between them and `.c:hover+.c` reaches the neighbours
    const clips = Array.from({ length: N }, (_, i) => `<clipPath id="k${i}"><rect x="${i * col}" width="${col}" height="${BH}" shape-rendering="crispEdges"/></clipPath>`).join('')
    const columns = Array.from({ length: N }, (_, i) => {
      const left = i * col
      const mid = left + col / 2
      return (
        `<g class="c" id="c${i}">` +
        `<rect x="${left}" width="${col}" height="${H}" fill="#000" fill-opacity="0"/>` +
        `<g class="s" style="transform-origin:${mid}px ${H / 2}px">` +
        `<g transform="translate(0 ${top})"><use href="#bar" clip-path="url(#k${i})"/></g></g></g>`
      )
    }).join('')
    // Glass: a soft shadow under it, a bright rim with a dark hairline outside
    // so it reads on a light pane and a dark one, and a sheen across its top
    const lens =
      `<g id="lens"><g class="glass">` +
      `<rect x="${-LW / 2}" y="${(H - LHt) / 2}" width="${LW}" height="${LHt}" rx="7" fill="url(#sheen)" stroke="#000" stroke-opacity=".28" stroke-width="2.5" filter="url(#lift)"/>` +
      `<rect x="${-LW / 2}" y="${(H - LHt) / 2}" width="${LW}" height="${LHt}" rx="7" fill="none" stroke="#fff" stroke-opacity=".95" stroke-width="1.25"/>` +
      `</g>${tags.join('')}</g>`
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<style>${css}</style>` +
      `<defs><clipPath id="r"><rect width="${W}" height="${BH}" rx="${BH / 2}" ry="${BH / 2}"/></clipPath>${bar}${clips}` +
      `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
      `<filter id="lift" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity=".35"/></filter></defs>` +
      `${columns}${lens}</svg>`
    return (
      <Box width="100%">
        <Svg
          source={source}
          alt={`${windowShare}% of the ${fmt(snap.window)} window in use${isMarked ? `, ${limitLabel} marked at ${fmt(budget)}` : ''}`}
          width={W}
          height={H}
          isInteractive
        />
      </Box>
    )
  }

  // What to do now: a few words and one primary button, or nothing
  const next: { text: string; color?: Color; press?: 'compact' | 'guard' | 'handoff' | 'resume' } | undefined = d.compacting
    ? { text: 'Keeping your goal, rules and decisions…', color: 'claude' }
    : canResume && picker.state === 'closed'
      ? { text: 'Pick up a past session?', press: 'resume' }
      : pressure >= 0.8
        ? { text: 'Compact keeps your goal and decisions', color: 'error', press: 'compact' }
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

  // The actions the next step did not take, quiet, at the foot; the exact count
  // only while the sizes are estimates
  const rest = (['compact', 'handoff', ...(canGuard ? ['guard'] : []), ...(isExact ? [] : ['exact']), ...(canResume ? ['resume'] : [])] as (keyof typeof ACTION)[]).filter(
    k => k !== next?.press,
  )

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
