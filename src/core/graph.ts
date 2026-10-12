import type { Ctx } from './workspace'
import { listDomains, type Domain } from './domain'
import { listSpecs } from './spec'
import { listDesigns } from './design'
import { listTasks } from './task'
import { listKnowledge } from './knowledge'
import { conceptNodeId, resolveConcept, withoutModel } from './model'

export type NodeKind = 'domain' | 'spec' | 'design' | 'task' | 'knowledge' | 'concept' | 'ghost'

export interface GNode {
  id: string
  label: string
  kind: NodeKind
  subdomainType?: string
  /** 개념 노드: 소속 도메인 / 종류 / 코드 위치 */
  domainId?: string
  conceptKind?: string
  code?: string[]
}

export interface GEdge {
  source: string
  target: string
  type: string
  /** 개념 관계가 도메인 경계를 넘는지 */
  cross?: boolean
}

export interface Graph {
  nodes: GNode[]
  edges: GEdge[]
}

const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

/**
 * KG-F03: `[[이름]]` 해석. id → `상위/이름` 경로 → 같은 상위의 형제 → 조상 경로 → 전체에서 유일한 이름.
 * 후보가 없거나 여럿이면 null (미정의/모호).
 */
export function resolveName(name: string, domains: Domain[], fromDomainId?: string, ids: Set<string> = new Set()): string | null {
  const n = name.trim()
  if (ids.has(n) || domains.some((d) => d.id === n)) return n
  if (n.includes('/')) {
    const [parentTitle, title] = n.split('/').map((s) => s.trim())
    const hit = domains.filter((d) => d.title === title && domains.find((p) => p.id === d.parent)?.title === parentTitle)
    return hit.length === 1 ? hit[0].id : null
  }
  const byTitle = domains.filter((d) => d.title === n)
  if (byTitle.length === 0) return null
  if (byTitle.length === 1) return byTitle[0].id
  const from = domains.find((d) => d.id === fromDomainId)
  if (from) {
    const siblings = byTitle.filter((d) => (d.parent ?? '') === (from.parent ?? ''))
    if (siblings.length === 1) return siblings[0].id
    let cur = from.parent ? domains.find((d) => d.id === from.parent) : undefined
    while (cur) {
      if (byTitle.some((d) => d.id === cur!.id)) return cur.id
      const kids = byTitle.filter((d) => d.parent === cur!.id)
      if (kids.length === 1) return kids[0].id
      cur = cur.parent ? domains.find((d) => d.id === cur!.parent) : undefined
    }
  }
  return null
}

export async function buildGraph(ctx: Ctx): Promise<Graph> {
  const domains = await listDomains(ctx)
  const specs = await listSpecs(ctx, domains)
  const designs = await listDesigns(ctx)
  const tasks = await listTasks(ctx)
  const knowledge = await listKnowledge(ctx)
  const concepts = domains.flatMap((d) => d.model.map((c) => ({ ...c, domainId: d.id, domainTitle: d.title })))

  const nodes: GNode[] = [
    ...domains.map((d) => ({ id: d.id, label: d.title, kind: 'domain' as const, subdomainType: d.subdomainType })),
    ...specs.map((s) => ({ id: s.id, label: s.title, kind: 'spec' as const })),
    ...concepts.map((c) => ({ id: conceptNodeId(c.domainId, c.name), label: c.name, kind: 'concept' as const, domainId: c.domainId, conceptKind: c.kind, code: c.code })),
    ...designs.map((d) => ({ id: d.id, label: d.title, kind: 'design' as const })),
    ...tasks.map((t) => ({ id: t.id, label: t.title, kind: 'task' as const })),
    ...knowledge.map((k) => ({ id: k.id, label: k.title, kind: 'knowledge' as const }))
  ]
  const ids = new Set(nodes.map((n) => n.id))
  const edges: GEdge[] = []
  const ghosts = new Map<string, GNode>()
  const link = (source: string, target: string, type: string) => {
    if (!ids.has(target)) {
      const gid = `ghost:${target}`
      if (!ghosts.has(gid)) ghosts.set(gid, { id: gid, label: target, kind: 'ghost' })
      target = gid
    }
    edges.push({ source, target, type })
  }
  const wiki = (source: string, content: string, fromDomain?: string) => {
    for (const m of content.matchAll(WIKI_RE)) {
      const resolved = resolveName(m[1], domains, fromDomain, ids)
      link(source, resolved ?? m[1].trim(), '관련')
    }
  }

  for (const d of domains) {
    if (d.parent) link(d.id, d.parent, '상위')
    for (const l of d.links) link(d.id, l.to, l.type)
    wiki(d.id, withoutModel(d.content), d.id)
  }
  // 도메인 모델 관계: 개념 → 소속 도메인, 개념 → 개념
  for (const c of concepts) {
    const from = conceptNodeId(c.domainId, c.name)
    edges.push({ source: from, target: c.domainId, type: '소속' })
    for (const r of c.relations) {
      const hit = resolveConcept(r.to, c.domainId, concepts)
      if (hit) edges.push({ source: from, target: conceptNodeId(hit.domainId, hit.name), type: r.type, cross: hit.domainId !== c.domainId })
      else link(from, r.to, r.type)
    }
  }
  for (const s of specs) {
    for (const b of s.basedOn) link(s.id, b.ref, '기준')
    wiki(s.id, s.content, s.domainId)
  }
  for (const d of designs) {
    for (const b of d.basedOn) link(d.id, b.ref, '기준')
    for (const r of d.refs) link(d.id, r.ref, '참조')
  }
  for (const t of tasks) for (const l of t.links) link(t.id, l, '근거')
  for (const k of knowledge) {
    for (const s of k.sources) if (ids.has(s)) link(k.id, s, '근거')
    wiki(k.id, k.content)
  }
  return { nodes: [...nodes, ...ghosts.values()], edges }
}
