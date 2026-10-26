import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PORT as A, LOOP_PORT as L, PipelineRunner, edgeProblem, expandPipeline, nodeInput, pipelineProblems, withInputPort,
  type Env, type FunctionParam, type PipeEdge, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import type { TerminalInfo } from '../src/core/terminal'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
const wire = (from: string, to: string, fromPort?: string, toPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { pin: 'data', fromPort } : {}), ...(toPort ? { toPort } : {}) })
const param = (id: string): FunctionParam => ({ id, name: id, type: 'terminal' })
const tab = (kind: 'claude' | 'codex'): TerminalInfo => ({ id: `tab-${kind}`, kind, title: `내 ${kind} 작업`, pid: 1 })
const graph = (kind: 'claude' | 'codex' = 'codex'): Pipeline => ({
  id: 'graph', title: '터미널 입력', file: '', nodes: [
    node('start', 'start'), node('tab', 'terminal', { ref: tab(kind).id }), node('text', 'text', { text: '연결한 글' }),
    node('work', kind, { text: '첫 작업', terminal: 'continue', session: '이 설정보다 입력이 우선' })
  ], edges: [wire('start', 'work'), wire('tab', 'work', undefined, A.terminal), wire('text', 'work')]
})
const fn = (): Pipeline => ({ id: 'fn', title: '터미널 함수', template: true, file: '', nodes: [
  node('in', 'function-input', { params: [param('tab')] }),
  node('work', 'codex', { text: '함수 작업', terminal: 'continue' }),
  node('out', 'function-output', { params: [param('result')] })
], edges: [wire('in', 'work'), wire('work', 'out'), wire('in', 'work', 'tab', A.terminal), wire('work', 'out', A.terminal, 'result')] })

function runnerHarness(initial: TerminalInfo[] = [tab('codex')]) {
  const tabs = new Map(initial.map((t) => [t.id, t]))
  const createTerminal = vi.fn(async (kind: TerminalInfo['kind']) => {
    const info = { id: `new-${tabs.size}`, kind, title: kind, pid: 1 }
    tabs.set(info.id, info)
    return info
  })
  const submit = vi.fn(), whenReady = vi.fn(async () => {})
  const runner = new PipelineRunner({ createTerminal, hasTerminal: (id) => tabs.has(id), getTerminal: (id) => tabs.get(id), whenReady, submit, runCommand: vi.fn(), completeTasks: async () => {}, emit: () => {} })
  const start = (p: Pipeline, env: Env = {}) => runner.start({ ...p, ...expandPipeline(p, env) })
  return { tabs, createTerminal, submit, whenReady, runner, start }
}

