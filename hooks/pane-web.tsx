import type { Color } from 'claude-code'

import type { Item, Picker, Row, Snapshot } from '../types'
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
  statusOf,
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

// The meter is the whole window, as the host's own context bar: each part in
// its colour, the latest turn a lighter stretch of the conversation, and the
// limit the pane warns at a separator on it, the room past it a fainter track.
// Drawn at any size: the pane's meter wide, the strip's above the prompt small.
//
// Under the pointer a lens magnifies it, so a sliver of a part grows readable,
// with a tag beside it naming the part. The frame runs no script, so the lens
// follows the pointer by CSS :hover on thin transparent columns over the bar.
// It is one layer that only moves (transform and opacity, which the page
// composites without repainting the rest): the bar under it is drawn once,
// exactly as at rest, and the lens shows a magnified copy of that same bar.
// No selector looks back at earlier siblings and nothing is filtered, so a
// pointer move restyles two elements, not the whole drawing.

// `zoom` is how many times wider the bar shows under the lens, `tall` how many
// times taller, and `width` the lens's own width in pixels
export type MeterLens = { zoom: number; tall: number; width: number }
const LENS: MeterLens = { zoom: 4, tall: 1.5, width: 56 }

// The same figures draw the same markup: a redraw that changed nothing the
// meter shows (a cache countdown, a new trend point) reuses it, and the surface
// is handed the very string it already has
const drawn = new WeakMap<Snapshot, Map<string, string>>()

// `axis` adds a row under the meter naming its scale, as a number line: 0,
// the limit under its mark, the window at the end
export const meterSource = (m: { snap: Snapshot; delta: number; budget: number; W: number; BH: number; H: number; lens?: MeterLens; axis?: boolean }): string => {
  const lens = m.lens ?? LENS
  const key = `${m.delta}|${m.budget}|${m.W}|${m.BH}|${m.H}|${lens.zoom}|${lens.tall}|${lens.width}|${m.axis === true}`
  const known = drawn.get(m.snap)?.get(key)
  if (known !== undefined) return known
  const source = drawMeter(m, lens)
  const bySnap = drawn.get(m.snap) ?? new Map<string, string>()
  // A snapshot is drawn at a size or two; more is a pane being resized
  if (bySnap.size > 4) bySnap.clear()
  bySnap.set(key, source)
  drawn.set(m.snap, bySnap)
  return source
}

// The desktop draws an interactive Svg as a frame of its own, and a changed
// source is a new frame: the old one goes at once and the new one is blank
// until it loads, and a pointer on the lens loses it. Every response of a turn
// moves the figures, so while a turn runs the meter keeps what it last drew,
// unless the context moved a stretch the eye would miss or it has been a
// while; the turn's end draws it afresh. The figures beside it move each step.
const HOLD = { ms: 20_000, share: 0.02 } as const
const held = new Map<string, { source: string; tokens: number; W: number; at: number }>()

export const steadyMeter = (
  slot: string,
  m: Parameters<typeof meterSource>[0],
  turn: { isRunning: boolean; now: number },
): string => {
  const source = meterSource(m)
  const last = held.get(slot)
  if (last === undefined || last.source === source) {
    if (last === undefined) held.set(slot, { source, tokens: m.snap.tokens, W: m.W, at: turn.now })
    return source
  }
  const isSmall = Math.abs(m.snap.tokens - last.tokens) < Math.max(1, m.snap.window) * HOLD.share
  if (turn.isRunning && isSmall && last.W === m.W && turn.now - last.at < HOLD.ms) return last.source
  held.set(slot, { source, tokens: m.snap.tokens, W: m.W, at: turn.now })
  return source
}

// The axis row's height in pixels, under the meter's own
export const AXIS = 12

// A figure on the axis, without a trailing .0: 250k, 1M
const tickOf = (n: number) => fmt(n).replace(/\.0(?=[kM]?$)/, '')

