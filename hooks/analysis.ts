import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { Eater, Guard, Memo } from '../types'

// What the pane reads out of the transcript: no API calls, so every figure
// here is an estimate from text length

// Roughly four characters a token for English and code, two for accented
// and non-Latin letters (Turkish, Cyrillic, Greek), one for CJK and emoji
export const estimate = (text: string): number => {
  let ascii = 0
  let other = 0
  let wide = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) ascii++
    else if (c >= 0xd800 && c <= 0xdbff) {
      wide++
      i++
    } else if (c >= 0x2e80) wide++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 2 + wide)
}

// Columns a string takes in a terminal: CJK and emoji take two, combining
// marks and joiners none
const isZeroWidth = (cp: number) =>
  (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)
const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1f64f) ||
  (cp >= 0x1f900 && cp <= 0x1f9ff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
const columnsOf = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 0
  return isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1
}

export const widthOf = (s: string): number => {
  let w = 0
  for (const ch of s) w += columnsOf(ch)
  return w
}

// Cut to `n` columns with an ellipsis, never through a wide character
export const fitWidth = (s: string, n: number): string => {
  if (widthOf(s) <= n) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = columnsOf(ch)
    if (w + cw > n - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

export const padWidth = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - widthOf(s)))

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

// Shell words, quotes kept together, and the operators between commands
const WORDS = /'[^']*'|"(?:\\.|[^"\\])*"|&&|\|\||[;|&]|[^\s;|&'"]+/g
const OPERATOR = /^(&&|\|\||[;|&])$/
// Commands that only set the stage for the one doing the work
const PRELUDE = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'true'])
const WRAPPERS = new Set(['sudo', 'rtk', 'time', 'env', 'nohup', 'command', 'exec', 'xargs'])
// Commands whose first argument says what they do: git status, npm test
const SUBCOMMANDS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'claude', 'make', 'pip', 'pip3', 'brew', 'uv', 'deno'])
const unquote = (w: string) => w.replace(/^(['"])([\s\S]*)\1$/, '$2')
const isFlag = (w: string) => w.startsWith('-')
const isRedirect = (w: string) => /^\d*[<>]/.test(w)
const isPath = (w: string) => /[/.]/.test(w) && !/[*?|()\\\s]/.test(w) && !isFlag(w)

// What a shell command does, in a few words: the cd and env in front dropped,
// a path made short, a heredoc called a script.
// `cd /tmp/x && grep -n "a\|b" hooks/register.tsx` -> grep hooks/register.tsx
export const commandOf = (command: string, cwd = ''): string => {
  const words = command.split('\n')[0]?.match(WORDS) ?? []
  const segments: string[][] = [[]]
  for (const w of words) {
    if (OPERATOR.test(w)) segments.push([])
    else segments.at(-1)?.push(w)
  }
  const bare = segments
    .map(seg => {
      let i = 0
      while (i < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i] ?? '') || WRAPPERS.has(seg[i] ?? ''))) i++
      return seg.slice(i)
    })
    .filter(seg => seg.length > 0)
  const seg = bare.find(s => !PRELUDE.has(s[0] ?? '')) ?? bare[0]
  if (!seg) return clip(command, 40)
  const name = (seg[0] ?? '').split('/').pop() ?? ''
  const rest = seg.slice(1)
  if (rest.some(w => w.startsWith('<<')) || (/^(python|node|ruby|perl|bash|sh|zsh)/.test(name) && rest.includes('-c'))) return `${name} script`
  const args = rest.filter(w => !isFlag(w) && !isRedirect(w)).map(unquote)
  const path = args.find(isPath)
  const shown = path ? short(path, cwd) : ''
  if (SUBCOMMANDS.has(name) && args[0] && args[0] !== path) return clip(`${name} ${args[0]}${shown ? ` ${shown}` : ''}`, 40)
  if (shown) return clip(`${name} ${shown}`, 40)
  return clip(args[0] ? `${name} ${args[0]}` : name, 40)
}

