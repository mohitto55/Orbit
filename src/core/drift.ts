import { promises as fs, type Stats } from 'fs'
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
  status: 'pending' | 'done' | 'rejected'
  /** 반영·반려할 때 남긴 메모 */
  resolution?: string
  created: string
  /** AI 수정안이 요청 파일에 저장돼 있으면 그 시각 */
  draftAt?: string
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

/**
 * 대화 기록 요약 캐시. 대화 파일(jsonl)은 끝에 줄이 붙기만 하므로, 파일마다 어디까지 읽었는지 기억해 두고
 * 새로 붙은 줄만 더 읽는다. 대시보드·배지가 자주 부르는데, 매번 수십 MB를 다시 읽으면 앱 전체가 멈칫한다.
 */
interface SessionScan {
  size: number
  mtimeMs: number
  /** 여기까지 읽었다 (바이트) */
  offset: number
  count: number
  firstAt?: string
  firstPrompt?: string
  cwd?: string
  id?: string
}
const scans = new Map<string, SessionScan>()

async function scanSession(file: string, agent: Agent): Promise<{ scan: SessionScan; st: Stats }> {
  const st = await fs.stat(file)
  const cached = scans.get(file)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return { scan: cached, st }
  // 처음 보거나 파일이 줄었으면(새로 쓰임) 처음부터 읽는다
  const scan: SessionScan = cached && st.size >= cached.offset ? { ...cached } : { size: 0, mtimeMs: 0, offset: 0, count: 0 }
  const len = st.size - scan.offset
  if (len > 0) {
    const buf = Buffer.alloc(len)
    const fh = await fs.open(file, 'r')
    try {
      await fh.read(buf, 0, len, scan.offset)
    } finally {
      await fh.close()
    }
    // 아직 쓰는 중인 마지막 줄은 남겨 두었다가 다음에 읽는다. 줄바꿈 없이 끝났어도 완전한 JSON이면 읽는다.
    let used = buf.lastIndexOf(0x0a) + 1
    const tail = buf.subarray(used).toString('utf8').trim()
    if (tail) {
      try {
        JSON.parse(tail)
        used = len
      } catch {
        // 쓰는 중
      }
    }
    const { messages, cwd, id } = parseSessionLines(buf.subarray(0, used).toString('utf8'), agent)
    scan.cwd ??= cwd
    scan.id ??= id
    scan.firstAt ??= messages[0]?.at
    if (scan.firstPrompt === undefined) {
      const first = messages.find((m) => m.role === 'user')
      if (first) scan.firstPrompt = first.text.slice(0, 200)
    }
    scan.count += messages.length
    scan.offset += used
  }
  scan.size = st.size
  scan.mtimeMs = st.mtimeMs
  scans.set(file, scan)
  return { scan, st }
}

function toInfo(file: string, agent: Agent, scan: SessionScan, st: Stats): SessionInfo | null {
  if (scan.count === 0) return null
  return {
    id: `${agent}:${scan.id ?? path.basename(file, '.jsonl')}`,
    agent,
    file,
    startedAt: scan.firstAt ?? st.birthtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
    firstPrompt: scan.firstPrompt ?? '',
    messages: scan.count
  }
}

export async function listClaudeSessions(projectDir: string, home = os.homedir()): Promise<SessionInfo[]> {
  const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectDir))
  if (!(await exists(dir))) return []
  const out: SessionInfo[] = []
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    const { scan, st } = await scanSession(file, 'claude')
    const info = toInfo(file, 'claude', scan, st)
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
    const { scan, st } = await scanSession(file, 'codex')
    if (!scan.cwd || !samePath(scan.cwd, projectDir)) continue
    const info = toInfo(file, 'codex', scan, st)
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

/** IR-F08: 변경 요청을 반영 완료(done) 또는 반려(rejected)로 닫는다. */
export async function resolveRequest(ctx: Ctx, id: string, status: 'done' | 'rejected' = 'done', note = ''): Promise<void> {
  const req = (await listRequests(ctx)).find((r) => r.id === id)
  if (!req) throw new Error(`변경 요청을 찾을 수 없습니다: ${id}`)
  if (req.status !== 'pending') throw new Error('이미 처리한 변경 요청입니다')
  const { data, content } = await readMd(req.file)
  await writeMd(req.file, { ...data, status, resolvedAt: nowIso(), ...(note ? { resolution: note } : {}) }, content)
}
