import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionContextUsage, SessionMessage, SessionUsage } from 'claude-code'

import type { Guard, Legend, Live, Memo, Picker, Recent, Snapshot, Square } from '../types'
import {
  EaterIndex,
  GUARD_FLOOR,
  PRESERVE_MARK,
  bashKey,
  projectSlug,
  titleOf,
  eaterLabel,
  fmt,
  guardHit,
  guardMessage,
  handoffOf,
  isLive,
  padWidth,
  preserveOf,
  requestsOf,
  stamp,
  summariesOf,
  toolTokens,
  widthOf,
} from './analysis'
import { TITLE, drawPane, glyphOf, nextGuard, scaled, shownEaters, top } from './pane'

export { fmt }

const PANE = 'side-context'
// Turns of context the trend line keeps
const HISTORY = 48
const HANDOFF = '.claude/side-context/handoff.md'
const HANDOFF_PREV = '.claude/side-context/handoff.prev.md'
const HANDOFF_IGNORE = '.claude/side-context/.gitignore'
const RESUME = `Read @${HANDOFF} and continue from the next step.`
// Below this the cold-cache warning is not worth a toast
const COLD_FLOOR = 20_000
// The grid view keeps /context's exact count, taken again at most this often
const EXACT_EVERY = 60_000
// A guarded call asked again within this long goes through
const RETRY_WINDOW = 10 * 60_000
// Guards one project keeps; the oldest goes first
const MAX_GUARDS = 50
// Sessions whose compaction memo the store keeps
const MAX_MEMOS = 30
// Past sessions the resume list offers
const RECENT = 5
// How much of a transcript's start and end is read for its title
const PEEK = 256 * 1024

const FRESH: Live = {
  snapshot: null,
  delta: 0,
  last: null,
  history: [],
  eaters: [],
  lastReply: null,
  warned: { cold: false, quality: false },
  stats: { peak: 0, compactions: 0, colds: 0 },
  scale: 1,
  exactAt: null,
  memo: { summaries: [] },
  fresh: null,
  seed: null,
}

const live = atom({ plugin: 'cc-side-context', key: 'live' } as const, FRESH)
const expanded = atom({ plugin: 'cc-side-context', key: 'expanded' } as const, false)
const storage = atom({ plugin: 'cc-side-context', key: 'storage' } as const, false)
const tick = atom({ plugin: 'cc-side-context', key: 'tick' } as const, 0)
const compacting = atom({ plugin: 'cc-side-context', key: 'compacting' } as const, false)
const guards = atom({ plugin: 'cc-side-context', key: 'guards' } as const, [])
const picker = atom({ plugin: 'cc-side-context', key: 'picker' } as const, { state: 'closed' } as Picker)

// Several figures change together: they land in one write, one redraw
const patch = ($: EngineInterface, fn: (l: Live) => Partial<Live>) => update($, live, l => ({ ...l, ...fn(l) }))

const percentOf = (tokens: number, window: number) => (window > 0 ? Math.round((tokens / window) * 100) : 0)

// The fill a response reported: the figure, how far the turn has grown it
// since it began, and the peak
const filled = (l: Live, context: SessionContextUsage): Partial<Live> => {
  const tokens = context.tokens
  if (tokens === undefined) return {}
  // The first turn counts from the opening measurement
  const from = l.last ?? l.snapshot?.tokens ?? null
  return {
    delta: from === null ? 0 : tokens - from,
    last: from,
    snapshot: l.snapshot === null ? null : { ...l.snapshot, tokens, percent: context.percent ?? percentOf(tokens, l.snapshot.window) },
    stats: { ...l.stats, peak: Math.max(l.stats.peak, tokens) },
    seed: null,
  }
}