// The command a guard matches on: the cd, export and env in front dropped
// and the spacing evened, so `cd /repo && npm test` and `npm  test` are one
export const bashKey = (command: string): string => {
  const words = command.replace(/\s+/g, ' ').trim().match(WORDS) ?? []
  let i = 0
  for (;;) {
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '') || WRAPPERS.has(words[i] ?? ''))) i++
    if (i >= words.length || !PRELUDE.has(words[i] ?? '')) break
    while (i < words.length && !OPERATOR.test(words[i] ?? '')) i++
    i++
  }
  const rest = words.slice(i)
  return rest.length > 0 ? rest.join(' ') : command.replace(/\s+/g, ' ').trim()
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
      return commandOf(str(i.command), cwd)
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

// What a guard matches on: the file a Read took whole, the command a Bash ran
const rawOf = (use: Pick<ToolUseSummary, 'tool' | 'input'>): string =>
  use.tool === 'Read' ? str(use.input.file_path) : use.tool === 'Bash' ? bashKey(str(use.input.command)) : ''

// One row's name: the tool, what it worked on, and how often
export const eaterLabel = (e: Pick<Eater, 'tool' | 'target' | 'count'>): string => `${toolLabel(e.tool)} ${e.target}${e.count > 1 ? ` ×${e.count}` : ''}`

// Calls under this size are not worth a row
const EATER_FLOOR = 500

const fold = (into: Map<string, Eater>, m: SessionMessage, cwd: string, shared: ReadonlyMap<string, Eater> = new Map()) => {
  if (m.role !== 'assistant') return
  for (const use of m.toolUses) {
    if (!use.text) continue
    const target = targetOf(use, cwd)
    const key = `${use.tool}\u0000${target}`
    const tokens = estimate(use.text)
    const seen = into.get(key) ?? shared.get(key)
    if (seen) into.set(key, { ...seen, tokens: seen.tokens + tokens, count: seen.count + 1 })
    else {
      const raw = rawOf(use)
      into.set(key, { tool: use.tool, target, tokens, count: 1, ...(raw ? { raw } : {}) })
    }
  }
}

// Everything a message puts in the window, roughly: its text, its calls and
// their results (a result is counted on its call, not again on the reply)
const sizeOf = (m: SessionMessage): number =>
  estimate(m.text) + m.toolUses.reduce((sum, u) => sum + estimate(JSON.stringify(u.input) ?? '') + (u.text ? estimate(u.text) : 0), 0)

const signatureOf = (m: SessionMessage | undefined): string =>
  m ? `${m.role}:${m.text.length}:${m.toolUses.map(u => `${u.tool_use_id}:${u.text?.length ?? -1}`).join(',')}` : ''

// The newest messages are counted again each time: a call's result can land
// after the call itself
const TAIL = 2

// The eaters kept from one scan to the next, so a long session folds in only
// what is new. A transcript that changed underneath (a compaction, /clear,
// /resume) is folded again from the start.
export class EaterIndex {
  private folded = new Map<string, Eater>()
  private done = 0
  private head = ''
  private last = ''
  private cwd = ''
  private size = 0
  private tailSize = 0
  private tail = new Map<string, Eater>()

  update(messages: readonly SessionMessage[], cwd = ''): this {
    const stable = Math.max(0, messages.length - TAIL)
    const isSame =
      cwd === this.cwd && this.done <= stable && signatureOf(messages[0]) === this.head && (this.done === 0 || signatureOf(messages[this.done - 1]) === this.last)
    if (!isSame) {
      this.folded = new Map()
      this.done = 0
      this.size = 0
      this.cwd = cwd
      this.head = signatureOf(messages[0])
    }
    for (let i = this.done; i < stable; i++) {
      const m = messages[i]
      if (!m) continue
      fold(this.folded, m, cwd)
      this.size += sizeOf(m)
    }
    this.done = stable
    this.last = signatureOf(messages[stable - 1])
    this.tail = new Map()
    this.tailSize = 0
    for (const m of messages.slice(stable)) {
      fold(this.tail, m, cwd, this.folded)
      this.tailSize += sizeOf(m)
    }
    return this
  }

