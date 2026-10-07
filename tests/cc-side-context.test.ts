import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage, SessionUsage, UiPane } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

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
const engine = (on: On, current: SessionUsage = usage) => {
  const panes: UiPane[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('command.register', () => ({ value: { command: 'side-context' } }))
  on('session.usage', () => ({ value: current }))
  on('session.messages', () => ({ value: transcript }))
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
  return { panes, toasts, clock }
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
    expect(drawn).toContain(' / 200.0k')
    // full labels, not clipped; one "(deferred)" at most; Skills flagged
    expect(drawn).toContain('System prompt')
    expect(drawn).toContain('Conversation')
    expect(drawn).not.toContain('(deferred) (deferred)')
    // an estimate only raises the question; the exact count answers it
    expect(drawn).toContain('may be large')
    expect(drawn).not.toContain('Exact count')
    expect(drawn).toContain('Disable unused plugins in /plugin')
    await pane.unmount()
  }
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
  // the biggest eater comes with what to do about it
  expect(drawn).toContain('Read a range (offset/limit)')
  // a tiny edit result is not worth a row
  expect(drawn).not.toContain('Edit src/fetch.ts')
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
  expect(drawn).toContain('0 to quality limit')
  expect(drawn).toContain('▄█')
  expect(drawn).toContain('5h 34%')
  expect(drawn).toContain('$1.50')
  // a subscription's cache lasts an hour
  await $.turn.complete(turn)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('cache 60m')
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
