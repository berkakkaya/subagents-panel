import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register } from 'claude-code'

import type { AgentPhase, AgentRow, AgentStep } from '../types'

const PANE = 'subagents'
const TITLE = 'Subagents'
const MAX_STEPS = 400
const MAX_TEXT = 6000
const MAX_KEPT_SESSIONS = 40

const agents = atom({ plugin: 'subagents-panel', key: 'agents' } as const, [])
const selected = atom({ plugin: 'subagents-panel', key: 'selected' } as const, null)
const showActive = atom({ plugin: 'subagents-panel', key: 'showActive' } as const, true)
const showDone = atom({ plugin: 'subagents-panel', key: 'showDone' } as const, true)
const toggled = atom({ plugin: 'subagents-panel', key: 'toggled' } as const, [])
const autoOpened = atom({ plugin: 'subagents-panel', key: 'autoOpened' } as const, false)
const tick = atom({ plugin: 'subagents-panel', key: 'tick' } as const, 0)
const query = atom({ plugin: 'subagents-panel', key: 'query' } as const, '')
const focusedKey = atom({ plugin: 'subagents-panel', key: 'focusedKey' } as const, null)
const bandHidden = atom({ plugin: 'subagents-panel', key: 'bandHidden' } as const, false)

// A steady mark for work in flight: an animated one redraws the pane every second, and a
// click that lands while its elements are being replaced can be lost.
const RUNNING = '●'
const TICK_MS = 5000

const isActive = (phase: AgentPhase) => phase === 'running' || phase === 'waiting'

function hashOf(id: string) {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash
}

// ── Avatars ───────────────────────────────────────────────────────────────────
// Each agent's id seeds a small random generator, so its avatar is its own and the same every
// time it is drawn, a resume included. Desktop draws an SVG from one of several shape families;
// the terminal draws a glyph of the same family in the same color.

type Family = 'star' | 'flower' | 'gear' | 'polygon' | 'burst' | 'orbit' | 'crystal' | 'blob'
const FAMILIES: Family[] = ['star', 'flower', 'gear', 'polygon', 'burst', 'orbit', 'crystal', 'blob']

// One terminal cell each, and none a terminal may swap for an emoji (❄ ✳ ⚙ are left out).
const FAMILY_GLYPHS: Record<Family, string[]> = {
  star: ['✦', '✶', '✷', '✸', '✹'],
  flower: ['✿', '❀', '❁', '✾', '❃'],
  gear: ['❂', '✪', '✺'],
  polygon: ['◆', '◈', '❖'],
  burst: ['❋', '✱', '✲', '❊', '❉'],
  orbit: ['◉', '◎', '⊛'],
  crystal: ['✧', '◇', '✥'],
  blob: ['●', '✽', '✻', '✼'],
}

/** mulberry32: a tiny seeded generator, plenty for picking shapes. */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hslHex(h: number, s: number, l: number) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

type Avatar = {
  /** The gradient's id, unique per agent: several avatars may share one page, and ids are page-wide. */
  gid: string
  family: Family
  glyph: string
  /** The main color; the terminal draws the glyph in it. */
  color: string
  /** The gradient's second stop. */
  color2: string
  count: number
  rotation: number
  depth: number
  detail: 'none' | 'dot' | 'ring'
  jitter: number[]
}

function avatar(id: string): Avatar {
  const rand = seeded(hashOf(id))
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const family = pick(FAMILIES)
  const hue = Math.floor(rand() * 360)
  const shift = 25 + Math.floor(rand() * 70)
  return {
    gid: `sa${hashOf(id).toString(36)}`,
    family,
    glyph: pick(FAMILY_GLYPHS[family]),
    // Mid lightness and saturation read on dark and light themes alike.
    color: hslHex(hue, 68, 62),
    color2: hslHex((hue + shift) % 360, 72, 52),
    count: 5 + Math.floor(rand() * 5),
    rotation: Math.floor(rand() * 360),
    depth: 0.35 + rand() * 0.25,
    detail: pick(['none', 'dot', 'ring'] as const),
    jitter: Array.from({ length: 10 }, () => 0.75 + rand() * 0.25),
  }
}

function phaseOf(status: AgentStatus): AgentPhase {
  if (status === 'pending' || status === 'running') return 'running'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  return status
}

function titleCase(text: string) {
  const t = text.trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Subagent'
}

function clip(text: string, max: number) {
  const one = text.replace(/\s+/g, ' ').trim()
  if (max <= 1) return ''
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function shortPath(path: unknown) {
  if (typeof path !== 'string' || !path) return ''
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

function firstLine(text: unknown) {
  return typeof text === 'string' ? (text.split('\n').find(l => l.trim()) ?? '').trim() : ''
}

/** A tool call as one line, what the agent is doing in plain words. */
function describeTool(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read':
      return `Read ${shortPath(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${shortPath(input.file_path)}`
    case 'Write':
      return `Write ${shortPath(input.file_path)}`
    case 'NotebookEdit':
      return `Edit ${shortPath(input.notebook_path)}`
    case 'Bash':
    case 'PowerShell':
      return firstLine(input.description) || firstLine(input.command)
    case 'Grep':
      return `Search for "${input.pattern ?? ''}"${input.path ? ` in ${shortPath(input.path)}` : ''}`
    case 'Glob':
      return `Find files ${input.pattern ?? ''}`
    case 'LS':
      return `List ${shortPath(input.path)}`
    case 'WebSearch':
      return `Search the web for "${input.query ?? ''}"`
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : ''
      return `Fetch ${url.replace(/^https?:\/\//, '').split('/')[0]}`
    }
    case 'Agent':
    case 'Task':
      return `Delegate: ${input.description ?? 'subagent'}`
    case 'SendMessage':
      return `Message ${input.to ?? 'an agent'}`
    case 'TodoWrite':
      return 'Update the todo list'
    case 'ToolSearch':
      return 'Load tools'
    case 'AskUserQuestion':
      return 'Ask the user a question'
    case 'Skill':
      return `Use skill ${input.skill ?? ''}`
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return mcp ? `${mcp[1]} › ${mcp[2]}` : tool
    }
  }
}

type Kind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'other'
const KINDS: Kind[] = ['read', 'edit', 'run', 'search', 'web', 'agent', 'other']

function kindOf(tool: string): Kind {
  if (tool === 'Read') return 'read'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'edit'
  if (tool === 'Bash' || tool === 'PowerShell') return 'run'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'search'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (tool === 'Agent' || tool === 'Task' || tool === 'SendMessage') return 'agent'
  return 'other'
}

const KIND_GLYPH: Record<Kind, string> = { read: '▤', edit: '✎', run: '›_', search: '⌕', web: '◍', agent: '◎', other: '◆' }

// Desktop and the other graphical surfaces draw these as tinted SVG chips.
// Blue for file operations, green for commands, purple for every other tool.
const FILE_BLUE = '#5B9BF0'
const RUN_GREEN = '#3FB98A'
const TOOL_PURPLE = '#A57FE0'
const KIND_COLOR: Record<Kind, string> = {
  read: FILE_BLUE,
  edit: FILE_BLUE,
  search: FILE_BLUE,
  run: RUN_GREEN,
  web: TOOL_PURPLE,
  agent: TOOL_PURPLE,
  other: TOOL_PURPLE,
}