export const toSnapshot = (
  context: SessionContextUsage,
  detail: Snapshot['detail'],
  at: number,
  meter: Pick<SessionUsage, 'rateLimits' | 'cost'> = { rateLimits: [] },
): Snapshot => {
  const b = context.breakdown
  const tokens = context.tokens ?? b?.totalTokens ?? 0
  const window = context.window
  const categories = b?.categories ?? []
  const kindOf = new Map(categories.map(c => [c.name, c.kind]))
  const measuredAgainst = b?.rawMaxTokens ?? window

  const grid: Square[][] = (b?.gridRows ?? []).map(row =>
    row.map(sq => {
      const kind = kindOf.get(sq.categoryName) ?? (sq.categoryName === 'Free space' ? 'free' : 'used')
      return { glyph: glyphOf(kind, sq.squareFullness), color: kind === 'free' ? 'subtle' : sq.color }
    }),
  )
  // /context lists every row it draws, and leaves out the ones loaded on demand
  const legend: Legend[] = categories
    .filter(c => c.kind !== 'deferred')
    .map(c => ({
      name: c.name,
      tokens: c.tokens,
      percent: measuredAgainst > 0 ? (c.tokens / measuredAgainst) * 100 : 0,
      color: c.kind === 'free' ? 'subtle' : c.color,
      glyph: glyphOf(c.kind),
    }))

  return {
    at,
    detail,
    tokens,
    window,
    percent: context.percent ?? percentOf(tokens, window),
    compactAt: b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    rows: categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    memory: top((b?.memoryFiles ?? []).map(f => ({ name: f.path.split('/').slice(-2).join('/'), tokens: f.tokens }))),
    mcp: top(
      (b?.mcpTools ?? [])
        .filter(t => t.isLoaded)
        .map(t => ({ name: t.name.replace(/^mcp__/, '').replace('__', ' › '), tokens: t.tokens })),
    ),
    skills: top((b?.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens }))),
    model: b?.model ?? '',
    grid,
    legend,
    counted: b?.totalTokens ?? tokens,
    measuredAgainst,
    limits: meter.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })),
    cost: meter.cost?.usd,
  }
}

// The tool results already counted, so each scan folds in only the new ones
const index = new EaterIndex()

// An exact count of the conversation over the transcript's own estimate:
// how far off "about four characters a token" is for this session
const scaleOf = (snap: Snapshot): number | undefined => {
  const exact = snap.rows.find(r => /^messages/i.test(r.name))?.tokens
  if (exact === undefined || index.total < 2_000) return undefined
  return Math.min(1.6, Math.max(0.6, exact / index.total))
}

// Bumped each time the conversation is replaced (/clear, /resume): a reading
// begun before is of the old one, and is dropped rather than written over the new
let generation = 0

const refresh = async ($: EngineInterface, detail: Snapshot['detail']) => {
  const gen = generation
  const usage = await $.session.usage({ breakdown: detail })
  const now = await $.clock.now()
  const { seed } = await read($, live)
  // Until its first response a resumed conversation has no fill of its own:
  // the transcript's last one stands in, not the estimate
  const context = usage.context.tokens === undefined && seed !== null ? { ...usage.context, tokens: seed, percent: undefined } : usage.context
  const next = toSnapshot(context, detail, now, usage)
  const scale = detail === 'full' ? scaleOf(next) : undefined
  if (gen !== generation) return
  await patch($, l => ({
    snapshot: next,
    stats: { ...l.stats, peak: Math.max(l.stats.peak, next.tokens) },
    // The trend starts from the first reading, not from the first turn after it
    history: l.history.length === 0 && next.tokens > 0 ? [next.tokens] : l.history,
    ...(detail === 'full' ? { exactAt: now, ...(scale !== undefined ? { scale } : {}) } : {}),
  }))
}

// The tool results still in the conversation, biggest first
const scan = async ($: EngineInterface, messages?: readonly SessionMessage[]) => {
  const gen = generation
  const all = messages ?? (await $.session.messages())
  const cwd = await $.session.cwd().catch(() => '')
  if (gen !== generation) return
  index.update(all, cwd)
  const fresh = requestsOf(all).length === 0
  await patch($, () => ({ eaters: index.top(5), fresh }))
  if (!fresh) await closePicker($)
}

// Both at once, in the background: a failed read leaves the last figures up
const remeasure = ($: EngineInterface, detail: Snapshot['detail'] = 'summary') => {
  void refresh($, detail).catch(() => undefined)
  void scan($).catch(() => undefined)
}

// The breakdown and the eaters as a turn goes: one reading at a time, and
// the responses that land meanwhile fold into one more
let reading = false
let readAgain = false
const readSoon = async ($: EngineInterface) => {
  if (reading) {
    readAgain = true
    return
  }
  reading = true
  try {
    do {
      readAgain = false
      await Promise.all([refresh($, 'summary').catch(() => undefined), scan($).catch(() => undefined)])
    } while (readAgain)
  } finally {
    reading = false
  }
}

