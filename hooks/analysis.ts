import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { Eater } from '../types'

// What the pane reads out of the transcript: no API calls, so every figure
// here is an estimate from text length

// Roughly four characters a token for English and code
export const estimate = (text: string): number => Math.ceil(text.length / 4)

// 1234 -> 1.2k, 1234567 -> 1.2M
export const fmt = (n: number): string => {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const tail = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')
// Inside the project a path is shown from its root, so README.md stays README.md
const short = (path: string, cwd = '') => tail(cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

// mcp__github__get_issue -> github › get_issue
export const toolLabel = (tool: string): string => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]} › ${m[2]}` : tool
}

// What a call worked on, short enough for one row
export const targetOf = (use: Pick<ToolUseSummary, 'tool' | 'input'>, cwd = ''): string => {
  const i = use.input
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path)
  switch (use.tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return short(path, cwd)
    case 'Bash':
      return clip(str(i.command), 40)
    case 'Grep':
    case 'Glob':
      return clip(str(i.pattern), 30) + (path ? ` in ${short(path, cwd)}` : '')
    case 'WebFetch':
      return /^https?:\/\/([^/]+)/.exec(str(i.url))?.[1] ?? ''
    case 'WebSearch':
      return clip(str(i.query), 40)
    case 'Agent':
    case 'Task':
      return clip(str(i.description), 40)
    default: {
      const first = Object.values(i).find(v => typeof v === 'string' && v.length > 0)
      return clip(str(first), 40)
    }
  }
}

// One line on how to keep a tool's output smaller next time
export const tipOf = (tool: string): string => {
  if (tool.startsWith('mcp__')) return 'Ask the MCP tool for fewer fields'
  switch (tool) {
    case 'Read':
      return 'Read a range (offset/limit), not the whole file'
    case 'Bash':
      return 'Pipe noisy output through tail or grep'
    case 'Grep':
    case 'Glob':
      return 'Narrow the pattern or the path'
    case 'WebFetch':
    case 'WebSearch':
      return 'Fetch in a subagent so only its answer lands here'
    case 'Agent':
    case 'Task':
      return 'Ask the subagent for a shorter answer'
    default:
      return 'Run it in a subagent so only its answer lands here'
  }
}

// Calls under this size are not worth a row
const EATER_FLOOR = 500

// The tool results that take the most room, the same call on the same target
// counted together (a file read three times is one row)
export const eatersOf = (messages: readonly SessionMessage[], limit = 5, cwd = ''): Eater[] => {
  const byKey = new Map<string, Eater>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const use of m.toolUses) {
      if (!use.text) continue
      const target = targetOf(use, cwd)
      const key = `${use.tool}\u0000${target}`
      const tokens = estimate(use.text)
      const seen = byKey.get(key)
      if (seen) {
        seen.tokens += tokens
        seen.count += 1
      } else byKey.set(key, { tool: use.tool, target, tokens, count: 1 })
    }
  }
  return [...byKey.values()]
    .filter(e => e.tokens >= EATER_FLOOR)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const uses = (messages: readonly SessionMessage[]) => messages.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))]

export const changedFiles = (messages: readonly SessionMessage[]): string[] =>
  unique(uses(messages).filter(u => EDITS.has(u.tool) && !u.isError).map(u => str(u.input.file_path) || str(u.input.notebook_path)))

export const readFiles = (messages: readonly SessionMessage[]): string[] =>
  unique(uses(messages).filter(u => u.tool === 'Read').map(u => str(u.input.file_path)))

// What the person typed: their messages without the reminders and command
// echoes the harness wraps around them
export const requestsOf = (messages: readonly SessionMessage[]): string[] =>
  messages
    .filter(m => m.role === 'user' && !(m.toolResults?.length))
    .map(m =>
      m.text
        .replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
        .trim(),
    )
    .filter(t => t.length > 0)

// The latest todo list's unfinished items
export const openTasks = (messages: readonly SessionMessage[]): string[] => {
  const todo = uses(messages).filter(u => u.tool === 'TodoWrite').at(-1)
  const list = Array.isArray(todo?.input.todos) ? (todo.input.todos as unknown[]) : []
  return list.flatMap(t => {
    if (typeof t !== 'object' || t === null) return []
    const { content, status } = t as { content?: unknown; status?: unknown }
    return typeof content === 'string' && status !== 'completed' ? [`${content}${status === 'in_progress' ? ' (in progress)' : ''}`] : []
  })
}

const MAX_FILES = 25

// What compaction is told to keep, on top of its own prompt
export const preserveOf = (messages: readonly SessionMessage[]): string => {
  const files = changedFiles(messages).slice(-MAX_FILES)
  return [
    'Keep in the summary, as specifically as possible:',
    "1. The user's goal, and every constraint, convention or preference they stated, word for word where short.",
    '2. Every file created or changed, and why.',
    '3. Decisions made, and approaches tried and rejected (with the reason).',
    '4. Open tasks, and the exact next step.',
    '5. Commands that build, test or run the project.',
    ...(files.length > 0 ? ['', 'Files changed this session:', ...files.map(f => `- ${f}`)] : []),
  ].join('\n')
}

// Marks the plugin's own instructions, so they are added only once
export const PRESERVE_MARK = 'Keep in the summary, as specifically as possible:'

const section = (title: string, lines: string[], empty = 'none') =>
  [`## ${title}`, '', ...(lines.length > 0 ? lines : [`_${empty}_`]), '']

// A handoff note a fresh session can start from: built from the transcript,
// so it costs no tokens to write
export const handoffOf = (messages: readonly SessionMessage[], when: string): string => {
  const asks = requestsOf(messages)
  const answer = messages.filter(m => m.role === 'assistant' && m.text.trim()).at(-1)?.text.trim() ?? ''
  return [
    `# Handoff · ${when}`,
    '',
    '> Written by cc-side-context from the session transcript. Start a new session with:',
    '> `Read @.claude/side-context/handoff.md and continue from the next step.`',
    '',
    ...section('Goal', asks[0] ? [clip(asks[0], 800)] : []),
    ...section('Latest requests', asks.slice(1).slice(-3).map(a => `- ${clip(a, 300)}`)),
    ...section('Open tasks', openTasks(messages).map(t => `- [ ] ${t}`)),
    ...section('Files changed', changedFiles(messages).slice(-MAX_FILES).map(f => `- ${f}`)),
    ...section('Files read', readFiles(messages).slice(-MAX_FILES).map(f => `- ${f}`)),
    ...section('Where it stopped', answer ? [clip(answer, 1500)] : []),
  ].join('\n')
}

// 2026-10-07 23:08, in local time
export const stamp = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const BLOCKS = '▁▂▃▄▅▆▇█'

// Context over the turns, one block a turn scaled to `max`; the newest at the
// right, as many as fit
export const sparkline = (history: readonly number[], max: number, width: number): string => {
  if (max <= 0) return ''
  return history
    .slice(-width)
    .map(v => BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, Math.floor((v / max) * BLOCKS.length)))])
    .join('')
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
export const limitName = (kind: string) => LIMIT_NAMES[kind] ?? kind.replace(/_/g, ' ')
