import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage, SessionUsage, UiPane } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { EaterIndex, GUARD_TTL, agoOf, bashKey, commandOf, eatersOf, estimate, fitWidth, projectSlug, titleOf, widthOf } from '../hooks/analysis'
import { shownEaters } from '../hooks/pane'

const PANE = 'side-context'
const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const usage: SessionUsage = {
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens: 84_000,
    window: 200_000,
    percent: 42,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 4_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Skills', tokens: 9_700, color: 'warning', isDeferred: false, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 55_800, color: 'inactive', isDeferred: true, kind: 'deferred' },
        { name: 'Messages', tokens: 70_300, color: 'claude', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 83_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 84_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'model-default',
      percentage: 42,
      gridRows: [
        [
          { color: 'promptBorder', isFilled: true, categoryName: 'System prompt', tokens: 4_000, percentage: 2, squareFullness: 1 },
          { color: 'warning', isFilled: true, categoryName: 'Skills', tokens: 9_700, percentage: 5, squareFullness: 0.4 },
          { color: 'inactive', isFilled: false, categoryName: 'Free space', tokens: 83_000, percentage: 41, squareFullness: 0 },
          { color: 'inactive', isFilled: true, categoryName: 'Autocompact buffer', tokens: 33_000, percentage: 16, squareFullness: 1 },
        ],
      ],
      model: 'claude-opus-5-5',
      memoryFiles: [{ path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 1_200 }],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
      apiUsage: null,
    },
  },
}

// A session that read one big file twice, ran a test command and edited a file
const transcript: SessionMessage[] = [
  { role: 'user', text: '<system-reminder>ignore me</system-reminder>Add retries to the fetch client', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/src/big.ts' }, text: 'x'.repeat(40_000) },
      { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, text: 'y'.repeat(8_000) },
      { tool_use_id: 't3', tool: 'Read', input: { file_path: '/repo/src/big.ts' }, text: 'x'.repeat(40_000) },
      { tool_use_id: 't4', tool: 'Edit', input: { file_path: '/repo/src/fetch.ts' }, text: 'ok' },
      { tool_use_id: 't5', tool: 'TodoWrite', input: { todos: [{ content: 'Add backoff', status: 'completed' }, { content: 'Write tests', status: 'pending' }] }, text: 'ok' },
    ],
  },
  { role: 'assistant', text: 'Retries are in; tests are next.', toolUses: [] },
]

// The engine beneath the plugin: a pane list it keeps, and the usage above
const engine = (on: On, current: SessionUsage = usage, messages: () => SessionMessage[] = () => transcript) => {
  const panes: UiPane[] = []
  const toasts: string[] = []
  const breakdowns: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: START.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // A model request that asked for a tool, answered at once
  on('turn.step', async function* (_$, e) {
    const reply = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: reply }
  })
  on('command.register', () => ({ value: { command: 'side-context' } }))
  on('session.usage', (_$, e) => {
    breakdowns.push((e as { breakdown?: string } | undefined)?.breakdown)
    return { value: current }
  })
  on('session.messages', () => ({ value: messages() }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    if (!panes.some(p => p.id === e.id)) {
      panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    }
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    const i = panes.findIndex(p => p.id === e.id)
    if (i >= 0) panes.splice(i, 1)
    return { value: undefined }
  })
  return { panes, toasts, clock, breakdowns }
}

const run = (args: string) => ({
  command: 'side-context',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const)

test('opens on every session start', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start(START)
  expect(panes.map(p => p.id)).toEqual([PANE])
})

test('/side-context toggles the pane; on, off and full are explicit', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start(START)

  await $.command.run(run(''))
  expect(panes).toEqual([])
  await $.command.run(run(''))
  expect(panes.map(p => p.id)).toEqual([PANE])

  await $.command.run(run('on'))
  expect(panes.map(p => p.id)).toEqual([PANE])
  await $.command.run(run('off'))
  expect(panes).toEqual([])
  await $.command.run(run('full'))
  expect(panes.map(p => p.id)).toEqual([PANE])
})

