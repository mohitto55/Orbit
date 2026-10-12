import type { Ctx } from './workspace'
import { listDomains, type Domain } from './domain'
import { listSpecs } from './spec'
import { resolveName } from './graph'
import { resolveConcept, withoutModel } from './model'

/**
 * 도메인 지도: 상위 도메인 안에 하위 도메인을 묶어 보이고, 도메인 사이 관계를 선으로 잇는다.
 * 선의 출처는 셋이다.
 * - link: 도메인 문서에 직접 적은 관계 (frontmatter links)
 * - concept: 모델 표에서 이 도메인의 개념이 다른 도메인의 개념을 가리킨 관계
 * - mention: 도메인 문서 본문의 `[[다른 도메인]]` 언급
 * 선은 같은 상위 도메인 안의 하위 도메인끼리만 긋는다. 상자(상위 도메인)를 넘는 관계와
 * 상위·하위 사이는 그리지 않는다 (묶음으로 이미 보인다).
 */

export type EdgeVia = 'link' | 'concept' | 'mention'

export interface MapEdge {
  source: string
  target: string
  /** 관계 이름들 (link 타입, 개념 관계 이름) */
  types: string[]
  via: EdgeVia[]
  /** concept일 때 어떤 개념끼리인지 (`방 진행 → 지급 의도`) */
  details: string[]
}

export interface MapNode {
  id: string
  title: string
  parent?: string
  subdomainType: string
  status: string
  role: string
  features: number
  concepts: number
}

export interface DomainMap {
  nodes: MapNode[]
  edges: MapEdge[]
}

const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

/** 같은 상위 도메인을 둔 형제인가 (최상위끼리는 형제로 보지 않는다) */
export function areSiblings(domains: Domain[], a: string, b: string): boolean {
  const pa = domains.find((d) => d.id === a)?.parent
  const pb = domains.find((d) => d.id === b)?.parent
  return !!pa && pa === pb
}

export function buildDomainMapFrom(domains: Domain[], featureCount: Record<string, number> = {}): DomainMap {
  const edges = new Map<string, MapEdge>()
  const add = (source: string, target: string, via: EdgeVia, type: string, detail?: string) => {
    if (source === target) return
    if (!areSiblings(domains, source, target)) return
    const key = `${source}→${target}`
    const e = edges.get(key) ?? { source, target, types: [], via: [], details: [] }
    if (type && !e.types.includes(type)) e.types.push(type)
    if (!e.via.includes(via)) e.via.push(via)
    if (detail && !e.details.includes(detail)) e.details.push(detail)
    edges.set(key, e)
  }

  const concepts = domains.flatMap((d) => d.model.map((c) => ({ ...c, domainId: d.id, domainTitle: d.title })))
  for (const d of domains) {
    for (const l of d.links) add(d.id, l.to, 'link', l.type)
    for (const c of d.model) {
      for (const r of c.relations) {
        const hit = resolveConcept(r.to, d.id, concepts)
        if (hit && hit.domainId !== d.id) add(d.id, hit.domainId, 'concept', r.type, `${c.name} → ${hit.name}`)
      }
    }
    for (const m of withoutModel(d.content).matchAll(WIKI_RE)) {
      const to = resolveName(m[1], domains, d.id)
      if (to) add(d.id, to, 'mention', '')
    }
  }

  return {
    nodes: domains.map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.parent && domains.some((p) => p.id === d.parent) ? { parent: d.parent } : {}),
      subdomainType: d.subdomainType,
      status: d.status,
      role: d.role,
      features: featureCount[d.id] ?? 0,
      concepts: d.model.length
    })),
    edges: [...edges.values()]
  }
}

export async function buildDomainMap(ctx: Ctx): Promise<DomainMap> {
  const domains = await listDomains(ctx)
  const specs = await listSpecs(ctx, domains)
  const count = Object.fromEntries(specs.map((s) => [s.domainId, s.features.filter((f) => f.status !== '폐기').length]))
  return buildDomainMapFrom(domains, count)
}

/* ---------- 도메인 하나의 그래프 ---------- */

export interface ScopeNode {
  id: string
  label: string
  kind: 'root' | 'domain' | 'concept'
  /** 개념은 소속 도메인 안에 묶어 그린다 */
  parent?: string
  domainId: string
  subdomainType?: string
  conceptKind?: string
  code?: string[]
  features?: number
}

export interface ScopeEdge {
  source: string
  target: string
  label: string
  /** relation: 하위 도메인끼리의 관계 / concept: 개념(객체) 사이 관계 */
  kind: 'relation' | 'concept'
}

