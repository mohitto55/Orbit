import type { Ctx } from './workspace'
import { readMd, writeMd, nowIso } from './md'
import { listDomains, domainPathLabel } from './domain'
import { listRequests, type DomainRequest } from './drift'

/**
 * 변경 요청을 AI(Claude Code / Codex)에게 넘겨 도메인 문서(domain.md 본문) 수정안을 받는다.
 * 수정안은 그 요청 파일에 저장해 두고(앞머리에 draftAgent·draftAt·draftBase, 본문 아래에 수정안),
 * 적용 여부는 사람이 나중에 비교를 보고 정한다.
 */

const START = '<<<DOMAIN_MD'
const END = 'DOMAIN_MD>>>'
const PLACEHOLDER = '(수정한 문서 본문 전체)'

export function buildDraftPrompt(opts: { domainLabel: string; content: string; request: Pick<DomainRequest, 'note' | 'excerpt' | 'source'> }): string {
  const { domainLabel, content, request } = opts
  return [
    '너는 도메인 문서 편집자다. 아래 변경 요청을 도메인 문서에 반영한 수정본을 만들어라.',
    '',
    '규칙:',
    '- 요청과 근거에 필요한 부분만 고친다. 관련 없는 문장, 순서, 형식은 그대로 둔다.',
    '- 마크다운 형식, 헤딩의 {#앵커}, [[위키링크]] 표기를 유지한다.',
    '- 파일을 직접 고치거나 도구를 쓰지 말고, 수정한 문서 본문 전체를 아래 형식으로만 답한다.',
    '- 답은 정확히 아래 모양이어야 한다. 첫 줄과 마지막 줄의 표시를 글자 그대로 쓰고, 그 밖에는 아무것도 쓰지 않는다.',
    '',
    START,
    PLACEHOLDER,
    END,
    '',
    `## 대상 도메인: ${domainLabel}`,
    '',
    '## 지금 문서 본문',
    content.trim() || '(비어 있음)',
    '',
    '## 변경 요청',
    request.note?.trim() || '(제안 없음, 근거만 있음)',
    '',
    '## 근거',
    request.excerpt.trim(),
    ''
  ].join('\n')
}

/**
 * AI 응답에서 수정본만 꺼낸다. 시작 표시 다음부터 끝 표시까지.
 * AI가 끝 표시를 조금 다르게 쓰거나(`DOMAIN_MD`, `>>>`) 빼먹어도 읽는다.
 * 시작 표시가 없으면 응답 전체를 감싼 코드 블록을, 그것도 없으면 오류.
 */
export function parseDraft(output: string): string {
  const text = output.replace(/\r\n/g, '\n')
  const s = text.lastIndexOf(START)
  if (s >= 0) {
    let body = text.slice(s + START.length).replace(/^[^\n]*\n/, '')
    const end = body.match(/^[ \t]*(?:DOMAIN_MD[ \t]*>*|>{3})[ \t]*$/m)
    if (end?.index !== undefined) body = body.slice(0, end.index)
    // 표시 안쪽을 코드 블록으로 한 번 더 감쌌으면 벗긴다
    const inner = body.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)
    if (inner) body = inner[1]
    body = body.replace(/^\n+/, '').replace(/\s+$/, '')
    // 요청문의 예시 자리를 잘못 집은 경우는 수정안이 아니다
    if (body && body !== PLACEHOLDER) return body + '\n'
  }
  const fenced = text.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)
  if (fenced) return fenced[1] + '\n'
  throw new Error('AI 응답에서 수정안을 찾지 못했습니다')
}

export async function requestDraftInput(ctx: Ctx, requestId: string) {
  const request = (await listRequests(ctx)).find((r) => r.id === requestId)
  if (!request) throw new Error(`변경 요청을 찾을 수 없습니다: ${requestId}`)
  if (request.status !== 'pending') throw new Error('이미 처리한 변경 요청입니다')
  const domains = await listDomains(ctx)
  const domain = domains.find((d) => d.id === request.domain)
  if (!domain) throw new Error(`도메인을 찾을 수 없습니다: ${request.domain}`)
  return { request, domain, prompt: buildDraftPrompt({ domainLabel: domainPathLabel(domains, domain.id), content: domain.content, request }) }
}

const DRAFT_OPEN = '<!-- ai-draft:start -->'
const DRAFT_CLOSE = '<!-- ai-draft:end -->'
const DRAFT_HEAD = '## AI 수정안'

export interface RequestDraft {
  agent: string
  at: string
  /** 수정안을 만들 때 본 도메인 문서 버전 */
  base: number
  content: string
}

/** 요청 파일 본문에서 수정안 부분을 떼어낸다. */
function splitBody(body: string): { rest: string; draft: string | null } {
  const s = body.indexOf(DRAFT_OPEN)
  const e = s < 0 ? -1 : body.indexOf(DRAFT_CLOSE, s)
  if (s < 0 || e < 0) return { rest: body, draft: null }
  const head = body.lastIndexOf(DRAFT_HEAD, s)
  const cut = head >= 0 && !body.slice(head + DRAFT_HEAD.length, s).trim() ? head : s
  const before = body.slice(0, cut).replace(/\n+$/, '')
  const after = body.slice(e + DRAFT_CLOSE.length).replace(/^\n+/, '')
  return {
    rest: (before + '\n' + (after ? '\n' + after : '')).replace(/\n+$/, '\n'),
    draft: body.slice(s + DRAFT_OPEN.length, e).replace(/^\n/, '').replace(/\n$/, '') + '\n'
  }
}

export async function readDraft(file: string): Promise<RequestDraft | null> {
  const { data, content } = await readMd(file)
  const { draft } = splitBody(content)
  if (draft === null || !data.draftAt) return null
  return { agent: data.draftAgent, at: data.draftAt, base: data.draftBase, content: draft }
}

export async function writeDraft(file: string, draft: { agent: string; base: number; content: string }): Promise<RequestDraft> {
  const { data, content } = await readMd(file)
  const { rest } = splitBody(content)
  const at = nowIso()
  const body = [rest.replace(/\n+$/, ''), '', DRAFT_HEAD, '', DRAFT_OPEN, draft.content.replace(/\n+$/, ''), DRAFT_CLOSE, ''].join('\n')
  await writeMd(file, { ...data, draftAgent: draft.agent, draftAt: at, draftBase: draft.base }, body)
  return { ...draft, at }
}

export async function clearDraft(file: string): Promise<void> {
  const { data, content } = await readMd(file)
  const { draftAgent: _a, draftAt: _t, draftBase: _b, ...rest } = data
  await writeMd(file, rest, splitBody(content).rest)
}
