// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Core, CytoscapeOptions } from 'cytoscape'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDomainMapFrom, buildDomainScopeFrom, type ScopeEdge } from '../src/core/domainmap'
import type { Domain } from '../src/core/domain'
import { DEFAULT_GRAPH_FILTERS, filterDomainScope, relationKind } from '../src/renderer/src/domainGraphView'
import Domains from '../src/renderer/src/pages/Domains'

// 실물 그래프 엔진으로 필터·선 모양·선택·좌표를 검증하고 캔버스 렌더러만 끈다.
vi.mock('cytoscape', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import('cytoscape') }>()
  return { default: (options: CytoscapeOptions) => original.default({ ...options, container: undefined, headless: true, styleEnabled: true }) }
})

const domain = (id: string, title: string, parent?: string): Domain => ({
  id, title, parent, folder: id, subdomainType: 'Core', version: 1, status: 'active', links: [], content: '', role: '', model: []
})
const domains = [domain('root', '주문 서비스'), domain('order', '주문', 'root'), domain('customer', '고객', 'root'), domain('other', '다른 서비스')]
domains[1].model = [
  { name: '주문', kind: 'Aggregate', behavior: '', invariants: '', code: [], relations: [{ type: '소유', to: '주문 항목' }, { type: '참조', to: '고객/고객 정보' }] },
  { name: '주문 항목', kind: 'Entity', behavior: '', invariants: '', code: [], relations: [{ type: '요청', to: '고객/알림' }] },
  { name: '메모', kind: 'Value Object', behavior: '', invariants: '', code: [], relations: [] }
]
domains[2].model = [
  { name: '고객 정보', kind: 'Aggregate', behavior: '', invariants: '', code: [], relations: [{ type: '소유', to: '알림' }] },
  { name: '알림', kind: 'Event', behavior: '', invariants: '', code: [], relations: [] }
]
domains[1].links = [{ type: '의존', to: 'customer' }]
const scope = buildDomainScopeFrom(domains, 'root')

describe('관계의 의미와 도메인 경계 필터', () => {
  it('명시한 소유·참조 이름만 분류하고 요청·사용자 정의 관계는 그대로 구별한다', () => {
    const edge: ScopeEdge = { source: 'a', target: 'b', kind: 'concept', label: ' 소유 ' }
    expect(relationKind(edge)).toBe('ownership')
    expect(relationKind({ ...edge, label: '조회' })).toBe('reference')
    expect(relationKind({ ...edge, label: '요청' })).toBe('other')
    expect(relationKind({ ...edge, label: '비소유' })).toBe('other')
    expect(relationKind({ ...edge, kind: 'relation' })).toBe('domain')
  })

  it('참조만 고르면 양쪽 객체와 소속 상자를 남긴다', () => {
    const view = filterDomainScope(scope, { ...DEFAULT_GRAPH_FILTERS, relation: 'reference' })
    expect(view.edges.map((e) => e.label)).toEqual(['참조'])
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['order', 'customer', 'concept:order/주문', 'concept:customer/고객 정보'].sort())
    expect(filterDomainScope(scope, DEFAULT_GRAPH_FILTERS)).toBe(scope)
  })

  it('도메인과 검색을 함께 걸어도 직접 연결된 외부 객체와 상자는 유지한다', () => {
    const view = filterDomainScope(scope, { ...DEFAULT_GRAPH_FILTERS, domainId: 'order', query: ' 주문 ', boundary: 'cross' })
    expect(view.edges.map((e) => e.label)).toEqual(['참조', '요청', '의존'])
    expect(view.nodes.map((n) => n.id)).toContain('concept:customer/고객 정보')
    expect(view.nodes.map((n) => n.id)).not.toContain('concept:order/메모')
    expect(view.edges.every((e) => view.nodes.some((n) => n.id === e.source) && view.nodes.some((n) => n.id === e.target))).toBe(true)
    expect(filterDomainScope(scope, { ...DEFAULT_GRAPH_FILTERS, query: '없는 객체' }).nodes).toEqual([])
    expect(filterDomainScope(scope, { ...DEFAULT_GRAPH_FILTERS, query: '메모' }).nodes.map((n) => n.id)).toEqual(['order', 'concept:order/메모'])
  })

  it('도메인을 넘는 소유도 참조로 바꾸지 않고 경계 필터와 함께 적용한다', () => {
    const crossOwnership: ScopeEdge = { source: 'concept:order/주문', target: 'concept:customer/알림', label: '소유', kind: 'concept' }
    const view = filterDomainScope({ ...scope, edges: [...scope.edges, crossOwnership] }, { ...DEFAULT_GRAPH_FILTERS, relation: 'ownership', boundary: 'cross' })
    expect(view.edges).toEqual([crossOwnership])
    expect(filterDomainScope(scope, { ...DEFAULT_GRAPH_FILTERS, relation: 'reference', boundary: 'internal' }).nodes).toEqual([])
  })
})