// A main-thread response came back: session.measure waits for the turn's
// end, so a turn of many tool calls would hold the opening figures until
// then. The fill and the cache clock move now, the rest is read behind.
const stepped = async ($: EngineInterface) => {
  const { context } = await $.session.usage()
  const at = await $.clock.now()
  // Each request rewrites the cache, so a long turn never lets it go cold
  await patch($, l => ({ ...filled(l, context), lastReply: at, warned: { ...l.warned, cold: false } }))
  // The grid keeps /context's own count, recounted at most once a minute
  if ((await isOpen($)) && !(await read($, storage))) await readSoon($)
}

// A compaction's conversation is installed only once its hook chain returns,
// and the fill stays unreported until the next response: a reading taken
// straight away still sees the old one. The pane takes core's own count now
// and measures again once the new conversation is in place.
const settle = async ($: EngineInterface, before?: number, after?: number) => {
  if (after !== undefined) {
    await patch($, l => ({
      snapshot: l.snapshot === null ? null : { ...l.snapshot, tokens: after, percent: percentOf(after, l.snapshot.window) },
      delta: before === undefined ? 0 : after - before,
      last: after,
      history: [...l.history, after].slice(-HISTORY),
      warned: { ...l.warned, quality: false },
    }))
  }
  $.clock.after(500, () => remeasure($))
}

// The conversation was replaced: readings of the old one still in flight are
// dropped, and the figures start over (from what is known of the new one)
const restart = async ($: EngineInterface, from: Partial<Live> = {}) => {
  generation++
  reading = false
  readAgain = false
  measuring = false
  await update($, live, () => ({ ...FRESH, ...from }))
  await closePicker($)
  remeasure($)
}

// What compactions took out of the transcript, kept per session in the store
// as well, so a /resume still knows the first request
const memoKey = async ($: EngineInterface) => `memo:${await $.session.id()}`

const isMemo = (v: unknown): v is Memo => typeof v === 'object' && v !== null && Array.isArray((v as Memo).summaries)

const memoOf = async ($: EngineInterface): Promise<Memo> => {
  const memo = (await read($, live)).memo
  if (memo.goal !== undefined || memo.summaries.length > 0) return memo
  const stored = await memoKey($)
    .then(k => $.store.get(k))
    .catch(() => undefined)
  return isMemo(stored) ? { ...(typeof stored.goal === 'string' ? { goal: stored.goal } : {}), summaries: stored.summaries.filter(s => typeof s === 'string') } : memo
}

const remember = async ($: EngineInterface, before: readonly SessionMessage[], after: readonly SessionMessage[]) => {
  const memo = await memoOf($)
  const goal = memo.goal ?? requestsOf(before, memo.summaries)[0]
  const next: Memo = { ...(goal !== undefined ? { goal } : {}), summaries: [...memo.summaries, ...summariesOf(before, after)].slice(-10) }
  await patch($, () => ({ memo: next }))
  try {
    const key = await memoKey($)
    await $.store.set(key, next)
    const memos = (await $.store.keys()).filter(k => k.startsWith('memo:') && k !== key)
    for (const old of memos.slice(0, Math.max(0, memos.length - MAX_MEMOS + 1))) await $.store.delete(old)
  } catch {
    // The memo is a nicety: without the store it lasts this session
  }
}

// Resuming a past session, offered only before the first message: the list
// is this project's newest transcripts, and picking one runs /resume with it

const closePicker = async ($: EngineInterface) => {
  if ((await read($, picker)).state !== 'closed') await update($, picker, () => ({ state: 'closed' }) as Picker)
}

// Where this project's transcripts are: the session's own when Claude Code
// said so at its start, else worked out from the config directory
let transcriptDir: string | null = null

const transcriptsOf = async ($: EngineInterface): Promise<string | undefined> => {
  if (transcriptDir !== null && (await $.fs.exists(transcriptDir).catch(() => false))) return transcriptDir
  const cwd = await $.session.cwd()
  const home = await $.env.get('HOME').catch(() => undefined)
  const config = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? (home ? `${home}/.claude` : undefined)
  if (!config) return undefined
  const dir = `${config.replace(/\/+$/, '')}/projects/${projectSlug(cwd)}`
  return (await $.fs.exists(dir).catch(() => false)) ? dir : undefined
}

