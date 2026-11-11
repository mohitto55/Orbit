import { expect, it, vi } from 'vitest'
import { expandPipeline, messagePeers, pipelineProblems, PipelineRunner, withMessagePeers, LOOP_PORT, type Graph, type Pipeline, type PipeNode } from '../src/core/pipeline'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import type { TerminalInfo } from '../src/core/terminal'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '작업', terminal: 'new', ...extra })
const graph = (): Pipeline => ({ id: 'g', title: '대화', file: '', nodes: [node('a', 'codex', { peers: ['b'] }), node('b', 'claude'), node('c', 'codex')], edges: [] })

it('대화 연결을 저장·재열기하고 상대에서 해제해도 실행 순서는 바뀌지 않는다', async () => {
  const project = await newProject(), original = graph()
  await savePipeline(project, original)
  const saved = (await listPipelines(project))[0]
  expect(messagePeers(saved, 'b').map((n) => n.id)).toEqual(['a'])
  expect(messagePeers(saved, 'c')).toEqual([])
  expect(pipelineProblems(saved)).toEqual([])
  expect(expandPipeline(saved).edges).toEqual([])
  saved.nodes = withMessagePeers(saved.nodes, 'b', [])
  await savePipeline(project, saved)
  expect(messagePeers((await listPipelines(project))[0], 'a')).toEqual([])
})

it('함수 호출·반복마다 상대 ID를 다시 매핑하여 다른 호출이나 반복에 연결하지 않는다', () => {
  const definition: Pipeline = { ...graph(), template: true, nodes: [node('in', 'function-input'), node('a', 'codex', { peers: ['b'] }), node('b', 'claude'), node('out', 'function-output')], edges: [{ from: 'in', to: 'a' }, { from: 'in', to: 'b' }, { from: 'a', to: 'out' }, { from: 'b', to: 'out' }] }
  const expanded = expandPipeline({ nodes: [node('one', 'template', { ref: 'g' }), node('two', 'template', { ref: 'g' })], edges: [] }, { library: [definition] })
  const first = expanded.nodes.find((n) => n.sourceIds?.includes('one') && n.kind === 'codex')!
  expect(messagePeers(expanded, first.id)).toHaveLength(1)
  expect(messagePeers(expanded, first.id)[0].sourceIds).toContain('one')
  const loop: Graph = { nodes: [node('items', 'list', { items: ['첫째', '둘째'] }), node('loop', 'foreach'), ...graph().nodes.slice(0, 2)], edges: [{ from: 'items', to: 'loop', toPort: LOOP_PORT.list }, { from: 'loop', to: 'a', fromPort: LOOP_PORT.body }, { from: 'loop', to: 'b', fromPort: LOOP_PORT.body }] }
  const iterations = expandPipeline(loop)
  expect(messagePeers(iterations, 'loop/0/a').map((n) => n.id)).toEqual(['loop/0/b'])
  expect(messagePeers(iterations, 'loop/1/b').map((n) => n.id)).toEqual(['loop/1/a'])
})

it('동시에 시작한 Codex·Claude만 실행 범위에 묶고 완료·중지 상태를 즉시 갱신한다', async () => {
  const terminals = new Map<string, TerminalInfo>(), begin = vi.fn(), sync = vi.fn(), submit = vi.fn(), end = vi.fn()
  const runner = new PipelineRunner({
    createTerminal: async (kind, label) => { const t: TerminalInfo = { id: label, kind, title: label, pid: 1 }; terminals.set(label, t); return t },
    getTerminal: (id) => terminals.get(id), hasTerminal: (id) => terminals.has(id), whenReady: async () => {},
    submit, runCommand() {}, completeTasks: async () => {}, emit() {}, beginOutputCapture: begin, endOutputCapture: end, syncMessageRun: sync
  })
  const state = runner.start(graph())
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3))
  expect(begin.mock.calls.find(([id]) => id === 'a')?.[3]).toEqual({ runId: state.runId, nodeId: 'a' })
  expect(begin.mock.calls.find(([id]) => id === 'b')?.[1]).toContain('receive_messages')
  expect(begin.mock.calls.find(([id]) => id === 'c')?.[3]).toBeUndefined()
  expect(submit.mock.calls.find(([id]) => id === 'c')?.[1]).toBe('작업')
  expect(sync.mock.lastCall?.[1]).toMatchObject({ status: 'running', nodes: { a: { status: 'running', peers: ['b'] }, b: { status: 'running', peers: ['a'] }, c: { peers: [] } } })
  runner.markDone(state.runId, 'a')
  expect(sync.mock.lastCall?.[1].nodes.a.status).toBe('done')
  runner.stop(state.runId)
  expect(sync.mock.lastCall?.[1].status).toBe('stopped')
  expect(end).toHaveBeenCalledWith('a')
  expect(end).toHaveBeenCalledWith('b')
})