test('draws the breakdown on every surface', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'cc-side-context',
      surface,
      component: 'Pane',
      requestId: PANE,
      props: {
        title: 'Context',
        isFocused: false,
        bodyColumns: 40,
        placement: 'dock',
      } as never,
    })
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).toContain('84.0k')
    expect(drawn).toContain('83.0k left')
    expect(drawn).toContain('Conversation')
    expect(drawn).toContain('Skills')
    expect(drawn).not.toContain('(deferred) (deferred)')
    expect(drawn).not.toContain('Exact count')
    if (surface === 'terminal') {
      // the bar is the whole window, with auto-compact a mark on it and the room before it
      expect(drawn).toContain(' / 200.0k window')
      expect(drawn).toContain(' 42%')
      expect(drawn).toContain('auto-compact 167.0k')
      expect(drawn).toContain('┃')
      // its key, in the colours of the In context rows
      expect(drawn).toContain('["setup"]')
      expect(drawn).toContain('["conversation"]')
      expect(drawn).not.toContain('["turn"]')
      // full labels, not clipped; an estimate only raises the question
      expect(drawn).toContain('System prompt')
      expect(drawn).toContain('may be large')
      expect(drawn).toContain('Disable unused plugins in /plugin')
    } else {
      // laid out by the page at the slot's width, never in counted cells
      expect(drawn).toContain('"width":"100%"')
      expect(drawn).toContain('"minWidth":0')
      // the verdict, a meter over the whole window with the limit marked on it
      expect(drawn).toContain('Filling up')
      expect(drawn).toContain('"type":"Svg"')
      expect(drawn).toContain('42% of the 200.0k window in use, auto-compact marked at 167.0k')
      expect(drawn).toContain('84.0k of 200.0k window')
      expect(drawn).toContain('Auto-compact 167.0k')
      // every part in a colour of its own, the same on its dot and its stretch of the meter
      expect(drawn).toContain('#3fa877')
      expect(drawn).toContain('#d9a521')
      expect(drawn).toContain('#9a72d8')
      expect(drawn).not.toContain('"suggestion"')
      // one fact per row, with its share of what is in context
      expect(drawn).toContain('System prompt')
      expect(drawn).toContain('["84%"]')
      // an estimate neither flags a row nor gives a fix, nor takes the next
      // step: the count is a quiet button at the foot
      expect(drawn).not.toContain('Disable unused plugins in /plugin')
      expect(drawn).not.toContain('Sizes are estimates')
      expect(drawn.match(/"variant":"primary"/g)?.length).toBe(1)
      expect(drawn).toContain('"label":"Count exactly","hotkey":"r","variant":"secondary"')
    }
    await pane.unmount()
  }
})

test('on the page the exact count flags a row, its fix under the pointer', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run(run('full'))
  const pane = await $.ui.mount({
    plugin: 'cc-side-context',
    surface: 'desktop',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Context', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('Disable unused plugins in /plugin')
  expect(drawn).toContain('"display":"none"')
  expect(drawn).not.toContain('Count exactly')
})

const mount = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: 'cc-side-context',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Context', isFocused: false, bodyColumns: 52, placement: 'dock' } as never,
  })

test('the exact count is the one that flags a row as too large', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run(run('full'))

  const drawn = JSON.stringify(await (await mount($)).drawn())
  expect(drawn).toContain('Exact count')
  expect(drawn).not.toContain('may be large')
  expect(drawn).toContain('Exact count')
})

test('storage draws /context grid and its rows, and list goes back', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))

  const pane = await mount($)
  // the grid sits behind "more"
  await pane.press({ key: 'details' })
  await pane.press({ key: 'storage' })
  const grid = JSON.stringify(await pane.drawn())
  expect(grid).toContain('Context Usage')
  expect(grid).toContain('claude-opus-5-5')
  expect(grid).toContain('⛁')
  expect(grid).toContain('⛀')
  expect(grid).toContain('⛶')
  expect(grid).toContain('⛝')
  expect(grid).toContain('Skills: ')
  expect(grid).toContain('9.7k tokens (4.9%)')
  // the free row has no "tokens", and the deferred row is not listed
  expect(grid).toContain('Free space: ')
  expect(grid).not.toContain('MCP tools (deferred)')
  expect(grid).toContain('Exact count')

  await pane.press({ key: 'storage' })
  const back = JSON.stringify(await pane.drawn())
  expect(back).not.toContain('Context Usage')
  expect(back).toContain('Conversation')
})

const turn = {
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 'turn',
  reason: 'answer' as const,
}

test('lists the tool results eating the most context, a repeated read as one row', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))

  const drawn = JSON.stringify(await (await mount($)).drawn())
  expect(drawn).toContain('Top context eaters')
  expect(drawn).toContain('Read src/big.ts ×2')
  expect(drawn).toContain('~20.0k')
  expect(drawn).toContain('Bash npm test')
  // each row says how much of the conversation it is
  expect(drawn).toContain('of conversation')
  expect(drawn).toContain('~20.0k  28%')
  expect(drawn).toContain('~2.0k   3%')
  // the row x would guard is marked, and the advice says what the press does
  expect(drawn).toContain('▸ ')
  expect(drawn).toContain('x guards ▸: next time Claude is asked to read a range')
  // a tiny edit result is not worth a row
  expect(drawn).not.toContain('Edit src/fetch.ts')
  // the conversation leads the breakdown; what was loaded at the start follows under its sum
  expect(drawn.indexOf('Conversation')).toBeLessThan(drawn.indexOf('Setup, loaded at start'))
  expect(drawn).toContain('Setup, loaded at start')
  expect(drawn.indexOf('Skills')).toBeLessThan(drawn.indexOf('System prompt'))
})