// The start and the end of a transcript, without reading all of a long one
const peek = async ($: EngineInterface, path: string, size: number): Promise<{ head: string; tail: string }> => {
  if (size <= PEEK * 2) {
    const text = await $.fs.read(path)
    return { head: text, tail: text }
  }
  try {
    const [head, tail] = await Promise.all([$.process.run(['head', '-c', String(PEEK), path]), $.process.run(['tail', '-c', String(PEEK), path])])
    if (head.exitCode === 0 && tail.exitCode === 0) return { head: head.stdout, tail: tail.stdout }
  } catch {
    // No head or tail on this system: read it whole below
  }
  const text = size <= 32 * 1024 * 1024 ? await $.fs.read(path) : ''
  return { head: text.slice(0, PEEK), tail: text.slice(-PEEK) }
}

const recentSessions = async ($: EngineInterface): Promise<Recent[]> => {
  const dir = await transcriptsOf($)
  if (!dir) return []
  const current = await $.session.id().catch(() => '')
  const files = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && f.name !== `${current}.jsonl` && f.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const found: Recent[] = []
  // Sessions nobody typed in are skipped, so look a little further than five
  for (const f of files.slice(0, RECENT * 3)) {
    if (found.length >= RECENT) break
    const { head, tail } = await peek($, `${dir}/${f.name}`, f.size).catch(() => ({ head: '', tail: '' }))
    const title = titleOf(head, tail)
    if (title) found.push({ id: f.name.replace(/\.jsonl$/, ''), title, at: f.mtimeMs })
  }
  return found
}

const resumePressed = async ($: EngineInterface) => {
  if ((await read($, picker)).state !== 'closed') return closePicker($)
  if ((await read($, live)).fresh !== true) return
  await update($, picker, () => ({ state: 'loading' }) as Picker)
  try {
    const sessions = await recentSessions($)
    // A message sent while the list was read closes it
    if ((await read($, picker)).state === 'loading') await update($, picker, () => ({ state: 'open', sessions }) as Picker)
  } catch (err) {
    await closePicker($)
    $.ui.toast(`Could not list past sessions: ${reasonOf(err)}`, { timeoutMs: 8_000 })
  }
}

const pick = async ($: EngineInterface, id: string) => {
  await closePicker($)
  if ((await read($, live)).fresh !== true) return
  try {
    await $.command.run({ command: 'resume', args: id })
  } catch (err) {
    $.ui.toast(`Could not resume: ${reasonOf(err)}. Try /resume ${id}`, { timeoutMs: 10_000 })
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

const show = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: TITLE })
  await refresh($, 'summary')
  await scan($)
}

// Hiding lasts for this session only: every new session opens the pane again
const hide = ($: EngineInterface) => $.ui.close({ id: PANE })

// The prompt cache lasts five minutes on an API key and an hour on a
// subscription; a subscription is the session that reports rate limits
const ttlOf = (options: PluginOptions, snap: Snapshot | null): number => {
  const ttl = options.cacheTtl
  if (ttl === '5m') return 5 * 60_000
  if (ttl === '1h') return 60 * 60_000
  return snap && snap.limits.length > 0 ? 60 * 60_000 : 5 * 60_000
}

// Guards last across sessions, one list a project
const guardKey = async ($: EngineInterface) => `guards:${await $.session.cwd().catch(() => '')}`

const isGuard = (v: unknown): v is Guard =>
  typeof v === 'object' && v !== null && ((v as Guard).tool === 'Read' || (v as Guard).tool === 'Bash') && typeof (v as Guard).key === 'string'

const saveGuards = async ($: EngineInterface, fn: (gs: Guard[]) => Guard[]) => {
  await update($, guards, gs => fn(gs).slice(-MAX_GUARDS))
  const gs = await read($, guards)
  const key = await guardKey($)
  await (gs.length > 0 ? $.store.set(key, gs) : $.store.delete(key))
}

// Guards left idle past their lifetime are dropped as they load
const loadGuards = async ($: EngineInterface) => {
  const stored = await $.store.get(await guardKey($))
  const now = await $.clock.now()
  const all = Array.isArray(stored) ? stored.filter(isGuard) : []
  const kept = all.map(g => (g.at === undefined ? { ...g, at: now } : g)).filter(g => isLive(g, now))
  await update($, guards, () => kept)
  if (kept.length !== all.length || all.some(g => g.at === undefined)) await saveGuards($, () => kept)
}

