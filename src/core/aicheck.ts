import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, stamp, nowIso } from './md'
import { listDomains, domainPathLabel } from './domain'
import { listChecks, pendingSessions, readSessionMessages, type SessionInfo } from './drift'
import { addInbox } from './task'
import { saveKnowledge } from './knowledge'
import { checkAnchors } from './codecheck'

/**
 * 도메인 점검: 지난 점검 이후의 작업 대화·커밋과 현재 도메인 문서를 AI(Claude Code / Codex)에게 주고
 * 도메인이 실제 작업과 맞는지 점검하게 한다. AI는 제안만 하고, 반영 여부는 사람이 항목마다 정한다.
 */

export type CheckAgent = 'claude' | 'codex'
export type FindingKind = 'domain' | 'task' | 'knowledge'
export type FindingStatus = 'pending' | 'accepted' | 'dismissed'

export interface Finding {
  id: string
  kind: FindingKind
  /** kind가 domain일 때 고칠 도메인 id */
  domainId?: string
  title: string
  detail: string
  /** 근거: 대화 인용, 커밋 등 */
  evidence?: string
  sessionId?: string
  status: FindingStatus
}

export interface AiCheck {
  id: string
  agent: CheckAgent
  since: string | null
  startedAt: string
  finishedAt: string
  sessions: string[]
  summary: string
  findings: Finding[]
  error?: string
  file: string
}

const SESSION_CHARS = 6000
const TOTAL_CHARS = 60000