test('compaction is told to keep decisions and the files changed', async ($, on) => {
  const { toasts, clock } = engine(on)
  const told: (string | undefined)[] = []
  on('session.compact', (_$, e) => {
    told.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'Summary', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 20_000 }
  })
  await $.session.start(START)

  await $.command.run(run('on'))
  const result = await $.command.run(run('compact'))
  expect(result.text).toContain('Compacting')
  await clock.advance(300)
  expect(toasts).toContain('Compacted 150.0k → 20.0k; decisions and changed files kept')
  expect(told[0]).toContain('Keep in the summary')
  expect(told[0]).toContain('/repo/src/fetch.ts')

  // a /compact with its own instructions keeps them, and gets ours once
  await $.session.compact({ trigger: 'manual', instructions: 'Focus on the API', messages: transcript })
  expect(told[1]).toContain('Focus on the API')
  expect(told[1]?.split('Keep in the summary').length).toBe(2)
})

test('handoff writes a note a fresh session can start from', async ($, on) => {
  engine(on)
  const written: { path: string; text: string }[] = []
  const copied: string[] = []
  on('fs.write', (_$, e) => {
    written.push(e)
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await $.session.start(START)

  const result = await $.command.run(run('handoff'))
  expect(result.text).toContain('.claude/side-context/handoff.md')
  expect(written[0]?.path.endsWith('.claude/side-context/handoff.md')).toBe(true)
  const note = written[0]?.text ?? ''
  expect(note).toContain('## Goal')
  expect(note).toContain('Add retries to the fetch client')
  expect(note).not.toContain('ignore me')
  expect(note).toContain('- [ ] Write tests')
  expect(note).not.toContain('Add backoff')
  expect(note).toContain('/repo/src/fetch.ts')
  expect(note).toContain('Retries are in; tests are next.')
  expect(copied[0]).toContain('@.claude/side-context/handoff.md')
})

test('counts down the prompt cache, and warns once when it goes cold', async ($, on) => {
  const { toasts, clock } = engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))
  await $.turn.complete(turn)

  const pane = await mount($)
  const warm = JSON.stringify(await pane.drawn())
  // an API key session (no rate limits) has the five-minute cache
  expect(warm).toContain('cache 5m')

  await clock.advance(6 * 60_000)
  expect(JSON.stringify(await pane.drawn())).toContain('cache cold')
  expect(toasts.filter(t => t.includes('Prompt cache expired')).length).toBe(1)
  await clock.advance(5 * 60_000)
  expect(toasts.filter(t => t.includes('Prompt cache expired')).length).toBe(1)
})

// One model request of a turn, read to its end as the engine reads it
const step = async ($: Parameters<TestBody>[0], index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'turn', index, model: 'claude-opus-5-5', messageCount: index + 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream);
  return stream.result
}

test('a turn of many tool calls moves the pane with each response, not only at its end', async ($, on) => {
  const current: SessionUsage = { ...usage, context: { ...usage.context } }
  const { clock, breakdowns } = engine(on, current)
  await $.session.start(START)
  await $.command.run(run('on'))
  await clock.settle()
  const pane = await mount($)
  await $.turn.start({ text: 'Add retries', turnId: 'turn' })

  // session.measure stays quiet until the turn ends; each response moves the
  // figure and reads the breakdown again
  const read = breakdowns.length
  for (const [i, tokens] of [96_000, 118_000].entries()) {
    current.context = { ...usage.context, tokens }
    await step($, i)
    await clock.settle()
  }
  let drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('118.0k')
  // grown since the turn began, not since the response before, and drawn
  // as the bar's end
  expect(drawn).toContain('+34.0k')
  expect(drawn).toContain('["turn"]')
  expect(breakdowns.slice(read)).toContain('summary')

  // a subagent's requests fill its own window, not this one
  current.context = { ...usage.context, tokens: 150_000 }
  await step($, 0, 'agent-1')
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).not.toContain('150.0k')

  // a rate-limit window moving mid-turn does not restart the count
  current.context = { ...usage.context, tokens: 119_000 }
  await $.session.measure({ context: { ...current.context, breakdown: undefined }, rateLimits: [], changed: ['context', 'rateLimits'] })
  // and the turn's end keeps the whole turn's growth
  current.context = { ...usage.context, tokens: 120_000 }
  await $.session.measure({ context: { ...current.context, breakdown: undefined }, rateLimits: [], changed: ['context'] })
  drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('120.0k')
  expect(drawn).toContain('+36.0k')

  // the next turn counts from there, and has added nothing until it answers
  await $.turn.start({ text: 'Now the tests', turnId: 'turn-2' })
  drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toContain('+36.0k')
  expect(drawn).not.toContain('["turn"]')
  current.context = { ...usage.context, tokens: 125_000 }
  await step($, 0)
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).toContain('+5.0k')
})

