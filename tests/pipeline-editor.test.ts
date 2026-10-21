// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Core, CytoscapeOptions, NodeSingular } from 'cytoscape'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineEditor from '../src/renderer/src/pages/Pipelines'
import type { PipeNode, Pipeline } from '../src/core/pipeline'

// 캔버스만 끄고 실제 그래프 엔진·React 편집·저장과 포트 선택 이벤트를 검증한다.
vi.mock('cytoscape-edgehandles', () => ({ default: () => {} }))
vi.mock('cytoscape', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import('cytoscape') }>()
  return { default: Object.assign((options: CytoscapeOptions) => {
    const core = original.default({ ...options, container: undefined, headless: true, styleEnabled: true })
    return Object.assign(core, { edgehandles: () => ({ start: () => {} }) })
  }, { use: original.default.use }) }
})

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '', terminal: 'new', ...extra })
let host: HTMLDivElement
let root: Root
let saved: Pipeline[]
const graph = () => (window as unknown as { __orbitPipe: Core }).__orbitPipe

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  saved = [{ id: 'g', title: '그래프', file: '', nodes: [node('list', 'list', { items: ['하나', '둘'], x: 0, y: 0 })], edges: [] }]
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.orbit = {
    async invoke(name, ...args) {
      if (name === 'listPipelines') return saved
      if (['listTasks', 'listSkills', 'listSpecs', 'pipelineRuns', 'agentSessions'].includes(name)) return []
      if (name === 'savePipeline') {
        const input = args[0] as Omit<Pipeline, 'file' | 'id'> & { id?: string }
        const result: Pipeline = { ...structuredClone(input), id: input.id ?? 'new-function', file: '' }
        saved = [...saved.filter((p) => p.id !== result.id), result]
        return result
      }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on: () => () => {}
  }
})
afterEach(async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(550) })
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const mount = () => act(async () => root.render(createElement(PipelineEditor, { tabs: [], onShowTerminal: () => {} })))
const select = (id: string) => act(async () => { graph().getElementById(id).emit('tap') })
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}
async function change(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('함수와 리스트 항목 편집 화면', () => {
  it('[DM-F02-AC12] 꺼내기 버튼은 원본 출력과 새 항목 입력을 연결하고 변경된 값을 보여 준다', async () => {
    await mount()
    await select('list')
    await click('+ 둘')
    const item = graph().nodes('[kind = "item"]').first()
    expect(item.nonempty()).toBe(true)
    expect(graph().edges().map((e) => [e.source().id(), e.target().id()])).toEqual([['list', item.id()]])
    await select('list')
    await change(host.querySelectorAll<HTMLTextAreaElement>('.pipe-list-items textarea')[1], '변경된 둘')
    await select(item.id())
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('변경된 둘')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toEqual([{ from: 'list', to: item.id() }])
    expect(saved[0].nodes.find((n) => n.id === item.id())).toMatchObject({ kind: 'item', index: 1 })
  })

  it('[DM-F02-AC13] 새 함수에는 삭제할 수 없는 Input·Output과 변수 이름·타입 편집기가 있다', async () => {
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="새 함수"]')!.click())
    expect(graph().nodes().map((n) => n.data('kind'))).toEqual(['function-input', 'function-output'])
    const input = graph().nodes('[kind = "function-input"]').first()
    expect(input.data('label')).toBe('')
    await select(input.id())
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === '노드 삭제')?.disabled).toBe(true)
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    expect(graph().nodes()).toHaveLength(2)
    await change(host.querySelector<HTMLInputElement>('[aria-label="입력 변수 이름"]')!, '작업 목록')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="작업 목록 타입"]')!, 'list')
    await click('+ 입력 변수')
    expect(input.data('pins').filter((p: { type: string }) => p.type === 'data')).toMatchObject([{ list: true, label: '작업 목록 · 텍스트 리스트' }, { list: false }])
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved.find((p) => p.id === 'new-function')?.nodes[0].params).toMatchObject([{ name: '작업 목록', type: 'list' }, { name: '입력', type: 'single' }])
  })

  it('[DM-F02-AC13] 두 번째 변수 핀을 정확히 연결하고 이름 변경·삭제를 해당 포트에만 반영한다', async () => {
    saved = [{ id: 'f', title: '함수', file: '', template: true, nodes: [
      node('in', 'function-input', { x: 0, y: 0, params: [{ id: 'a', name: '첫째', type: 'single' }, { id: 'b', name: '둘째', type: 'single' }] }),
      node('out', 'function-output', { x: 600, y: 0, params: [{ id: 'x', name: '첫 결과', type: 'single' }, { id: 'y', name: '둘째 결과', type: 'single' }], values: { y: '' } })
    ], edges: [{ from: 'in', to: 'out' }, { from: 'in', to: 'out', pin: 'data', fromPort: 'a', toPort: 'x' }] }]
    await mount()
    const c = graph()
    c.zoom(1); c.pan({ x: 0, y: 0 })
    const source = c.getElementById('in') as NodeSingular, target = c.getElementById('out') as NodeSingular
    const fromPin = source.data('pins').find((p: { id?: string }) => p.id === 'b') as { dy: number }
    const toPin = target.data('pins').find((p: { id?: string }) => p.id === 'y') as { dy: number }
    const drop = { x: target.position().x - target.width() / 2, y: target.position().y + toPin.dy }
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    await act(async () => {
      emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y + fromPin.dy } })
      emit({ type: 'tapdrag', position: drop })
      const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: 'in', target: 'out' } })
      emit({ type: 'ehcomplete', position: drop }, [source, target, temporary])
      c.emit('tapend')
    })
    const edge = c.edges().filter((e) => e.data('fromPort') === 'b').first()
    expect(edge.data('toPort')).toBe('y')
    expect(edge.style('target-endpoint')).toContain(`${toPin.dy}px`)
    await select('in')
    await change(host.querySelectorAll<HTMLInputElement>('[aria-label="입력 변수 이름"]')[1], '바뀐 이름')
    expect(edge.data('fromPort')).toBe('b')
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="첫째 변수 삭제"]')!.click())
    expect(c.edges().filter((e) => e.data('fromPort') === 'a')).toHaveLength(0)
    expect(c.edges().filter((e) => e.data('fromPort') === 'b')).toHaveLength(1)
  })
})