  // The rough size of the whole conversation, for calibrating against an exact count
  get total(): number {
    return this.size + this.tailSize
  }

  all(): Eater[] {
    const merged = new Map(this.folded)
    for (const [k, v] of this.tail) merged.set(k, v)
    return [...merged.values()]
  }

  top(limit = 5): Eater[] {
    return this.all()
      .filter(e => e.tokens >= EATER_FLOOR)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit)
  }
}

// The tool results that take the most room, the same call on the same target
// counted together (a file read three times is one row)
export const eatersOf = (messages: readonly SessionMessage[], limit = 5, cwd = ''): Eater[] => new EaterIndex().update(messages, cwd).top(limit)

// All the tool output still in the conversation
export const toolTokens = (messages: readonly SessionMessage[]): number =>
  uses(messages).reduce((sum, use) => sum + (use.text ? estimate(use.text) : 0), 0)

// A guard asks the model to narrow a call that ate a lot last time: a whole
// file read becomes a range, a noisy command gets its output trimmed. Only
// these two have a smaller form to ask for.
// A call smaller than this is not worth sending back
export const GUARD_FLOOR = 1_000

export const guardOf = (eater: Eater): Guard | undefined => {
  const tokens = Math.round(eater.tokens / eater.count)
  if ((eater.tool !== 'Read' && eater.tool !== 'Bash') || !eater.raw || tokens < GUARD_FLOOR) return undefined
  return { tool: eater.tool, key: eater.raw, label: eater.target, tokens }
}

// Output already narrowed: piped through a filter, or sent to a file
const NARROWED = /\|\s*(head|tail|grep|rg|wc|jq|awk|sed|cut|sort|uniq|less)\b|(?:^|[^\d&])>\s*[^&\s]/

// A guard nobody has run into for this long is dropped
export const GUARD_TTL = 30 * 24 * 60 * 60_000

// Two guards are one when they match the same calls; a Bash guard saved
// before keys were normalized still matches
const sameKey = (g: Pick<Guard, 'tool' | 'key'>, tool: string, key: string) => g.tool === tool && (tool === 'Bash' ? bashKey(g.key) === bashKey(key) : g.key === key)
export const isGuarded = (gs: readonly Guard[], g: Pick<Guard, 'tool' | 'key'>) => gs.some(x => sameKey(x, g.tool, g.key))

// Whether a guard still stands: not left idle past its lifetime
export const isLive = (g: Guard, now: number): boolean => now - (g.lastHit ?? g.at ?? now) < GUARD_TTL

// Which guard, if any, a call runs into
export const guardHit = (guards: readonly Guard[], call: { tool: string; input: Record<string, unknown> }, now = 0): Guard | undefined => {
  const i = call.input
  if (call.tool === 'Read' && (i.offset !== undefined || i.limit !== undefined || i.pages !== undefined)) return undefined
  if (call.tool === 'Bash' && NARROWED.test(str(i.command))) return undefined
  const raw = rawOf(call)
  return raw ? guards.find(g => sameKey(g, call.tool, raw) && (now === 0 || isLive(g, now))) : undefined
}

export const guardMessage = (g: Guard, tokens = g.tokens): string =>
  g.tool === 'Read'
    ? `cc-side-context guard: reading all of ${g.label} costs ~${fmt(tokens)} tokens of context. Read only the part you need (offset/limit), or Grep for it first. If you really need the whole file, make the same call again.`
    : `cc-side-context guard: \`${g.label}\` printed ~${fmt(tokens)} tokens last time. Narrow its output (| tail -n 40, | grep …, or > a file read in parts). If you need all of it, make the same call again.`

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const uses = (messages: readonly SessionMessage[]) => messages.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))]