test('on a 1M window the bar is the whole window, the quality limit a mark on it', async ($, on) => {
  const b = usage.context.breakdown
  const categories = [
    { name: 'System prompt', tokens: 4_700, color: 'promptBorder', isDeferred: false, kind: 'used' as const },
    { name: 'System tools', tokens: 27_600, color: 'inactive', isDeferred: false, kind: 'used' as const },
    { name: 'Skills', tokens: 6_000, color: 'warning', isDeferred: false, kind: 'used' as const },
    { name: 'Messages', tokens: 94_300, color: 'claude', isDeferred: false, kind: 'used' as const },
  ]
  const at = (tokens: number): SessionUsage => ({
    ...usage,
    context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000), breakdown: b && { ...b, categories, autoCompactThreshold: 967_000 } },
  })
  const current = at(127_900)
  const { clock } = engine(on, current)
  await $.session.start(START)
  await $.command.run(run('on'))
  await clock.settle()
  await $.turn.start({ text: 'Add retries', turnId: 'turn' })
  current.context = at(132_600).context
  await step($, 0)
  await clock.settle()

  const drawn = JSON.stringify(await (await mount($)).drawn())
  // the window is the bar's end; past half the quality limit the status says so
  expect(drawn).toContain(' / 1.0M window')
  expect(drawn).toContain(' 13%')
  expect(drawn).toContain('● Filling')
  expect(drawn).toContain('quality limit 250.0k')
  expect(drawn).toContain('117.4k left')
  // every part the key names has a cell, small as it is on this scale
  for (const part of ['setup', 'conversation', 'turn']) expect(drawn).toContain(`["${part}"]`)
  expect(drawn).toContain('+4.7k')
})

test('on the page a 1M window fills the whole bar, the quality limit marked on it', async ($, on) => {
  engine(on, { ...big, context: { ...big.context, tokens: 64_000, percent: 6 } })
  await $.session.start(START)
  await $.command.run(run('on'))
  const pane = await $.ui.mount({
    plugin: 'cc-side-context',
    surface: 'desktop',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Context', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('64.0k of 1.0M window')
  expect(drawn).toContain('["6%"]')
  expect(drawn).toContain('Quality limit 250.0k')
  expect(drawn).toContain('186.0k left')
  expect(drawn).toContain('6% of the 1.0M window in use, quality limit marked at 250.0k')
  // the mark sits a quarter of the way along
  expect(drawn).toContain('x=\\"98.0\\" width=\\"4\\"')
})

test('with auto-compact off the bar counts towards the window', async ($, on) => {
  const b = usage.context.breakdown
  engine(on, { ...usage, context: { ...usage.context, breakdown: b && { ...b, isAutoCompactEnabled: false } } })
  await $.session.start(START)
  await $.command.run(run('on'))

  const drawn = JSON.stringify(await (await mount($)).drawn())
  expect(drawn).toContain(' / 200.0k window')
  expect(drawn).toContain(' 42%')
  expect(drawn).toContain('116.0k left')
  expect(drawn).toContain('auto-compact off')
  // no limit before the window's end, so no mark
  expect(drawn).not.toContain('┃')
  expect(drawn).not.toContain('░')
})

test('a turn that runs past the cache lifetime keeps the cache warm', async ($, on) => {
  const { toasts, clock } = engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))
  await $.turn.complete(turn)
  await $.turn.start({ text: 'Add retries', turnId: 'turn' })

  // an API key's five minutes, crossed by a turn that keeps sending requests
  for (let i = 0; i < 4; i++) {
    await clock.advance(2 * 60_000)
    await step($, i)
    await clock.settle()
  }
  expect(toasts.filter(t => t.includes('Prompt cache expired'))).toEqual([])
  expect(JSON.stringify(await (await mount($)).drawn())).not.toContain('cache cold')
})

const big: SessionUsage = {
  ...usage,
  rateLimits: [{ kind: 'five_hour', percentUsed: 34 }],
  cost: { usd: 1.5 },
  context: {
    ...usage.context,
    tokens: 300_000,
    window: 1_000_000,
    percent: 30,
    breakdown: usage.context.breakdown && { ...usage.context.breakdown, autoCompactThreshold: 967_000 },
  },
}

test('a 1M window warns at the quality budget, long before auto-compact', async ($, on) => {
  const { toasts } = engine(on, big)
  await $.session.start(START)
  await $.command.run(run('on'))
  for (const tokens of [120_000, 300_000]) {
    await $.session.measure({ context: { ...big.context, tokens, breakdown: undefined }, rateLimits: big.rateLimits, cost: big.cost, changed: ['context'] })
  }

  expect(toasts.filter(t => t.includes('Context passed 250.0k')).length).toBe(1)
  const pane = await mount($)
  const drawn = JSON.stringify(await pane.drawn())
  await pane.unmount()
  expect(drawn).toContain('Time to compact')
  // the bar is the whole 1M window; the quality limit is a mark on it, and the
  // line beside the mark says how far past it the context is
  expect(drawn).toContain(' / 1.0M window')
  expect(drawn).toContain(' 30%')
  expect(drawn).toContain('quality limit 250.0k')
  expect(drawn).toContain('50.0k over')
  expect(drawn).toContain('░')
  expect(drawn).toContain('5h 34%')
  expect(drawn).toContain('$1.50')
  // a subscription's cache lasts an hour
  await $.turn.complete(turn)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('cache 60m')
})