let host: HTMLDivElement
let root: Root | null
const graph = () => (window as unknown as { __orbitDomainGraph: Core }).__orbitDomainGraph
const visibleEdges = () => graph().edges().not('.filtered')

function control(label: string): HTMLInputElement | HTMLSelectElement {
  const field = [...host.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === label)?.querySelector('input, select')
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) throw new Error(`필터 없음: ${label}`)
  return field
}

async function change(label: string, value: string) {
  const field = control(label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = null
  window.orbit = {
    async invoke(name, ...args) {
      if (name === 'listDomains') return domains
      if (name === 'listRequests' || name === 'listSpecs') return []
      if (name === 'allAcStatuses') return {}
      if (name === 'domainMap') return buildDomainMapFrom(domains)
      if (name === 'domainScope') return buildDomainScopeFrom(domains, String(args[0]))
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on: () => () => {}
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  root = createRoot(host)
  await act(async () => root!.render(createElement(Domains, { refreshKey: 0, reloadBadges: () => {}, go: () => {} })))
  const order = [...host.querySelectorAll<HTMLButtonElement>('.root-card')].find((b) => b.textContent?.includes('주문 서비스'))!
  await act(async () => order.click())
}

describe('도메인 그래프 화면', () => {
  it('선택해도 소유 마름모와 참조 점선의 색·방향을 유지하고 출처를 따라 이동한다', async () => {
    await mount()
    const c = graph()
    const own = c.edges('[relation = "ownership"]').first()
    const ref = c.edges('[relation = "reference"]').first()
    expect(own.style('source-arrow-shape')).toBe('diamond')
    expect(own.style('target-arrow-shape')).toBe('none')
    expect(ref.style('line-style')).toBe('dashed')
    expect(ref.style('target-arrow-shape')).toBe('triangle')
    const refColor = ref.style('line-color')
    await act(async () => { c.getElementById('concept:order/주문').emit('tap') })
    expect(ref.style('line-color')).toBe(refColor)
    expect(host.querySelector('.map-side')?.textContent).toContain('직접 소유 · 소유')
    expect(host.querySelector('.map-side')?.textContent).toContain('주문 서비스 › 고객 · 다른 도메인')
    const reference = [...host.querySelectorAll<HTMLButtonElement>('.concept-connection')].find((b) => b.textContent?.includes('고객 정보'))!
    await act(async () => reference.click())
    expect(host.querySelector('.map-side h3')?.textContent).toContain('고객 정보')
    expect(host.querySelector('.map-side')?.textContent).toContain('이 객체로 들어오는 관계')
  })

  it('필터를 조합하고 초기화하며 숨겨진 선택을 해제하고 노드 위치를 보존한다', async () => {
    await mount()
    const c = graph()
    const hidden = c.getElementById('concept:order/주문 항목')
    hidden.position({ x: 700, y: 480 })
    await act(async () => { hidden.emit('tap') })
    await change('관계 종류', 'reference')
    expect(graph()).toBe(c)
    expect(visibleEdges().map((e) => e.data('label'))).toEqual(['참조'])
    expect(c.$(':selected').length).toBe(0)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('객체 2/5 · 관계 1/5')
    await change('연결 범위', 'internal')
    expect(visibleEdges().length).toBe(0)
    expect(host.querySelector('.domain-graph-empty')?.textContent).toContain('조건에 맞는 객체나 관계가 없습니다')
    await click('필터 초기화')
    expect(visibleEdges().length).toBe(scope.edges.length)
    expect(hidden.position()).toEqual({ x: 700, y: 480 })
    await change('도메인', 'order')
    await change('객체·도메인 검색', '메모')
    expect(c.nodes().not('.filtered').map((n) => n.id())).toEqual(['order', 'concept:order/메모'])
    await act(async () => { c.getElementById('concept:order/메모').emit('dragfree') })
    expect(JSON.parse(localStorage.getItem('orbit.domainGraph.v3.root')!)['concept:order/주문 항목']).toEqual({ x: 700, y: 480 })
  })

  it('관계 이름 토글은 그래프를 다시 만들지 않고 다른 최상위 도메인을 열면 필터가 초기화된다', async () => {
    await mount()
    const c = graph()
    const checkbox = host.querySelector<HTMLInputElement>('.graph-label-toggle input')!
    expect(c.edges().first().style('text-opacity')).toBe('1')
    await act(async () => checkbox.click())
    expect(c.edges().first().style('text-opacity')).toBe('0')
    expect(graph()).toBe(c)
    await change('관계 종류', 'reference')
    const other = [...host.querySelectorAll<HTMLButtonElement>('.root-card')].find((b) => b.textContent?.includes('다른 서비스'))!
    await act(async () => other.click())
    expect(control('관계 종류').value).toBe('all')
    expect(graph().nodes().map((n) => n.id())).toEqual(['other'])
  })
})
