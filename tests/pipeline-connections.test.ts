// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Core, CytoscapeOptions, NodeSingular } from 'cytoscape'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PipelineEditor from '../src/renderer/src/pages/Pipelines'
import { AGENT_PORT as A, IF_PORT as I, LOOP_PORT as L, type PipeNode, type Pipeline } from '../src/core/pipeline'

// 화면 그리기만 끈다. 임시 선·스냅·연결 완료는 실제 edgehandles로 검증한다.
vi.mock('cytoscape', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import('cytoscape') }>()
  return { default: Object.assign((options: CytoscapeOptions) => original.default({ ...options, container: undefined, headless: true, styleEnabled: true }), { use: original.default.use }) }
})

const node = (id: string, kind: PipeNode['kind'], x: number, extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '', terminal: 'new', x, y: 0, ...extra })
let host: HTMLDivElement, root: Root, saved: Pipeline[]
const listeners = new Map<string, (value: unknown) => void>()
const graph = () => (window as unknown as { __orbitPipe: Core }).__orbitPipe
type Point = { x: number; y: number }
function emit(type: string, position: Point) {
  const c = graph(), pan = c.pan(), zoom = c.zoom()
  ;(c.emit as unknown as (event: { type: string; position: Point; renderedPosition: Point }) => void)({ type, position, renderedPosition: { x: position.x * zoom + pan.x, y: position.y * zoom + pan.y } })
}
const pinPosition = (n: NodeSingular, port?: string, side = 'out') => {
  const pin = (n.data('pins') as { side: string; id?: string; dy: number }[]).find((p) => p.side === side && p.id === port)!
  return { x: n.position().x + n.width() / 2 * (side === 'out' ? 1 : -1), y: n.position().y + pin.dy }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  saved = [{ id: 'g', title: '출력 연결', file: '', nodes: [node('first', 'codex', 0), node('second', 'codex', 600), node('result', 'dictionary', 1000)], edges: [] }]
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  window.orbit = { getPathForFile: (file) => file.name, on: (channel, callback) => { listeners.set(channel, callback); return () => { listeners.delete(channel) } }, async invoke(name, ...args) {
    if (name === 'listPipelines') return saved
    if (['pipelineRuns', 'listTasks', 'listSkills', 'listSpecs', 'agentSessions', 'agentModels'].includes(name)) return []
    if (name === 'savePipeline') { saved[0] = { ...structuredClone(args[0] as Pipeline), file: '' }; return saved[0] }
    throw new Error(name)
  } }
})
afterEach(async () => { await act(async () => { root.unmount(); await vi.runOnlyPendingTimersAsync() }); host.remove(); listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = () => act(async () => root.render(createElement(PipelineEditor, { tabs: [], onShowTerminal() {} })))

it.each([0.25, 1, 2])('[DM-F02-AC23] 줌 %s에서 두 노드의 서로 다른 출력을 연속해서 끌어도 누른 핀에서 임시 선이 나온다', async (zoom) => {
  await mount()
  const c = graph(); c.zoom(zoom); c.pan({ x: 350, y: 170 })
  for (const [id, port] of [['first', A.output], ['second', A.terminal], ['first', undefined]] as const) {
    const source = c.getElementById(id) as NodeSingular, pin = pinPosition(source, port)
    await act(async () => { emit('tapstart', pin); emit('tapdrag', { x: pin.x + 20, y: pin.y }) })
    const ghost = c.edges('.eh-ghost-edge').first()
    expect(ghost.length).toBe(1)
    expect(ghost.source().id()).toBe(id)
    expect(ghost.data('fromPort')).toBe(port)
    expect(ghost.style('source-endpoint')).toBe(`${source.width() / 2 + 2}px ${pin.y - source.position().y}px`)
    await act(async () => emit('tapend', { x: pin.x + 20, y: pin.y }))
    expect(c.elements('.eh-ghost')).toHaveLength(0)
  }
})

it.each([
  { kind: 'function-input' as const, port: 'items', extra: { params: [{ id: 'name', name: '이름', type: 'single' as const }, { id: 'items', name: '목록', type: 'list' as const }] } },
  { kind: 'foreach' as const, port: L.done, extra: {} },
  { kind: 'if' as const, port: I.no, extra: {} }
])('[DM-F02-AC23] $kind의 선택한 변수·실행 분기에서 미리 보기 선을 시작한다', async ({ kind, port, extra }) => {
  saved[0].nodes = [node('source', kind, 0, extra)]
  await mount()
  const source = graph().getElementById('source') as NodeSingular, pin = pinPosition(source, port)
  await act(async () => { emit('tapstart', pin); emit('tapdrag', { x: pin.x + 20, y: pin.y }) })
  const ghost = graph().edges('.eh-ghost-edge').first()
  expect(ghost.data('fromPort')).toBe(port)
  expect(ghost.style('source-endpoint')).toContain(`${pin.y}px`)
})

it('[DM-F02-AC23] 실행 상태가 갱신돼도 끌고 있는 선을 유지하고 같은 출력에서 연결·저장한다', async () => {
  await mount()
  const c = graph(), source = c.getElementById('second') as NodeSingular, target = c.getElementById('result') as NodeSingular
  const start = pinPosition(source, A.output), drop = pinPosition(target, undefined, 'in')
  await act(async () => { emit('tapstart', start); emit('tapdrag', { x: start.x + 20, y: start.y }) })
  const ghostId = c.edges('.eh-ghost-edge').first().id()
  await act(async () => listeners.get('pipeline-state')!({ pipelineId: 'g', runId: 'r', title: '', status: 'done', started: '', nodes: { first: { status: 'done', output: '완료' } } }))
  expect(c.getElementById(ghostId).length).toBe(1)
  expect(source.hasClass('eh-source')).toBe(true)
  await act(async () => { emit('tapdrag', drop); await vi.advanceTimersByTimeAsync(200) })
  const preview = c.edges('.eh-preview').first()
  expect(preview.source().id()).toBe('second')
  expect(preview.data('fromPort')).toBe(A.output)
  expect(preview.style('source-endpoint')).toBe('162px 46px')
  await act(async () => emit('tapend', drop))
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(saved[0].edges).toEqual([{ from: 'second', to: 'result', pin: 'data', fromPort: A.output }])
  expect(c.edges()).toHaveLength(1)
  expect(c.edges().first().style('source-endpoint')).toBe('162px 46px')
})

it('[DM-F02-AC23] 대상 미리 보기에서 출력 핀으로 돌아와 놓으면 이전 대상을 연결하지 않는다', async () => {
  await mount()
  const c = graph(), source = c.getElementById('first') as NodeSingular, target = c.getElementById('result') as NodeSingular
  const start = pinPosition(source, A.output), drop = pinPosition(target, undefined, 'in')
  await act(async () => { emit('tapstart', start); emit('tapdrag', drop); await vi.advanceTimersByTimeAsync(150) })
  expect(c.edges('.eh-preview')).toHaveLength(1)
  // 마지막 tapdrag가 오기 전에 놓아도 실제 tapend 위치를 따른다.
  await act(async () => emit('tapend', start))
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(saved[0].edges).toEqual([])
  expect(c.edges()).toHaveLength(0)
  // 다음 핀을 클릭만 하면 앞 드래그의 마지막 위치로 검색 메뉴를 열지 않는다.
  const next = pinPosition(c.getElementById('second') as NodeSingular, A.terminal)
  await act(async () => { emit('tapstart', next); emit('tapend', next) })
  expect(host.querySelector('.pipe-menu')).toBeNull()
})

it('[DM-F02-AC23] 원래 출력 핀 옆에 연결 가능한 노드가 있어도 그 핀에 놓으면 취소한다', async () => {
  saved[0].nodes = [node('first', 'codex', 0), node('second', 'codex', 0, { y: 220 })]
  await mount()
  const c = graph(), source = c.getElementById('first') as NodeSingular, target = c.getElementById('second') as NodeSingular
  const start = pinPosition(source, A.terminal), drop = pinPosition(target, A.terminal, 'in')
  await act(async () => { emit('tapstart', start); emit('tapdrag', drop); await vi.advanceTimersByTimeAsync(150) })
  await act(async () => { emit('tapdrag', start); await vi.advanceTimersByTimeAsync(150) })
  expect(c.edges('.eh-preview').first().target().id()).toBe('second')
  await act(async () => emit('tapend', start))
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(saved[0].edges).toEqual([])
  expect(c.edges()).toHaveLength(0)
})
