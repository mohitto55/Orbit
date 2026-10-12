import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Ctx, ProjectSettings } from './workspace'
import { exists, listMd, readMd, writeMd, stamp, nowIso } from './md'
import { addInbox } from './task'
import { saveKnowledge } from './knowledge'

export type Agent = 'claude' | 'codex'

export interface SessionInfo {
  id: string
  agent: Agent
  file: string
  startedAt: string
  updatedAt: string
  firstPrompt: string
  messages: number
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  text: string
  at?: string
}

export interface Mark {
  kind: 'domain' | 'task' | 'knowledge'
  excerpt: string
  sessionId: string
  domainId?: string
  note?: string
}

export interface DriftCheck {
  id: string
  startedAt: string
  finishedAt: string
  sessions: string[]
  marks: Mark[]
  file: string
}

export interface DomainRequest {
  id: string
  domain: string
  excerpt: string
  note?: string
  source: string
  status: 'pending' | 'done'
  created: string
  file: string
}

/** Claude Code는 프로젝트 경로의 영숫자 외 문자를 '-'로 바꾼 폴더에 세션을 둔다. */
export function encodeClaudeProjectDir(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, '-')
}

function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text'))
    .map((c) => c.text)
    .join('\n')
}

function isNoise(text: string): boolean {
  const t = text.trim()
  return !t || t.startsWith('<') || t.startsWith('Caveat:')
}

export function parseSessionLines(raw: string, agent: Agent): { messages: SessionMessage[]; cwd?: string; id?: string } {
  const messages: SessionMessage[] = []
  let cwd: string | undefined
  let id: string | undefined
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (agent === 'claude') {
      cwd ??= obj.cwd
      id ??= obj.sessionId
      if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) {
        const text = textOf(obj.message.content)
        if (!isNoise(text)) messages.push({ role: obj.type, text, at: obj.timestamp })
      }
    } else {
      if (obj.type === 'session_meta') {
        cwd ??= obj.payload?.cwd
        id ??= obj.payload?.id
        continue
      }
      const item = obj.payload ?? obj
      if (item?.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
        const text = textOf(item.content)
        if (!isNoise(text)) messages.push({ role: item.role, text, at: obj.timestamp })
      }
    }
  }
  return { messages, cwd, id }
}

async function toInfo(file: string, agent: Agent, raw: string): Promise<SessionInfo | null> {
  const { messages, id } = parseSessionLines(raw, agent)
  if (messages.length === 0) return null
  const st = await fs.stat(file)
  const first = messages.find((m) => m.role === 'user')
  return {
    id: `${agent}:${id ?? path.basename(file, '.jsonl')}`,
    agent,
    file,
    startedAt: messages[0].at ?? st.birthtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
    firstPrompt: (first?.text ?? '').slice(0, 200),
    messages: messages.length
  }
}

export async function listClaudeSessions(projectDir: string, home = os.homedir()): Promise<SessionInfo[]> {
  const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectDir))
  if (!(await exists(dir))) return []
  const out: SessionInfo[] = []
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    const info = await toInfo(file, 'claude', await fs.readFile(file, 'utf8'))
    if (info) out.push(info)
  }
  return out
}

async function walkJsonl(dir: string, since: number, out: string[]) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walkJsonl(p, since, out)
    else if (e.name.endsWith('.jsonl') && (await fs.stat(p)).mtimeMs >= since) out.push(p)
  }
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

export async function listCodexSessions(projectDir: string, home = os.homedir(), since = 0): Promise<SessionInfo[]> {
  const files: string[] = []
  await walkJsonl(path.join(home, '.codex', 'sessions'), since, files)
  const out: SessionInfo[] = []
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8')
    const { cwd } = parseSessionLines(raw, 'codex')
    if (!cwd || !samePath(cwd, projectDir)) continue
    const info = await toInfo(file, 'codex', raw)
    if (info) out.push(info)
  }
  return out
}

