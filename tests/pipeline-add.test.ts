import { describe, expect, it } from 'vitest'
import {
  ADD_PORT as P, AGENT_PORT, dataItems, dataValue, edgeProblem, expandPipeline, fillOutputs,
  pipelineProblems, withInputPort, type Graph, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })

describe('텍스트 Add', () => {
  it('연결·배치 순서와 무관하게 A + B 순서로 이어 붙인다', () => {
    const a = node('a', 'text', { text: ' 앞\n', y: 100 })
    const b = node('b', 'text', { text: '뒤  ', y: -100 })
    const graph: Graph = {
      nodes: [a, b, node('add', 'add'), node('work', 'shell')],
      edges: [{ from: 'b', to: 'add', toPort: P.b }, { from: 'a', to: 'add', toPort: P.a }, { from: 'add', to: 'work' }]
    }
    expect(dataItems(graph, 'add')).toEqual([' 앞\n뒤  '])
    a.y = -200
    b.y = 200
    expect(dataValue(graph, 'add')).toBe(' 앞\n뒤  ')
    expect(pipelineProblems(graph)).toEqual([])
    // 실행 프롬프트는 기존 규칙에 따라 전체 앞뒤 공백을 정리한다.
    expect(expandPipeline(graph).nodes).toMatchObject([{ id: 'work', text: '앞\n뒤' }])
  })

  it.each([
    ['', '', ''], ['hello', ' world', 'hello world'], [' ', '\n', ' \n']
  ])('연결하지 않은 입력의 기본값 %j + %j를 보존한다', (a, b, expected) => {
    expect(dataValue({ nodes: [node('add', 'add', { values: { [P.a]: a, [P.b]: b } })], edges: [] }, 'add')).toBe(expected)
  })

  it('빈 입력도 연결된 값을 우선하고 연결을 끊으면 기본값으로 돌아간다', () => {
    const graph: Graph = {
      nodes: [node('empty', 'text'), node('add', 'add', { values: { [P.a]: '기본', [P.b]: '!' } })],
      edges: [{ from: 'empty', to: 'add', toPort: P.a }]
    }
    expect(dataValue(graph, 'add')).toBe('!')
    graph.edges = []
    expect(dataValue(graph, 'add')).toBe('기본!')
    expect(dataValue({ nodes: [node('add', 'add')], edges: [] }, 'add')).toBe('')
  })

  it('텍스트 입력만 허용하고 본체에 연결하면 비어 있는 A/B 입력을 고른다', () => {
    const graph: Graph = {
      nodes: [node('a', 'text'), node('b', 'text'), node('c', 'text'), node('add', 'add'), node('agent', 'codex'),
        node('list', 'list'), node('terminal', 'terminal'), node('schema', 'schema'), node('json', 'dictionary')],
      edges: [{ from: 'a', to: 'add', toPort: P.a }]
    }
    const edge = withInputPort(graph, { from: 'b', to: 'add' }, {})
    expect(edge.toPort).toBe(P.b)
    expect(edgeProblem(graph, 'b', 'add', undefined, {}, edge)).toBeNull()
    expect(edgeProblem(graph, 'a', 'add', undefined, {}, { toPort: P.b })).toBeNull()
    expect(edgeProblem(graph, 'b', 'add', undefined, {}, { toPort: P.a })).toContain('이미 연결된 입력')
    graph.edges.push(edge)
    expect(edgeProblem(graph, 'c', 'add', undefined, {}, { toPort: P.b })).toContain('이미 연결된 입력')
    expect(edgeProblem(graph, 'b', 'add', undefined, {}, { toPort: 'unknown' })).toContain('A 또는 B')
    for (const id of ['list', 'terminal', 'schema', 'json']) {
      expect(edgeProblem(graph, id, 'add', undefined, {}, { toPort: P.a })).toContain('연결할 수 없습니다')
    }
    graph.edges = []
    expect(edgeProblem(graph, 'agent', 'add', 'data', {}, { fromPort: AGENT_PORT.output, toPort: P.a })).toBeNull()
    expect(edgeProblem(graph, 'agent', 'add', undefined)).toContain('실행 출력에서 데이터 노드')
  })

  it('실행 결과를 이어 붙이고 Add끼리 연결해도 결과 참조를 유지한다', () => {
    const graph: Graph = {
      nodes: [node('source', 'shell', { text: 'echo hello' }), node('add', 'add', { values: { [P.b]: ' world' } }),
        node('suffix', 'add', { values: { [P.b]: '!' } }), node('work', 'shell')],
      edges: [{ from: 'source', to: 'work' }, { from: 'source', to: 'add', pin: 'data', toPort: P.a },
        { from: 'add', to: 'suffix', toPort: P.a }, { from: 'suffix', to: 'work' }]
    }
    expect(pipelineProblems(graph)).toEqual([])
    const work = expandPipeline(graph).nodes.find((n) => n.id === 'work')!
    expect(fillOutputs(work.text, () => 'hello')).toBe('hello world!')
  })

  it('함수의 텍스트 변수를 받고 반환하며 기본값 안의 함수 입력도 치환한다', () => {
    const definition: Pipeline = { id: 'f', title: '인사', file: '', template: true, nodes: [
      node('in', 'function-input', { params: [{ id: 'who', name: '이름', type: 'single' }] }),
      node('add', 'add', { values: { [P.b]: '님, {{이름}}!' } }),
      node('out', 'function-output', { params: [{ id: 'result', name: '인사', type: 'single' }] })
    ], edges: [{ from: 'in', to: 'out' }, { from: 'in', to: 'add', pin: 'data', fromPort: 'who', toPort: P.a },
      { from: 'add', to: 'out', toPort: 'result' }] }
    const graph: Graph = { nodes: [node('call', 'template', { ref: 'f', values: { who: 'Orbit' } }), node('work', 'shell')],
      edges: [{ from: 'call', to: 'work' }, { from: 'call', to: 'work', pin: 'data', fromPort: 'result' }] }
    const env = { library: [definition] }
    expect(pipelineProblems(graph, env)).toEqual([])
    expect(expandPipeline(graph, env).nodes.find((n) => n.id === 'work')?.text).toBe('Orbit님, Orbit!')
  })

  it('Add 사이의 순환 연결은 계산할 수 없다고 알린다', () => {
    const graph: Graph = { nodes: [node('a', 'add'), node('b', 'add')],
      edges: [{ from: 'a', to: 'b', toPort: P.a }, { from: 'b', to: 'a', toPort: P.b }] }
    expect(() => dataValue(graph, 'a')).toThrow('고리를 이룹니다')
  })

  it('노드 종류·입력 기본값·포트 연결을 저장하고 다시 읽는다', async () => {
    const ctx = await newProject()
    const saved = await savePipeline(ctx, { title: '텍스트 Add', nodes: [node('text', 'text', { text: '안녕' }),
      node('add', 'add', { values: { [P.b]: ' Orbit\n' } })], edges: [{ from: 'text', to: 'add', toPort: P.a }] })
    const restored = (await listPipelines(ctx)).find((p) => p.id === saved.id)!
    expect(restored.nodes.find((n) => n.id === 'add')).toMatchObject({ kind: 'add', values: { [P.b]: ' Orbit\n' } })
    expect(restored.edges).toEqual([{ from: 'text', to: 'add', toPort: P.a }])
    expect(dataValue(restored, 'add')).toBe('안녕 Orbit\n')
  })
})
