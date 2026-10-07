import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionContextUsage, SessionUsage } from 'claude-code'

import type { Guard, Item, Legend, Row, Snapshot, Square } from '../types'
import {
  PRESERVE_MARK,
  eatersOf,
  fmt,
  guardHit,
  guardMessage,
  guardOf,
  handoffOf,
  limitName,
  preserveOf,
  sparkline,
  stamp,
  tipOf,
  toolLabel,
  toolTokens,
} from './analysis'

export { fmt }

const PANE = 'side-context'
const TITLE = 'Context'
// Wider than this and the numbers drift too far from their labels to read
const MAX_WIDTH = 52
const LIST_SIZE = 8
// Turns of context the trend line keeps
const HISTORY = 48
const HANDOFF = '.claude/side-context/handoff.md'
const RESUME = `Read @${HANDOFF} and continue from the next step.`
// Below this the cold-cache warning is not worth a toast
const COLD_FLOOR = 20_000

const snapshot = atom({ plugin: 'cc-side-context', key: 'snapshot' } as const, null)
const delta = atom({ plugin: 'cc-side-context', key: 'delta' } as const, 0)
const last = atom({ plugin: 'cc-side-context', key: 'last' } as const, null)
const expanded = atom({ plugin: 'cc-side-context', key: 'expanded' } as const, false)
const storage = atom({ plugin: 'cc-side-context', key: 'storage' } as const, false)
const history = atom({ plugin: 'cc-side-context', key: 'history' } as const, [])
const eaters = atom({ plugin: 'cc-side-context', key: 'eaters' } as const, [])
const lastReply = atom({ plugin: 'cc-side-context', key: 'lastReply' } as const, null)
const tick = atom({ plugin: 'cc-side-context', key: 'tick' } as const, 0)
const warned = atom({ plugin: 'cc-side-context', key: 'warned' } as const, { cold: false, quality: false })
const compacting = atom({ plugin: 'cc-side-context', key: 'compacting' } as const, false)
const guards = atom({ plugin: 'cc-side-context', key: 'guards' } as const, [])
const stats = atom({ plugin: 'cc-side-context', key: 'stats' } as const, { turns: 0, peak: 0, compactions: 0, colds: 0 })

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
const budgetOf = (snap: Snapshot, quality: number): number => {
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
const glyphOf = (kind: Row['kind'] | undefined, fullness = 1): string =>
  kind === 'free' ? GLYPH.free : kind === 'buffer' ? GLYPH.buffer : fullness < 0.7 ? GLYPH.partial : GLYPH.full

const top = (items: Item[]): Item[] => [...items].sort((a, b) => b.tokens - a.tokens).slice(0, LIST_SIZE)

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
    percent: context.percent ?? (window > 0 ? Math.round((tokens / window) * 100) : 0),
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


const refresh = async ($: EngineInterface, detail: Snapshot['detail']) => {
  const usage = await $.session.usage({ breakdown: detail })
  const next = toSnapshot(usage.context, detail, await $.clock.now(), usage)
  await update($, snapshot, () => next)
  await update($, stats, s => ({ ...s, peak: Math.max(s.peak, next.tokens) }))
  // The trend starts from the first reading, not from the first turn after it
  if (next.tokens > 0) await update($, history, h => (h.length === 0 ? [next.tokens] : h))
}

// The tool results still in the conversation, biggest first
const scan = async ($: EngineInterface) => {
  const messages = await $.session.messages()
  const cwd = await $.session.cwd().catch(() => '')
  await update($, eaters, () => eatersOf(messages, 5, cwd))
}

// Both at once, in the background: a failed read leaves the last figures up
const remeasure = ($: EngineInterface, detail: Snapshot['detail'] = 'summary') => {
  void refresh($, detail).catch(() => undefined)
  void scan($).catch(() => undefined)
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

const loadGuards = async ($: EngineInterface) => {
  const stored = await $.store.get(await guardKey($))
  await update($, guards, () => (Array.isArray(stored) ? (stored as Guard[]) : []))
}

const saveGuards = async ($: EngineInterface, fn: (gs: Guard[]) => Guard[]) => {
  await update($, guards, fn)
  const gs = await read($, guards)
  const key = await guardKey($)
  await (gs.length > 0 ? $.store.set(key, gs) : $.store.delete(key))
}

// The biggest eater that can be guarded and is not yet
const nextGuard = (eaten: readonly Parameters<typeof guardOf>[0][], gs: readonly Guard[]): Guard | undefined =>
  eaten.map(guardOf).find(g => g !== undefined && !gs.some(x => x.tool === g.tool && x.key === g.key))

const guardPressed = async ($: EngineInterface) => {
  const g = nextGuard(await read($, eaters), await read($, guards))
  if (!g) return
  await saveGuards($, gs => [...gs, g])
  $.ui.toast(
    g.tool === 'Read'
      ? `Guarded: a whole read of ${g.label} now asks for a range first (this project)`
      : `Guarded: \`${g.label}\` now asks for its output trimmed first (this project)`,
    { timeoutMs: 8_000 },
  )
}

// A denied call made again unchanged goes through: the model asked twice
let lastDenied: string | null = null

const guardCall = async ($: EngineInterface, call: { tool: string; input: Record<string, unknown> }) => {
  const hit = guardHit(await read($, guards), call)
  if (!hit) return undefined
  const id = `${hit.tool}\u0000${hit.key}`
  if (lastDenied === id) {
    lastDenied = null
    return undefined
  }
  lastDenied = id
  return guardMessage(hit)
}

// A report of the session short enough to paste anywhere
const statsOf = async ($: EngineInterface): Promise<string> => {
  const messages = await $.session.messages()
  const cwd = await $.session.cwd().catch(() => '')
  const snap = await read($, snapshot)
  const s = await read($, stats)
  const gs = await read($, guards)
  const output = toolTokens(messages)
  const top = eatersOf(messages, 3, cwd)
  const share = output > 0 ? Math.round((top.reduce((sum, t) => sum + t.tokens, 0) / output) * 100) : 0
  const width = Math.max(0, ...top.map(t => `${toolLabel(t.tool)} ${t.target}${t.count > 1 ? ` ×${t.count}` : ''}`.length))
  return [
    'Session stats',
    ...(snap ? [`Context      ${fmt(snap.tokens)} / ${fmt(snap.window)} now · peak ${fmt(Math.max(s.peak, snap.tokens))}`] : []),
    `Turns        ${s.turns} · compactions ${s.compactions} · cache went cold ${s.colds}×${snap?.cost !== undefined && snap.cost >= 0.01 ? ` · $${snap.cost.toFixed(2)}` : ''}`,
    `Tool output  ~${fmt(output)} in context${top.length > 0 ? ` · the top ${top.length} took ${share}%` : ''}`,
    ...top.map(t => {
      const label = `${toolLabel(t.tool)} ${t.target}${t.count > 1 ? ` ×${t.count}` : ''}`
      return `  ${label.padEnd(width)}  ~${fmt(t.tokens)}`
    }),
    ...(gs.length > 0 ? [`Guards       ${gs.length} on in this project`] : []),
    'github.com/bcanozgur/cc-side-context',
  ].join('\n')
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Compaction with the keep-list. The plugin's own call does not pass through
// its own compaction hook, so it brings the list itself. The pane shows
// "Compacting…" while the summary is written, which takes a while.
const compact = async ($: EngineInterface) => {
  if (await read($, compacting)) return
  await update($, compacting, () => true)
  try {
    const result = await $.session.compact({ instructions: preserveOf(await $.session.messages()) })
    if (result.skip !== undefined) $.ui.toast(`Not compacted: ${result.skip}`)
    else {
      const { tokensBefore: before, tokensAfter: after } = result
      await update($, stats, s => ({ ...s, compactions: s.compactions + 1 }))
      $.ui.toast(before !== undefined && after !== undefined ? `Compacted ${fmt(before)} → ${fmt(after)}; decisions and changed files kept` : 'Compacted')
    }
  } catch (err) {
    $.ui.toast(`Compaction failed: ${reasonOf(err)}`, { timeoutMs: 10_000 })
  } finally {
    await update($, compacting, () => false)
    remeasure($)
  }
}

const handoff = async ($: EngineInterface): Promise<string> => {
  const messages = await $.session.messages()
  await $.fs.write(HANDOFF, handoffOf(messages, stamp(await $.clock.now())))
  await $.ui.copy({ text: RESUME })
  return `Handoff written to ${HANDOFF}. Run /clear, then paste (copied): ${RESUME}`
}

const handoffPressed = async ($: EngineInterface) => {
  try {
    $.ui.toast(await handoff($), { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`Could not write the handoff: ${reasonOf(err)}`, { timeoutMs: 10_000 })
  }
}

// A conversation that replaced the last one (/clear, /resume) starts the
// running figures over and is measured at once, not at its first reply
const restart = async ($: EngineInterface) => {
  await update($, history, () => [])
  await update($, eaters, () => [])
  await update($, lastReply, () => null)
  await update($, last, () => null)
  await update($, delta, () => 0)
  await update($, warned, () => ({ cold: false, quality: false }))
  await update($, stats, () => ({ turns: 0, peak: 0, compactions: 0, colds: 0 }))
  await update($, snapshot, () => null)
}

// Every half minute: the cache countdown moves, a cache gone cold gets one
// warning, and a pane still without figures is measured again
const onTick = async ($: EngineInterface, options: PluginOptions) => {
  const now = await $.clock.now()
  await update($, tick, () => now)
  const snap = await read($, snapshot)
  if (!snap) {
    if (await isOpen($)) remeasure($)
    return
  }
  const at = await read($, lastReply)
  if (at === null || snap.tokens < COLD_FLOOR) return
  if (now - at < ttlOf(options, snap) || (await read($, warned)).cold) return
  await update($, warned, w => ({ ...w, cold: true }))
  await update($, stats, s => ({ ...s, colds: s.colds + 1 }))
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

export const register: Register = (on, options) => {
  const quality = typeof options.qualityBudget === 'number' ? options.qualityBudget : 250_000
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

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await restart($)
    return next(e)
  })

  on('command.run', { command: 'side-context' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

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
            : ['Guards in this project:', ...gs.map(g => `- ${g.tool} ${g.label} (~${fmt(g.tokens)})`), '', '/side-context guards clear removes them.'].join('\n'),
      }
    }

    const open = await isOpen($)
    if (arg === 'off' || arg === 'hide' || (arg === '' && open)) {
      await hide($)
      return { text: 'Context pane hidden. /side-context brings it back.' }
    }
    await show($)
    if (arg === 'full') await refresh($, 'full')

    return { text: 'Context pane shown.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const tokens = e.context.tokens
      if (tokens !== undefined) {
        // The first turn counts from the opening measurement
        const prev = (await read($, last)) ?? (await read($, snapshot))?.tokens ?? null
        await update($, delta, () => (prev === null ? 0 : tokens - prev))
        await update($, last, () => tokens)
        await update($, history, h => [...h, tokens].slice(-HISTORY))
      }
      // The grid stands for /context, so it keeps /context's own count; the
      // list is redrawn from the free estimate
      if (await isOpen($)) await refresh($, (await read($, storage)) ? 'full' : 'summary')

      // One warning on crossing the quality budget, again only after dropping back
      const snap = await read($, snapshot)
      if (tokens !== undefined && snap !== null && quality > 0 && quality < (snap.compactAt ?? snap.window)) {
        const over = tokens >= quality
        const w = await read($, warned)
        if (over && !w.quality) {
          $.ui.toast(`Context passed ${fmt(quality)}: long conversations start losing early details. Press c in the pane to compact, or w for a handoff.`, {
            timeoutMs: 10_000,
          })
        }
        if (over !== w.quality) await update($, warned, v => ({ ...v, quality: over }))
      }
    }
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      await update($, snapshot, s =>
        s === null ? s : { ...s, limits: e.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })), cost: e.cost?.usd ?? s.cost },
      )
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const at = await $.clock.now()
      await update($, lastReply, () => at)
      await update($, tick, () => at)
      await update($, warned, w => ({ ...w, cold: false }))
      await update($, stats, s => ({ ...s, turns: s.turns + 1 }))
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
      if (!isOurs) await update($, stats, s => ({ ...s, compactions: s.compactions + 1 }))
      remeasure($)
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const change = await read($, delta)
    const isExpanded = await read($, expanded)
    const isStorage = await read($, storage)
    const isCompacting = await read($, compacting)
    const trend = await read($, history)
    const eaten = await read($, eaters)
    const guarded = await read($, guards)
    const replied = await read($, lastReply)
    const now = Math.max(await read($, tick), await $.clock.now())
    const width = Math.max(24, Math.min(MAX_WIDTH, e.props.bodyColumns))

    // Lines truncate rather than wrap, so resizing keeps the pane's height;
    // only advice wraps, as cutting it loses the point.
    // Each row is label then number, the number flush with the pane's right
    // edge; a flag sits just before the number and colours it.
    const line = (props: { label: string; value?: string; flag?: boolean; mark?: string; markColor?: string; dim?: boolean }) => {
      const mark = props.mark ?? '  '
      const value = `${props.flag ? `${flagGlyph} ` : ''}${props.value ?? ''}`
      const fit = Math.max(1, width - mark.length - value.length - 1)
      const label = props.label.length > fit ? `${props.label.slice(0, fit - 1)}…` : props.label
      return (
        <Box width={width}>
          <Text color={props.markColor}>{mark}</Text>
          <Text dimColor={props.dim}>{label.padEnd(fit + 1)}</Text>
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
        <Box width={width - 4}>
          <Text dimColor wrap="wrap">{text}</Text>
        </Box>
      </Box>
    )
    const hint = (props: { text: string }) => (
      <Box width={width} paddingLeft={2}>
        <Text dimColor wrap="truncate-end">{props.text}</Text>
      </Box>
    )

    // An estimate counts some rows well above what /context finds (tool schemas
    // most), so only the exact count may say a row is too large; an estimate
    // can only raise the question
    const isExact = snap?.detail === 'full'
    const flagGlyph = isExact ? '*' : '?'
    const flagColor = isExact ? 'error' : 'warning'

    if (!snap) {
      void measureOnce($).catch(() => undefined)
      return (
        <Box flexDirection="column" width={width}>
          <Text bold>{TITLE}</Text>
          <Text dimColor>Measuring…</Text>
        </Box>
      )
    }

    // Pressure is measured against the budget, not the raw window
    const budget = budgetOf(snap, quality)
    const isQualityFirst = budget < (snap.compactAt ?? snap.window)
    const pressure = budget > 0 ? snap.tokens / budget : 0
    const status = isCompacting
      ? { color: 'claude', text: '◌ Compacting' }
      : pressure >= 0.8
        ? { color: 'error', text: isQualityFirst ? '● Time to compact' : '● Near compact' }
        : pressure >= 0.5
          ? { color: 'warning', text: '● Filling' }
          : { color: 'success', text: '● Healthy' }

    const inWindow = snap.rows.filter(r => r.kind !== 'deferred')
    const deferred = snap.rows.filter(r => r.kind === 'deferred')
    const flagged = inWindow.filter(r => isHeavy(r, snap, quality))
    const total = inWindow.reduce((sum, r) => sum + r.tokens, 0) || snap.window

    // One bar, each category a run of cells in /context's own colours
    let used = 0
    const segments = inWindow.map(r => {
      const cells = Math.round(((used + r.tokens) / total) * width) - Math.round((used / total) * width)
      used += r.tokens
      return { ...r, cells }
    })

    // How far it may still grow, and where the trend has been
    const room =
      snap.compactAt === undefined
        ? 'auto-compact off'
        : isQualityFirst
          ? `${fmt(Math.max(0, budget - snap.tokens))} to quality limit`
          : `${fmt(Math.max(0, snap.compactAt - snap.tokens))} to auto-compact`
    const spark = trend.length >= 1 ? `${sparkline(trend, Math.max(budget, ...trend), Math.max(6, width - room.length - 2))}  ` : ''

    // Every message sends the whole conversation again: cheap while the prompt
    // cache holds it, paid in full once it lapses
    const left = replied === null ? 0 : replied + ttlOf(options, snap) - now
    const isCold = replied !== null && left <= 0
    const meter = [
      ...(replied === null ? [] : [isCold ? 'cache cold' : `cache ${Math.max(1, Math.ceil(left / 60_000))}m`]),
      ...snap.limits.map(l => `${limitName(l.kind)} ${Math.round(l.percent)}%`),
      ...(snap.cost !== undefined && snap.cost >= 0.01 ? [`$${snap.cost.toFixed(2)}`] : []),
    ]

    const list = (title: string, items: Item[], limit: number) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        {items.length === 0 ? hint({ text: 'none' }) : items.map(i => line({ label: i.name, value: fmt(i.tokens), flag: i.tokens > limit, dim: true }))}
      </Box>
    )

    // /context's grid and the rows beside it, stacked: the pane is too narrow
    // to hold them side by side
    const storageView = () => {
      const cols = snap.grid[0]?.length ?? 0
      const gap = width >= cols * 2 ? ' ' : ''
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box width={width}>
            <Text wrap="truncate-end">
              <Text bold>Context Usage</Text>
              <Text dimColor>{snap.model ? `  ${snap.model}` : ''}</Text>
            </Text>
          </Box>
          <Box width={width}>
            <Text dimColor wrap="truncate-end">
              {`${fmt(snap.counted)}/${fmt(snap.measuredAgainst)} tokens (${Math.round((snap.counted / (snap.measuredAgainst || 1)) * 100)}%)`}
            </Text>
          </Box>
          {snap.grid.length === 0 ? (
            hint({ text: 'No grid yet' })
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {snap.grid.map(row => (
                <Text>
                  {row.map(sq => (
                    <Text color={sq.color}>{`${sq.glyph}${gap}`}</Text>
                  ))}
                </Text>
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
        </Box>
      )
    }

    const inUse = inWindow.filter(r => r.kind === 'used')
    const canGuard = !isStorage && nextGuard(eaten, guarded) !== undefined
    const time = new Date(snap.at).toTimeString().slice(0, 5)
    const footer = isExact ? `Exact count · ${time}` : flagged.length > 0 ? `Estimate · ? may be large, r to check · ${time}` : `Estimate · ${time}`

    return (
      <Box flexDirection="column" width={width}>
        <Box width={width} justifyContent="space-between">
          <Text>
            <Text bold color={status.color}>{status.text}</Text>
            <Text bold>{`  ${fmt(snap.tokens)}`}</Text>
            <Text dimColor>{` / ${fmt(snap.window)}`}</Text>
          </Text>
          <Text color={change > 0 ? 'warning' : 'success'}>{change === 0 ? '' : `${change > 0 ? '+' : '−'}${fmt(Math.abs(change))}`}</Text>
        </Box>
        {!isStorage && (
          <Text>
            {segments.map(s =>
              s.cells > 0 ? (
                <Text color={s.kind === 'free' ? 'subtle' : s.color}>
                  {(s.kind === 'free' ? '░' : s.kind === 'buffer' ? '▒' : '█').repeat(s.cells)}
                </Text>
              ) : null,
            )}
          </Text>
        )}
        <Box width={width}>
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

        {/* What is in the window; free space and the reserve are the bar's pale end */}
        {!isStorage && (
          <Box flexDirection="column" marginTop={1}>
            {inUse.map(r => {
              const heavy = isHeavy(r, snap, quality)
              return (
                <Box flexDirection="column">
                  {line({ mark: '■ ', markColor: r.color, label: labelOf(r.name), value: fmt(r.tokens), flag: heavy })}
                  {heavy && advice(ruleOf(r.name)?.fix ?? 'Bigger than usual')}
                </Box>
              )
            })}
          </Box>
        )}

        {isStorage && storageView()}

        {!isStorage && eaten.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Top context eaters</Text>
            {eaten.map(t => {
              const g = guardOf(t)
              const isGuarded = g !== undefined && guarded.some(x => x.tool === g.tool && x.key === g.key)
              return line({
                mark: isGuarded ? '⊘ ' : '  ',
                markColor: 'success',
                label: `${toolLabel(t.tool)} ${t.target}${t.count > 1 ? ` ×${t.count}` : ''}`,
                value: `~${fmt(t.tokens)}`,
                dim: true,
              })
            })}
            {eaten[0] && advice(tipOf(eaten[0].tool))}
          </Box>
        )}

        {!isStorage && isExpanded && deferred.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Loaded on demand (not in context)</Text>
            {deferred.map(r => line({ label: labelOf(r.name), value: fmt(r.tokens), dim: true }))}
          </Box>
        )}
        {!isStorage && isExpanded && list('Memory files', snap.memory, ITEM_LIMIT.memory)}
        {!isStorage && isExpanded && list('Loaded MCP tools', snap.mcp, ITEM_LIMIT.mcp)}
        {!isStorage && isExpanded && list('Largest skills', snap.skills, ITEM_LIMIT.skills)}

        <Box marginTop={1} width={width} gap={1} flexWrap="wrap">
          <Button key="compact" hotkey="c" label={isCompacting ? 'compacting…' : 'compact'} onPress={() => void compact($)} />
          <Button key="handoff" hotkey="w" label="handoff" onPress={() => void handoffPressed($)} />
          {canGuard && <Button key="guard" hotkey="x" label="guard" onPress={() => void guardPressed($).catch(() => undefined)} />}
          <Button key="details" hotkey="e" label={isExpanded ? 'less' : 'more'} onPress={() => void update($, expanded, v => !v)} />
          {/* The finer tools wait behind "more", so the everyday row stays short */}
          {(isExpanded || isStorage) && (
            <Button
              key="storage"
              hotkey="s"
              label={isStorage ? 'list' : 'grid'}
              onPress={() => {
                void update($, storage, v => !v)
                // The grid is /context's, so it is drawn from /context's own count
                if (!isStorage) void refresh($, 'full').catch(() => undefined)
              }}
            />
          )}
          {(isExpanded || flagged.length > 0) && (
            <Button key="exact" hotkey="r" label="exact" onPress={() => void refresh($, 'full').catch(() => undefined)} />
          )}
        </Box>
        <Box width={width}>
          <Text dimColor wrap="truncate-end">{footer}</Text>
        </Box>
      </Box>
    )
  })
}