/** How a subagent hands its report back: a tool call, not a step of its work. */
const HANDBACK = 'SubagentHandback'

/** The report a hand-back call carries; its argument's name is the engine's, so read it loosely. */
function handbackReport(input: Record<string, unknown>) {
  for (const key of ['report', 'text', 'message', 'content', 'result']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const strings = Object.values(input).filter((v): v is string => typeof v === 'string')
  return strings.sort((a, b) => b.length - a.length)[0]?.trim() || undefined
}
const KIND_PATH: Record<Kind, string> = {
  read: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h4',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  run: 'M4 17l6-5-6-5 M12 19h8',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M21 21l-4.3-4.3',
  web: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18',
  agent: 'M12 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8z M4 21a8 8 0 0 1 16 0',
  other: 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z',
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'

function kindIcon(kind: Kind) {
  const c = KIND_COLOR[kind]
  return (
    `<svg ${SVG_NS} width="24" height="24" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="6" fill="${c}" fill-opacity="0.16"/>` +
    `<g transform="translate(5 5) scale(0.5833)" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${KIND_PATH[kind]}"/></g></svg>`
  )
}

const at = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`
}

/** The shape itself, centered on (12, 12) within a radius of about 8, filled with the gradient. */
function avatarShape(v: Avatar) {
  const fill = `fill="url(#${v.gid})"`
  const n = v.count
  switch (v.family) {
    case 'star': {
      const pts = Array.from({ length: n * 2 }, (_, i) => at(i % 2 ? 8 * v.depth : 8, (360 / (n * 2)) * i))
      return `<polygon points="${pts.join(' ')}" ${fill} stroke-linejoin="round"/>`
    }
    case 'flower': {
      const petals = Array.from(
        { length: n },
        (_, i) => `<ellipse cx="12" cy="7.2" rx="2.4" ry="4.4" transform="rotate(${(360 / n) * i} 12 12)" ${fill}/>`,
      )
      return petals.join('') + `<circle cx="12" cy="12" r="2.6" fill="${v.color2}"/>`
    }
    case 'gear': {
      const teeth = n + 2
      const step = 360 / teeth
      const pts: string[] = []
      for (let i = 0; i < teeth; i++) {
        const a = step * i
        pts.push(at(6, a - step * 0.3), at(8.4, a - step * 0.18), at(8.4, a + step * 0.18), at(6, a + step * 0.3))
      }
      return `<polygon points="${pts.join(' ')}" ${fill} stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4" fill="#000" fill-opacity="0.35"/>`
    }
    case 'polygon': {
      const sides = 5 + (n % 4)
      const outer = Array.from({ length: sides }, (_, i) => at(8, (360 / sides) * i))
      const inner = Array.from({ length: sides }, (_, i) => at(4.2, (360 / sides) * i + 180 / sides))
      return `<polygon points="${outer.join(' ')}" ${fill} stroke-linejoin="round"/><polygon points="${inner.join(' ')}" fill="${v.color2}" fill-opacity="0.85"/>`
    }
    case 'burst': {
      const rays = n + 4
      const lines = Array.from({ length: rays }, (_, i) => {
        const a = (360 / rays) * i
        const len = i % 2 ? 6.2 : 8.4
        const [x1, y1] = at(3, a).split(',')
        const [x2, y2] = at(len, a).split(',')
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#${v.gid})" stroke-width="1.8" stroke-linecap="round"/>`
      })
      return lines.join('') + `<circle cx="12" cy="12" r="3" ${fill}/>`
    }
    case 'orbit': {
      const moons = 2 + (n % 3)
      const dots = Array.from({ length: moons }, (_, i) => {
        const [x, y] = at(7.2, (360 / moons) * i).split(',')
        return `<circle cx="${x}" cy="${y}" r="1.6" fill="${v.color2}"/>`
      })
      return `<circle cx="12" cy="12" r="7.2" fill="none" stroke="url(#${v.gid})" stroke-width="1.2" stroke-opacity="0.8"/><circle cx="12" cy="12" r="4" ${fill}/>` + dots.join('')
    }
    case 'crystal': {
      const big = [at(8.6, 0), at(3.2, 90), at(8.6, 180), at(3.2, 270)]
      const small = [at(5.6, 45), at(1.6, 135), at(5.6, 225), at(1.6, 315)]
      return `<polygon points="${small.join(' ')}" fill="${v.color2}" fill-opacity="0.8"/><polygon points="${big.join(' ')}" ${fill} stroke-linejoin="round"/>`
    }
    case 'blob': {
      // A smooth closed curve through jittered points: quadratic curves between their midpoints.
      const k = 6 + (n % 3)
      const pts = Array.from({ length: k }, (_, i) => at(8 * (v.jitter[i] ?? 1), (360 / k) * i).split(',').map(Number))
      const mid = (p: number[], q: number[]) => `${(((p[0] ?? 0) + (q[0] ?? 0)) / 2).toFixed(2)},${(((p[1] ?? 0) + (q[1] ?? 0)) / 2).toFixed(2)}`
      let d = `M${mid(pts[k - 1] ?? [], pts[0] ?? [])}`
      for (let i = 0; i < k; i++) d += ` Q${(pts[i] ?? []).join(',')} ${mid(pts[i] ?? [], pts[(i + 1) % k] ?? [])}`
      return `<path d="${d} Z" ${fill}/>`
    }
  }
}

/** A round avatar: a tinted disc, the agent's shape rotated its own way, and an optional center detail. */
function avatarIcon(id: string) {
  const v = avatar(id)
  const detail =
    v.detail === 'dot'
      ? `<circle cx="12" cy="12" r="1.4" fill="#fff" fill-opacity="0.85"/>`
      : v.detail === 'ring'
        ? `<circle cx="12" cy="12" r="1.9" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="0.9"/>`
        : ''
  return (
    `<svg ${SVG_NS} width="24" height="24" viewBox="0 0 24 24">` +
    `<defs><linearGradient id="${v.gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.color}"/><stop offset="1" stop-color="${v.color2}"/></linearGradient></defs>` +
    `<circle cx="12" cy="12" r="11.5" fill="${v.color}" fill-opacity="0.18"/>` +
    `<g transform="rotate(${v.rotation} 12 12)">${avatarShape(v)}</g>${detail}</svg>`
  )
}

/**
 * Several avatars in one SVG, overlapping like a stack of profile pictures: each ringed in a dark
 * edge so the one beneath shows where it ends. One image, so the surface lays out nothing per head.
 */
function avatarStack(ids: string[]) {
  const size = 24
  const step = 14
  const width = size + step * Math.max(0, ids.length - 1)
  // Each avatar's own SVG is nested at its offset; the first sits on top, as a stack reads.
  const heads = ids
    .map((id, i) => {
      const inner = avatarIcon(id).replace(/^<svg [^>]*>/, '').replace(/<\/svg>$/, '')
      return `<g transform="translate(${i * step} 0)"><circle class="ring" cx="12" cy="12" r="12"/><svg x="1" y="1" width="22" height="22" viewBox="0 0 24 24">${inner}</svg></g>`
    })
    .reverse()
  // The ring follows the surface's theme: dark on a dark theme, white on a light one. A desktop is
  // a web page that states its scheme, so the image answers its `prefers-color-scheme` itself.
  const style = `<style>.ring{fill:#1E1F22}@media (prefers-color-scheme: light){.ring{fill:#FFFFFF}}</style>`
  return `<svg ${SVG_NS} width="${width}" height="${size}" viewBox="0 0 ${width} ${size}">${style}${heads.join('')}</svg>`
}