test('a /compact from the chat redraws the pane without waiting for a reply', async ($, on) => {
  const current: SessionUsage = { ...big, context: { ...big.context } }
  const { clock } = engine(on, current)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Summary', toolUses: [] }], tokensBefore: 300_000, tokensAfter: 30_000 }))
  await $.session.start(START)
  await $.command.run(run('on'))
  await $.session.measure({ context: { ...big.context, breakdown: undefined }, rateLimits: big.rateLimits, cost: big.cost, changed: ['context'] })
  const pane = await mount($)
  expect(JSON.stringify(await pane.drawn())).toContain('Time to compact')

  // core still reports the old fill while the hook chain runs
  await $.session.compact({ trigger: 'manual', messages: transcript })
  let drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toContain('Time to compact')
  expect(drawn).toContain('220.0k left')

  // once installed, the fill is unreported until the next response
  current.context = { ...big.context, tokens: undefined, percent: undefined }
  await clock.advance(600)
  drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toContain('Time to compact')
})

test('the pane presses compact and shows it running', async ($, on) => {
  const { toasts, clock } = engine(on)
  let release = () => {}
  on('session.compact', async () => {
    await new Promise<void>(r => (release = r))
    return { messages: [{ role: 'user' as const, text: 'Summary', toolUses: [] }], tokensBefore: 90_000, tokensAfter: 9_000 }
  })
  await $.session.start(START)
  await $.command.run(run('on'))

  const pane = await mount($)
  await pane.press({ key: 'compact' })
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).toContain('Compacting')
  release()
  await clock.settle()
  expect(toasts).toContain('Compacted 90.0k → 9.0k; decisions and changed files kept')
  expect(JSON.stringify(await pane.drawn())).not.toContain('Compacting')
})

test('a resumed or cleared conversation is measured again at once', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))
  await $.session.end({ reason: 'resume', sessionId: 'old', resume: { sessionId: 'old' } as never })

  const pane = await mount($)
  await clock.settle()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toContain('Measuring')
  expect(drawn).toContain('84.0k')
})

test('a /resume shows the resumed fill, not an estimate taken before it was in place', async ($, on) => {
  // The engine has no fill until the first response, and its first estimate
  // is of the empty conversation the resume replaces
  const current: SessionUsage = {
    ...usage,
    context: { window: 1_000_000, breakdown: { ...usage.context.breakdown!, totalTokens: 39_800, rawMaxTokens: 1_000_000 } },
  }
  let messages: SessionMessage[] = []
  const { clock } = engine(on, current, () => messages)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await $.command.run(run('on'))
  const pane = await mount($)
  await clock.settle()

  await $.session.end({ reason: 'resume', sessionId: 'old', resume: { sessionId: 'old' } as never })
  messages = transcript
  await $.classic.SessionStart({ source: 'resume', context_tokens: 540_000, seconds_since_last_response: 60 })
  await clock.settle()
  const resumed = JSON.stringify(await pane.drawn())
  expect(resumed).toContain('540.0k')
  expect(resumed).not.toContain('39.8k')
  expect(resumed).not.toContain('pick up a past one')

  // The first turn grows it from the resumed fill, not from the empty one
  await $.turn.start({ turnId: 't1' } as never)
  current.context = { ...current.context, tokens: 553_600, percent: 55 }
  await $.session.measure({ context: { ...current.context, breakdown: undefined }, rateLimits: [], changed: ['context'] })
  await clock.settle()
  const after = JSON.stringify(await pane.drawn())
  expect(after).toContain('+13.6k')
  expect(after).not.toContain('+513')
})

test('a Bash row says what the command did, not how it was spelled', async () => {
  expect(commandOf('cd /private/tmp/x && grep -n "drawn\\|mount(" /repo/hooks/register.tsx', '/repo')).toBe('grep hooks/register.tsx')
  expect(commandOf("python3 - <<'EOF'\nprint(1)\nEOF")).toBe('python3 script')
  expect(commandOf('sed -n 1,62p hooks/analysis.ts; sed -n 70,90p hooks/analysis.ts')).toBe('sed hooks/analysis.ts')
  expect(commandOf('FOO=1 rtk git status')).toBe('git status')
  expect(commandOf('npm test 2>&1 | tail -20')).toBe('npm test')
  expect(commandOf('ls')).toBe('ls')
  // every command of a chain is named, as any may be the one that printed most
  expect(commandOf('cd /repo && ls && git diff', '/repo')).toBe('ls && git diff')
  expect(commandOf('git status --short && git diff --stat | head -5')).toBe('git status && git diff')
  expect(commandOf('npm test &> out.log')).toBe('npm test')
  expect(commandOf('make build > build.log 2>&1 && ./run.sh')).toBe('make build && run.sh')
  expect(commandOf('cd /repo && ls && git diff && git log && cat hooks/register.tsx', '/repo').length).toBeLessThanOrEqual(40)
})