describe('작업 그래프 터미널 입출력', () => {
  it.each(['claude', 'codex'] as const)('[DM-F02-AC15] %s의 터미널 입력은 새 탭·세션·이어서 설정보다 우선하며 프롬프트에 섞이지 않는다', (kind) => {
    const p = graph(kind), h = runnerHarness([tab(kind)])
    expect(pipelineProblems(p, { terminals: [tab(kind)] })).toEqual([])
    expect(nodeInput(p, 'work')).toBe('첫 작업\n\n연결한 글')
    const run = h.start(p)
    expect(run.nodes.work).toMatchObject({ status: 'running', termId: tab(kind).id })
    expect(h.submit.mock.calls).toEqual([[tab(kind).id, '첫 작업\n\n연결한 글']])
    expect(h.createTerminal).not.toHaveBeenCalled()
    expect(h.whenReady).not.toHaveBeenCalled()
    expect(h.runner.markDone(run.runId, 'work')?.status).toBe('done')
  })

  it('[DM-F02-AC15] 중간 작업을 건너 연결한 터미널 출력도 앞 작업 완료 후 같은 탭을 쓴다', async () => {
    const p: Pipeline = { ...graph(), nodes: [node('start', 'start'), node('first', 'codex', { text: '첫째' }), node('middle', 'shell', { text: 'echo middle' }), node('last', 'codex', { text: '마지막' })], edges: [wire('start', 'first'), wire('first', 'middle'), wire('middle', 'last'), wire('first', 'last', A.terminal, A.terminal)] }
    expect(pipelineProblems(p)).toEqual([])
    const h = runnerHarness([]), run = h.start(p)
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1))
    const firstTab = h.submit.mock.calls[0][0] as string
    h.runner.markDone(run.runId, 'first')
    await vi.waitFor(() => expect(h.runner.list()[0].nodes.middle.status).toBe('running'))
    h.runner.commandDone(h.runner.list()[0].nodes.middle.termId!, 0)
    expect(h.submit).toHaveBeenLastCalledWith(firstTab, '마지막')
    expect(h.createTerminal).toHaveBeenCalledTimes(2) // Codex 하나 + 중간 셸 하나
    expect(h.whenReady).toHaveBeenCalledTimes(2)
    p.edges = [wire('start', 'first'), wire('start', 'last'), wire('first', 'last', A.terminal, A.terminal)]
    expect(pipelineProblems(p).join('\n')).toContain('실행 선으로 먼저')
  })

  it('[DM-F02-AC15] 터미널·프롬프트 타입을 구분하고 중복 터미널과 다른 에이전트 종류 연결을 막는다', () => {
    const p = graph()
    p.nodes.push(node('other', 'terminal'), node('claude', 'claude'), node('items', 'list'))
    const to = { toPort: A.terminal }
    expect(edgeProblem(p, 'text', 'work', undefined, {}, to)).toContain('터미널만')
    expect(edgeProblem(p, 'tab', 'work', undefined, {}, { toPort: A.prompt })).toContain('텍스트·리스트만')
    expect(edgeProblem(p, 'other', 'work', undefined, {}, to)).toContain('하나만')
    expect(edgeProblem(p, 'claude', 'work', 'data', {}, to)).toContain('같은 종류')
    expect(edgeProblem(p, 'tab', 'text')).toContain('터미널 타입')
    expect(edgeProblem(p, 'tab', 'items')).toContain('터미널 타입')
    expect(edgeProblem(p, 'items', 'work', undefined, {}, { toPort: A.prompt })).toBeNull()
    expect(withInputPort(p, wire('tab', 'work'), {})).toEqual(wire('tab', 'work', undefined, A.terminal))
    expect(withInputPort(p, wire('text', 'work'), {})).toEqual(wire('text', 'work'))
  })

  it('[DM-F02-AC15] 없거나 종료된 탭과 종류가 바뀐 탭은 실행 전에 알린다', () => {
    const p = graph()
    expect(pipelineProblems(p, { terminals: [] }).join('\n')).toContain('닫혔습니다')
    expect(pipelineProblems(p, { terminals: [{ ...tab('codex'), exited: 0 }] }).join('\n')).toContain('닫혔습니다')
    expect(pipelineProblems(p, { terminals: [{ ...tab('codex'), kind: 'shell' }] }).join('\n')).toContain('같은 종류')
    p.nodes.find((n) => n.id === 'tab')!.ref = undefined
    expect(pipelineProblems(p).join('\n')).toContain('터미널을 고르세요')
  })

  it('[DM-F02-AC15] 중첩 함수의 터미널 인자·반환값은 이름 변경 후에도 ID로 전달된다', () => {
    const inner = fn(), outer = fn()
    outer.id = 'outer'
    outer.nodes[1] = node('call', 'template', { ref: inner.id })
    outer.edges = [wire('in', 'call'), wire('call', 'out'), wire('in', 'call', 'tab', 'tab'), wire('call', 'out', 'result', 'result')]
    outer.nodes[0].params![0].name = '변경한 변수 이름'
    const p: Pipeline = { ...graph(), nodes: [node('start', 'start'), node('tab', 'terminal', { ref: tab('codex').id }), node('call', 'template', { ref: outer.id }), node('after', 'codex', { text: '반환한 탭에서 작업' })], edges: [wire('start', 'call'), wire('call', 'after'), wire('tab', 'call', undefined, 'tab'), wire('call', 'after', 'result', A.terminal)] }
    const env = { library: [inner, outer], terminals: [tab('codex')] }
    expect(pipelineProblems(p, env)).toEqual([])
    expect(expandPipeline(p, env).nodes).toMatchObject([
      { id: 'call/call/work', text: '함수 작업', terminalInput: { tabId: tab('codex').id } },
      { id: 'after', text: '반환한 탭에서 작업', terminalInput: { nodeId: 'call/call/work' } }
    ])
    const h = runnerHarness(), run = h.start(p, env)
    expect(h.submit.mock.calls).toEqual([[tab('codex').id, '함수 작업']])
    h.runner.markDone(run.runId, 'call/call/work')
    expect(h.submit).toHaveBeenLastCalledWith(tab('codex').id, '반환한 탭에서 작업')
    expect(h.createTerminal).not.toHaveBeenCalled()
  })

  it('[DM-F02-AC15] 함수 기본값으로 고른 터미널을 쓰고 입력이 비면 누락된 변수를 알린다', () => {
    const p: Pipeline = { ...graph(), nodes: [node('call', 'template', { ref: 'fn', values: { tab: tab('codex').id } })], edges: [] }
    const env = { library: [fn()] }
    expect(expandPipeline(p, env).nodes[0].terminalInput).toEqual({ tabId: tab('codex').id })
    delete p.nodes[0].values
    expect(pipelineProblems(p, env).join('\n')).toContain('터미널을 연결하거나 고르세요')
  })

  it('[DM-F02-AC15] For Each에서 터미널 출력 참조는 각 반복의 앞 노드를 가리킨다', () => {
    const p: Pipeline = { ...graph(), nodes: [node('start', 'start'), node('tab', 'terminal', { ref: tab('codex').id }), node('loop', 'foreach', { values: { [L.list]: '첫째\n둘째' } }), node('a', 'codex', { text: '작업' }), node('b', 'codex', { text: '검토' })], edges: [wire('start', 'loop'), { from: 'loop', to: 'a', fromPort: L.body }, wire('a', 'b'), wire('loop', 'a', L.item, A.prompt), wire('tab', 'a', undefined, A.terminal), wire('a', 'b', A.terminal, A.terminal)] }
    expect(pipelineProblems(p)).toEqual([])
    const flat = expandPipeline(p)
    expect(flat.nodes.map((n) => n.terminalInput)).toEqual([{ tabId: tab('codex').id }, { nodeId: 'loop/0/a' }, { tabId: tab('codex').id }, { nodeId: 'loop/1/a' }])
    const h = runnerHarness(), run = h.start(p)
    for (const n of flat.nodes) h.runner.markDone(run.runId, n.id)
    expect(h.submit.mock.calls).toEqual([[tab('codex').id, '작업\n\n첫째'], [tab('codex').id, '검토'], [tab('codex').id, '작업\n\n둘째'], [tab('codex').id, '검토']])
    expect(h.createTerminal).not.toHaveBeenCalled()
  })

  it('[DM-F02-AC15] 닫힘·종류 변경·작업 중을 전송 직전에 확인하고 새 탭으로 대체하지 않는다', () => {
    for (const tabs of [[], [{ ...tab('codex'), kind: 'claude' as const }], [{ ...tab('codex'), exited: 0 }], [{ ...tab('codex'), activity: 'working' as const }]]) {
      const h = runnerHarness(tabs), run = h.start(graph())
      expect(run.nodes.work.status).toBe('failed')
      expect(h.submit).not.toHaveBeenCalled()
      expect(h.createTerminal).not.toHaveBeenCalled()
    }
  })

  it('[DM-F02-AC15] 다른 그래프가 점유한 터미널에 덮어쓰지 않고 완료 후 다시 사용할 수 있다', () => {
    const h = runnerHarness(), first = h.start(graph())
    const second = h.start({ ...graph(), id: 'second' })
    expect(second.nodes.work.message).toContain('다른 작업 노드가 실행 중')
    expect(h.submit).toHaveBeenCalledTimes(1)
    h.runner.markDone(first.runId, 'work')
    const third = h.start({ ...graph(), id: 'third' })
    expect(third.nodes.work.status).toBe('running')
    expect(h.submit).toHaveBeenCalledTimes(2)
  })

  it('[DM-F02-AC15] 완료 신호가 상태 제목보다 먼저 와도 같은 탭의 다음 작업을 즉시 시작한다', () => {
    const p = graph()
    p.nodes.push(node('next', 'codex', { text: '다음 작업' }))
    p.edges.push(wire('work', 'next'), wire('work', 'next', A.terminal, A.terminal))
    const h = runnerHarness(), run = h.start(p)
    h.tabs.get(tab('codex').id)!.activity = 'working'
    h.runner.agentDone(tab('codex').id, true)
    expect(h.runner.list()[0].nodes.next).toMatchObject({ status: 'running', termId: tab('codex').id })
    expect(h.submit).toHaveBeenLastCalledWith(tab('codex').id, '다음 작업')
    expect(h.whenReady).not.toHaveBeenCalled()
    h.runner.stop(run.runId)
    // 중지는 완료 신호가 아니므로 실제 작업 중인 탭을 다른 실행이 가져가면 안 된다.
    const blocked = h.start({ ...graph(), id: 'other' })
    expect(blocked.nodes.work.message).toContain('작업이 진행 중')
  })

  it('[DM-F02-AC15] 함수 타입·선택한 탭·핀 연결을 저장하되 실행 시 계산한 참조는 저장하지 않는다', async () => {
    const ctx = await newProject(), definition = fn()
    definition.nodes[1].terminalInput = { tabId: '실행에서만 사용' }
    await savePipeline(ctx, definition)
    await savePipeline(ctx, graph())
    const saved = await listPipelines(ctx)
    expect(saved.find((p) => p.id === definition.id)?.nodes).toMatchObject([{ params: [param('tab')] }, { kind: 'codex' }, { params: [param('result')] }])
    expect(saved.find((p) => p.id === definition.id)?.nodes[1]).not.toHaveProperty('terminalInput')
    expect(saved.find((p) => p.id === 'graph')?.nodes.find((n) => n.id === 'tab')).toMatchObject({ kind: 'terminal', ref: tab('codex').id })
    expect(saved.find((p) => p.id === 'graph')?.edges).toEqual(graph().edges)
  })
})