const guardPressed = async ($: EngineInterface, quality: number) => {
  const g = nextGuard(shownEaters(await read($, live), quality), await read($, guards))
  // The button stays drawn, dim, when there is nothing to guard
  if (!g) {
    $.ui.toast('Nothing to guard yet: a guard takes a large whole-file Read or Bash output', { timeoutMs: 5_000 })
    return
  }
  const at = await $.clock.now()
  await saveGuards($, gs => [...gs, { ...g, at, hits: 0 }])
  $.ui.toast(
    g.tool === 'Read'
      ? `Guarded: a whole read of ${g.label} now asks for a range first (this project)`
      : `Guarded: \`${g.label}\` now asks for its output trimmed first (this project)`,
    { timeoutMs: 8_000 },
  )
}

// The calls sent back, and when: one asked again unchanged goes through, as
// the model asked twice. Each call has its own entry, so parallel calls and
// calls in between do not use up another's retry.
const denied = new Map<string, number>()

const guardCall = async ($: EngineInterface, call: { tool: string; input: Record<string, unknown> }) => {
  const now = await $.clock.now()
  const hit = guardHit(await read($, guards), call, now)
  if (!hit) return undefined
  for (const [k, at] of denied) if (now - at > RETRY_WINDOW) denied.delete(k)
  const id = `${hit.tool}\u0000${hit.tool === 'Bash' ? bashKey(hit.key) : hit.key}`
  if (denied.has(id)) {
    denied.delete(id)
    return undefined
  }
  // A file that has shrunk since is no longer worth sending back
  let tokens = hit.tokens
  if (hit.tool === 'Read') {
    const size = await $.fs
      .stat(hit.key)
      .then(s => s.size)
      .catch(() => undefined)
    if (size !== undefined) {
      tokens = Math.ceil(size / 4)
      if (tokens < GUARD_FLOOR) return undefined
    }
  }
  denied.set(id, now)
  await saveGuards($, gs => gs.map(g => (g.tool === hit.tool && g.key === hit.key ? { ...g, lastHit: now, hits: (g.hits ?? 0) + 1 } : g))).catch(() => undefined)
  return guardMessage(hit, tokens)
}