test('an eater needs a hundredth of the budget for a row, so x never guards a hidden one', async () => {
  const eater = (tokens: number) => ({ tool: 'Bash', target: `cmd ${tokens}`, tokens, count: 1, raw: `cmd ${tokens}` })
  const live = { eaters: [eater(3_000), eater(1_200)], scale: 1, snapshot: { compactAt: 900_000, window: 1_000_000 } }
  // a 250k budget: 2.5k and up
  expect(shownEaters(live as never, 250_000).map(e => e.tokens)).toEqual([3_000])
  // never under a guard's floor, however small the budget
  expect(shownEaters({ ...live, snapshot: { compactAt: 50_000, window: 64_000 } } as never, 0).map(e => e.tokens)).toEqual([3_000, 1_200])
  expect(shownEaters({ ...live, eaters: [eater(800)] } as never, 250_000)).toEqual([])
})

test('x guards the biggest eater: the next whole read is sent back once', async ($, on) => {
  engine(on)
  mock.store(on)
  const read: string[] = []
  on('tool.call', (_$, e) => {
    read.push(e.tool)
    return { result: { text: 'ok' } } as never
  })
  await $.session.start(START)
  await $.command.run(run('on'))

  const pane = await mount($)
  await pane.press({ key: 'guard' })
  const guarded = JSON.stringify(await pane.drawn())
  expect(guarded).toContain('⊘')
  // the mark moves on to the next row x would guard
  expect(guarded).toContain('x guards ▸: next time Claude is asked to trim its output')

  const first = await $.tool.call({ tool: 'Read', file_path: '/repo/src/big.ts' } as never)
  expect(JSON.stringify(first)).toContain('offset/limit')
  expect(read.length).toBe(0)
  // a range goes through, and so does the same whole read asked again
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/big.ts', offset: 1, limit: 50 } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/big.ts' } as never)
  expect(read.length).toBe(2)

  expect((await $.command.run(run('guards'))).text).toContain('Read src/big.ts')
  await $.command.run(run('guards clear'))
  expect((await $.command.run(run('guards'))).text).toContain('No guards')
})

test('/side-context stats sums up the session and copies it', async ($, on) => {
  engine(on)
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await $.session.start(START)
  await $.command.run(run('on'))
  await $.turn.complete(turn)

  const { text } = await $.command.run(run('stats'))
  expect(text).toContain('84.0k / 200.0k')
  // turns come from the transcript, so a resumed session counts them all
  expect(text).toContain('Turns        1')
  expect(text).toContain('Since launch peak 84.0k')
  expect(text).toContain('Read src/big.ts ×2')
  expect(text).toContain('the top 2 took 100%')
  expect(copied[0]).toContain('Session stats')
})

test('after a compaction the handoff keeps the first request as the goal, not the summary', async ($, on) => {
  let messages = transcript
  const { clock } = engine(on, usage, () => messages)
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
  const summary = 'This session is being continued from a previous conversation. Summary: retries were added.'
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: summary, toolUses: [] }], tokensBefore: 90_000, tokensAfter: 9_000 }))
  const written: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    written.push(e)
    return { value: undefined }
  })
  await $.session.start(START)
  await $.command.run(run('compact'))
  await clock.advance(300)

  messages = [
    { role: 'user', text: summary, toolUses: [] },
    { role: 'user', text: 'Now add jitter to the backoff', toolUses: [] },
    { role: 'assistant', text: 'Jitter is in.', toolUses: [] },
  ]
  await $.command.run(run('handoff'))
  const note = written.find(w => w.path.endsWith('handoff.md'))?.text ?? ''
  expect(note).toContain('## Goal\n\nAdd retries to the fetch client')
  expect(note).toContain('- Now add jitter to the backoff')
  expect(note).not.toContain('Summary: retries were added')

  const { text } = await $.command.run(run('stats'))
  expect(text).toContain('Turns        1 since the last compaction')
})

test('a resumed session still knows the goal from before its compaction', async ($, on) => {
  engine(on, usage, () => [
    { role: 'user', text: 'Summary of the earlier work', toolUses: [] },
    { role: 'user', text: 'Ship it', toolUses: [] },
  ])
  mock.store(on, { 'memo:session-1': { goal: 'Port the CLI to Rust', summaries: ['Summary of the earlier work'] } })
  on('session.id', () => ({ value: 'session-1' }))
  const written: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    written.push(e)
    return { value: undefined }
  })
  await $.session.start(START)
  await $.command.run(run('handoff'))
  const note = written.find(w => w.path.endsWith('handoff.md'))?.text ?? ''
  expect(note).toContain('## Goal\n\nPort the CLI to Rust')
  expect(note).toContain('- Ship it')
  expect(note).not.toContain('Summary of the earlier work')
})

