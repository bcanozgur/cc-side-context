import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Item, Legend, Row, Snapshot, Square } from '../types'

const PANE = 'side-context'
const TITLE = 'Context'
// Wider than this and the numbers drift too far from their labels to read
const MAX_WIDTH = 52
const LIST_SIZE = 8

const snapshot = atom({ plugin: 'cc-side-context', key: 'snapshot' } as const, null)
const delta = atom({ plugin: 'cc-side-context', key: 'delta' } as const, 0)
const last = atom({ plugin: 'cc-side-context', key: 'last' } as const, null)
const expanded = atom({ plugin: 'cc-side-context', key: 'expanded' } as const, false)
const help = atom({ plugin: 'cc-side-context', key: 'help' } as const, false)
const storage = atom({ plugin: 'cc-side-context', key: 'storage' } as const, false)

// 1234 -> 1.2k, 1234567 -> 1.2M
export const fmt = (n: number): string => {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

// What each /context row is, the size past which it is unusually large, and
// what to do about it. Matched on the row's name with "(deferred)" stripped.
type Rule = { test: RegExp; label: string; about: string; limit?: number; fix?: string }
const RULES: Rule[] = [
  { test: /^system prompt/i, label: 'System prompt', about: "Claude Code's core instructions", limit: 8_000, fix: 'Large output style or --append-system-prompt' },
  { test: /^system tools/i, label: 'Built-in tools', about: 'Read, Bash, Edit… tool schemas', limit: 20_000, fix: 'Many tool schemas loaded up front' },
  { test: /^mcp tools/i, label: 'MCP tools', about: 'MCP tool schemas loaded into context', limit: 10_000, fix: 'Disable unused servers in /mcp' },
  { test: /^mcp server instructions/i, label: 'MCP instructions', about: 'Instructions MCP servers add', limit: 3_000, fix: 'Some MCP server sends long instructions' },
  { test: /^custom agents/i, label: 'Subagents', about: 'Descriptions of your subagents', limit: 3_000, fix: 'Shorten agent descriptions' },
  { test: /^memory files/i, label: 'Memory (CLAUDE.md, rules)', about: 'CLAUDE.md, rules and auto-memory', limit: 8_000, fix: 'Trim large CLAUDE.md / rules files' },
  { test: /^skills/i, label: 'Skills', about: 'Skill list (name + description)', limit: 8_000, fix: 'Disable unused plugins in /plugin' },
  { test: /^slash commands/i, label: 'Slash commands', about: 'Command list', limit: 3_000 },
  { test: /^messages/i, label: 'Conversation', about: 'Messages and tool output', fix: 'Run /compact, or /clear for a new topic' },
  { test: /^autocompact buffer/i, label: 'Compact reserve', about: 'Space held back for auto-compact' },
  { test: /^free space/i, label: 'Free', about: 'Space still available' },
]
const ITEM_LIMIT = { memory: 3_000, mcp: 1_500, skills: 800 } as const

const ruleOf = (name: string): Rule | undefined => RULES.find(r => r.test.test(name.replace(/\s*\(deferred\)\s*$/i, '')))
const labelOf = (name: string) => ruleOf(name)?.label ?? name.replace(/\s*\(deferred\)\s*$/i, '')

// Conversation is "too big" once it holds over half of what fits before compaction
const isHeavy = (r: Row, snap: Snapshot): boolean => {
  if (r.kind !== 'used') return false
  if (/^messages/i.test(r.name)) return snap.compactAt !== undefined && r.tokens > snap.compactAt * 0.5
  const limit = ruleOf(r.name)?.limit
  return limit !== undefined && r.tokens > limit
}

// /context's glyphs: a full square, a partly full one (under 0.7), free, reserve
const GLYPH = { full: '⛁', partial: '⛀', free: '⛶', buffer: '⛝' } as const
const glyphOf = (kind: Row['kind'] | undefined, fullness = 1): string =>
  kind === 'free' ? GLYPH.free : kind === 'buffer' ? GLYPH.buffer : fullness < 0.7 ? GLYPH.partial : GLYPH.full

const top = (items: Item[]): Item[] => [...items].sort((a, b) => b.tokens - a.tokens).slice(0, LIST_SIZE)

export const toSnapshot = (context: SessionContextUsage, detail: Snapshot['detail'], at: number): Snapshot => {
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
  }
}

