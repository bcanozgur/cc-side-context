import type { Color } from 'claude-code'

import type { Item, Picker, Row, Snapshot } from '../types'
import { agoOf, eaterLabel, fitWidth, fmt, guardOf, isGuarded, limitName, tipOf } from './analysis'
import {
  type PaneActions,
  type PaneData,
  type Ui,
  budgetOf,
  colorOf,
  isHeavy,
  labelOf,
  nextGuard,
  ruleOf,
  scaled,
  shownEaters,
  statusOf,
  top,
  usageColor,
} from './pane'

// The pane as the desktop app, the editor and the phone draw it: HTML in a
// proportional font, laid out by the page rather than in counted cells.
// One fact per row, in the host's own idiom (a dot, a name, a size, a share);
// the advice behind a row shows under the pointer, the next step is one
// sentence and one primary button, and the rest of the actions sit quietly
// at the foot.

// What a group shows before "Show all"
const SETUP_ROWS = 3
const EATERS = 3
// A row's name up to this long is kept whole while its detail gives way
const SHORT_NAME = 12

// The line between the pane's sections: the track's grey, a touch stronger
const HAIRLINE = '#80808040'
const GUIDE = '#80808066'

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
// composites without repainting the rest), and shows a magnified copy of the
// bar the frame keeps unseen. No selector looks back at earlier siblings and
// nothing is filtered, so a pointer move restyles two elements, not the whole
// drawing. The bar itself is the page's own boxes (meterBox).

// `zoom` is how many times wider the bar shows under the lens, `tall` how many
// times taller, and `width` the lens's own width in pixels
export type MeterLens = { zoom: number; tall: number; width: number }
const LENS: MeterLens = { zoom: 4, tall: 1.5, width: 56 }

// The same figures draw the same markup: a redraw that changed nothing the
// meter shows (a cache countdown, a new trend point) reuses it, and the surface
// is handed the very string it already has
const drawn = new WeakMap<Snapshot, Map<string, string>>()