test('the handoff keeps itself out of git and keeps the note before it', async ($, on) => {
  engine(on)
  const written: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    written.push(e)
    return { value: undefined }
  })
  on('fs.read', () => ({ value: '# Handoff · earlier' }) as never)
  on('fs.exists', () => ({ value: false }))
  await $.session.start(START)
  await $.command.run(run('handoff'))
  const paths = written.map(w => w.path)
  expect(paths.some(p => p.endsWith('.claude/side-context/handoff.md'))).toBe(true)
  expect(written.find(w => w.path.endsWith('handoff.prev.md'))?.text).toBe('# Handoff · earlier')
  expect(written.find(w => w.path.endsWith('.claude/side-context/.gitignore'))?.text).toContain('*')
})

const NOW = 1_000_000
const stored = (guards: object[]) => ({ 'guards:/tmp': guards })

test('guards send each call back once, parallel calls and a reworded command alike', async ($, on) => {
  engine(on)
  mock.store(
    on,
    stored([
      { tool: 'Read', key: '/repo/a.ts', label: 'a.ts', tokens: 9_000, at: NOW },
      { tool: 'Read', key: '/repo/b.ts', label: 'b.ts', tokens: 9_000, at: NOW },
      { tool: 'Bash', key: 'npm test', label: 'npm test', tokens: 5_000, at: NOW },
    ]),
  )
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    ran.push(`${e.tool} ${JSON.stringify(e)}`)
    return { result: { text: 'ok' } } as never
  })
  await $.session.start(START)
  const isDenied = (r: unknown) => JSON.stringify(r).includes('cc-side-context guard')

  // two whole reads in one turn are each sent back, and each goes through when asked again
  expect(isDenied(await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' } as never))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never))).toBe(false)
  expect(isDenied(await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' } as never))).toBe(false)

  // the cd in front and the spacing do not hide a guarded command; a trimmed one goes through
  expect(isDenied(await $.tool.call({ tool: 'Bash', command: 'cd /repo &&  npm test' } as never))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -20' } as never))).toBe(false)
  expect(isDenied(await $.tool.call({ tool: 'Bash', command: 'npm test' } as never))).toBe(false)
  expect(ran.length).toBe(4)

  expect((await $.command.run(run('guards'))).text).toContain('sent back 1×')
})

test('a guard left unused for 30 days is dropped', async ($, on) => {
  engine(on)
  mock.store(
    on,
    stored([
      { tool: 'Read', key: '/repo/old.ts', label: 'old.ts', tokens: 9_000, at: NOW - GUARD_TTL - 1 },
      { tool: 'Read', key: '/repo/new.ts', label: 'new.ts', tokens: 9_000, at: NOW - GUARD_TTL - 1, lastHit: NOW - 1_000 },
    ]),
  )
  await $.session.start(START)
  const { text } = await $.command.run(run('guards'))
  expect(text).not.toContain('old.ts')
  expect(text).toContain('new.ts')
})

test('the grid view recounts exactly at most once a minute', async ($, on) => {
  const { clock, breakdowns } = engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))
  const pane = await mount($)
  await pane.press({ key: 'details' })
  await pane.press({ key: 'storage' })
  await clock.settle()
  const exact = () => breakdowns.filter(b => b === 'full').length
  const before = exact()
  const measure = () => $.session.measure({ context: { ...usage.context, breakdown: undefined }, rateLimits: [], changed: ['context'] })
  await measure()
  await measure()
  await clock.settle()
  expect(exact()).toBe(before)
  await clock.advance(61_000)
  await measure()
  await clock.settle()
  expect(exact()).toBe(before + 1)
})

test('an unknown option says so instead of toggling the pane', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start(START)
  expect((await $.command.run(run('compcat'))).text).toContain('Unknown option')
  expect(panes.map(p => p.id)).toEqual([PANE])
  expect((await $.command.run(run('help'))).text).toContain('/side-context handoff')
})

test('sizes and widths count non-English text and wide characters', async () => {
  expect(estimate('x'.repeat(400))).toBe(100)
  expect(estimate('ğ'.repeat(100))).toBe(50)
  expect(estimate('漢'.repeat(10))).toBe(10)
  expect(widthOf('漢字ab')).toBe(6)
  expect(widthOf('é')).toBe(1)
  expect(fitWidth('漢字漢字', 5)).toBe('漢字…')
  expect(widthOf(fitWidth('漢字漢字', 5))).toBe(5)
  expect(fitWidth('short', 10)).toBe('short')
  expect(bashKey('cd /repo && FOO=1 rtk npm   test')).toBe('npm test')
  expect(bashKey('ls -la')).toBe('ls -la')
})

