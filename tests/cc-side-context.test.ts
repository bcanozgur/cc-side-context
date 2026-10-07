import { expect, test } from 'claude-code/testing'
import type { On, SessionUsage, UiPane } from 'claude-code'
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

// The engine beneath the plugin: a pane list it keeps, and the usage above
const engine = (on: On) => {
  const panes: UiPane[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'side-context' } }))
  on('session.usage', () => ({ value: usage }))
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
  return { panes }
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

test('draws the breakdown, and the hide button closes the pane', async ($, on) => {
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
    expect(drawn).toContain('May be larger than usual')
    expect(drawn).not.toContain('* Larger than usual')
    expect(drawn).toContain('Disable unused plugins in /plugin')
    if (surface === 'terminal') await pane.press({ key: 'hide' })
  }

  expect(panes).toEqual([])
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
  expect(drawn).toContain('* Larger than usual')
  expect(drawn).not.toContain('May be larger')
  expect(drawn).toContain('Exact count')
})

test('storage draws /context grid and its rows, and list goes back', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run(run('on'))

  const pane = await mount($)
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
