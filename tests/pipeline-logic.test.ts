import { describe, expect, it, vi } from 'vitest'
import {
  ADD_PORT as A, IF_PORT as I, LOOP_PORT as L, PipelineRunner, dataValue, edgeProblem, expandPipeline,
  fillOutputs, outputRefs, pipelineProblems, withInputPort, type Env, type Graph, type PipeEdge, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import type { CompareOp, CompareType } from '../src/core/pipelineLogic'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: kind === 'shell' ? id : '', terminal: 'new', ...extra })
const exec = (from: string, to: string, fromPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { fromPort } : {}) })
const data = (from: string, to: string, toPort?: string, fromPort?: string): PipeEdge => ({ from, to, ...(toPort ? { toPort } : {}), ...(fromPort ? { fromPort, pin: 'data' } : {}) })
const compare = (op: CompareOp, type: CompareType, a: string, b: string) => dataValue({ nodes: [node('c', 'compare', { operation: op, compareType: type, values: { [A.a]: a, [A.b]: b } })], edges: [] }, 'c')
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function branch(value: boolean): Graph {
  return { nodes: [node('s', 'start'), node('bool', 'boolean', { text: String(value) }), node('if', 'if'), node('yes', 'shell'), node('no', 'shell'), node('join', 'shell')],
    edges: [exec('s', 'if'), data('bool', 'if', I.condition), exec('if', 'yes', I.yes), exec('if', 'no', I.no), exec('yes', 'join'), exec('no', 'join')] }
}
async function harness(graph: Graph, env: Env = {}) {
  expect(pipelineProblems(graph, env)).toEqual([])
  const commands: string[] = []
  const create = vi.fn(async (kind: 'shell' | 'codex' | 'claude', title: string) => ({ id: title, kind, title, pid: 1 }))
  const runner = new PipelineRunner({ createTerminal: create, hasTerminal: () => true, getTerminal: () => undefined,
    whenReady: async () => {}, submit: () => {}, runCommand: (_id, text) => { commands.push(text) }, completeTasks: async () => {}, emit: () => {} })
  runner.start({ id: 'g', title: '조건 테스트', file: '', ...expandPipeline(graph, env) })
  await flush()
  const state = () => runner.list()[0]
  const done = async (id: string, output = '', code = 0) => { runner.commandDone(state().nodes[id].termId!, code, output); await flush() }
  return { commands, create, runner, state, done }
}