// A report of the session short enough to paste anywhere
const statsOf = async ($: EngineInterface): Promise<string> => {
  const messages = await $.session.messages()
  await scan($, messages).catch(() => undefined)
  const l = await read($, live)
  const snap = l.snapshot
  const gs = await read($, guards)
  const memo = await memoOf($)
  const turns = requestsOf(messages, memo.summaries).length
  const output = Math.round(toolTokens(messages) * l.scale)
  const all = scaled(l)
  const best = all.slice(0, 3)
  const share = output > 0 ? Math.min(100, Math.round((best.reduce((sum, t) => sum + t.tokens, 0) / output) * 100)) : 0
  const width = Math.max(0, ...best.map(t => widthOf(eaterLabel(t))))
  const hits = gs.reduce((sum, g) => sum + (g.hits ?? 0), 0)
  return [
    'Session stats',
    ...(snap ? [`Context      ${fmt(snap.tokens)} / ${fmt(snap.window)}`] : []),
    `Turns        ${turns}${memo.summaries.length > 0 ? ' since the last compaction' : ''}${snap?.cost !== undefined && snap.cost >= 0.01 ? ` · $${snap.cost.toFixed(2)}` : ''}`,
    // The transcript keeps no sizes or cache times, so these count from launch
    `Since launch peak ${fmt(Math.max(l.stats.peak, snap?.tokens ?? 0))} · compactions ${l.stats.compactions} · cache went cold ${l.stats.colds}×`,
    `Tool output  ~${fmt(output)} in context${best.length > 0 ? ` · the top ${best.length} took ${share}%` : ''}`,
    ...best.map(t => `  ${padWidth(eaterLabel(t), width)}  ~${fmt(t.tokens)}`),
    ...(gs.length > 0 ? [`Guards       ${gs.length} on in this project${hits > 0 ? ` · sent back ${hits} call${hits === 1 ? '' : 's'}` : ''}`] : []),
    'github.com/bcanozgur/cc-side-context',
  ].join('\n')
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Compaction with the keep-list. The plugin's own call does not pass through
// its own compaction hook, so it brings the list and does its own counting.
// The pane shows "Compacting…" while the summary is written, which takes a while.
const compact = async ($: EngineInterface) => {
  if (await read($, compacting)) return
  await update($, compacting, () => true)
  let figures: { before?: number; after?: number } = {}
  try {
    const messages = await $.session.messages()
    const result = await $.session.compact({ instructions: preserveOf(messages) })
    if (result.skip !== undefined) $.ui.toast(`Not compacted: ${result.skip}`)
    else {
      const { tokensBefore: before, tokensAfter: after } = result
      figures = { before, after }
      await patch($, l => ({ stats: { ...l.stats, compactions: l.stats.compactions + 1 } }))
      await remember($, messages, result.messages)
      $.ui.toast(before !== undefined && after !== undefined ? `Compacted ${fmt(before)} → ${fmt(after)}; decisions and changed files kept` : 'Compacted')
    }
  } catch (err) {
    $.ui.toast(`Compaction failed: ${reasonOf(err)}`, { timeoutMs: 10_000 })
  } finally {
    await update($, compacting, () => false)
    await settle($, figures.before, figures.after)
  }
}

// The note goes in the project, so it keeps itself out of git, and the one
// before it is kept beside it
const handoff = async ($: EngineInterface): Promise<string> => {
  const messages = await $.session.messages()
  const note = handoffOf(messages, stamp(await $.clock.now()), await memoOf($))
  const prev = await $.fs.read(HANDOFF).catch(() => undefined)
  await $.fs.write(HANDOFF, note)
  if (typeof prev === 'string' && prev.trim() && prev !== note) await $.fs.write(HANDOFF_PREV, prev).catch(() => undefined)
  if (!(await $.fs.exists(HANDOFF_IGNORE).catch(() => true))) {
    await $.fs.write(HANDOFF_IGNORE, '# Written by cc-side-context: handoff notes hold your prompts, so they stay out of git\n*\n').catch(() => undefined)
  }
  await $.ui.copy({ text: RESUME }).catch(() => undefined)
  return `Handoff written to ${HANDOFF}. Run /clear, then paste (copied): ${RESUME}`
}

const handoffPressed = async ($: EngineInterface) => {
  try {
    $.ui.toast(await handoff($), { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`Could not write the handoff: ${reasonOf(err)}`, { timeoutMs: 10_000 })
  }
}

// Every half minute: the cache countdown moves, a cache gone cold gets one
// warning, and a pane still without figures is measured again
const onTick = async ($: EngineInterface, options: PluginOptions) => {
  const open = await isOpen($)
  const l = await read($, live)
  const now = await $.clock.now()
  // A closed pane has no countdown to move
  if (open) await update($, tick, () => now)
  const snap = l.snapshot
  if (!snap) {
    if (open) remeasure($)
    return
  }
  const at = l.lastReply
  if (at === null || snap.tokens < COLD_FLOOR) return
  if (now - at < ttlOf(options, snap) || l.warned.cold) return
  await patch($, x => ({ warned: { ...x.warned, cold: true }, stats: { ...x.stats, colds: x.stats.colds + 1 } }))
  $.ui.toast(`Prompt cache expired: your next message re-sends ${fmt(snap.tokens)} tokens uncached. A handoff and /clear is cheaper.`, {
    timeoutMs: 10_000,
  })
}

// Opening a drawing with no figures yet (a resumed or cleared conversation)
// measures once; the write redraws it
let measuring = false
const measureOnce = async ($: EngineInterface) => {
  if (measuring) return
  measuring = true
  try {
    await refresh($, 'summary')
    await scan($)
  } finally {
    measuring = false
  }
}

// The desktop app draws the pane in a proportional font, where glyphs run
// wider than the cells the layout counts; asked once, it does not change
let desktop: Promise<boolean> | undefined
const isDesktop = ($: EngineInterface) =>
  (desktop ??= $.env
    .get('CLAUDE_CODE_ENTRYPOINT')
    .then(v => v === 'claude-desktop')
    .catch(() => false))

export const register: Register = (on, options) => {
  const quality = typeof options.qualityBudget === 'number' && options.qualityBudget >= 0 ? options.qualityBudget : 250_000
  const smartCompact = options.smartCompact !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'side-context',
      description: 'Live context pane: toggle it, compact with a keep-list, write a handoff, or share session stats',
      argumentHint: '[on|off|full|compact|handoff|stats|guards [clear]]',
    })
    await loadGuards($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })
    remeasure($)
    $.clock.every(30_000, () => void onTick($, options).catch(() => undefined))

    return next(e)
  })

  // A conversation that replaced the last one (/clear, /resume) starts the
  // running figures over and is measured at once, not at its first reply
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await restart($)
    return next(e)
  })

  on('command.run', { command: 'side-context' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')

    // A command holds the turn it runs in and compacting under it is refused,
    // so the compaction starts once the command has answered
    if (arg === 'compact') {
      $.clock.after(250, () => void compact($))
      return { text: 'Compacting with the keep-list (goal, rules, changed files, decisions, next step)…' }
    }
    if (arg === 'handoff') {
      try {
        return { text: await handoff($) }
      } catch (err) {
        return { text: `Could not write the handoff: ${reasonOf(err)}` }
      }
    }
    if (arg === 'stats') {
      const text = await statsOf($)
      await $.ui.copy({ text }).catch(() => undefined)
      return { text: `${text}\n\n(copied)` }
    }
    if (arg === 'guards clear') {
      await saveGuards($, () => [])
      return { text: 'Guards cleared for this project.' }
    }
    if (arg === 'guards') {
      const gs = await read($, guards)
      return {
        text:
          gs.length === 0
            ? 'No guards in this project. Press x in the pane to guard the biggest context eater.'
            : [
                'Guards in this project:',
                ...gs.map(g => `- ${g.tool} ${g.label} (~${fmt(g.tokens)})${g.hits ? ` · sent back ${g.hits}×` : ''}`),
                '',
                'A guard left unused for 30 days is dropped. /side-context guards clear removes them all.',
              ].join('\n'),
      }
    }
    if (arg === 'help' || arg === '?') {
      return {
        text: [
          '/side-context            toggle the pane',
          '/side-context on|off     show or hide it',
          '/side-context full       show it with an exact count (token-count API)',
          '/side-context compact    compact, keeping goal, rules, files, decisions, next step',
          '/side-context handoff    write .claude/side-context/handoff.md for a fresh session',
          '/side-context stats      a shareable summary of this session (copied)',
          '/side-context guards     list the guards in this project; "guards clear" removes them',
        ].join('\n'),
      }
    }

    const known = ['', 'on', 'show', 'off', 'hide', 'full']
    if (!known.includes(arg)) return { text: `Unknown option "${arg}". /side-context help lists them.` }

    const open = await isOpen($)
    if (arg === 'off' || arg === 'hide' || (arg === '' && open)) {
      await hide($)
      return { text: 'Context pane hidden. /side-context brings it back.' }
    }
    await show($)
    if (arg === 'full') await refresh($, 'full')

    return { text: 'Context pane shown.' }
  })

  // Observe only: the fill lands now, the breakdown is read in the background
  // so the engine never waits on it
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const tokens = e.context.tokens
      if (tokens !== undefined) await patch($, l => ({ ...filled(l, e.context), history: [...l.history, tokens].slice(-HISTORY) }))
      if (await isOpen($)) {
        // The grid stands for /context, so it keeps /context's own count, taken
        // again now and then; the list is redrawn from the free estimate
        const l = await read($, live)
        const now = await $.clock.now()
        if (!(await read($, storage))) void refresh($, 'summary').catch(() => undefined)
        else if (l.exactAt === null || now - l.exactAt >= EXACT_EVERY) void refresh($, 'full').catch(() => undefined)
      }

      // One warning on crossing the quality budget, again only after dropping back
      const l = await read($, live)
      const limit = l.snapshot?.compactAt ?? l.snapshot?.window ?? e.context.window
      if (tokens !== undefined && quality > 0 && quality < limit) {
        const over = tokens >= quality
        if (over && !l.warned.quality) {
          $.ui.toast(`Context passed ${fmt(quality)}: long conversations start losing early details. Press c in the pane to compact, or w for a handoff.`, {
            timeoutMs: 10_000,
          })
        }
        if (over !== l.warned.quality) await patch($, x => ({ warned: { ...x.warned, quality: over } }))
      }
    }
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      await patch($, l => ({
        snapshot:
          l.snapshot === null
            ? null
            : { ...l.snapshot, limits: e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })), cost: e.cost?.usd ?? l.snapshot.cost },
      }))
    }

    return next(e)
  })

  // Remembers where this session's transcript is, for the resume list. A
  // resumed conversation is in place by now, where session.end saw the old
  // one: the figures start over from it, its fill and its cache age taken
  // from the transcript until its first response reports its own
  on('classic.SessionStart', async ($, e, next) => {
    const path = (e as { transcript_path?: unknown }).transcript_path
    if (typeof path === 'string' && path.includes('/')) transcriptDir = path.slice(0, path.lastIndexOf('/'))
    if (e.source === 'resume' || e.source === 'fork' || e.source === 'clear') {
      const tokens = typeof e.context_tokens === 'number' && e.context_tokens > 0 ? e.context_tokens : null
      const since = typeof e.seconds_since_last_response === 'number' ? e.seconds_since_last_response : undefined
      const now = await $.clock.now()
      await restart($, {
        seed: tokens,
        last: tokens,
        history: tokens === null ? [] : [tokens],
        lastReply: since === undefined ? null : now - since * 1000,
        warned: { ...FRESH.warned, cold: e.prompt_cache_likely_expired === true },
      })
      settle($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The first message ends the chance to resume: the button goes, and a list
  // still open closes
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, live)).fresh !== false) await patch($, () => ({ fresh: false }))
    await closePicker($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn's growth counts from where the context stood as it began, whatever
  // measures in between (a rate-limit window moving, the session's first);
  // the last turn's leaves the bar's end as this one starts
  on('turn.start', async ($, e, next) => {
    await patch($, l => ({ last: l.snapshot?.tokens ?? l.last, delta: 0 }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each response of the main thread moves the pane, not only the turn's end;
  // the stream passes through untouched and nothing waits on the reading
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage !== null) void stepped($).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const at = await $.clock.now()
      await patch($, l => ({ lastReply: at, warned: { ...l.warned, cold: false } }))
      await update($, tick, () => at)
      if (await isOpen($)) void scan($).catch(() => undefined)
    }
    return next(e)
  })

  // Every compaction, auto and /compact alike, keeps what a summary tends to
  // drop: the person's own rules, the files changed, the decisions, the next step
  on('session.compact', async ($, e, next) => {
    const isOurs = (e.instructions ?? '').includes(PRESERVE_MARK)
    const instructions = smartCompact && !isOurs && e.messages.length > 0 ? [e.instructions, preserveOf(e.messages)].filter(Boolean).join('\n\n') : e.instructions
    const result = await next({ ...e, instructions })
    // The pane's own compaction counts itself once it has the figures
    if (e.trigger !== 'precompute' && !e.agentId && result.skip === undefined) {
      if (!isOurs) await patch($, l => ({ stats: { ...l.stats, compactions: l.stats.compactions + 1 } }))
      await remember($, e.messages, result.messages).catch(() => undefined)
      await settle($, result.tokensBefore, result.tokensAfter)
    }
    return result
    // A failure here must never stop the compaction itself
  }).catch(($, e, next) => next(e))

  // A guarded call is sent back once with how to make it smaller; a guard
  // that fails lets the call through
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const deny = await guardCall($, { tool: 'Read', input: e as unknown as Record<string, unknown> })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guardCall($, { tool: 'Bash', input: e as unknown as Record<string, unknown> })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const l = await read($, live)
    const isStorage = await read($, storage)
    const data = {
      live: l,
      expanded: await read($, expanded),
      storage: isStorage,
      compacting: await read($, compacting),
      guards: await read($, guards),
      picker: await read($, picker),
      now: Math.max(await read($, tick), await $.clock.now()),
      columns: e.props.bodyColumns,
      desktop: await isDesktop($),
      rows: e.props.placement === 'dock' ? e.props.scroll?.bodyRows : undefined,
      quality,
      ttl: ttlOf(options, l.snapshot),
    }
    // Started once every read is in, so the figures it writes redraw the pane
    if (!l.snapshot) void measureOnce($).catch(() => undefined)
    return drawPane(
      ui,
      data,
      {
        compact: () => void compact($),
        handoff: () => void handoffPressed($),
        guard: () => void guardPressed($, quality).catch(() => undefined),
        toggleExpanded: () => void update($, expanded, v => !v),
        toggleStorage: () => {
          void update($, storage, v => !v)
          // The grid is /context's, so it is drawn from /context's own count
          if (!isStorage) void refresh($, 'full').catch(() => undefined)
        },
        exact: () => void refresh($, 'full').catch(() => undefined),
        resume: () => void resumePressed($).catch(() => undefined),
        pick: (id: string) => void pick($, id),
      },
    )
  })
}