export interface DomainScope {
  rootId: string
  nodes: ScopeNode[]
  edges: ScopeEdge[]
}

const conceptId = (domainId: string, name: string) => `concept:${domainId}/${name}`

/**
 * 고른 도메인(최상위) 하나의 그래프 (그림 3.3처럼): 하위 도메인마다 상자, 그 안에 개념(객체),
 * 개념끼리는 상자 안팎으로 선. 고른 도메인 자체는 개념이 있을 때만 상자로 나온다.
 * 범위 밖을 가리키는 관계는 그리지 않는다.
 */
export function buildDomainScopeFrom(domains: Domain[], rootId: string, featureCount: Record<string, number> = {}): DomainScope {
  const scope = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const d of domains) if (d.parent && scope.has(d.parent) && !scope.has(d.id)) scope.add(d.id), (grew = true)
  }
  const inScope = domains.filter((d) => scope.has(d.id))
  const nodes: ScopeNode[] = []
  const edges: ScopeEdge[] = []
  for (const d of inScope) {
    if (d.id === rootId && d.model.length === 0 && inScope.length > 1) continue
    nodes.push({ id: d.id, label: d.title, kind: d.id === rootId ? 'root' : 'domain', domainId: d.id, subdomainType: d.subdomainType, features: featureCount[d.id] ?? 0 })
    for (const c of d.model) {
      nodes.push({ id: conceptId(d.id, c.name), label: c.name, kind: 'concept', parent: d.id, domainId: d.id, conceptKind: c.kind, code: c.code })
    }
  }
  // 개념이 있는 상자끼리는 개념 관계로 선을 만들고, 개념이 없는 상자는 도메인 문서에 적은 관계로 선을 만든다
  const hasConcepts = (id: string) => (domains.find((d) => d.id === id)?.model.length ?? 0) > 0
  const domainEdges: ScopeEdge[] = []
  for (const e of buildDomainMapFrom(domains).edges) {
    if (hasConcepts(e.source) && hasConcepts(e.target)) continue
    if (nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target)) domainEdges.push({ source: e.source, target: e.target, label: e.types.join(', '), kind: 'relation' })
  }
  const concepts = inScope.flatMap((d) => d.model.map((c) => ({ ...c, domainId: d.id, domainTitle: d.title })))
  const all = domains.flatMap((d) => d.model.map((c) => ({ ...c, domainId: d.id, domainTitle: d.title })))
  // 상자 안: 개념끼리 그대로. 상자 사이: 각 상자의 대표 개념(애그리거트 루트)끼리 선 하나로 합친다
  // (책 그림의 Order — Member처럼. 어떤 개념이 무엇을 가리켰는지는 선 이름에 남긴다)
  const rootOf = (domainId: string) => {
    const model = domains.find((d) => d.id === domainId)?.model ?? []
    const r = model.find((m) => /aggregate/i.test(m.kind)) ?? model[0]
    return r ? conceptId(domainId, r.name) : domainId
  }
  const cross = new Map<string, ScopeEdge>()
  for (const c of concepts) {
    for (const r of c.relations) {
      const hit = resolveConcept(r.to, c.domainId, all)
      if (!hit || !scope.has(hit.domainId)) continue
      if (hit.domainId === c.domainId) {
        edges.push({ source: conceptId(c.domainId, c.name), target: conceptId(hit.domainId, hit.name), label: r.type, kind: 'concept' })
        continue
      }
      const [a, b] = [c.domainId, hit.domainId].sort()
      const key = `${a}|${b}`
      const label = `${c.name} ${r.type} ${hit.name}`
      const e = cross.get(key)
      if (e) e.label = `${e.label}\n${label}`
      else cross.set(key, { source: rootOf(c.domainId), target: rootOf(hit.domainId), label, kind: 'relation' })
    }
  }
  // 같은 두 상자 사이 선은 방향과 출처에 상관없이 하나만 (개념 관계로 만든 선이 먼저)
  for (const e of domainEdges) {
    const key = [e.source, e.target].sort().join('|')
    if (!cross.has(key)) cross.set(key, e)
  }
  edges.push(...cross.values())
  return { rootId, nodes, edges }
}

export async function buildDomainScope(ctx: Ctx, rootId: string): Promise<DomainScope> {
  const domains = await listDomains(ctx)
  if (!domains.some((d) => d.id === rootId)) throw new Error(`도메인을 찾을 수 없습니다: ${rootId}`)
  const specs = await listSpecs(ctx, domains)
  const count = Object.fromEntries(specs.map((s) => [s.domainId, s.features.filter((f) => f.status !== '폐기').length]))
  return buildDomainScopeFrom(domains, rootId, count)
}