test('the eater index folds in only new messages, and starts over when the transcript is replaced', async () => {
  const index = new EaterIndex()
  index.update(transcript, '/repo')
  const more: SessionMessage[] = [
    ...transcript,
    { role: 'user', text: 'and the docs', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't9', tool: 'Read', input: { file_path: '/repo/src/big.ts' }, text: 'x'.repeat(40_000) }] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  ]
  expect(index.update(more, '/repo').top()).toEqual(eatersOf(more, 5, '/repo'))
  expect(index.top()[0]?.count).toBe(3)

  const compacted: SessionMessage[] = [{ role: 'user', text: 'Summary', toolUses: [] }, ...more.slice(-2)]
  expect(index.update(compacted, '/repo').top()).toEqual(eatersOf(compacted, 5, '/repo'))
  expect(index.top()[0]?.count).toBe(1)
})

const line = (v: object) => JSON.stringify(v)
const PROJECT = `/home/me/.claude/projects/${projectSlug(START.cwd)}`
const past: Record<string, { text: string; mtimeMs: number }> = {
  'login.jsonl': {
    mtimeMs: NOW - 3 * 60 * 60_000,
    text: [
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'user', message: { role: 'user', content: 'Fix the login bug' } }),
      line({ type: 'ai-title', aiTitle: 'Login bug fix' }),
    ].join('\n'),
  },
  'dark.jsonl': {
    mtimeMs: NOW - 2 * 24 * 60 * 60_000,
    text: line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/x</command-name>Add dark mode' }] } }),
  },
  'empty.jsonl': { mtimeMs: NOW - 60_000, text: line({ type: 'mode', mode: 'normal' }) },
  'current.jsonl': { mtimeMs: NOW, text: line({ type: 'user', message: { role: 'user', content: 'this one' } }) },
}

// A fresh session in a project with past transcripts
const freshSession = (on: On) => {
  const { clock } = engine(on, usage, () => [])
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: Object.entries(past).map(([name, f]) => ({ name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', (_$, e) => ({ value: past[(e as { path: string }).path.split('/').pop() ?? '']?.text ?? '' }) as never)
  const resumed: string[] = []
  on('command.run', { command: 'resume' }, (_$, e) => {
    resumed.push(e.args)
    return { text: '' }
  })
  return { clock, resumed }
}

test('a fresh session offers its project\'s past sessions, and a number resumes one', async ($, on) => {
  const { clock, resumed } = freshSession(on)
  await $.session.start(START)
  const pane = await mount($)
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).toContain('"key":"resume"')

  await pane.press({ key: 'resume' })
  await clock.settle()
  const list = JSON.stringify(await pane.drawn())
  expect(list).toContain('Resume a session')
  expect(list).toContain('1 Login bug fix')
  expect(list).toContain('3h ago')
  expect(list).toContain('2 Add dark mode')
  expect(list).toContain('2d ago')
  // nobody typed in it, or it is this very session
  expect(list).not.toContain('this one')
  expect(list).not.toContain('3 ')

  await pane.press({ key: 'resume-1' })
  await clock.settle()
  expect(resumed).toEqual(['login'])
  expect(JSON.stringify(await pane.drawn())).not.toContain('Resume a session')
})

test('once the conversation starts, resume is gone', async ($, on) => {
  const { clock } = freshSession(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.session.start(START)
  const pane = await mount($)
  await clock.settle()
  await pane.press({ key: 'resume' })
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).toContain('Resume a session')

  await $.prompt.submit({ text: 'Hello', wait: false, origin: { kind: 'user' } } as never)
  await clock.settle()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toContain('Resume a session')
  expect(drawn).not.toContain('"key":"resume"')
})

test('a session already under way does not offer resume', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(START)
  const pane = await mount($)
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).not.toContain('"key":"resume"')
})

test('a past session is named by /rename, then by Claude, then by its first prompt', async () => {
  const user = line({ type: 'user', message: { role: 'user', content: 'Refactor the parser' } })
  const ai = line({ type: 'ai-title', aiTitle: 'Parser refactor' })
  const custom = line({ type: 'custom-title', customTitle: 'parser-v2' })
  expect(titleOf(user, `${ai}\n${custom}`)).toBe('parser-v2')
  expect(titleOf(user, ai)).toBe('Parser refactor')
  expect(titleOf(`{"type":"user","message":{"cut`, '')).toBeUndefined()
  expect(titleOf(`${line({ type: 'user', isMeta: true, message: { content: 'meta' } })}\n${user}`, '')).toBe('Refactor the parser')
  expect(titleOf(line({ type: 'mode' }), '')).toBeUndefined()
  expect(projectSlug('/Users/me/my_app.v2')).toBe('-Users-me-my-app-v2')
  expect(agoOf(30_000)).toBe('just now')
  expect(agoOf(5 * 60_000)).toBe('5m ago')
})