const drawMeter = (m: { snap: Snapshot; delta: number; budget: number; W: number; BH: number; H: number; axis?: boolean }, lens: MeterLens): string => {
  const { snap, delta, budget, W, BH, H } = m
  const inUse = snap.rows.filter(r => r.kind === 'used')
  const conversation = inUse.find(r => /^messages/i.test(r.name))
  const setup = inUse.filter(r => r !== conversation).sort((a, b) => b.tokens - a.tokens)
  const total = inUse.reduce((sum, r) => sum + r.tokens, 0)
  const top = (H - BH) / 2
  const span = Math.max(snap.window, snap.tokens, 1)
  const x = (tokens: number) => Math.max(0, Math.min(W, (tokens / span) * W))
  // The rows are an estimate of the same whole: scaled to the measured total
  const ratio = total > 0 ? snap.tokens / total : 0
  const turn = Math.max(0, Math.min(delta, (conversation?.tokens ?? 0) * ratio))
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

  // The columns only catch the pointer: thin, so the lens steps in small
  // moves its glide smooths over, few enough to keep the markup small
  const col = Math.max(2, Math.ceil(W / 140))
  const N = Math.ceil(W / col)

  // Which part each column names: the one under its middle, except that a part
  // thinner than a column, under no column's middle, takes the column it
  // overlaps most from a part that has columns to spare, so every part on the
  // meter can be read
  const owner = Array.from({ length: N }, (_, i) => spans.findIndex(s => i * col + col / 2 >= s.from && i * col + col / 2 < s.from + s.w))
  const held = (k: number) => owner.filter(o => o === k).length
  spans.forEach((s, k) => {
    if (held(k) > 0 || s.w <= 0) return
    const overlap = (i: number) => Math.min(s.from + s.w, (i + 1) * col) - Math.max(s.from, i * col)
    const first = Math.max(0, Math.floor(s.from / col))
    const last = Math.min(N - 1, Math.floor((s.from + s.w - 0.001) / col))
    const spare = Array.from({ length: last - first + 1 }, (_, n) => first + n)
      .filter(i => owner[i] === -1 || held(owner[i] as number) > 1)
      .sort((a, b) => overlap(b) - overlap(a))[0]
    if (spare !== undefined) owner[spare] = k
  })
  // What a column names: its part, and whether it is past the mark
  const partAt = (i: number) => {
    const p = spans[owner[i] ?? -1]
    const px = i * col + col / 2
    return { name: p?.name ?? 'Free', size: p ? fmt(p.tokens) : fmt(Math.max(0, snap.window - snap.tokens)), color: p?.color ?? '#80808066', isPast: p !== undefined && isMarked && px >= mark }
  }

  const LW = Math.min(lens.width, W)
  const LHt = Math.min(H - 2, BH * lens.tall + 4)
  // The readout: a dark tag beside the lens naming the part and its size, at
  // once rather than after a tooltip's delay. One tag per distinct reading,
  // drawn on either side of the lens so it hides none of it. Where neither
  // side has room for the whole reading it sheds words until it fits: the
  // overage note, then the size; a part past the limit then shows its size in
  // red instead. The lens is drawn over the tag, so the bar never hides
  const LH = 18
  const gap = LW / 2 + 4
  const tagWidth = (t: string) => Math.ceil(t.length * 6) + 26
  const tags: string[] = []
  const tagOf = new Map<string, number>()
  const readings = Array.from({ length: N }, (_, i) => {
    const mid = i * col + col / 2
    // Where the lens's middle sits: under the pointer, but never past an end
    const lensAt = Math.max(LW / 2, Math.min(W - LW / 2, mid))
    const p = partAt(i)
    const room = Math.max(W - lensAt - gap, lensAt - gap)
    const forms = [
      { size: true, note: p.isPast ? '  · over the limit' : '' },
      { size: true, note: p.isPast ? '  · over' : '' },
      { size: true, note: '' },
      { size: false, note: '' },
    ]
    const textOf = (f: (typeof forms)[number]) => `${p.name}${f.size ? `  ${p.size}` : ''}${f.note}`
    const form = forms.find(f => tagWidth(textOf(f)) <= room) ?? (forms[forms.length - 1] as (typeof forms)[number])
    const text = textOf(form)
    const w = tagWidth(text)
    // The side with room, else the roomier one, kept inside the bar
    const isRight = lensAt + gap + w <= W || (lensAt - gap - w < 0 && W - lensAt >= lensAt)
    const x0 = Math.round(Math.max(-lensAt, Math.min(W - lensAt - w, isRight ? gap : -gap - w)))
    const key = `${text}@${x0}`
    if (!tagOf.has(key)) {
      const n = tagOf.size
      tagOf.set(key, n)
      const isRed = p.isPast && !form.note
      tags.push(
        `<g class="t" id="t${n}" transform="translate(${x0} ${(H - LH) / 2})">` +
          `<rect width="${w}" height="${LH}" rx="${LH / 2}" fill="#1c1c1e" fill-opacity=".9" stroke="#ffffff" stroke-opacity=".14"/>` +
          `<circle cx="10" cy="${LH / 2}" r="3.5" fill="${p.color}"/>` +
          `<text x="18" y="${LH / 2 + 3.5}" fill="#f5f5f7" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" xml:space="preserve">` +
          `<tspan font-weight="600">${p.name}</tspan>` +
          (form.size ? (isRed ? `<tspan fill="#ff8a80">  ${p.size}</tspan>` : `<tspan fill-opacity=".72">  ${p.size}</tspan>`) : '') +
          (form.note ? `<tspan fill="#ff8a80">${form.note}</tspan>` : '') +
          `</text></g>`,
      )
    }
    return { mid: +mid.toFixed(1), at: +lensAt.toFixed(1), tag: tagOf.get(key) as number }
  })

  // The lens sits at the column under the pointer (--l, kept inside the bar
  // at the ends) and shows the bar magnified about the pointer (--m): the copy
  // moves left by --m times the zoom, so the point under the pointer is drawn
  // where the pointer is. Both moves run on one timing, so the copy and the
  // glass never drift apart as they glide. At rest the lens fades where it is
  // and only then goes back to the start
  const Z = lens.zoom
  const TY = (LHt - 4) / BH
  const glide = '.11s cubic-bezier(.25,.8,.25,1)'
  const css =
    `.c{fill:#000;fill-opacity:0}` +
    `#lens{--l:0px;--m:0px;pointer-events:none;opacity:0;transform:translateX(var(--l));transition:opacity .1s ease-out,transform 0s .1s}` +
    `#lens .z{transform-box:view-box;transform-origin:0 ${H / 2}px;transform:translateX(calc(var(--m) - var(--l) - var(--m) * ${Z})) scale(${Z},${TY.toFixed(3)});transition:transform 0s .1s}` +
    `.c:hover~#lens{opacity:1;transition:opacity .08s ease-out,transform ${glide}}` +
    `.c:hover~#lens .z{transition:transform ${glide}}` +
    `.t{opacity:0}` +
    readings.map((r, i) => `#c${i}:hover~#lens{--l:${r.at}px;--m:${r.mid}px}#c${i}:hover~#lens #t${r.tag}{opacity:1}`).join('')
  const columns = Array.from({ length: N }, (_, i) => `<rect class="c" id="c${i}" x="${i * col}" width="${col}" height="${H}"/>`).join('')
  // Glass: a clear pane with the magnified bar in it, a bright rim with a dark
  // hairline outside so it reads on a light pane and a dark one, and a sheen
  // across its top. Drawn with strokes, not a shadow filter, which the page
  // would have to recompute on every frame of the glide
  const ly = (H - LHt) / 2
  const glass =
    `<g id="lens">${tags.join('')}` +
    `<g clip-path="url(#lc)"><rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" fill="#1c1c1e"/>` +
    `<g class="z"><use href="#bar" y="${top}"/></g>` +
    `<rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" fill="url(#sheen)"/></g>` +
    `<rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" rx="7" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="2.5"/>` +
    `<rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" rx="7" fill="none" stroke="#fff" stroke-opacity=".95" stroke-width="1.25"/></g>`
  // The scale: 0 at the start, the window at the end and the limit under its
  // mark, in a grey that reads on a light pane and a dark one. The limit says
  // more than the end, so a limit near an end takes its place
  const figures = (() => {
    if (!m.axis) return ''
    const widthOf = (t: string) => t.length * 5.6
    const ticks: { x: number; text: string; anchor: 'start' | 'middle' | 'end' }[] = [
      { x: 0, text: '0', anchor: 'start' },
      { x: x(snap.window), text: tickOf(snap.window), anchor: 'end' },
    ]
    if (isMarked) {
      const text = tickOf(budget)
      const half = widthOf(text) / 2
      const at = Math.max(half, Math.min(W - half, mark))
      const ends = ticks.filter(t => (t.anchor === 'start' ? widthOf(t.text) + 6 < at - half : t.x - widthOf(t.text) - 6 > at + half))
      ticks.splice(0, ticks.length, ...ends, { x: at, text, anchor: 'middle' })
    }
    return ticks
      .map(
        t =>
          `<text x="${t.x.toFixed(1)}" y="${H + AXIS - 2}" text-anchor="${t.anchor}" fill="#8e8e93" font-size="9" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">${t.text}</text>`,
      )
      .join('')
  })()
  const VH = m.axis ? H + AXIS : H
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${VH}" preserveAspectRatio="none">` +
    `<style>${css}</style>` +
    `<defs><clipPath id="r"><rect width="${W}" height="${BH}" rx="${BH / 2}" ry="${BH / 2}"/></clipPath>${bar}` +
    `<clipPath id="lc"><rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" rx="7"/></clipPath>` +
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `<use href="#bar" y="${top}"/>${figures}${columns}${glass}</svg>`
  )
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
  const status = statusOf(snap, d.quality, d.compacting)
  const pressure = status.pressure

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

  // The meter, its lens under the pointer (meterSource)
  const meter = () => {
    if (!Svg) return undefined
    const W = Math.max(160, d.columns * 10)
    // Room above and below the bar for the lens
    const BH = 20
    const H = 40
    const isMarked = budget < Math.max(snap.window, snap.tokens, 1)
    const source = steadyMeter('pane', { snap, delta: d.live.delta, budget, W, BH, H, axis: true }, { isRunning: d.isRunning === true, now: d.now })
    return (
      <Box width="100%">
        <Svg
          source={source}
          alt={`${windowShare}% of the ${fmt(snap.window)} window in use${isMarked ? `, ${limitLabel} marked at ${fmt(budget)}` : ''}`}
          width={W}
          height={H + AXIS}
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