const DIVIDER =
  `<svg ${SVG_NS} width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none">` +
  `<rect width="2000" height="1" fill="#8A8A8A" fill-opacity="0.35"/></svg>`

/** "Read 3 files, ran 2 commands", the header of a run of tool calls. */
function groupTitle(steps: AgentStep[]) {
  const count: Record<Kind, number> = { read: 0, edit: 0, run: 0, search: 0, web: 0, agent: 0, other: 0 }
  for (const s of steps) count[kindOf(s.tool ?? '')]++
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    count.read && `read ${plural(count.read, 'file', 'files')}`,
    count.edit && `edited ${plural(count.edit, 'file', 'files')}`,
    count.run && `ran ${plural(count.run, 'command', 'commands')}`,
    count.search && `searched ${plural(count.search, 'time', 'times')}`,
    count.web && `browsed ${plural(count.web, 'page', 'pages')}`,
    count.agent && `messaged ${plural(count.agent, 'agent', 'agents')}`,
    count.other && `used ${plural(count.other, 'tool', 'tools')}`,
  ].filter(Boolean) as string[]
  const text = parts.join(', ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Worked'
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

async function patch($: EngineInterface, id: string, fn: (row: AgentRow) => AgentRow) {
  await update($, agents, list => list.map(row => (row.id === id ? fn(row) : row)))
}

function pushStep(row: AgentRow, step: AgentStep): AgentRow {
  return { ...row, steps: [...row.steps, step].slice(-MAX_STEPS) }
}

// ── Kept across restarts ──────────────────────────────────────────────────────
// The transcript holds what each agent did; it does not hold when. A few numbers
// per agent go to the store, under the session's id, so a resumed session shows
// real times. The steps themselves are rebuilt from the transcript.

type Kept = { s?: number; e?: number; p?: AgentPhase; m?: string }

async function remember($: EngineInterface, id: string, kept: Kept) {
  try {
    const sid = await $.session.id()
    const key = `times:${sid}`
    const all = ((await $.store.get(key)) ?? {}) as Record<string, Kept>
    all[id] = { ...all[id], ...kept }
    await $.store.set(key, all)

    const index = ((await $.store.get('sessions')) ?? []) as string[]
    if (index[index.length - 1] !== sid) {
      const next = [...index.filter(s => s !== sid), sid]
      for (const old of next.splice(0, Math.max(0, next.length - MAX_KEPT_SESSIONS))) await $.store.delete(`times:${old}`)
      await $.store.set('sessions', next)
    }
  } catch {
    // Times are a nicety; the panel works without them.
  }
}

/** Rebuilds the agent list from the transcript: a resumed session starts with none in memory. */
/** The agent an Agent call started: on the call when the session tracks it, else in what the call stored. */
function spawnedId(use: { agentId?: string; result?: unknown }) {
  if (use.agentId) return use.agentId
  const r = use.result
  if (r && typeof r === 'object') {
    const rec = r as Record<string, unknown>
    for (const key of ['agentId', 'agent_id']) if (typeof rec[key] === 'string' && rec[key]) return rec[key] as string
  }
  return undefined
}

type Restored = { agentCalls: number; rebuilt: number; unreadable: number }

/**
 * What an Agent call stored once it settled: its report, tool count and duration. A background
 * call stores only its launch, so this is empty for one; the report then arrives later in main.
 */
function callRecord(result: unknown): { report?: string; toolCount?: number; durationMs?: number; model?: string } {
  if (!result || typeof result !== 'object') return {}
  const rec = result as Record<string, unknown>
  // Every record names the model it ran on, a launch included.
  const model = typeof rec.resolvedModel === 'string' && rec.resolvedModel ? rec.resolvedModel : undefined
  // `async_launched` and `remote_launched` hold only the launch notice, never a report.
  if (rec.status !== undefined && rec.status !== 'completed') return { model }
  const handback = rec.handbackReport as { text?: unknown } | undefined
  const blocks = Array.isArray(rec.content) ? (rec.content as { type?: unknown; text?: unknown }[]) : []
  const content = blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
  return {
    report: (typeof handback?.text === 'string' && handback.text.trim()) || content || undefined,
    toolCount: typeof rec.totalToolUseCount === 'number' ? rec.totalToolUseCount : undefined,
    durationMs: typeof rec.totalDurationMs === 'number' ? rec.totalDurationMs : undefined,
    model,
  }
}

/** A background agent's report, as it reached the main conversation: its hand-back, or its finished task's notice. */
function reportFromMain(main: { role: string; text: string }[], id: string) {
  for (let i = main.length - 1; i >= 0; i--) {
    const msg = main[i]
    if (!msg || msg.role !== 'user' || !msg.text.includes(id)) continue
    const text = msg.text
    const handback = /The report follows:\s*([\s\S]*?)(?:<\/agent-message>|$)/.exec(text)
    if (handback?.[1]?.trim()) return handback[1].replace(/^ {2}/gm, '').trim()
    const result = /<result>([\s\S]*?)<\/result>/.exec(text)
    if (result?.[1]?.trim() && !/delivered to you as a message/i.test(result[1])) return result[1].trim()
  }
  return undefined
}

async function restore($: EngineInterface): Promise<Restored> {
  const found: Restored = { agentCalls: 0, rebuilt: 0, unreadable: 0 }
  const main = await $.session.messages()
  if (!Array.isArray(main)) return found
  const calls = main.flatMap(m => (m.role === 'assistant' ? (m.toolUses ?? []) : [])).filter(u => u.tool === 'Agent' || u.tool === 'Task')
  found.agentCalls = calls.length
  const uses = calls.map(u => ({ ...u, agentId: spawnedId(u) })).filter(u => u.agentId)
  if (uses.length === 0) return found

  const sid = await $.session.id().catch(() => '')
  const kept = (sid ? ((await $.store.get(`times:${sid}`).catch(() => undefined)) ?? {}) : {}) as Record<string, Kept>
  const live = await $.agent.list().catch(() => [])
  const have = new Set((await read($, agents)).map(r => r.id))
  const rows: AgentRow[] = []

  for (const use of uses) {
    const id = use.agentId
    if (!id || have.has(id)) continue
    have.add(id)
    const input = use.input
    const info = live.find(a => a.id === id)
    const k = kept[id] ?? {}
    const phase: AgentPhase = info ? phaseOf(info.status) : (k.p ?? (use.isError ? 'failed' : 'completed'))

    const steps: AgentStep[] = []
    let toolCount = 0
    let answer: string | undefined
    let note: string | undefined
    const child = await $.session.messages({ agentId: id }).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }))
    if (!Array.isArray(child)) note = 'deny' in child && child.deny ? child.deny : 'The engine returned no transcript for this agent.'
    if (Array.isArray(child)) {
      for (const msg of child) {
        if (msg.role !== 'assistant') continue
        if (msg.text.trim()) steps.push({ kind: 'say', text: msg.text.trim().slice(0, MAX_TEXT), at: 0 })
        for (const t of msg.toolUses ?? []) {
          if (t.tool === HANDBACK) {
            answer = handbackReport(t.input) ?? answer
            continue
          }
          toolCount++
          const state = t.isError ? 'error' : t.text === undefined && isActive(phase) ? 'running' : 'done'
          steps.push({ kind: 'tool', id: t.tool_use_id, tool: t.tool, text: describeTool(t.tool, t.input) || t.tool, at: 0, state })
        }
      }
    } else {
      found.unreadable++
    }
    // Without a hand-back, the agent's last words are its report.
    const last = steps[steps.length - 1]
    if (answer === undefined && last?.kind === 'say' && !isActive(phase)) {
      answer = last.text
      steps.pop()
    } else if (answer !== undefined && last?.kind === 'say' && last.text === answer.slice(0, MAX_TEXT)) {
      steps.pop()
    }
    if (Array.isArray(child) && child.length === 0) note = 'The engine kept no steps for this agent.'

    // The main conversation still holds what the call stored and the report handed back.
    const record = callRecord(use.result)
    if (toolCount === 0 && record.toolCount !== undefined) toolCount = record.toolCount
    answer ??= record.report ?? reportFromMain(main, id)

    const description = typeof input.description === 'string' ? input.description : ''
    const type = typeof input.subagent_type === 'string' ? input.subagent_type : info?.type ?? 'general-purpose'
    rows.push({
      id,
      description: titleCase(description || info?.description || type),
      type,
      model: k.m ?? record.model ?? (typeof input.model === 'string' ? input.model : undefined),
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      phase,
      startedAt: k.s ?? 0,
      endedAt: isActive(phase) ? undefined : k.e,
      current: isActive(phase) ? 'Working…' : phase === 'completed' ? firstLine(answer) || 'Done' : phase === 'killed' ? 'Stopped' : 'Failed',
      toolCount,
      steps: steps.slice(-MAX_STEPS),
      answer,
      restored: true,
      durationMs: record.durationMs,
      note: steps.length === 0 ? note : undefined,
    })
  }
  if (rows.length > 0) await update($, agents, list => [...rows, ...list.filter(r => !rows.some(n => n.id === r.id))])
  found.rebuilt = rows.length
  return found
}

