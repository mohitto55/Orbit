/**
 * 도메인 모델: domain.md의 `## 모델` 표.
 * 업무 분류(도메인 트리)와 따로, 어떤 개념이 어떤 상태·행위·불변식을 갖고 서로 어떻게 관계하는지 적는다.
 *
 * | 개념 | 종류 | 상태·행위 | 불변식 | 관계 | 코드 |
 * |---|---|---|---|---|---|
 * | 방 진행 | Aggregate | 턴 수, 진행 상태 / 턴 진행 | 턴은 1씩만 오른다 | 사용 [[트리거]]<br>소유 [[턴]] | `BaseRoom` |
 *
 * 관계 칸은 `관계이름 [[개념]]`을 여러 개(줄바꿈·쉼표) 쓴다. 다른 도메인의 개념은 `[[도메인/개념]]`.
 */

export interface ConceptRelation {
  type: string
  /** 적힌 그대로의 대상 이름 (`개념` 또는 `도메인/개념`) */
  to: string
}

export interface Concept {
  name: string
  kind: string
  behavior: string
  invariants: string
  relations: ConceptRelation[]
  /** 코드 위치 (클래스·파일 이름) */
  code: string[]
}

export const MODEL_HEADING = '모델'
export const MODEL_HEADER = ['개념', '종류', '상태·행위', '불변식', '관계', '코드']
export const CONCEPT_KINDS = ['Entity', 'Value Object', 'Aggregate', 'Event', 'Policy', 'Domain Service']

function splitRow(line: string): string[] {
  const cells = line.trim().split(/(?<!\\)\|/)
  if (cells.length && cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** `## 모델` 섹션의 줄 범위 [start, end). 없으면 null */
export function modelSectionRange(content: string): { start: number; end: number } | null {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${MODEL_HEADING}`)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end++
  return { start, end }
}

const REL_RE = /(?:([^\s,[\]<>]+)\s*(?:→|->)?\s*)?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

export function parseRelations(text: string): ConceptRelation[] {
  const out: ConceptRelation[] = []
  for (const m of text.matchAll(REL_RE)) out.push({ type: (m[1] ?? '').trim() || '관련', to: m[2].trim() })
  return out
}

export function parseModel(content: string): Concept[] {
  const range = modelSectionRange(content)
  if (!range) return []
  const lines = content.split('\n').slice(range.start + 1, range.end)
  const hi = lines.findIndex((l) => l.trim().startsWith('|') && splitRow(l)[0] === '개념')
  if (hi < 0) return []
  const header = splitRow(lines[hi])
  const col = (name: string) => header.indexOf(name)
  const get = (c: string[], name: string) => (col(name) >= 0 ? c[col(name)] ?? '' : '')
  const out: Concept[] = []
  for (let i = hi + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const c = splitRow(lines[i])
    const name = get(c, '개념').replace(/\*\*/g, '').trim()
    if (!name) continue
    out.push({
      name,
      kind: get(c, '종류'),
      behavior: get(c, '상태·행위'),
      invariants: get(c, '불변식'),
      relations: parseRelations(get(c, '관계')),
      code: [...get(c, '코드').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
    })
  }
  return out
}

/** 모델 섹션을 뺀 본문. 모델 표의 `[[개념]]`은 도메인 링크가 아니므로 도메인 관계를 찾을 때 뺀다. */
export function withoutModel(content: string): string {
  const range = modelSectionRange(content)
  if (!range) return content
  const lines = content.split('\n')
  return [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n')
}

export function modelTemplate(): string {
  return `## ${MODEL_HEADING}

이 도메인이 소유한 개념의 상태·행위·불변식과 관계다. 응용 서비스의 호출 순서는 적지 않는다 (그건 설계에).

| ${MODEL_HEADER.join(' | ')} |
|${MODEL_HEADER.map(() => '---').join('|')}|
`
}

/** 모델 섹션이 없으면 `## 하지 않는 것` 앞(없으면 끝)에 빈 모델 표를 넣는다. */
export function ensureModelSection(content: string): string {
  if (modelSectionRange(content)) return content
  const lines = content.split('\n')
  const at = lines.findIndex((l) => l.trim() === '## 하지 않는 것')
  const block = modelTemplate().split('\n')
  if (at < 0) return content.trimEnd() + '\n\n' + block.join('\n')
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n')
}

export interface ConceptRef {
  domainId: string
  name: string
}

/**
 * 관계 대상 이름 해석: `도메인/개념`이면 그 도메인(이름 또는 id), 아니면 같은 도메인 → 전체에서 유일한 이름.
 * 못 찾거나 여럿이면 null.
 */
export function resolveConcept(
  to: string,
  fromDomainId: string,
  all: { domainId: string; domainTitle: string; name: string }[]
): ConceptRef | null {
  if (to.includes('/')) {
    const [d, n] = to.split('/').map((s) => s.trim())
    const hit = all.filter((c) => (c.domainTitle === d || c.domainId === d) && c.name === n)
    return hit.length === 1 ? { domainId: hit[0].domainId, name: n } : null
  }
  const same = all.find((c) => c.domainId === fromDomainId && c.name === to)
  if (same) return { domainId: same.domainId, name: to }
  const hit = all.filter((c) => c.name === to)
  return hit.length === 1 ? { domainId: hit[0].domainId, name: to } : null
}

export const conceptNodeId = (domainId: string, name: string) => `concept:${domainId}/${name}`