export async function readSessionMessages(file: string, agent: Agent): Promise<SessionMessage[]> {
  return parseSessionLines(await fs.readFile(file, 'utf8'), agent).messages
}

export async function listChecks(ctx: Ctx): Promise<DriftCheck[]> {
  const out: DriftCheck[] = []
  for (const file of await listMd(path.join(ctx.dataRoot, 'drift'))) {
    const { data } = await readMd(file)
    if (data.kind === 'ai-check') continue // AI 점검 기록은 aicheck.ts가 따로 다룬다
    out.push({ id: data.id, startedAt: data.startedAt, finishedAt: data.finishedAt, sessions: data.sessions ?? [], marks: data.marks ?? [], file })
  }
  return out.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
}

/** DR-F02: 지난 검토 이후, 아직 검토하지 않은 세션. */
export async function pendingSessions(ctx: Ctx, home = os.homedir()): Promise<SessionInfo[]> {
  const checks = await listChecks(ctx)
  const reviewed = new Set(checks.flatMap((c) => c.sessions))
  const sessions = [...(await listClaudeSessions(ctx.projectDir, home)), ...(await listCodexSessions(ctx.projectDir, home))]
  return sessions.filter((s) => !reviewed.has(s.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** DR-F01: 주기가 지났고 새 세션이 있을 때만 검토가 필요하다. */
export function isDriftDue(checks: DriftCheck[], settings: ProjectSettings, pendingCount: number, now = new Date()): boolean {
  if (pendingCount === 0) return false
  const last = checks[checks.length - 1]
  if (!last) return true
  const days = (now.getTime() - new Date(last.finishedAt).getTime()) / 86400000
  return days >= settings.driftIntervalDays
}

export async function finishCheck(ctx: Ctx, input: { sessionIds: string[]; marks: Mark[]; startedAt?: string }): Promise<DriftCheck> {
  const id = `drift-${stamp()}`
  const file = path.join(ctx.dataRoot, 'drift', `${id}.md`)
  const finishedAt = nowIso()
  for (const m of input.marks) {
    if (m.kind === 'domain') {
      if (!m.domainId) throw new Error('도메인 반영 표시에는 대상 도메인이 필요합니다')
      const rid = `req-${stamp()}`
      await writeMd(
        path.join(ctx.dataRoot, 'requests', `${rid}.md`),
        { id: rid, kind: 'domain-request', domain: m.domainId, excerpt: m.excerpt, ...(m.note ? { note: m.note } : {}), source: `drift:${id}`, status: 'pending', created: finishedAt },
        `> ${m.excerpt.replace(/\n/g, '\n> ')}\n`
      )
    } else if (m.kind === 'task') {
      await addInbox(ctx, m.note || m.excerpt.slice(0, 80), m.sessionId)
    } else {
      await saveKnowledge(ctx, { type: '교훈', title: m.note || m.excerpt.slice(0, 60), content: `> ${m.excerpt}\n`, status: '초안', sources: [m.sessionId] })
    }
  }
  const check = { id, kind: 'drift-check', startedAt: input.startedAt ?? finishedAt, finishedAt, sessions: input.sessionIds, marks: input.marks }
  await writeMd(file, check, `# Drift 검토\n\n세션 ${input.sessionIds.length}개, 표시 ${input.marks.length}개\n`)
  return { ...check, file }
}

export async function listRequests(ctx: Ctx): Promise<DomainRequest[]> {
  const out: DomainRequest[] = []
  for (const file of await listMd(path.join(ctx.dataRoot, 'requests'))) {
    const { data } = await readMd(file)
    out.push({ ...(data as any), file })
  }
  return out
}

export async function resolveRequest(ctx: Ctx, id: string): Promise<void> {
  const req = (await listRequests(ctx)).find((r) => r.id === id)
  if (!req) throw new Error(`변경 요청을 찾을 수 없습니다: ${id}`)
  const { data, content } = await readMd(req.file)
  await writeMd(req.file, { ...data, status: 'done' }, content)
}