export const meterSource = (m: { snap: Snapshot; delta: number; budget: number; W: number; BH: number; H: number; lens?: MeterLens }): string => {
  const lens = m.lens ?? LENS
  const key = `${m.delta}|${m.budget}|${m.W}|${m.BH}|${m.H}|${lens.zoom}|${lens.tall}|${lens.width}`
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
// source is a new frame, blank until it loads, which a pointer on the lens
// loses. Every response of a turn moves the figures, so while a turn runs the
// lens keeps what it last drew, unless the context moved a stretch the eye
// would miss or it has been a while; the turn's end draws it afresh. The bar
// and the figures beside it move each step.
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

// The parts along the meter in tokens, the setup largest first, then the
// conversation and the latest turn; and the whole the meter spans
const partsOf = (snap: Snapshot, delta: number) => {
  const inUse = snap.rows.filter(r => r.kind === 'used')
  const conversation = inUse.find(r => /^messages/i.test(r.name))
  const setup = inUse.filter(r => r !== conversation).sort((a, b) => b.tokens - a.tokens)
  const total = inUse.reduce((sum, r) => sum + r.tokens, 0)
  // The rows are an estimate of the same whole: scaled to the measured total
  const ratio = total > 0 ? snap.tokens / total : 0
  const turn = Math.max(0, Math.min(delta, (conversation?.tokens ?? 0) * ratio))
  const parts = [
    ...setup.map(r => ({ name: labelOf(r.name), tokens: r.tokens * ratio, color: colorOf(r.name) })),
    ...(conversation ? [{ name: 'Conversation', tokens: conversation.tokens * ratio - turn, color: colorOf(conversation.name) }] : []),
    ...(conversation && turn > 0 ? [{ name: 'Latest turn', tokens: turn, color: lighter(colorOf(conversation.name)) }] : []),
  ].filter(p => p.tokens > 0)
  return { parts, span: Math.max(snap.window, snap.tokens, 1) }
}

const drawMeter = (m: { snap: Snapshot; delta: number; budget: number; W: number; BH: number; H: number }, lens: MeterLens): string => {
  const { snap, delta, budget, W, BH, H } = m
  const top = (H - BH) / 2
  const { parts, span } = partsOf(snap, delta)
  const x = (tokens: number) => Math.max(0, Math.min(W, (tokens / span) * W))
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
  const bar =
    `<g id="bar" clip-path="url(#r)"><rect width="${W}" height="${BH}" fill="#80808033"/>` +
    (isMarked ? `<rect x="${mark.toFixed(1)}" width="${(W - mark).toFixed(1)}" height="${BH}" fill="${TRACK.past}"/>` : '') +
    `${rects}` +
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
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<style>${css}</style>` +
    `<defs><clipPath id="r"><rect width="${W}" height="${BH}" rx="${BH / 2}" ry="${BH / 2}"/></clipPath>${bar}` +
    `<clipPath id="lc"><rect x="${-LW / 2}" y="${ly}" width="${LW}" height="${LHt}" rx="7"/></clipPath>` +
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `${columns}${glass}</svg>`
  )
}

// The track, and the room past the limit a shade fainter: the window is
// there, but it is better not to reach
const TRACK = { before: '#80808033', past: '#8080801a' } as const

// A figure on the scale, without a trailing .0: 250k, 1M
export const tickOf = (n: number) => fmt(n).replace(/\.0(?=[kM]?$)/, '')

// The desktop tells the engine which row its window starts at, rounded from
// the page's own pixels, and at the very bottom that row can lie past the
// engine's last one (contentRows - bodyRows), which the page measures in
// whole rows of its body. The engine follows the end while a move lands
// at or past its last row, and the page, told to follow, scrolls back to the
// bottom; so a slow wheel up from the bottom, a row at a time, never leaves
// it. A person's move up lands a row short of the end at least, which lets go.
export const unfollowOffset = (e: { offset: number; by: number; bodyRows: number; contentRows: number; origin: { kind: string } }): number => {
  const end = Math.max(0, e.contentRows - e.bodyRows)
  return e.origin.kind === 'person' && e.by < 0 && end > 0 && e.offset >= end ? end - 1 : e.offset
}

// A drawing that only sizes its box, the same markup every time: the page
// keeps it as it is
const spacerOf = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"/>`

// The meter as the page draws it. The bar is the page's own boxes, which
// redraw in place as the figures move; the lens is a frame over it shown only
// under the pointer, since a changed drawing is a new frame, blank (opaque on
// a dark page) until it loads, and the bar would blink with every response.
// A drawing that never changes gives the meter the lens's own size, so the
// lens lies on the bar as drawn; the bar's height is in the page's lines,
// some twenty pixels each, whatever the drawing does.
// Its scale is two figures in the page's own type on either side, 0 and the
// window, read as a number line; the mark says where the limit is.
export const meterBox = (
  ui: Ui,
  m: Parameters<typeof meterSource>[0] & { slot: 'pane' | 'strip'; isFull: boolean; alt: string; turn: { isRunning: boolean; now: number } },
) => {
  const { Box, Text } = ui
  const Svg = 'Svg' in ui ? ui.Svg : undefined
  if (!Svg) return undefined
  const { snap, budget, W, BH, H } = m
  const { parts, span } = partsOf(snap, m.delta)
  const isMarked = budget < span
  const cut = isMarked ? budget : span
  // Lengths share the row as flex weights: the page takes a percentage only
  // in whole numbers, too coarse for a sliver
  const weight = (tokens: number) => +((Math.max(0, tokens) / span) * 1000).toFixed(3)

  type Piece = { from: number; to: number; color: string; isPart: boolean }
  let at = 0
  const pieces: Piece[] = parts.map(p => ({ from: at, to: (at += p.tokens), color: p.color, isPart: true }))
  if (at < span) pieces.push({ from: at, to: span, color: TRACK.before, isPart: false })
  const before = pieces.filter(p => p.from < cut).map(p => ({ ...p, to: Math.min(p.to, cut) }))
  const past = pieces.filter(p => p.to > cut).map(p => ({ ...p, from: Math.max(p.from, cut), color: p.isPart ? p.color : TRACK.past }))
  // A part of 1k or more is never thinner than a sliver
  const piece = (p: Piece) => (
    <Box width={0} flexGrow={weight(p.to - p.from)} minWidth={p.isPart && p.to - p.from >= 1_000 ? 0.2 : 0} height="100%" backgroundColor={p.color} />
  )
  // The limit is a pin through the bar, standing out above and below it, so
  // it reads over any part colour; a mid grey, as clear on a light page as
  // on a dark one
  const pin = isMarked && (
    <Box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center">
      <Box width="100%" height={BH / 20 + 0.6}>
        <Box width={0} flexGrow={weight(cut)} minWidth={0} />
        <Box flexShrink={0} width={0.35} height="100%" backgroundColor="#707070" />
        <Box width={0} flexGrow={weight(span - cut)} minWidth={0} />
      </Box>
    </Box>
  )
  const scope = `side-context-meter-${m.slot}`
  const lens = steadyMeter(m.slot, m, m.turn)
  const figure = (text: string) => (
    <Box flexShrink={0}>
      <Text dimColor>{text}</Text>
    </Box>
  )

  return (
    <Box width={m.isFull ? '100%' : undefined} flexShrink={0} alignItems="center">
      {figure('0')}
      <Box flexGrow={m.isFull ? 1 : 0} flexShrink={m.isFull ? 1 : 0} minWidth={0} marginX={1} hover={{ scope, backgroundColor: '#00000000' }}>
        <Svg source={spacerOf(W, H)} alt={m.alt} width={W} height={H} />
        <Box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center">
          <Box width="100%" height={BH / 20} overflow="hidden" borderStyle="round" borderColor="#00000000" padding={0}>
            {before.map(piece)}
            {past.map(piece)}
          </Box>
        </Box>
        {pin}
        <Box position="absolute" top={0} bottom={0} left={0} right={0} display="none" hover={{ scope, display: 'flex' }}>
          <Svg source={lens} alt={m.alt} width={W} height={H} isInteractive />
        </Box>
      </Box>
      {figure(tickOf(snap.window))}
    </Box>
  )
}


export const drawWebPane = (ui: Ui, d: PaneData, actions: PaneActions) => {
  const { Box, Text, Button } = ui
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
  const isMarked = budget < Math.max(snap.window, snap.tokens, 1)

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

  // The summary is the one framed card: the verdict, the meter and the next
  // step. Every other group is a flat section under a hairline, so the frame
  // marks what matters most rather than every group alike.
  const hairline = <Box width="100%" height={0.05} backgroundColor={HAIRLINE} />
  const section = (key: string, title: string, aside: string | undefined, children: unknown) => (
    <Box key={key} flexDirection="column" width="100%" paddingX={1} marginTop={1} flexShrink={0}>
      {hairline}
      <Box width="100%" justifyContent="space-between" marginTop={1}>
        <Box flexShrink={1} {...clip}>
          <Text bold wrap="truncate-end">
            {title}
          </Text>
        </Box>
        {aside !== undefined && (
          <Box flexShrink={1000} paddingLeft={1} {...clip}>
            <Text dimColor wrap="truncate-end">
              {aside}
            </Text>
          </Box>
        )}
      </Box>
      {children as never}
    </Box>
  )

  // A part's colour as a small square of the page's own boxes, a cell wide
  // and as tall: Setup's is striped with the colours of every part under it,
  // since it is their sum
  const swatch = (colors: string[], key: string) => (
    <Box key={key} width={1} height={0.45} flexShrink={0} overflow="hidden">
      {colors.map((c, i) => (
        <Box key={`${key}-${i}`} width={0} flexGrow={1} height="100%" backgroundColor={c} />
      ))}
    </Box>
  )
  type Mark = { glyph: string; color: Color } | { colors: string[] }
  // Every row of a group keeps the mark's column, marked or not, so the
  // names line up under one another
  const markSlot = (key: string, mark: Mark | undefined) => (
    <Box key={`${key}-mark`} width={2} height={1} flexShrink={0} alignItems="center">
      {mark !== undefined && ('colors' in mark ? swatch(mark.colors, `${key}-swatch`) : <Text color={mark.color}>{mark.glyph}</Text>)}
    </Box>
  )
  // The line a part hangs from: down from Setup's square, a short arm into
  // each part, ending at the last one
  const guide = (key: string, isLast: boolean) => (
    <Box key={`${key}-guide`} width={2} flexShrink={0}>
      <Box width={0.45} flexShrink={0} />
      <Box width={0.15} flexShrink={0} flexDirection="column">
        <Box width="100%" height={isLast ? 0.5 : undefined} flexGrow={isLast ? 0 : 1} backgroundColor={GUIDE} />
      </Box>
      <Box width={0} flexGrow={1} height={0.5} marginRight={0.4} flexDirection="column" justifyContent="flex-end">
        <Box width="100%" height={0.05} backgroundColor={GUIDE} />
      </Box>
    </Box>
  )

  // One row: the mark's column (a part's colour, the guard's target), the
  // name and a dim detail after it, the size and its share. A tip shows under
  // it: always when it asks for action, else under the pointer.
  type RowOf = {
    key: string
    label: string
    detail?: string
    value: string
    share?: string
    mark?: Mark
    hasSlot?: boolean
    tree?: 'mid' | 'last'
    isWarn?: boolean
    isQuiet?: boolean
    tip?: string
    isTipShown?: boolean
  }
  const row = (p: RowOf) => (
    <Box key={p.key} width="100%">
      {p.tree !== undefined && guide(p.key, p.tree === 'last')}
      <Box flexDirection="column" width={0} flexGrow={1} {...clip}>
        <Box width="100%" justifyContent="space-between">
          {/* On a narrow pane the detail gives way first, so the name stays readable */}
          <Box flexShrink={1} {...clip}>
            {(p.hasSlot || p.mark !== undefined) && markSlot(p.key, p.mark)}
            {/* A short name never shrinks: the page shares a shortfall by size,
                and even a fraction of a pixel taken from "Read" draws "Re…" */}
            <Box flexShrink={p.detail !== undefined && p.label.length <= SHORT_NAME ? 0 : 1} {...clip}>
              <Text color={p.isWarn ? 'error' : undefined} wrap="truncate-end">
                {p.label}
              </Text>
            </Box>
            {p.detail !== undefined && (
              <Box flexShrink={1000} {...clip}>
                <Text dimColor wrap="truncate-end">{`\u00a0${p.detail}`}</Text>
              </Box>
            )}
          </Box>
          <Box flexShrink={0} paddingLeft={1}>
            <Text color={p.isWarn ? 'error' : undefined} dimColor={!p.isWarn}>
              {p.value}
            </Text>
            {p.share !== undefined && (
              <Box width={5} justifyContent="flex-end">
                <Text bold={!p.isQuiet} dimColor={p.isQuiet}>
                  {p.share}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
        {p.tip !== undefined && (
          <Box
            display={p.isTipShown ? 'flex' : 'none'}
            hover={p.isTipShown ? undefined : { display: 'flex' }}
            width="100%"
            paddingLeft={p.hasSlot || p.mark !== undefined ? 2 : 0}
            {...clip}
          >
            <Text dimColor={!p.isWarn} color={p.isWarn ? 'error' : undefined} wrap="wrap">
              {p.tip}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )

  // What a collapsed group leaves out; "Show all" at the foot opens it
  const hiddenLine = (key: string, n: number, tokens: number, isTree = false, hasSlot = false) =>
    n > 0 && (
      <Box key={key} width="100%">
        {isTree && guide(key, true)}
        {hasSlot && markSlot(key, undefined)}
        <Box width={0} flexGrow={1} {...clip}>
          <Text dimColor wrap="truncate-end">{`+${n} more · ${fmt(tokens)}`}</Text>
        </Box>
      </Box>
    )

  // The meter, its lens under the pointer and its scale under it (meterBox).
  // Drawn wider than the card, so the page fits it to the card's width
  const windowShare = Math.round((snap.tokens / Math.max(1, snap.window)) * 100)
  const meter = () => (
    <Box width="100%">
      {meterBox(ui, {
        slot: 'pane',
        snap,
        delta: d.live.delta,
        budget,
        W: Math.max(160, d.columns * 9),
        BH: 20,
        H: 40,
        isFull: true,
        alt: `${windowShare}% of the ${fmt(snap.window)} window in use${isMarked ? `, ${limitLabel} marked at ${fmt(budget)}` : ''}`,
        turn: { isRunning: d.isRunning === true, now: d.now },
      })}
    </Box>
  )

  // What to do now: a few words, a line on what the press does, and one
  // primary button; or nothing
  type Next = { text: string; detail?: string; color?: Color; press?: 'compact' | 'guard' | 'handoff' | 'resume' }
  const next: Next | undefined = d.compacting
    ? { text: 'Keeping your goal, rules and decisions…', color: 'claude' }
    : canResume && picker.state === 'closed'
      ? { text: 'Pick up a past session?', press: 'resume' }
      : pressure >= 0.8
        ? { text: 'Compact before answers slip', detail: 'Keeps your goal, rules and decisions', color: 'error', press: 'compact' }
        : pressure >= 0.5 && canGuard
          ? {
              text: 'One output takes a lot of room',
              detail: `Guard asks Claude to ${guardTarget?.tool === 'Read' ? 'read only a range' : 'trim it'} next time`,
              color: 'warning',
              press: 'guard',
            }
          : pressure >= 0.5
            ? { text: 'Hand off before it gets tight', detail: 'Writes a note a fresh session starts from', color: 'warning', press: 'handoff' }
            : undefined

  // Collapsed, each group shows its largest few; "Show all" at the foot opens
  // every group at once, and the finer lists with them
  const setupShown = d.expanded ? setup : setup.filter((r, i) => i < SETUP_ROWS || isLarge(r))
  const setupHidden = setup.filter(r => !setupShown.includes(r))
  const isTarget = (t: (typeof eaten)[number]) => {
    const g = guardOf(t)
    return g !== undefined && guardTarget !== undefined && g.tool === guardTarget.tool && g.key === guardTarget.key
  }
  const eatenShown = d.expanded ? eaten : eaten.filter((t, i) => i < EATERS || isTarget(t))
  const eatenHidden = eaten.filter(t => !eatenShown.includes(t))
  const lists = [
    { key: 'memory', title: 'Memory files', part: 'Memory (CLAUDE.md, rules)', items: snap.memory },
    { key: 'mcp', title: 'Largest MCP tools', part: 'MCP tools', items: snap.mcp },
    { key: 'skills', title: 'Largest skills', part: 'Skills', items: snap.skills },
  ].filter(l => l.items.length > 0)
  const canExpand = d.expanded || setupHidden.length > 0 || eatenHidden.length > 0 || lists.length > 0

  const ACTION = {
    compact: { label: d.compacting ? 'Compacting…' : 'Compact', hotkey: 'c', onPress: actions.compact },
    handoff: { label: 'Handoff', hotkey: 'w', onPress: actions.handoff },
    guard: { label: 'Guard', hotkey: 'x', onPress: actions.guard },
    exact: { label: 'Exact count', hotkey: 'r', onPress: actions.exact },
    resume: { label: picker.state === 'closed' ? 'Resume' : 'Close', hotkey: 'p', onPress: actions.resume },
    more: { label: d.expanded ? 'Show less' : 'Show all', hotkey: 'e', onPress: actions.toggleExpanded },
  } as const
  const action = (key: keyof typeof ACTION, isPrimary = false) => (
    <Box key={`a-${key}`} flexShrink={0}>
      <Button key={key} hotkey={ACTION[key].hotkey} label={ACTION[key].label} variant={isPrimary ? 'primary' : 'secondary'} onPress={ACTION[key].onPress} />
    </Box>
  )

  const room = budget - snap.tokens
  const replied = d.live.lastReply
  const left = replied === null ? 0 : replied + d.ttl - d.now
  const isCold = replied !== null && left <= 0
  // Under the meter, this session's figures; the plan's, which are the
  // account's and not this conversation's, sit at the foot
  const session = [
    `${fmt(snap.tokens)} used`,
    ...(d.live.delta > 0 ? [`+${fmt(d.live.delta)} this turn`] : []),
    ...(replied === null ? [] : [isCold ? 'cache cold' : `cache ${Math.max(1, Math.ceil(left / 60_000))}m`]),
    ...(snap.cost !== undefined && snap.cost >= 0.01 ? [`$${snap.cost.toFixed(2)}`] : []),
  ]

  // The verdict leads with the share of the limit it is read from, so the
  // figure and the advice under it tell the same story; the window's own
  // share is the meter's to show
  const limitShare = Math.round(pressure * 100)
  const summary = (
    <Box key="summary" flexDirection="column" width="100%" borderStyle="round" borderColor="subtle" paddingX={1} flexShrink={0}>
      <Box width="100%" justifyContent="space-between">
        <Box flexShrink={1} {...clip}>
          <Text color={status.color}>{'● '}</Text>
          <Text bold wrap="truncate-end">
            {status.text}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text bold>{`${limitShare}%`}</Text>
          <Text dimColor>{isMarked ? ` of ${tickOf(budget)}` : ' of window'}</Text>
        </Box>
      </Box>
      {meter()}
      <Box width="100%" {...clip}>
        <Text wrap="wrap">
          {room >= 0 ? <Text bold>{`${fmt(room)} left`}</Text> : <Text bold color="error">{`${fmt(-room)} over`}</Text>}
          <Text dimColor>{` ${room >= 0 ? 'before' : 'past'} the ${fmt(budget)} ${limitLabel}`}</Text>
        </Text>
      </Box>
      <Box width="100%" {...clip}>
        <Text dimColor wrap="truncate-end">
          {session.map((f, i) => (
            <Text color={f === 'cache cold' ? 'warning' : undefined}>{`${i > 0 ? ' · ' : ''}${f}`}</Text>
          ))}
        </Text>
      </Box>
      {next && (
        <Box width="100%" justifyContent="space-between" alignItems="center" flexWrap="wrap" marginTop={1} rowGap={0.5} columnGap={1}>
          <Box flexDirection="column" flexShrink={1} {...clip}>
            <Text color={next.color} wrap="wrap">
              {next.text}
            </Text>
            {next.detail !== undefined && (
              <Text dimColor wrap="wrap">
                {next.detail}
              </Text>
            )}
          </Box>
          {next.press && action(next.press, true)}
        </Box>
      )}
    </Box>
  )

  // What is in the window, split by what acts on it: the conversation, which
  // compact and handoff shrink, then the setup loaded at start, which only
  // settings trim, with its parts under it
  const breakdown = section(
    'breakdown',
    'In context',
    `${isExact ? '' : '~'}${fmt(total)}`,
    <Box flexDirection="column" width="100%">
      {conversation &&
        row({
          key: 'row-Conversation',
          mark: { colors: [colorOf(conversation.name)] },
          label: labelOf(conversation.name),
          value: fmt(conversation.tokens),
          share: shareOf(conversation.tokens, total),
          isWarn: isLarge(conversation),
          tip: isLarge(conversation) ? ruleOf(conversation.name)?.fix : undefined,
          isTipShown: true,
        })}
      {setup.length > 0 &&
        row({
          key: 'row-setup',
          mark: { colors: [...new Set(setup.map(r => colorOf(r.name)))] },
          label: 'Setup',
          detail: 'loaded at start',
          value: fmt(setupTokens),
          share: shareOf(setupTokens, total),
        })}
      {setupShown.map((r, i) =>
        row({
          key: `row-${labelOf(r.name)}`,
          tree: i === setupShown.length - 1 && setupHidden.length === 0 ? 'last' : 'mid',
          mark: { colors: [colorOf(r.name)] },
          label: labelOf(r.name),
          value: fmt(r.tokens),
          share: shareOf(r.tokens, total),
          isQuiet: true,
          isWarn: isLarge(r),
          tip: isLarge(r) ? (ruleOf(r.name)?.fix ?? 'Bigger than usual') : undefined,
          isTipShown: true,
        }),
      )}
      {hiddenLine(
        'row-setup-more',
        setupHidden.length,
        setupHidden.reduce((sum, r) => sum + r.tokens, 0),
        true,
        true,
      )}
    </Box>,
  )

  // The tool outputs filling the conversation: the tool, then what it ran on,
  // dim. Only the row Guard acts on, and one already guarded, carry a mark,
  // so no colour here reads as a part of the meter.
  const all = scaled(d.live)
  const hasOutputMarks = eatenShown.some(t => {
    const g = guardOf(t)
    return isTarget(t) || (g !== undefined && isGuarded(d.guards, g))
  })
  const eaters = section(
    'eaters',
    'Biggest outputs',
    conversation && eaten.length > 0 ? 'of conversation' : undefined,
    <Box flexDirection="column" width="100%">
      {eaten.length === 0 && all[0] && <Text dimColor>{`Nothing large yet · the biggest is ~${fmt(all[0].tokens)}`}</Text>}
      {eatenShown.map((t, i) => {
        const g = guardOf(t)
        const isGuard = g !== undefined && isGuarded(d.guards, g)
        const target = isTarget(t)
        const tool = eaterLabel({ tool: t.tool, target: '', count: 1 }).trim()
        const label = eaterLabel(t)
        return row({
          key: `eater-${i}`,
          mark: target ? { glyph: '▸', color: 'claude' } : isGuard ? { glyph: '✓', color: 'success' } : undefined,
          hasSlot: hasOutputMarks,
          label: tool,
          detail: `${label.slice(tool.length).trimStart()}${isGuard ? ' · guarded' : ''}`,
          value: `~${fmt(t.tokens)}`,
          share: conversation ? shareOf(t.tokens, conversation.tokens) : undefined,
          isQuiet: true,
          // The mark says which one Guard acts on; what Guard does is the
          // button's to say, so the row carries no long note
          tip: target || isGuard ? undefined : tipOf(t.tool),
        })
      })}
      {hiddenLine(
        'eater-more',
        eatenHidden.length,
        eatenHidden.reduce((sum, t) => sum + t.tokens, 0),
        false,
        hasOutputMarks,
      )}
    </Box>,
  )

  const resume =
    picker.state === 'closed'
      ? undefined
      : section(
          'resume',
          'Resume a session',
          undefined,
          <Box flexDirection="column" width="100%">
            {picker.state === 'loading' && <Text dimColor>Reading past sessions…</Text>}
            {picker.state === 'open' && picker.sessions.length === 0 && <Text dimColor>No past sessions in this project</Text>}
            {picker.state === 'open' &&
              picker.sessions.map((r, i) => (
                <Box key={`resume-row-${i + 1}`} width="100%" justifyContent="space-between" marginTop={1}>
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

  // The finer lists, under "Show all". Each holds the largest few, so beside
  // its sum stands the whole its In context row counts, when that is more
  const list = (l: (typeof lists)[number]) => {
    const sum = l.items.reduce((s, i) => s + i.tokens, 0)
    const whole = inUse.find(r => labelOf(r.name) === l.part)?.tokens
    const aside = whole !== undefined && sum < whole * 0.95 ? `${fmt(sum)} of ${fmt(whole)}` : fmt(sum)
    return section(
      l.key,
      l.title,
      aside,
      <Box flexDirection="column" width="100%">
        {top(l.items).map((i, n, all) =>
          row({ key: `${l.key}-${n}`, tree: n === all.length - 1 ? 'last' : 'mid', label: i.name, value: fmt(i.tokens), isQuiet: true }),
        )}
      </Box>,
    )
  }

  // The plan's limits, the account's rather than this conversation's: a
  // short bar each, red once nearly spent
  const plan = snap.limits.length > 0 && (
    <Box width="100%" alignItems="center" flexWrap="wrap" marginTop={1} rowGap={0.5} columnGap={1}>
      <Box flexShrink={0}>
        <Text dimColor>Plan</Text>
      </Box>
      {snap.limits.map(l => {
        const p = Math.max(0, Math.min(100, Math.round(l.percent)))
        const fill = usageColor(p)
        return (
          <Box key={`plan-${l.kind}`} width={11} flexGrow={1} alignItems="center">
            <Box flexShrink={0}>
              <Text dimColor>{`${limitName(l.kind)} `}</Text>
            </Box>
            <Box width={0} flexGrow={1} minWidth={2} height={0.25} backgroundColor={`${fill}29`} overflow="hidden">
              <Box width={0} flexGrow={p} height="100%" backgroundColor={fill} />
              <Box width={0} flexGrow={100 - p} />
            </Box>
            <Box flexShrink={0}>
              <Text color={p >= 50 ? fill : undefined} dimColor={p < 50}>{` ${p}%`}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )

  // The actions the next step did not take, quiet, at the foot; the exact count
  // only while the sizes are estimates, and one "Show all" for every group
  const rest = (
    ['compact', 'handoff', ...(canGuard ? ['guard'] : []), ...(isExact ? [] : ['exact']), ...(canResume ? ['resume'] : []), ...(canExpand ? ['more'] : [])] as (keyof typeof ACTION)[]
  ).filter(k => k !== next?.press)

  // The plan's limits are the pane's footer: the tree is held at least as
  // tall as the room the surface gave the body, so they sit at its bottom
  // edge however short the rest; a longer pane scrolls them to its end
  return (
    <Box flexDirection="column" width="100%" minHeight={d.bodyRows ?? '100%'}>
      {summary}
      {resume}
      {inUse.length > 0 && breakdown}
      {all.length > 0 && eaters}
      {d.expanded && lists.map(list)}
      <Box flexDirection="column" width="100%" paddingX={1} marginTop={1} flexShrink={0}>
        {hairline}
        <Box width="100%" flexWrap="wrap" marginTop={1} rowGap={0.5} columnGap={1}>
          {rest.map(k => action(k))}
        </Box>
      </Box>
      {plan && <Box key="spacer" flexGrow={1} />}
      {plan && (
        <Box key="footer" flexDirection="column" width="100%" paddingX={1} marginTop={1} flexShrink={0}>
          {hairline}
          {plan}
        </Box>
      )}
    </Box>
  )
}