describe('Bool 비교·논리 데이터', () => {
  it.each<[CompareOp, CompareType, string, string, boolean]>([
    ['eq', 'number', '10', '10.0', true], ['ne', 'number', '10', '2', true], ['gt', 'number', '10', '2', true],
    ['gte', 'number', '2', '2', true], ['lt', 'number', '-2', '-1', true], ['lte', 'number', '2', '2', true],
    ['gt', 'number', '2', '10', false], ['eq', 'single', 'Orbit', 'orbit', false], ['eq', 'single', 'x ', 'x', false],
    ['ne', 'single', '', '', false], ['eq', 'boolean', 'false', 'false', true], ['ne', 'boolean', 'true', 'false', true]
  ])('%s %s: %j, %j → %s', (op, type, a, b, result) => expect(compare(op, type, a, b)).toBe(String(result)))

  it.each(['and', 'or', 'not'] as const)('%s는 Bool 진리표를 따른다', (kind) => {
    for (const a of [false, true]) for (const b of [false, true]) {
      const graph: Graph = { nodes: [node('calc', kind, { values: { [A.a]: String(a), [A.b]: String(b) } })], edges: [] }
      expect(dataValue(graph, 'calc')).toBe(String(kind === 'and' ? a && b : kind === 'or' ? a || b : !a))
    }
  })

  it('숫자·Bool은 명시적으로 변환하고 문자열의 truthiness를 쓰지 않는다', () => {
    for (const value of ['"false"', '0', 'yes', '{}']) {
      const graph: Graph = { nodes: [node('text', 'text', { text: value }), node('bool', 'boolean')], edges: [data('text', 'bool')] }
      expect(() => dataValue(graph, 'bool')).toThrow('true 또는 false')
    }
    expect(() => compare('gt', 'single', '10', '2')).toThrow('숫자')
    expect(() => compare('eq', 'number', '', '0')).toThrow('유효한 숫자')
    expect(() => compare('eq', 'number', 'Infinity', '0')).toThrow('유효한 숫자')
    const graph: Graph = { nodes: [node('json', 'dictionary', { text: '{"ok":false}' }), node('field', 'property', { pointer: '/ok' }), node('bool', 'boolean')], edges: [data('json', 'field'), data('field', 'bool')] }
    expect(dataValue(graph, 'bool')).toBe('false')
  })

  it('If는 Bool 하나만 받고 계산 노드도 입력 타입·중복·순환을 검사한다', () => {
    const graph: Graph = { nodes: [node('if', 'if'), node('bool', 'boolean'), node('text', 'text'), node('num', 'number'), node('cmp', 'compare'), node('not', 'not')], edges: [] }
    expect(withInputPort(graph, data('bool', 'if'), {}).toPort).toBe(I.condition)
    expect(edgeProblem(graph, 'bool', 'if')).toBeNull()
    for (const id of ['text', 'num']) expect(edgeProblem(graph, id, 'if')).toContain('Bool 입력')
    expect(edgeProblem(graph, 'num', 'cmp', undefined, {}, { toPort: A.b })).toBeNull()
    expect(edgeProblem(graph, 'text', 'cmp')).toContain('Number 입력')
    graph.edges.push(data('bool', 'if', I.condition))
    expect(edgeProblem(graph, 'not', 'if')).toContain('이미 연결된 입력')
    graph.edges.push(data('bool', 'not', A.a), data('not', 'bool'))
    expect(() => dataValue(graph, 'not')).toThrow('고리를 이룹니다')
  })

  it('중첩 계산·JSON 안의 실행 결과 참조를 유지하고 실행 순서를 검사한다', () => {
    const g = branch(true)
    g.nodes.push(node('source', 'shell'), node('number', 'number'), node('cmp', 'compare', { operation: 'gt', values: { [A.b]: '2' } }), node('not', 'not'))
    g.edges = g.edges.filter((e) => e.to !== 'if')
    g.edges.push(exec('s', 'source'), exec('source', 'if'), { from: 'source', to: 'number', pin: 'data' }, data('number', 'cmp', A.a), data('cmp', 'not', A.a), data('not', 'if', I.condition))
    expect(pipelineProblems(g)).toEqual([])
    const condition = expandPipeline(g).nodes.find((n) => n.id === 'if')!.condition!
    expect(outputRefs(condition)).toEqual(['source'])
    expect(fillOutputs(condition, () => '10')).toBe('false')
    expect(fillOutputs(condition, () => '1')).toBe('true')
    expect(fillOutputs(condition, () => '[응답]', true)).toContain('[응답]')
    g.edges = g.edges.filter((e) => e.from !== 'source' || e.pin)
    g.edges.push(exec('s', 'if'))
    expect(pipelineProblems(g).join('\n')).toContain('실행 선으로 먼저')
  })
})