/** Reconciles rows with the engine's own list: agents the hooks missed, and ones stopped from outside. */
async function sync($: EngineInterface) {
  const live = await $.agent.list()
  const now = await $.clock.now()
  // Write only when something moved: every write redraws the pane.
  const current = await read($, agents)
  const ids = new Set(current.map(row => row.id))
  const moved = live.some(info => {
    if (!ids.has(info.id)) return !info.teammateId
    return current.find(row => row.id === info.id)?.phase !== phaseOf(info.status)
  })
  if (!moved) return
  await update($, agents, list => {
    const known = new Map(list.map(row => [row.id, row]))
    const next = list.map(row => {
      const info = live.find(a => a.id === row.id)
      if (!info) return row
      const phase = phaseOf(info.status)
      if (phase === row.phase) return row
      return { ...row, phase, endedAt: isActive(phase) ? undefined : (row.endedAt ?? now) }
    })
    for (const info of live) {
      if (known.has(info.id) || info.teammateId) continue
      const phase = phaseOf(info.status)
      next.push({
        id: info.id,
        description: titleCase(info.description || info.name || info.type),
        type: info.type,
        prompt: '',
        phase,
        startedAt: now,
        endedAt: isActive(phase) ? undefined : now,
        current: isActive(phase) ? 'Working…' : '',
        toolCount: 0,
        steps: [],
      })
    }
    return next
  })
}

// ── Search ────────────────────────────────────────────────────────────────────
// The field filters as the person types. The filter itself waits a beat so a fast typist does
// not redraw the list on every key; what they typed is kept here meanwhile, so a redraw in that
// beat shows their text and not the last filter's.
const SEARCH_DEBOUNCE_MS = 120
let draft: string | undefined
let pendingFilter: { cancel: () => void } | undefined
const SEARCH_ICON =
  `<svg ${SVG_NS} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9AA0A6" stroke-width="2.2" stroke-linecap="round">` +
  `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg>`

// ── Elapsed times ─────────────────────────────────────────────────────────────
// A heartbeat from session.start moves them every few seconds while anything runs. Should that
// timer ever stop, the times would freeze, so every drawing that shows a running agent also arms
// a one-shot refresh of its own: whichever fires first moves the times, and the other stands down.
let lastBeat = 0
let armed: { cancel: () => void } | undefined
let lastBeatError = ''
async function beat($: EngineInterface) {
  armed?.cancel()
  armed = undefined
  try {
    const list = await read($, agents)
    if (list.length === 0) return
    // Reconcile first, whatever the rows say: one marked done too soon (a turn that ended while
    // the agent waits on work of its own) comes back here, and its times move again.
    await sync($)
    if (!(await read($, agents)).some(row => isActive(row.phase))) return
    lastBeat = await $.clock.now()
    await update($, tick, n => n + 1)
    // The tick redraws the drawings that read it; invalidate is the engine's own word for a
    // countdown, in case a surface holds a drawing that did not subscribe.
    $.ui.invalidate('ui.render')
    lastBeatError = ''
  } catch (err) {
    lastBeatError = err instanceof Error ? err.message : String(err)
  }
}
function armRefresh($: EngineInterface) {
  if (armed) return
  armed = $.clock.after(TICK_MS, () => {
    armed = undefined
    void beat($).catch(() => undefined)
  })
}

/**
 * Sends the person's message to a running agent, as the SendMessage tool delivers one, and
 * records it in the agent's timeline as "You →". Answers why not, when it was not delivered.
 */
async function deliver($: EngineInterface, id: string, text: string): Promise<string | undefined> {
  const message = text.trim()
  if (!message) return undefined
  const sent = await $.session.send({ to: { agentId: id }, text: message }).catch((err: unknown) => ({
    isDelivered: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }))
  if (!sent.isDelivered) return sent.reason
  const row = (await read($, agents)).find(r => r.id === id)
  const at = row ? (await $.clock.now()) - row.startedAt : 0
  await patch($, id, r => pushStep(r, { kind: 'you', text: message, at }))
  return undefined
}
let restoreCount = 0

async function reset($: EngineInterface) {
  draft = ''
  pendingFilter?.cancel()
  pendingFilter = undefined
  await update($, agents, () => [])
  await update($, selected, () => null)
  await update($, toggled, () => [])
  await update($, autoOpened, () => false)
  await update($, query, () => '')
  await update($, bandHidden, () => false)
}