const refresh = async ($: EngineInterface, detail: Snapshot['detail']) => {
  const usage = await $.session.usage({ breakdown: detail })
  const next = toSnapshot(usage.context, detail, Date.now())
  await update($, snapshot, () => next)
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

const show = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: TITLE })
  await refresh($, 'summary')
}

// Hiding lasts for this session only: every new session opens the pane again
const hide = ($: EngineInterface) => $.ui.close({ id: PANE })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'side-context',
      description: 'Toggle the context breakdown side pane',
      argumentHint: '[on|off|full]',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($, 'summary')

    return next(e)
  })

  on('command.run', { command: 'side-context' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
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
    if (e.changed.includes('context') && e.context.tokens !== undefined) {
      const tokens = e.context.tokens
      const prev = await read($, last)
      await update($, delta, () => (prev === null ? 0 : tokens - prev))
      await update($, last, () => tokens)
      // The grid stands for /context, so it keeps /context's own count; the
      // list is redrawn from the free estimate
      if (await isOpen($)) await refresh($, (await read($, storage)) ? 'full' : 'summary')
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const change = await read($, delta)
    const isExpanded = await read($, expanded)
    const isHelp = await read($, help)
    const isStorage = await read($, storage)
    const width = Math.max(24, Math.min(MAX_WIDTH, e.props.bodyColumns))

    // Lines truncate rather than wrap, so resizing keeps the pane's height;
    // only the advice under a flagged row wraps, as cutting it loses the point.
    // Each row is label | number | flag in fixed columns.
    const line = (props: { label: string; value?: string; flag?: boolean; mark?: string; markColor?: string; dim?: boolean }) => (
      <Box width={width}>
        <Text color={props.markColor}>{props.mark ?? '  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" dimColor={props.dim}>{props.label}</Text>
        </Box>
        <Text dimColor={props.dim}>{(props.value ?? '').padStart(8)}</Text>
        <Text color={isExact ? 'error' : 'warning'} bold>{props.flag ? ` ${flagGlyph}` : '  '}</Text>
      </Box>
    )
    const hint = (props: { text: string }) => (
      <Box width={width}>
        <Text dimColor wrap="truncate-end">{`    ${props.text}`}</Text>
      </Box>
    )

    // An estimate counts some rows well above what /context finds (tool schemas
    // most), so only the exact count may say a row is too large; an estimate
    // can only raise the question
    const isExact = snap?.detail === 'full'
    const flagGlyph = isExact ? '*' : '?'

    if (!snap) {
      return (
        <Box flexDirection="column" width={width}>
          <Text bold>{TITLE}</Text>
          <Text dimColor>Measuring…</Text>
        </Box>
      )
    }

    // Pressure is measured against where auto-compact starts, not the raw window
    const budget = snap.compactAt ?? snap.window
    const pressure = budget > 0 ? snap.tokens / budget : 0
    const status =
      pressure >= 0.8
        ? { color: 'error', text: '● Near compact' }
        : pressure >= 0.5
          ? { color: 'warning', text: '● Filling' }
          : { color: 'success', text: '● Healthy' }

    const inWindow = snap.rows.filter(r => r.kind !== 'deferred')
    const deferred = snap.rows.filter(r => r.kind === 'deferred')
    const flagged = inWindow.filter(r => isHeavy(r, snap))
    const total = inWindow.reduce((sum, r) => sum + r.tokens, 0) || snap.window

    // One bar, each category a run of cells in /context's own colours
    let used = 0
    const segments = inWindow.map(r => {
      const cells = Math.round(((used + r.tokens) / total) * width) - Math.round((used / total) * width)
      used += r.tokens
      return { ...r, cells }
    })

    const list = (title: string, items: Item[], limit: number) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        {items.length === 0 ? (
          hint({ text: "none" })
        ) : (
          items.map(i => line({ label: i.name, value: fmt(i.tokens), flag: i.tokens > limit, dim: true }))
        )}
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

    return (
      <Box flexDirection="column" width={width}>
        <Box width={width} justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Box>
            <Box borderStyle="round" borderColor={status.color} paddingX={1}>
              <Text color={status.color}>{status.text}</Text>
            </Box>
            <Box marginLeft={1} alignItems="center">
              <Button key="hide" hotkey="x" label="✕" plain role="dismiss" onPress={() => void hide($)} />
            </Box>
          </Box>
        </Box>

        <Box width={width}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color={status.color}>{fmt(snap.tokens)}</Text>
              <Text dimColor>{` / ${fmt(snap.window)} · %${snap.percent}`}</Text>
            </Text>
          </Box>
          <Text color={change > 0 ? 'warning' : 'success'}>
            {change === 0 ? '' : `${change > 0 ? '+' : '−'}${fmt(Math.abs(change))} last turn`}
          </Text>
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
          <Text dimColor wrap="truncate-end">
            {snap.compactAt !== undefined
              ? `Auto-compact at ${fmt(snap.compactAt)} · ${fmt(Math.max(0, snap.compactAt - snap.tokens))} to go`
              : 'Auto-compact off'}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {!isStorage && inWindow.map(r => (
            <Box flexDirection="column">
              {line({ mark: r.kind === 'free' ? '□ ' : r.kind === 'buffer' ? '▒ ' : '■ ', markColor: r.kind === 'free' ? 'subtle' : r.color, label: labelOf(r.name), value: fmt(r.tokens), flag: isHeavy(r, snap), dim: r.kind !== 'used' })}
              {isHelp && hint({ text: ruleOf(r.name)?.about ?? '' })}
            </Box>
          ))}
        </Box>

        {isStorage && storageView()}

        {!isStorage && deferred.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Loaded on demand (not in context)</Text>
            {deferred.map(r => line({ label: labelOf(r.name), value: fmt(r.tokens), dim: true }))}
          </Box>
        )}

        {!isStorage && flagged.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {isExact ? (
              <Text color="error" bold>* Larger than usual</Text>
            ) : (
              <Text color="warning" bold>? May be larger than usual</Text>
            )}
            {flagged.map(r => (
              <Box flexDirection="column" width={width}>
                <Text wrap="truncate-end">
                  <Text bold>{labelOf(r.name)}</Text>
                  <Text dimColor>{` ${fmt(r.tokens)}${ruleOf(r.name)?.limit ? ` (usual ≤ ${fmt(ruleOf(r.name)?.limit ?? 0)})` : ''}`}</Text>
                </Text>
                <Box paddingLeft={2} width={width}>
                  <Text dimColor wrap="wrap">{ruleOf(r.name)?.fix ?? 'Bigger than expected'}</Text>
                </Box>
              </Box>
            ))}
            {!isExact && hint({ text: 'Estimate only · press r for the exact count' })}
          </Box>
        )}

        {!isStorage && isExpanded && list('Memory files', snap.memory, ITEM_LIMIT.memory)}
        {!isStorage && isExpanded && list('Loaded MCP tools', snap.mcp, ITEM_LIMIT.mcp)}
        {!isStorage && isExpanded && list('Largest skills', snap.skills, ITEM_LIMIT.skills)}

        <Box marginTop={1} width={width} gap={1}>
          <Button
            key="storage"
            hotkey="s"
            label={isStorage ? 'list' : 'storage'}
            onPress={() => {
              void update($, storage, v => !v)
              // The grid is /context's, so it is drawn from /context's own count
              if (!isStorage) void refresh($, 'full')
            }}
          />
          <Button key="details" hotkey="e" label={isExpanded ? 'less' : 'files'} onPress={() => void update($, expanded, v => !v)} />
          <Button key="help" hotkey="h" label={isHelp ? 'hide info' : 'info'} onPress={() => void update($, help, v => !v)} />
          <Button key="exact" hotkey="r" label="exact" onPress={() => void refresh($, 'full')} />
        </Box>
        <Box width={width}>
          <Text dimColor wrap="truncate-end">
            {`${snap.detail === 'full' ? 'Exact count' : 'Estimate'} · ${new Date(snap.at).toTimeString().slice(0, 5)}`}
          </Text>
        </Box>
      </Box>
    )
  })
}
