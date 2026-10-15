import type { DomainScope, ScopeEdge } from './types'

export const RELATION_LABELS = {
  ownership: '직접 소유',
  reference: '참조·사용',
  other: '기타 객체 관계',
  domain: '도메인 관계'
} as const

export type RelationKind = keyof typeof RELATION_LABELS

/** 관계 이름의 뜻과 도메인 경계는 별개다. 다른 도메인을 향해도 소유는 소유로 표시한다. */
export function relationKind(edge: ScopeEdge): RelationKind {
  if (edge.kind === 'relation') return 'domain'
  const label = edge.label.trim().toLowerCase()
  if (['소유', '포함', '보유', '구성', 'owns', 'contains'].includes(label)) return 'ownership'
  if (['참조', '사용', '의존', '조회', '읽음', '읽기', 'reference', 'references', 'uses', 'depends on', 'reads'].includes(label)) return 'reference'
  return 'other'
}

export interface DomainGraphFilters {
  relation: 'all' | RelationKind
  boundary: 'all' | 'internal' | 'cross'
  domainId: string
  query: string
}

export const DEFAULT_GRAPH_FILTERS: DomainGraphFilters = { relation: 'all', boundary: 'all', domainId: '', query: '' }

export function filterDomainScope(scope: DomainScope, filters: DomainGraphFilters): DomainScope {
  const query = filters.query.trim().toLocaleLowerCase()
  const restrictNodes = !!filters.domainId || !!query
  const restrictEdges = filters.relation !== 'all' || filters.boundary !== 'all'
  if (!restrictNodes && !restrictEdges) return scope

  const byId = new Map(scope.nodes.map((n) => [n.id, n]))
  const matches = new Set(scope.nodes.filter((n) =>
    (!filters.domainId || n.domainId === filters.domainId) &&
    (!query || `${n.label} ${byId.get(n.domainId)?.label ?? ''}`.toLocaleLowerCase().includes(query))
  ).map((n) => n.id))
  const edges = scope.edges.filter((e) => {
    if (filters.relation !== 'all' && relationKind(e) !== filters.relation) return false
    const cross = byId.get(e.source)?.domainId !== byId.get(e.target)?.domainId
    if (filters.boundary === 'cross' && !cross) return false
    if (filters.boundary === 'internal' && cross) return false
    return !restrictNodes || matches.has(e.source) || matches.has(e.target)
  })
  // 검색한 객체와 직접 연결된 대상은 함께 남겨 도메인 밖 참조가 끊겨 보이지 않게 한다.
  const visible = new Set(restrictEdges ? [] : matches)
  for (const e of edges) { visible.add(e.source); visible.add(e.target) }
  for (const id of [...visible]) {
    const parent = byId.get(id)?.parent
    if (parent) visible.add(parent)
  }
  return { ...scope, nodes: scope.nodes.filter((n) => visible.has(n.id)), edges }
}