// A short log of what reached the pane (renders, focus moves, presses) for `/subagents debug`.
// Module memory: a reload starts it over, which is what a fresh reproduction wants anyway.
const trace: string[] = []
let traceStart = 0
async function traceEvent($: EngineInterface, line: string) {
  const now = await $.clock.now()
  if (traceStart === 0) traceStart = now
  trace.push(`+${((now - traceStart) / 1000).toFixed(2)}s ${line}`)
  if (trace.length > 40) trace.splice(0, trace.length - 40)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: "Open the side panel with this session's subagents",
    })
    await restore($).catch(() => undefined)
    await sync($).catch(() => undefined)

    // Elapsed times move every few seconds, and only while something runs.
    $.clock.every(TICK_MS, () => {
      void beat($).catch(() => undefined)
    })

    return next(e)
  })

  // A /resume inside a running session swaps the conversation: drop the old list, rebuild the resumed one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await reset($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume' || e.source === 'fork' || e.source === 'compact') await restore($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Opening the panel also catches up with the transcript, and says what it found when that adds anything or fails.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'agent-chat') return next(e)
    const data = e.data as { type?: unknown; agentId?: unknown; text?: unknown }
    if (data?.type !== 'send' || typeof data.agentId !== 'string' || typeof data.text !== 'string') return {}
    const reason = await deliver($, data.agentId, data.text)
    if (!reason) return {}
    $.ui.toast(`Message not delivered: ${reason}`)
    // Put the text back in the box so nothing typed is lost.
    return {
      props: { agentId: data.agentId, placeholder: 'Message this subagent', terminal: e.surface === 'terminal', restore: { text: data.text, n: ++restoreCount } },
    }
  }).catch(($, e, next) => next(e))

  // Which of the pane's elements holds the ring, so the terminal's search field can light its border.
  // A person's move names `element`; this plugin's own `$.ui.focus` names `key`.
  on('ui.focus', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const moved = e as { element?: string; key?: string }
    const to = moved.element ?? moved.key ?? null
    await traceEvent($, `focus -> ${to ?? '(pane)'}`)
    const result = await next(e)
    if (!result.deny) await update($, focusedKey, () => to)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.press', async ($, e, next) => {
    if (e.requestId === PANE) await traceEvent($, `press ${e.element} (${e.surface})`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'subagents' }, async ($, e) => {
    if (e.args.trim() === 'debug') {
      const since = lastBeat ? `${((await $.clock.now()) - lastBeat) / 1000}s ago` : 'not since the mod loaded'
      const head = `Elapsed times last moved ${since}.${lastBeatError ? ` Last heartbeat failed: ${lastBeatError}` : ''}`
      return { text: trace.length ? [head, 'Last events in the Subagents panel:', ...trace].join('\n') : `${head}\nNo panel events recorded since the mod loaded.` }
    }
    await update($, bandHidden, () => false)
    let extra = ''
    try {
      const found = await restore($)
      if (found.rebuilt > 0) extra = ` Rebuilt ${found.rebuilt} from the transcript.`
      else if (found.agentCalls > 0 && (await read($, agents)).length === 0)
        extra = ` Found ${found.agentCalls} subagent call(s) in the transcript but none with an agent id${found.unreadable ? `; ${found.unreadable} unreadable` : ''}.`
    } catch (err) {
      extra = ` Could not read the transcript: ${err instanceof Error ? err.message : String(err)}`
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: (opened.isPlaced ? 'Subagents panel opened.' : `Subagents panel is open but not shown: ${opened.reason}`) + extra }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!started.agentId || e.isTeammate) return started

    const now = await $.clock.now()
    const row: AgentRow = {
      id: started.agentId,
      description: titleCase(e.description || e.name || e.subagentType),
      type: e.subagentType,
      model: started.model,
      prompt: e.prompt,
      phase: 'running',
      startedAt: now,
      current: 'Starting…',
      toolCount: 0,
      steps: [],
    }
    await update($, agents, list => [...list.filter(r => r.id !== row.id), row])
    void remember($, row.id, { s: now, m: started.model })

    if (!(await read($, autoOpened))) {
      await update($, autoOpened, () => true)
      void $.ui
        .open({ id: PANE, title: TITLE })
        .then(opened => {
          if (!opened.isPlaced) $.ui.log(`subagents-panel: panel waits unshown: ${opened.reason}`)
        })
        .catch(() => undefined)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    const list = await read($, agents)
    const row = list.find(r => r.id === id)
    if (!row) return next(e)

    const { tool, tool_use_id, ...input } = e as { tool: string; tool_use_id: string } & Record<string, unknown>
    if (String(tool) === HANDBACK) {
      const report = handbackReport(input)
      if (report) await patch($, id, r => ({ ...r, answer: report.slice(0, 40000), current: firstLine(report) || r.current }))
      return next(e)
    }
    const text = describeTool(String(tool), input) || String(tool)
    const at = (await $.clock.now()) - row.startedAt
    await patch($, id, r =>
      pushStep(
        { ...r, phase: 'running', endedAt: undefined, current: text, toolCount: r.toolCount + 1 },
        { kind: 'tool', id: tool_use_id, tool: String(tool), text, at, state: 'running' },
      ),
    )

    const ran = await next(e)
    const failed = 'deny' in ran && ran.deny !== undefined ? true : Boolean(ran.isError)
    await patch($, id, r => ({
      ...r,
      steps: r.steps.map(s => (s.id === tool_use_id ? { ...s, state: failed ? 'error' : 'done' } : s)),
    }))
    return ran
  }).catch(($, e, next) => next(e))

  // The agent's own words between tool calls: its narration, and the freshest "what it is doing".
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const id = e.agentId
    if (id && step.answer.trim()) {
      const text = step.answer.trim().slice(0, MAX_TEXT)
      const list = await read($, agents)
      const row = list.find(r => r.id === id)
      if (row) {
        const at = (await $.clock.now()) - row.startedAt
        await patch($, id, r => pushStep({ ...r, current: firstLine(text) }, { kind: 'say', text, at }))
      }
    }
    return step
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (!id) return result
    const now = await $.clock.now()
    const answer = e.answer.trim()
    // A turn ends whenever the agent stops to wait (on a background command of its own, say) and
    // it picks up again later. Only the engine knows which this is: while it still lists the
    // agent as running or waiting, the row stays in progress, shown as waiting.
    const info = (await $.agent.list().catch(() => [])).find(a => a.id === id)
    const still = info ? phaseOf(info.status) : undefined
    if (still && isActive(still)) {
      await patch($, id, r => ({ ...r, phase: 'waiting', endedAt: undefined, current: firstLine(answer) || r.current }))
      return result
    }
    const phase: AgentPhase = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
    await patch($, id, r => {
      // The last narration is usually the report itself: keep it once, as the result.
      const last = r.steps[r.steps.length - 1]
      const steps = last?.kind === 'say' && answer && last.text === answer.slice(0, MAX_TEXT) ? r.steps.slice(0, -1) : r.steps
      const current = phase === 'completed' ? firstLine(answer) || 'Done' : phase === 'killed' ? 'Stopped' : 'Failed'
      return { ...r, phase, endedAt: now, answer: answer || r.answer, steps, current }
    })
    void remember($, id, { e: now, p: phase })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void traceEvent($, `render ${e.surface} focused=${e.props.isFocused} placement=${e.props.placement}`)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    // Graphical surfaces (desktop, VS Code, mobile) draw SVG; the terminal draws glyphs. Decide by
    // surface, not by the table: at run time the terminal's table answers `Svg` too, and draws nothing.
    const isTerminal = e.surface === 'terminal'
    const Svg = !isTerminal && 'Svg' in els ? els.Svg : undefined
    // The terminal and a desktop run a `Client` module on the surface itself: elapsed times tick
    // there, on the surface's clock, whether or not the engine raises anything meanwhile.
    const Client = (isTerminal || e.surface === 'desktop') && 'Client' in els ? els.Client : undefined
    const liveElapsed = (key: string, baseMs: number, prefix = '', dim = true) =>
      Client ? (
        <Client key={key} module="./elapsed.tsx" props={{ baseMs, prefix, dim }} />
      ) : (
        <Text dimColor={dim}>
          {prefix}
          {duration(baseMs)}
        </Text>
      )

    const list = await read($, agents)
    const chosen = await read($, selected)
    const open = await read($, toggled)
    await read($, tick) // redraw as elapsed times move
    if (list.some(r => isActive(r.phase))) armRefresh($)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    const flip = (key: string) => update($, toggled, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]))

    const face = (row: AgentRow) => {
      // A desktop draws no Svg whose alt is empty, so every Svg here names itself.
      if (Svg) return <Svg source={avatarIcon(row.id)} alt="Agent avatar" width={18} height={18} />
      const a = avatar(row.id)
      return <Text color={a.color}>{a.glyph}</Text>
    }

    const kindChip = (kind: Kind, size = 20) => {
      if (Svg) return <Svg source={kindIcon(kind)} alt={kind} width={size} height={size} />
      // The terminal draws the same colors: blue files, green commands, purple the rest.
      return <Text color={KIND_COLOR[kind]}>{KIND_GLYPH[kind]}</Text>
    }

    const statusMark = (row: AgentRow) => {
      if (row.phase === 'running') return <Text color="claude">{RUNNING}</Text>
      if (row.phase === 'waiting') return <Text color="warning">◌</Text>
      if (row.phase === 'failed') return <Text color="error">✗</Text>
      if (row.phase === 'killed') return <Text color="inactive">■</Text>
      return <Text color="success">✓</Text>
    }

    const divider = () =>
      Svg ? (
        <Box marginTop={1}>
          <Svg source={DIVIDER} alt="Divider" height={1} />
        </Box>
      ) : (
        <Text dimColor>{'─'.repeat(Math.max(1, width - 2))}</Text>
      )

    const agent = chosen ? list.find(r => r.id === chosen) : undefined
    // The mobile app draws no text field yet.
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : undefined

    // Switching views removes the element that held the focus, and the surface then lets go of
    // the pane: the next click only took the focus back (a "double click" on desktop). Hand the
    // ring to an element the new view draws; `$.ui.focus` waits for that drawing.
    const handFocus = async (key: string) => {
      const moved = await $.ui.focus({ requestId: PANE, key }).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }))
      await traceEvent($, `hand focus -> ${key}: ${moved.deny ? `refused (${moved.deny})` : 'ok'}`)
    }
    const openAgent = async (id: string) => {
      await update($, selected, () => id)
      await handFocus('back')
    }
    const goBack = async (from: string) => {
      await update($, selected, () => null)
      await handFocus(`open-${from}`)
    }

    // ── Detail: one agent's progress ──────────────────────────────────────────
    if (agent) {
      // The default agent type says nothing; the header shows a type only when it is a chosen one.
      const meta = [agent.model, agent.type === 'general-purpose' ? '' : agent.type].filter(Boolean).join(' · ')
      const nameRoom = Math.max(8, width - meta.length - 10)
      // Kept start and end times first; else the duration the Agent call's record states.
      const hasTimes = agent.startedAt > 0 && (isActive(agent.phase) || agent.endedAt !== undefined)
      const ran = hasTimes ? (agent.endedAt ?? now) - agent.startedAt : (agent.durationMs ?? 0)
      const ranLabel = isActive(agent.phase)
        ? `${agent.phase === 'waiting' ? 'Waiting' : 'Running'}${hasTimes ? ` for ${duration(ran)}` : ''}`
        : !hasTimes && agent.durationMs === undefined
          ? agent.phase === 'completed'
            ? 'Completed'
            : agent.phase === 'failed'
              ? 'Failed'
              : 'Stopped'
          : agent.phase === 'completed'
            ? `Ran for ${duration(ran)}`
            : `${agent.phase === 'failed' ? 'Failed' : 'Stopped'} after ${duration(ran)}`

      // Runs of consecutive tool calls fold into one group, as Codex shows them.
      type Block = { kind: 'say'; step: AgentStep } | { kind: 'you'; step: AgentStep } | { kind: 'tools'; key: string; steps: AgentStep[] }
      const blocks: Block[] = []
      agent.steps.forEach((step, i) => {
        const last = blocks[blocks.length - 1]
        if (step.kind === 'say') blocks.push({ kind: 'say', step })
        else if (step.kind === 'you') blocks.push({ kind: 'you', step })
        else if (last?.kind === 'tools') last.steps.push(step)
        else blocks.push({ kind: 'tools', key: `${agent.id}:g${i}`, steps: [step] })
      })
      const lastTools = [...blocks].reverse().find(b => b.kind === 'tools')
      const taskKey = `${agent.id}:task`

      return (
        <Box flexDirection="column" paddingX={1} minHeight={isActive(agent.phase) && Client ? e.props.scroll.bodyRows : undefined}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {isTerminal ? (
              <Button key="back" plain hotkey="b" label="←" onPress={() => goBack(agent.id)} />
            ) : (
              <Button key="back" plain label="←" onPress={() => goBack(agent.id)} />
            )}
            {face(agent)}
            <Text bold wrap="truncate-end">
              {clip(agent.description, nameRoom)}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate-end">
              {meta}
            </Text>
          </Box>
          {divider()}

          <Box flexDirection="row" alignItems="center" marginTop={1}>
            {statusMark(agent)}
            {isActive(agent.phase) && hasTimes ? (
              liveElapsed('elapsed-detail', ran, ` ${agent.phase === 'waiting' ? 'Waiting' : 'Running'} for `)
            ) : (
              <Text dimColor> {ranLabel}</Text>
            )}
            {agent.toolCount > 0 && <Text dimColor> · {agent.toolCount} tool calls</Text>}
          </Box>

          {agent.prompt !== '' && (
            <Box flexDirection="column" marginTop={1}>
              <Button
                key="task"
                plain
                dimColor
                label={`${open.includes(taskKey) ? '▾' : '▸'} Task`}
                onPress={() => flip(taskKey)}
              />
              {open.includes(taskKey) && (
                <Box paddingLeft={2} marginTop={1}>
                  <Markdown text={agent.prompt.slice(0, MAX_TEXT)} dimColor />
                </Box>
              )}
            </Box>
          )}

          {blocks.length === 0 && !isActive(agent.phase) && agent.note && (
            <Box marginTop={1}>
              <Text dimColor italic>
                Steps unavailable after resume: {agent.note}
              </Text>
            </Box>
          )}

          {blocks.length === 0 && isActive(agent.phase) && (
            <Box marginTop={1}>
              <Text dimColor italic>
                {agent.current}
              </Text>
            </Box>
          )}

          {blocks.map(block => {
            if (block.kind === 'you') {
              return (
                <Box marginTop={1} flexDirection="row">
                  <Text color="claude" bold>
                    You →{' '}
                  </Text>
                  <Text>{block.step.text}</Text>
                </Box>
              )
            }
            if (block.kind === 'say') {
              return (
                <Box marginTop={1}>
                  <Markdown text={block.step.text} />
                </Box>
              )
            }
            // The live group stays open while the agent works; the person's toggle flips it.
            const isLive = block === lastTools && isActive(agent.phase)
            const isOpen = isLive !== open.includes(block.key)
            const running = block.steps.some(s => s.state === 'running')
            const failed = block.steps.filter(s => s.state === 'error').length
            const kinds = KINDS.filter(k => block.steps.some(s => kindOf(s.tool ?? '') === k))
            const label = `${isOpen ? '▾' : '▸'} ${groupTitle(block.steps)}`
            // The label and its marks share a row; the row wraps, so the marks move to a second
            // line only when the surface itself runs out of room. Neither part shrinks.
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
                  <Box flexShrink={0}>
                    <Button key={block.key} plain dimColor label={label} onPress={() => flip(block.key)} />
                  </Box>
                  <Box flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
                    {kinds.map(k => kindChip(k, 16))}
                    {failed > 0 && <Text color="error">{failed} failed</Text>}
                    {running && <Text color="claude">{RUNNING}</Text>}
                  </Box>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={2} marginTop={Svg ? 1 : 0} gap={Svg ? 1 : 0}>
                    {block.steps.slice(-40).map(s => {
                      const kind = kindOf(s.tool ?? '')
                      if (Svg) {
                        return (
                          <Box flexDirection="row" alignItems="center" gap={1}>
                            {kindChip(kind)}
                            <Text color={s.state === 'error' ? 'error' : undefined} dimColor={s.state === 'done'} wrap="truncate-end">
                              {clip(s.text, width - 10)}
                            </Text>
                            <Box flexGrow={1} />
                            {s.state === 'running' && <Text color="claude">{RUNNING}</Text>}
                            {s.state === 'error' && <Text color="error">✗</Text>}
                          </Box>
                        )
                      }
                      return (
                        <Box flexDirection="row">
                          <Text color={s.state === 'error' ? 'error' : s.state === 'running' ? 'claude' : KIND_COLOR[kind]}>
                            {s.state === 'error' ? '✗ ' : s.state === 'running' ? `${RUNNING} ` : `${KIND_GLYPH[kind]} `}
                          </Text>
                          <Text dimColor={s.state === 'done'} wrap="truncate-end">
                            {clip(s.text, width - 8)}
                          </Text>
                        </Box>
                      )
                    })}
                  </Box>
                )}
              </Box>
            )
          })}

          {agent.answer && !isActive(agent.phase) && (
            <Box marginTop={1} flexDirection="column">
              <Markdown text={agent.answer.slice(0, 40000)} />
            </Box>
          )}

          {/* A running agent takes messages, as the SendMessage tool delivers them: the engine
              queues the text for the agent's loop, which reads it at its next step. */}
          {/* A running agent takes messages. The box is a surface module of its own: it wraps what
              is typed and grows a line at a time, full width, at the foot of the pane. Where no
              surface module runs (VS Code, mobile), a one-line field stands in. */}
          {isActive(agent.phase) && (Client || Input) && <Box flexGrow={1} />}
          {isActive(agent.phase) && Client && (
            <Box marginTop={1} width="100%">
              <Client key="agent-chat" module="./composer.tsx" width="100%" props={{ agentId: agent.id, placeholder: 'Message this subagent', terminal: isTerminal }} />
            </Box>
          )}
          {isActive(agent.phase) && !Client && Input && (
            <Box marginTop={1} width="100%">
              <Input
                key="agent-chat-field"
                placeholder="Message this subagent"
                submitLabel="send"
                onSubmit={value => {
                  void deliver($, agent.id, value).then(reason => {
                    if (reason) $.ui.toast(`Message not delivered: ${reason}`)
                  })
                }}
              />
            </Box>
          )}
        </Box>
      )
    }

    // ── Overview: every subagent, in two sections ─────────────────────────────
    // Search: every word must appear in the agent's name, type, current line, task or report.
    // The mobile app draws no text field yet, so it lists everything.
    const raw = Input ? await read($, query) : ''
    const search = raw.trim()
    const typed = draft ?? raw
    // Lit while the person's keys are in the field: the pane has the keyboard and its ring is on it.
    const searchFocused = e.props.isFocused && (await read($, focusedKey)) === 'search'
    const setSearch = (value: string, now = false) => {
      draft = value
      pendingFilter?.cancel()
      pendingFilter = undefined
      if (now) {
        void update($, query, () => value)
        return
      }
      pendingFilter = $.clock.after(SEARCH_DEBOUNCE_MS, () => {
        pendingFilter = undefined
        void update($, query, () => value)
      })
    }
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (r: AgentRow) => {
      if (words.length === 0) return true
      const hay = [r.description, r.type, r.current, r.prompt, r.answer ?? ''].join(' ').toLowerCase()
      return words.every(w => hay.includes(w))
    }
    const shown = list.filter(matches)
    const active = shown.filter(r => isActive(r.phase)).sort((a, b) => b.startedAt - a.startedAt)
    const done = shown.filter(r => !isActive(r.phase)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const wantActive = await read($, showActive)
    const wantDone = await read($, showDone)

    const row = (r: AgentRow) => {
      const hasTimes = r.startedAt > 0
      const when = isActive(r.phase)
        ? hasTimes
          ? duration(now - r.startedAt)
          : ''
        : r.phase === 'completed'
          ? r.endedAt
            ? ago(now - r.endedAt)
            : 'earlier'
          : r.phase
      const nameRoom = Math.max(8, width - when.length - 8)
      return (
        <Box key={`row-${r.id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {face(r)}
            <Button key={`open-${r.id}`} plain label={clip(r.description, nameRoom)} onPress={() => openAgent(r.id)} />
            <Box flexGrow={1} />
            {isActive(r.phase) && hasTimes ? (
              liveElapsed(`elapsed-${r.id}`, now - r.startedAt)
            ) : (
              <Text color={r.phase === 'failed' ? 'error' : undefined} dimColor={r.phase !== 'failed'}>
                {when}
              </Text>
            )}
          </Box>
          {isActive(r.phase) && (
            <Box flexDirection="row" paddingLeft={2}>
              {statusMark(r)}
              <Text dimColor wrap="truncate-end">
                {' '}
                {clip(r.current, width - 6)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const header = (key: string, label: string, count: number, shown: boolean, onPress: () => unknown) => (
      <Box flexDirection="row" marginBottom={1}>
        <Button key={key} plain dimColor label={`${shown ? '▾' : '▸'} ${label} · ${count}`} onPress={() => void onPress()} />
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {Input && (
          // The terminal draws the field inside a rounded border with a ⌕ in it; a desktop draws its
          // own native field, so it gets the magnifier beside it and no second border.
          <Box
            flexDirection="row"
            alignItems="center"
            gap={1}
            marginBottom={1}
            {...(isTerminal
              ? searchFocused
                ? { borderStyle: 'round', borderColor: 'text', paddingX: 1 }
                : { borderStyle: 'round', borderDimColor: true, paddingX: 1 }
              : {})}
          >
            {Svg ? <Svg source={SEARCH_ICON} alt="Search" width={16} height={16} /> : <Text dimColor>⌕</Text>}
            <Box flexGrow={1}>
              <Input
                key="search"
                placeholder="Search subagents"
                value={typed}
                // Typing filters already. The terminal draws no Enter label when it is empty; a desktop
                // still draws a blank button for one, so there it keeps its word.
                submitLabel={isTerminal ? '' : 'filter'}
                onInput={value => setSearch(value)}
                onSubmit={value => setSearch(value, true)}
              />
            </Box>
            {typed !== '' && <Button key="clear-search" plain dimColor label="×" onPress={() => setSearch('', true)} />}
          </Box>
        )}
        {words.length > 0 && shown.length === 0 && (
          <Box marginBottom={1}>
            <Text dimColor>No subagents match "{clip(search, width - 24)}"</Text>
          </Box>
        )}
        {header('toggle-active', 'In progress', active.length, wantActive, () => update($, showActive, v => !v))}
        {wantActive && active.length === 0 && words.length === 0 && (
          <Box marginBottom={1}>
            <Text dimColor>No subagents running</Text>
          </Box>
        )}
        {wantActive && active.map(row)}

        <Box marginTop={1} />
        {header('toggle-done', 'Completed', done.length, wantDone, () => update($, showDone, v => !v))}
        {wantDone && done.length === 0 && words.length === 0 && <Text dimColor>None yet</Text>}
        {wantDone && done.map(row)}
      </Box>
    )
  })

  // ── The band above the prompt ──────────────────────────────────────────────
  // A one-line status of this session's subagents and a way into the panel, on the terminal and the
  // desktop alike: avatars (SVG on a desktop, colored glyphs on the terminal), the counts, an Open
  // button and a close mark. What each agent is doing is the panel's to show, not the band's.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (await read($, bandHidden)) return next(e)
    const list = await read($, agents)
    if (list.length === 0) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const isTerminal = e.surface === 'terminal'
    const Svg = !isTerminal && 'Svg' in els ? els.Svg : undefined

    await read($, tick) // redraw as elapsed times move
    if (list.some(r => isActive(r.phase))) armRefresh($)
    const running = list.filter(r => isActive(r.phase)).sort((a, b) => b.startedAt - a.startedAt)
    const done = list.length - running.length
    const failed = list.filter(r => r.phase === 'failed').length
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

    const headline = running.length > 0 ? `${plural(running.length, 'subagent')} running` : `${plural(done, 'subagent')} finished`
    const tail = [running.length > 0 && done > 0 ? `${done} done` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean)
    // One line, never wrapped: what does not fit gives way, the done count first, then the
    // button's words. What each agent is doing belongs to the panel, not here.
    const cols = e.props.bodyColumns
    // How many heads the band shows: five when wide, fewer as it narrows; past that, the first
    // few as a stack and "+N" for the rest, so a crowd never pushes the line over.
    const cap = cols >= 90 ? 5 : cols >= 60 ? 3 : 2
    const crowded = running.length > cap
    const shownHeads = running.slice(0, crowded ? cap - 1 : cap)
    const moreText = crowded ? `+${running.length - shownHeads.length}` : ''
    const stacked = Svg !== undefined && shownHeads.length >= 3
    const avatarsWidth =
      running.length === 0 ? 2 : (stacked ? Math.ceil((24 + 14 * (shownHeads.length - 1)) / 8) : shownHeads.length * 2) + (moreText ? moreText.length + 3 : 0)
    const buttonWidth = (label: string) => label.length + (isTerminal ? 4 : 2)
    const room = (tailText: string, label: string) => 2 + avatarsWidth + headline.length + (tailText ? tailText.length + 1 : 0) + buttonWidth(label) + 3 <= cols
    const fullTail = tail.length > 0 ? `· ${tail.join(' · ')}` : ''
    const tailText = room(fullTail, 'Open subagents') || room(fullTail, 'Open') ? fullTail : ''
    const openLabel = room(tailText, 'Open subagents') ? 'Open subagents' : 'Open'

    const face = (r: AgentRow) => {
      if (Svg) return <Svg source={avatarIcon(r.id)} alt="Agent avatar" width={16} height={16} />
      const a = avatar(r.id)
      return <Text color={a.color}>{a.glyph}</Text>
    }

    const band = (
      <Box key="subagents-band" flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} paddingX={1}>
        {running.length === 0 ? (
          <Text color="success">✓</Text>
        ) : stacked && Svg ? (
          <Svg
            source={avatarStack(shownHeads.map(r => r.id))}
            alt="Agent avatars"
            width={24 + 14 * (shownHeads.length - 1)}
            height={18}
          />
        ) : (
          // The terminal packs its glyphs tight: a character cell cannot overlap another.
          <Box flexDirection="row" flexShrink={0}>
            {shownHeads.map(face)}
          </Box>
        )}
        {moreText !== '' && (
          // "+3 · 7 subagents running": the dot keeps the two numbers from reading as one.
          <Box flexShrink={0} flexDirection="row" gap={1}>
            <Text dimColor bold>
              {moreText}
            </Text>
            <Text dimColor>·</Text>
          </Box>
        )}
        <Box flexShrink={0}>
          <Text bold={running.length > 0} wrap="truncate-end">
            {headline}
          </Text>
        </Box>
        {tailText !== '' && (
          <Box flexShrink={0}>
            <Text dimColor wrap="truncate-end">
              {tailText}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} />
        <Button
          key="open-subagents"
          label={openLabel}
          onPress={() => void $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined)}
        />
        {/* The close mark at the far right. Hovering it floats a small card over the band, left of
            the mark, saying how to bring the band back: it covers rather than pushes the line, as
            a tooltip would (a mod's Button carries no native tooltip). A click hides the band and
            says so in a toast. */}
        <Box key="band-close" position="relative" flexDirection="row" alignItems="center">
          <Box
            position="absolute"
            top={0}
            right={3}
            display="none"
            hover={{ display: 'flex' }}
            backgroundColor="#2B2D31"
            paddingX={1}
          >
            {/* Fixed colors, not theme names: a tooltip reads light on dark in either theme. */}
            <Text color="#F2F2F2" wrap="truncate-end">
              Type /subagents to bring it back
            </Text>
          </Box>
          <Button
            key="dismiss-band"
            role="dismiss"
            plain
            dimColor
            label="×"
            onPress={() => {
              void update($, bandHidden, () => true)
              $.ui.toast('Subagents band hidden. Type /subagents to bring back the band and the panel.')
            }}
          />
        </Box>
      </Box>
    )
    // The terminal sets the band off from the conversation above with a rule across its top.
    if (!isTerminal) return band
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(1, cols))}
        </Text>
        {band}
      </Box>
    )
  })

}