export const changedFiles = (messages: readonly SessionMessage[]): string[] =>
  unique(uses(messages).filter(u => EDITS.has(u.tool) && !u.isError).map(u => str(u.input.file_path) || str(u.input.notebook_path)))

export const readFiles = (messages: readonly SessionMessage[]): string[] =>
  unique(uses(messages).filter(u => u.tool === 'Read').map(u => str(u.input.file_path)))

// The summary a compaction leaves behind reads as a user message; Claude
// Code's own opens with this line
const SUMMARY = /^This session is being continued from a previous conversation/i

// How a summary is recognized again later: its opening
export const fingerprintOf = (text: string): string => text.slice(0, 200)

const cleanOf = (text: string) => text.replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, '').trim()

// What the person typed: their messages without the reminders and command
// echoes the harness wraps around them, and without compaction summaries
// (`summaries`: the openings of the ones seen written)
export const requestsOf = (messages: readonly SessionMessage[], summaries: readonly string[] = []): string[] =>
  messages
    .filter(m => m.role === 'user' && !(m.toolResults?.length))
    .map(m => cleanOf(m.text))
    .filter(t => t.length > 0 && !SUMMARY.test(t) && !summaries.some(s => s.length > 0 && t.startsWith(s)))

// The summaries a compaction wrote: the plain user messages afterwards that
// were not there before
export const summariesOf = (before: readonly SessionMessage[], after: readonly SessionMessage[]): string[] => {
  const asked = new Set(before.filter(m => m.role === 'user' && !(m.toolResults?.length)).map(m => cleanOf(m.text)))
  return after
    .filter(m => m.role === 'user' && !(m.toolResults?.length))
    .map(m => cleanOf(m.text))
    .filter(t => t.length > 0 && !asked.has(t))
    .map(fingerprintOf)
}

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
// `memo`: what earlier compactions left out of the transcript, the goal and
// the summaries they wrote
export const handoffOf = (messages: readonly SessionMessage[], when: string, memo: Memo = { summaries: [] }): string => {
  const now = requestsOf(messages, memo.summaries)
  const goal = memo.goal ?? now[0]
  const asks = memo.goal ? [memo.goal, ...now.filter(a => a !== memo.goal)] : now
  const answer = messages.filter(m => m.role === 'assistant' && m.text.trim()).at(-1)?.text.trim() ?? ''
  return [
    `# Handoff · ${when}`,
    '',
    '> Written by cc-side-context from the session transcript. Start a new session with:',
    '> `Read @.claude/side-context/handoff.md and continue from the next step.`',
    '',
    ...section('Goal', goal ? [clip(goal, 800)] : []),
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

// Where Claude Code keeps a project's transcripts: its path with every
// character but letters and digits turned into a dash
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
  } catch {
    // A line cut at the edge of what was read
    return undefined
  }
}

// A typed prompt's text: the reminders and command echoes around it dropped
const promptOf = (entry: Record<string, unknown>): string => {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return ''
  const message = entry.message as { content?: unknown } | undefined
  const content = message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(b => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? str((b as { text?: unknown }).text) : '')).join(' ')
        : ''
  const clean = cleanOf(text)
  return SUMMARY.test(clean) || clean.startsWith('<') ? '' : clean
}

// What a past session is called, read from the start and the end of its
// transcript: the name given with /rename, else the one Claude gave it, else
// its first prompt. Undefined for a session nobody typed anything in.
export const titleOf = (head: string, tail: string): string | undefined => {
  let custom = ''
  let ai = ''
  for (const line of tail.split('\n')) {
    const e = line.includes('-title"') ? parse(line) : undefined
    if (e?.type === 'custom-title') custom = str(e.customTitle) || custom
    if (e?.type === 'ai-title') ai = str(e.aiTitle) || ai
  }
  let first = ''
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    const e = parse(line)
    first = e ? promptOf(e) : ''
    if (first) break
  }
  if (!first && !custom && !ai) return undefined
  return clip(custom || ai || first, 80)
}

// 5m ago, 3h ago, 2d ago
export const agoOf = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