describe('If 실행 분기', () => {
  it.each([true, false])('[DM-F02-AC16] %s 경로만 실행하고 합류 작업은 한 번 실행한다', async (condition) => {
    const g = branch(condition)
    g.nodes.reverse() // 저장된 노드 순서와 무관하게 분기·건너뜀을 전파해야 한다.
    const h = await harness(g), chosen = condition ? 'yes' : 'no', skipped = condition ? 'no' : 'yes'
    expect(h.commands).toEqual([chosen])
    expect(h.state().nodes.if).toMatchObject({ status: 'done', conditionResult: condition })
    expect(h.state().nodes[skipped]).toMatchObject({ status: 'skipped', skipReason: 'condition' })
    expect(h.state().nodes.join.status).toBe('waiting')
    await h.done(chosen)
    expect(h.commands).toEqual([chosen, 'join'])
    await h.done('join')
    expect(h.state().status).toBe('done')
    expect(h.create).toHaveBeenCalledTimes(2) // If는 터미널을 만들지 않는다.
  })

  it('실제 명령 결과를 비교하며 잘못된 Bool 출력은 실패로 처리한다', async () => {
    for (const value of ['false', 'true', '잘못된 값']) {
      const g = branch(true)
      g.nodes.push(node('source', 'shell'))
      g.edges = g.edges.filter((e) => e.from !== 's')
      g.edges.push(exec('s', 'source'), exec('source', 'if'), { from: 'source', to: 'bool', pin: 'data' })
      const h = await harness(g)
      await h.done('source', value)
      if (value === '잘못된 값') {
        expect(h.state().status).toBe('failed')
        expect(h.state().nodes.if.message).toContain('true 또는 false')
        expect(h.commands).toEqual(['source'])
      } else expect(h.commands).toEqual(['source', value === 'true' ? 'yes' : 'no'])
    }
  })

  it('선택한 경로가 실패하면 합류를 실행하지 않고, 선택하지 않은 결과를 만들어내지 않는다', async () => {
    const h = await harness(branch(true))
    await h.done('yes', '', 1)
    expect(h.state().nodes.join).toMatchObject({ status: 'skipped', skipReason: 'failed' })
    expect(h.state().status).toBe('failed')
    const g = branch(true)
    g.edges.push({ from: 'no', to: 'join', pin: 'data' })
    const missing = await harness(g)
    await missing.done('yes')
    expect(missing.state().nodes.join).toMatchObject({ status: 'failed', message: expect.stringContaining('응답을 받지 못했습니다') })
  })

  it('중첩 분기와 같은 대상에 연결한 True·False를 처리한다', async () => {
    const g = branch(true)
    g.nodes.push(node('inner', 'if'), node('unselected', 'shell'))
    g.edges = g.edges.filter((e) => e.from !== 'if' || e.fromPort !== I.yes)
    g.edges.push(exec('if', 'inner', I.yes), exec('inner', 'yes', I.yes), exec('inner', 'yes', I.no), exec('if', 'unselected', I.no))
    const h = await harness(g)
    expect(h.commands).toEqual(['yes'])
    await h.done('yes')
    expect(h.commands).toEqual(['yes', 'join'])
    await h.done('join')
    expect(h.state().status).toBe('done')
  })

  it('합류에서는 선택된 병렬 작업을 모두 기다린다', async () => {
    const g = branch(false)
    g.nodes.push(node('parallel', 'shell'))
    g.edges.push(exec('if', 'parallel', I.no), exec('parallel', 'join'))
    const h = await harness(g)
    expect(h.commands).toEqual(['no', 'parallel'])
    await h.done('no')
    expect(h.state().nodes.join.status).toBe('waiting')
    await h.done('parallel')
    expect(h.commands).toEqual(['no', 'parallel', 'join'])
  })

  it('합류의 이어서 실행은 실제 선택한 앞 작업의 터미널을 쓴다', async () => {
    const g = branch(false)
    g.nodes.find((n) => n.id === 'join')!.terminal = 'continue'
    const h = await harness(g)
    await h.done('no')
    expect(h.state().nodes.join).toMatchObject({ status: 'running', termId: h.state().nodes.no.termId })
    expect(h.create).toHaveBeenCalledTimes(1)
    await h.done('join')
    expect(h.state().status).toBe('done')
  })

  it('For Each에서 거짓인 항목을 건너뛰고 다음 항목·완료 경로를 실행한다', async () => {
    const g: Graph = { nodes: [node('s', 'start'), node('loop', 'foreach', { values: { [L.list]: '1\n3\n2' } }), node('num', 'number'), node('cmp', 'compare', { operation: 'gt', values: { [A.b]: '2' } }), node('if', 'if'), node('work', 'shell'), node('after', 'shell')],
      edges: [exec('s', 'loop'), exec('loop', 'if', L.body), exec('if', 'work', I.yes), exec('loop', 'after', L.done), data('loop', 'num', undefined, L.item), data('num', 'cmp', A.a), data('cmp', 'if', I.condition)] }
    const h = await harness(g)
    expect(h.state().nodes['loop/0/work'].status).toBe('skipped')
    expect(h.commands).toEqual(['work'])
    await h.done('loop/1/work')
    expect(h.state().nodes['loop/2/work'].status).toBe('skipped')
    expect(h.commands).toEqual(['work', 'after'])
    await h.done('after')
    expect(h.state().status).toBe('done')
  })

  it('함수 Bool·숫자 인자와 Bool 반환값을 연결하며 빈 분기는 함수에서 반환한다', async () => {
    const fn: Pipeline = { id: 'f', title: '조건 함수', file: '', template: true, nodes: [
      node('in', 'function-input', { params: [{ id: 'enabled', name: '실행 여부', type: 'boolean' }, { id: 'count', name: '개수', type: 'number' }] }),
      node('if', 'if'), node('work', 'shell'), node('cmp', 'compare', { operation: 'gt', values: { [A.b]: '2' } }),
      node('out', 'function-output', { params: [{ id: 'result', name: '결과', type: 'boolean' }] })
    ], edges: [exec('in', 'if'), exec('if', 'work', I.yes), exec('work', 'out'), data('in', 'if', I.condition, 'enabled'), data('in', 'cmp', A.a, 'count'), data('cmp', 'out', 'result')] }
    const g: Graph = { nodes: [node('call', 'template', { ref: 'f', values: { enabled: 'false', count: '10' } }), node('if', 'if'), node('yes', 'shell')],
      edges: [exec('call', 'if'), data('call', 'if', I.condition, 'result'), exec('if', 'yes', I.yes)] }
    const h = await harness(g, { library: [fn] })
    expect(h.state().nodes['call/work'].status).toBe('skipped')
    expect(h.commands).toEqual(['yes'])
    await h.done('yes')
    expect(h.state().status).toBe('done')
  })

  it('중첩 For Each에서 빈 False 경로도 바깥 반복의 다음 항목으로 이어진다', async () => {
    const g: Graph = { nodes: [node('s', 'start'), node('outer', 'foreach', { values: { [L.list]: 'A\nB' } }), node('inner', 'foreach', { values: { [L.list]: 'false\ntrue' } }), node('bool', 'boolean'), node('if', 'if'), node('work', 'shell'), node('after', 'shell')],
      edges: [exec('s', 'outer'), exec('outer', 'inner', L.body), exec('inner', 'if', L.body), exec('if', 'work', I.yes), exec('outer', 'after', L.done), data('inner', 'bool', undefined, L.item), data('bool', 'if', I.condition), data('outer', 'work', undefined, L.item)] }
    const h = await harness(g)
    expect(h.commands).toEqual(['work\n\nA'])
    await h.done('outer/0/inner/1/outer/0/work')
    expect(h.commands).toEqual(['work\n\nA', 'work\n\nB'])
    await h.done('outer/1/inner/1/outer/1/work')
    expect(h.commands).toEqual(['work\n\nA', 'work\n\nB', 'after'])
    await h.done('after')
    expect(h.state().status).toBe('done')
  })

  it('비교 타입·연산·Bool 기본값과 분기 핀을 저장하고 다시 읽는다', async () => {
    const ctx = await newProject(), g = branch(false)
    g.nodes.push(node('cmp', 'compare', { operation: 'gte', compareType: 'number', values: { [A.a]: '10', [A.b]: '2' } }))
    g.nodes.find((n) => n.id === 'if')!.condition = '실행에서만 사용'
    const saved = await savePipeline(ctx, { title: '조건', ...g })
    const restored = (await listPipelines(ctx)).find((p) => p.id === saved.id)!
    expect(restored.nodes.find((n) => n.id === 'cmp')).toMatchObject({ operation: 'gte', compareType: 'number', values: { [A.a]: '10', [A.b]: '2' } })
    expect(restored.nodes.find((n) => n.id === 'if')).not.toHaveProperty('condition')
    expect(restored.edges).toEqual(g.edges)
    expect(dataValue(restored, 'bool')).toBe('false')
  })
})