async function gitLog(projectDir: string, since: string | null): Promise<string> {
  const args = ['-C', projectDir, 'log', '--no-merges', '--format=%h %ad %s', '--date=short', '--stat=100', '-n', '50']
  if (since) args.push(`--since=${since}`)
  try {
    const { stdout } = await promisify(execFile)('git', args, { maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** 지난 점검 시각. AI 점검과 직접 점검 중 더 최근 것. */
export async function lastCheckAt(ctx: Ctx): Promise<string | null> {
  const times = [...(await listChecks(ctx)).map((c) => c.finishedAt), ...(await listAiChecks(ctx)).filter((c) => !c.error).map((c) => c.finishedAt)]
  return times.sort().pop() ?? null
}

/** AI에게 줄 점검 요청문. 도구 없이도 판단할 수 있게 필요한 자료를 모두 담는다. */
export async function buildCheckPrompt(ctx: Ctx, sessions: SessionInfo[], since: string | null, log: string): Promise<string> {
  const domains = await listDomains(ctx)
  const domainText = domains
    .map((d) => `### ${domainPathLabel(domains, d.id)} (id: ${d.id}, v${d.version})\n${d.content.trim()}`)
    .join('\n\n')

  const anchors = await checkAnchors(ctx, domains).catch(() => [])
  const anchorText = anchors.map((a) => `- ${a.domainId} › ${a.concept}: \`${a.anchor}\` → ${a.found ?? '찾지 못함'}`).join('\n')

  let budget = TOTAL_CHARS
  const sessionText: string[] = []
  for (const s of sessions) {
    if (budget <= 0) break
    const msgs = await readSessionMessages(s.file, s.agent)
    let text = msgs.map((m) => `${m.role === 'user' ? '사람' : 'AI'}: ${m.text}`).join('\n')
    const limit = Math.min(SESSION_CHARS, budget)
    if (text.length > limit) text = '…(앞부분 생략)\n' + text.slice(-limit)
    budget -= text.length
    sessionText.push(`### 세션 ${s.id} (${s.updatedAt})\n${text}`)
  }

  return `너는 이 프로젝트의 도메인 모델을 점검하는 리뷰어다.
${since ? `지난 점검(${since}) 이후` : '지금까지'}의 작업 대화와 커밋을 보고, 아래 도메인 문서가 실제 작업과 맞는지 점검해라.

찾을 것:
- domain: 작업에서 새로 생기거나 바뀐 도메인 규칙·용어·역할인데 도메인 문서에 없거나 다르게 적힌 것 (고칠 도메인 id를 domainId에)
- task: 대화에서 "나중에", "TODO"처럼 미뤄둔 할 일
- knowledge: 도메인 규칙은 아니지만 남겨둘 결정·교훈·주의사항
- domain (모델): 도메인 문서의 \`## 모델\` 표가 코드와 어긋난 것. 코드 위치를 찾지 못한 개념, 커밋에서 이름이 바뀌거나 옮겨진 클래스,
  개념이 지켜야 할 규칙·계산이 모델이 아니라 응용 서비스(호출 순서를 조율하는 쪽)에 들어간 것, 새 개념·관계가 생겼는데 표에 없는 것

규칙:
- 문서를 직접 고치지 말고 제안만 한다.
- 근거(대화 인용이나 커밋)가 없는 추측은 넣지 않는다. 문제가 없으면 findings를 빈 배열로 둔다.
- 반드시 아래 JSON 하나만 출력한다. 설명 문장이나 코드 블록 밖 텍스트를 붙이지 않는다.

{"summary": "한두 문장 요약", "findings": [{"kind": "domain|task|knowledge", "domainId": "dom-…(domain일 때)", "title": "한 줄 제목", "detail": "무엇을 어떻게 고치자는지", "evidence": "근거 인용", "sessionId": "근거 세션 id(있으면)"}]}

## 현재 도메인 문서

${domainText}

## 모델 표의 코드 위치 확인 결과

${anchorText || '(코드 위치가 적힌 개념 없음)'}

## 커밋

${log || '(없음)'}

## 작업 대화

${sessionText.join('\n\n') || '(없음)'}
`
}

/** AI 응답에서 JSON을 꺼낸다. 코드 블록으로 감싸거나 앞뒤에 말을 붙여도 처리한다. */
export function parseCheckResult(text: string): { summary: string; findings: Omit<Finding, 'id' | 'status'>[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 응답에서 결과(JSON)를 찾지 못했습니다')
  const data = JSON.parse(body.slice(start, end + 1))
  const kinds: FindingKind[] = ['domain', 'task', 'knowledge']
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .filter((f: any) => f && kinds.includes(f.kind) && typeof f.title === 'string')
    .map((f: any) => ({
      kind: f.kind as FindingKind,
      ...(f.domainId ? { domainId: String(f.domainId) } : {}),
      title: f.title.trim(),
      detail: String(f.detail ?? '').trim(),
      ...(f.evidence ? { evidence: String(f.evidence) } : {}),
      ...(f.sessionId ? { sessionId: String(f.sessionId) } : {})
    }))
  return { summary: String(data.summary ?? '').trim(), findings }
}

/** 에이전트 실행기. 요청문을 받아 최종 응답 텍스트를 돌려준다 (테스트에서는 가짜로 바꿔 끼운다). */
export type AgentRunner = (agent: CheckAgent, prompt: string, cwd: string, onOutput: (chunk: string) => void) => Promise<string>

export async function runAiCheck(ctx: Ctx, agent: CheckAgent, runner: AgentRunner, onOutput: (chunk: string) => void = () => {}): Promise<AiCheck> {
  const startedAt = nowIso()
  const since = await lastCheckAt(ctx)
  const sessions = (await pendingSessions(ctx)).filter((s) => !since || s.updatedAt > since)
  const log = await gitLog(ctx.projectDir, since)
  const prompt = await buildCheckPrompt(ctx, sessions, since, log)
  onOutput(`점검 대상: 대화 ${sessions.length}개, 커밋 ${log ? log.split('\n').filter((l) => /^[0-9a-f]{7,} /.test(l)).length : 0}개${since ? ` (지난 점검 ${since} 이후)` : ''}\n`)

  const id = `aicheck-${stamp()}`
  const file = path.join(ctx.dataRoot, 'drift', `${id}.md`)
  let result: AiCheck
  try {
    const text = await runner(agent, prompt, ctx.projectDir, onOutput)
    const parsed = parseCheckResult(text)
    result = {
      id,
      agent,
      since,
      startedAt,
      finishedAt: nowIso(),
      sessions: sessions.map((s) => s.id),
      summary: parsed.summary,
      findings: parsed.findings.map((f, i) => ({ ...f, id: `f${i + 1}`, status: 'pending' as const })),
      file
    }
  } catch (e) {
    result = { id, agent, since, startedAt, finishedAt: nowIso(), sessions: [], summary: '', findings: [], error: e instanceof Error ? e.message : String(e), file }
  }
  await saveAiCheck(result)
  return result
}

async function saveAiCheck(c: AiCheck) {
  const { file, ...data } = c
  const lines = c.findings.map((f) => `- [${f.status === 'pending' ? ' ' : 'x'}] (${f.kind}) ${f.title}`)
  await writeMd(file, { ...data, kind: 'ai-check' }, `# AI 도메인 점검\n\n${c.error ? `실패: ${c.error}` : c.summary}\n\n${lines.join('\n')}\n`)
}

export async function listAiChecks(ctx: Ctx): Promise<AiCheck[]> {
  const out: AiCheck[] = []
  for (const file of await listMd(path.join(ctx.dataRoot, 'drift'))) {
    const { data } = await readMd(file)
    if (data.kind !== 'ai-check') continue
    out.push({ ...(data as any), findings: data.findings ?? [], sessions: data.sessions ?? [], file })
  }
  return out.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
}

/** 항목 받아들이기: domain → 도메인 변경 요청, task → Inbox, knowledge → 지식 초안. 무시하면 기록만 남긴다. */
export async function decideFinding(ctx: Ctx, checkId: string, findingId: string, accept: boolean): Promise<Finding> {
  const check = (await listAiChecks(ctx)).find((c) => c.id === checkId)
  if (!check) throw new Error(`점검 기록을 찾을 수 없습니다: ${checkId}`)
  const f = check.findings.find((x) => x.id === findingId)
  if (!f) throw new Error(`점검 항목을 찾을 수 없습니다: ${findingId}`)
  if (f.status !== 'pending') throw new Error('이미 처리한 항목입니다')
  if (accept) {
    const source = `ai-check:${check.id}`
    if (f.kind === 'domain') {
      if (!f.domainId || !(await listDomains(ctx)).some((d) => d.id === f.domainId)) throw new Error('고칠 도메인을 알 수 없습니다. 무시하거나 직접 변경 요청을 남기세요')
      const rid = `req-${stamp()}`
      await writeMd(
        path.join(ctx.dataRoot, 'requests', `${rid}.md`),
        { id: rid, kind: 'domain-request', domain: f.domainId, excerpt: f.evidence ?? f.detail, note: `${f.title}: ${f.detail}`, source, status: 'pending', created: nowIso() },
        `## ${f.title}\n\n${f.detail}\n\n${f.evidence ? `> ${f.evidence.replace(/\n/g, '\n> ')}\n` : ''}`
      )
    } else if (f.kind === 'task') {
      await addInbox(ctx, f.title, f.sessionId ?? source)
    } else {
      await saveKnowledge(ctx, { type: '교훈', title: f.title, content: `${f.detail}\n\n${f.evidence ? `> ${f.evidence}\n` : ''}`, status: '초안', sources: [f.sessionId ?? source] })
    }
  }
  f.status = accept ? 'accepted' : 'dismissed'
  await saveAiCheck(check)
  return f
}
