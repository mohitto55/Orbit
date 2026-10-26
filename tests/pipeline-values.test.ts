// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PORT as A, LOOP_PORT as L, dataPreviews, type Env, type Graph, type NodeRun, type PipeNode, type Pipeline, type RunState } from '../src/core/pipeline'
import { PipelineValue } from '../src/renderer/src/PipelineValue'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '', terminal: 'new', ...extra })
const run = (nodes: Record<string, NodeRun>, runId = 'run'): RunState => ({ pipelineId: 'g', runId, title: '값 보기', status: 'running', started: new Date().toISOString(), nodes })
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const show = (graph: Graph, id: string, state?: RunState, env: Env = {}) => act(async () => root.render(createElement(PipelineValue, {
  key: `${id}:${state?.runId ?? ''}`, node: graph.nodes.find((n) => n.id === id)!, graph, env, run: state,
  states: Object.entries(state?.nodes ?? {}).filter(([key, value]) => key === id || value.sourceIds?.includes(id))
})))
const content = () => host.querySelector('.pipe-value-content')?.textContent
async function click(label: string) {
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click())
}
async function choose(id: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="값을 볼 실행 항목"]')!
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('노드 Value 패널', () => {
  it.each([
    [node('v', 'text', { text: '' }), '(빈 문자열)', ''],
    [node('v', 'text', { text: '  첫째\n<img src=x>\n끝  ' }), '  첫째\n<img src=x>\n끝  ', '  첫째\n<img src=x>\n끝  '],
    [node('v', 'boolean', { text: 'false' }), 'false', 'false'],
    [node('v', 'number', { text: '0' }), '0', '0']
  ] as const)('[DM-F02-AC20] %j 값을 실행 없이 표시하고 원문을 복사한다', async (value, display, raw) => {
    await show({ nodes: [value], edges: [] }, 'v')
    expect(content()).toBe(display)
    expect(host.querySelector('img')).toBeNull()
    await click('복사')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(raw)
  })

  it('리스트·JSON을 트리와 원문으로 보고 빈 Array·Null·false·0을 구분한다', async () => {
    const graph: Graph = { nodes: [node('list', 'list', { items: ['하나', '둘'] }), node('v', 'dictionary', { text: '{"items":[],"value":null,"active":false,"count":0}' })], edges: [] }
    await show(graph, 'list')
    expect(host.textContent).toContain('Array')
    expect(host.textContent).toContain('2 items')
    expect(content()).toContain('하나')
    await click('Raw')
    expect(content()).toBe('[\n  "하나",\n  "둘"\n]')
    await show(graph, 'v')
    expect(content()).toContain('[]'); expect(content()).toContain('null'); expect(content()).toContain('false'); expect(content()).toContain('0')
    await click('Raw'); await click('복사')
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify({ items: [], value: null, active: false, count: 0 }, null, 2))
    await click('Tree')
    expect(host.querySelector('.pipe-json-tree')).not.toBeNull()
  })

  it('텍스트 Add·Bool 계산은 현재 입력 변경을 바로 반영한다', async () => {
    const graph: Graph = { nodes: [node('text', 'text', { text: 'A' }), node('add', 'add', { values: { $b: '!' } }), node('cmp', 'compare', { operation: 'eq', compareType: 'single', values: { $b: 'A!' } })],
      edges: [{ from: 'text', to: 'add', toPort: '$a' }, { from: 'add', to: 'cmp', toPort: '$a' }] }
    await show(graph, 'add'); expect(content()).toBe('A!')
    await show(graph, 'cmp'); expect(content()).toBe('true')
    const changed = { ...graph, nodes: graph.nodes.map((n) => n.id === 'text' ? { ...n, text: 'B' } : n) }
    await show(changed, 'cmp'); expect(content()).toBe('false')
    await show(changed, 'add'); expect(content()).toBe('B!')
  })

  it('Print 없이 에이전트 응답과 파생 JSON 값을 표시하고 새 실행에서는 이전 값을 대기 상태로 바꾼다', async () => {
    const graph: Graph = { nodes: [node('ai', 'codex'), node('json', 'dictionary'), node('v', 'property', { pointer: '/works/0/title' })],
      edges: [{ from: 'ai', to: 'json', pin: 'data', fromPort: A.output }, { from: 'json', to: 'v' }] }
    await show(graph, 'v')
    expect(host.textContent).toContain('ai: 응답 대기'); expect(content()).toBeUndefined()
    const response = { works: [{ title: '현재 작업' }] }, state = run({ ai: { status: 'done', output: JSON.stringify(response), structuredOutput: response } })
    await show(graph, 'ai', state); expect(content()).toContain('현재 작업')
    await show(graph, 'v', state); expect(content()).toBe('"현재 작업"')
    expect(host.textContent).toContain('현재 설정 + 최근 실행 응답')
    await show(graph, 'v', run({ ai: { status: 'running' } }, 'next'))
    expect(host.textContent).toContain('응답 대기'); expect(content()).toBeUndefined()
    await show(graph, 'v', run({ ai: { status: 'failed', output: '실패한 응답' } }))
    expect(host.textContent).toContain('ai: 실패'); expect(content()).toBeUndefined()
  })

  it('잘못된 데이터와 실패한 응답의 오류를 표시하고 원문은 그대로 확인한다', async () => {
    const graph: Graph = { nodes: [node('v', 'dictionary', { text: 'bad json' }), node('ai', 'codex')], edges: [] }
    await show(graph, 'v')
    expect(host.querySelector('.pipe-value-error')?.textContent).toContain('JSON')
    await show(graph, 'ai', run({ ai: { status: 'failed', output: 'bad json', message: 'JSON 형식 오류' } }))
    expect(host.querySelector('.pipe-value-error')?.textContent).toBe('JSON 형식 오류')
    expect(content()).toBe('bad json')
  })

  it('함수·반복 실행 응답을 이름으로 선택하고 각각의 원문을 보여 준다', async () => {
    const graph: Graph = { nodes: [node('ai', 'codex')], edges: [] }
    const state = run({
      'loop/0/ai': { sourceIds: ['ai', 'loop'], name: 'For Each[0]/ai', status: 'done', output: '첫 응답', outputOrder: 1 },
      'loop/1/ai': { sourceIds: ['ai', 'loop'], name: 'For Each[1]/ai', status: 'done', output: '', outputOrder: 2 }
    })
    await show(graph, 'ai', state); expect(content()).toBe('(빈 문자열)')
    expect(host.textContent).toContain('For Each[0]/ai')
    await choose('loop/0/ai'); expect(content()).toBe('첫 응답')
  })

  it('반복 안의 파생 데이터도 해당 항목의 응답으로 계산하고 원본 그래프를 변경하지 않는다', async () => {
    const graph: Graph = { nodes: [node('s', 'start'), node('loop', 'foreach', { values: { [L.list]: '하나\n둘' } }), node('ai', 'codex', { text: '결과' }), node('d', 'dictionary'), node('v', 'property', { pointer: '/title' }), node('next', 'shell', { text: '처리' })], edges: [
      { from: 's', to: 'loop' }, { from: 'loop', to: 'ai', fromPort: L.body }, { from: 'ai', to: 'next' },
      { from: 'ai', to: 'd', pin: 'data', fromPort: A.output }, { from: 'd', to: 'v' }, { from: 'v', to: 'next' }
    ] }
    const before = structuredClone(graph)
    const state = run({ 'loop/0/ai': { status: 'done', output: '{"title":"첫 작업"}' }, 'loop/1/ai': { status: 'done', output: '{"title":"둘째 작업"}' } })
    await show(graph, 'v', state)
    expect(content()).toBe('"둘째 작업"')
    await choose('loop/0/v'); expect(content()).toBe('"첫 작업"')
    expect(graph).toEqual(before)
  })

  it('함수 반환값을 연결한 데이터는 인자 바인딩을 사용한다', () => {
    const fn: Pipeline = { id: 'fn', title: '그대로 반환', template: true, file: '', nodes: [
      node('in', 'function-input', { params: [{ id: 'arg', name: '인자', type: 'single' }] }),
      node('out', 'function-output', { params: [{ id: 'ret', name: '결과', type: 'single' }] })
    ], edges: [{ from: 'in', to: 'out' }, { from: 'in', to: 'out', pin: 'data', fromPort: 'arg', toPort: 'ret' }] }
    const graph: Graph = { nodes: [node('s', 'start'), node('call', 'template', { ref: 'fn', values: { arg: '실제 인자' } }), node('v', 'text')],
      edges: [{ from: 's', to: 'call' }, { from: 'call', to: 'v', pin: 'data', fromPort: 'ret' }] }
    expect(dataPreviews(graph, 'v', { library: [fn] })[0].items).toEqual(['실제 인자'])
  })
})
