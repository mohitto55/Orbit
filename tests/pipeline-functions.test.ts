import { describe, expect, it } from 'vitest'
import {
  dataValue, edgeProblem, expandPipeline, fillOutputs, functionParams, innerValues,
  outputToken, pipelineProblems, withFunctionBoundary,
  type FunctionParam, type Graph, type PipeEdge, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
const param = (id: string, type: FunctionParam['type'] = 'single'): FunctionParam => ({ id, name: id, type })
const wire = (from: string, to: string, fromPort?: string, toPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { pin: 'data', fromPort } : {}), ...(toPort ? { toPort } : {}) })
const fn = (extra: Partial<Pipeline> = {}): Pipeline => ({
  id: 'identity', title: '두 값 반환', file: '', template: true,
  nodes: [
    node('in', 'function-input', { params: [param('title'), param('items', 'list')] }),
    node('out', 'function-output', { params: [param('result'), param('results', 'list')] })
  ],
  edges: [wire('in', 'out'), wire('in', 'out', 'title', 'result'), wire('in', 'out', 'items', 'results')],
  ...extra
})
const caller = (extra: Partial<Graph> = {}): Graph => ({
  nodes: [
    node('start', 'start'), node('call', 'template', { ref: 'identity', values: { title: '제목', items: '하나\n둘' } }),
    node('item', 'item', { index: 1 }), node('join', 'join', { text: ' / ' }), node('work', 'codex', { text: '처리' })
  ],
  edges: [wire('start', 'call'), wire('call', 'work'), wire('call', 'item', 'results'), wire('call', 'join', 'results'), wire('item', 'work'), wire('join', 'work'), wire('call', 'work', 'result')],
  ...extra
})

describe('함수와 연결된 리스트 항목', () => {
  it('[DM-F02-AC12] 꺼낸 항목은 연결된 리스트의 현재 인덱스 값을 읽고 원본 변경을 따라간다', () => {
    const graph: Graph = { nodes: [node('list', 'list', { items: ['하나', '', '둘'] }), node('item', 'item', { index: 1 })], edges: [wire('list', 'item')] }
    expect(innerValues(graph.nodes[0], {}, graph)).toEqual([{ kind: 'item', index: 0, label: '하나' }, { kind: 'item', index: 1, label: '둘' }])
    expect(dataValue(graph, 'item')).toBe('둘')
    graph.nodes[0].items = ['첫째', '둘째']
    expect(dataValue(graph, 'item')).toBe('둘째')
    graph.nodes[0].items = ['하나']
    expect(() => dataValue(graph, 'item')).toThrow('2번째 항목이 없습니다')
    expect(() => dataValue({ ...graph, edges: [] }, 'item')).toThrow('원본 리스트를 연결하세요')
  })

  it('[DM-F02-AC12] 입력으로 모은 리스트에서도 항목을 꺼내고 리스트 이외의 원본은 막는다', () => {
    const graph: Graph = { nodes: [node('text', 'text', { text: '현재 값' }), node('list', 'list'), node('item', 'item')], edges: [wire('text', 'list'), wire('list', 'item')] }
    expect(innerValues(graph.nodes[1], {}, graph)).toEqual([{ kind: 'item', index: 0, label: '현재 값' }])
    expect(dataValue(graph, 'item')).toBe('현재 값')
    expect(edgeProblem(graph, 'text', 'item')).toContain('리스트를 연결')
    expect(() => dataValue({ ...graph, edges: [wire('item', 'list'), wire('list', 'item')] }, 'item')).toThrow('고리')
  })

  it('[DM-F02-AC13] 이름과 타입이 있는 여러 인자·반환값을 전달하고 리스트의 항목 구분을 보존한다', () => {
    const env = { library: [fn()] }
    expect(pipelineProblems(caller(), env, { requireStart: true })).toEqual([])
    expect(expandPipeline(caller(), env)).toMatchObject({ nodes: [{ id: 'work', text: '처리\n\n둘\n\n하나 / 둘\n\n제목' }], edges: [] })
    expect(functionParams(caller().nodes[1], env)).toEqual({ inputs: [param('title'), param('items', 'list')], outputs: [param('result'), param('results', 'list')] })
  })

  it('[DM-F02-AC13] 연결한 인자는 기본값을 대체하며 각 포트에 독립적으로 전달된다', () => {
    const graph = caller()
    graph.nodes.push(node('names', 'list', { items: ['새 값\n안쪽 줄', '다음'] }), node('label', 'text', { text: '변경된 제목' }))
    graph.edges.push(wire('names', 'call', undefined, 'items'), wire('label', 'call', undefined, 'title'))
    expect(pipelineProblems(graph, { library: [fn()] })).toEqual([])
    expect(expandPipeline(graph, { library: [fn()] }).nodes[0].text).toBe('처리\n\n다음\n\n새 값\n안쪽 줄 / 다음\n\n변경된 제목')
  })

  it('[DM-F02-AC13] 변수 이름을 바꿔도 ID로 연결한 내부·외부 선은 유지된다', () => {
    const definition = fn()
    definition.nodes[0].params![0].name = '새 이름'
    definition.nodes[1].params![0].name = '새 반환 이름'
    expect(pipelineProblems(caller(), { library: [definition] })).toEqual([])
    expect(expandPipeline(caller(), { library: [definition] }).nodes[0].text).toContain('제목')
  })

  it('[DM-F02-AC13] 반환값을 다른 데이터와 합칠 때 호출자 화면의 위·왼쪽 순서를 따른다', () => {
    const definition = fn()
    definition.nodes[1].x = 900
    definition.nodes[1].y = 300
    const graph: Graph = { nodes: [node('s', 'start'), node('call', 'template', { ref: 'identity', y: -100, values: { title: '먼저' } }), node('text', 'text', { text: '나중', y: 0 }), node('work', 'codex')], edges: [wire('s', 'call'), wire('call', 'work'), wire('text', 'work'), wire('call', 'work', 'result')] }
    expect(expandPipeline(graph, { library: [definition] }).nodes[0].text).toBe('먼저\n\n나중')
  })

  it('[DM-F02-AC13] 중첩 함수와 같은 함수의 여러 호출은 서로의 값을 섞지 않는다', () => {
    const wrapped = fn({ id: 'wrapped', title: '중첩' })
    wrapped.nodes.push(node('inner', 'template', { ref: 'identity' }))
    wrapped.edges = [wire('in', 'inner'), wire('inner', 'out'), wire('in', 'inner', 'title', 'title'), wire('in', 'inner', 'items', 'items'), wire('inner', 'out', 'result', 'result'), wire('inner', 'out', 'results', 'results')]
    const graph: Graph = {
      nodes: [node('s', 'start'), node('a', 'template', { ref: 'wrapped', values: { title: '첫 호출', items: 'A\nB' } }), node('b', 'template', { ref: 'wrapped', values: { title: '두 번째', items: 'C' } }), node('work', 'codex')],
      edges: [wire('s', 'a'), wire('a', 'b'), wire('b', 'work'), wire('a', 'work', 'result'), wire('b', 'work', 'result')]
    }
    const env = { library: [fn(), wrapped] }
    expect(pipelineProblems(graph, env)).toEqual([])
    expect(expandPipeline(graph, env).nodes[0].text).toBe('첫 호출\n\n두 번째')
    wrapped.nodes.find((n) => n.id === 'inner')!.ref = 'wrapped'
    expect(pipelineProblems(graph, env).join('\n')).toContain('자기 자신을 다시')
  })

  it('[DM-F02-AC13] 함수의 셸 출력은 호출 뒤 실행되는 노드에 실제 결과로 전달된다', () => {
    const definition = fn({ nodes: [node('in', 'function-input', { params: [param('title')] }), node('sh', 'shell', { text: 'echo {{title}}' }), node('out', 'function-output', { params: [param('result')] })], edges: [wire('in', 'sh'), wire('sh', 'out'), { from: 'sh', to: 'out', pin: 'data', toPort: 'result' }] })
    const graph: Graph = { nodes: [node('s', 'start'), node('call', 'template', { ref: 'identity', values: { title: 'hello' } }), node('work', 'codex')], edges: [wire('s', 'call'), wire('call', 'work'), wire('call', 'work', 'result')] }
    const env = { library: [definition] }
    expect(pipelineProblems(graph, env)).toEqual([])
    const flat = expandPipeline(graph, env)
    expect(flat.nodes.map((n) => n.text)).toEqual(['echo hello', outputToken('call/sh')])
    expect(flat.edges).toEqual([wire('call/sh', 'work')])
    expect(fillOutputs(flat.nodes[1].text, (id) => id === 'call/sh' ? '실제 결과' : '')).toBe('실제 결과')
    graph.edges = [wire('s', 'call'), wire('s', 'work'), wire('call', 'work', 'result')]
    expect(pipelineProblems(graph, env).join('\n')).toContain('실행 선으로 먼저')
  })

  it('[DM-F02-AC13] 함수 앞뒤의 실행 순서를 빈 함수와 분기·합류에서도 유지한다', () => {
    const definition = fn()
    const graph: Graph = { nodes: [node('s', 'start'), node('before', 'shell', { text: 'echo before' }), node('call', 'template', { ref: definition.id }), node('after', 'shell', { text: 'echo after' })], edges: [wire('s', 'before'), wire('before', 'call'), wire('call', 'after')] }
    expect(expandPipeline(graph, { library: [definition] }).edges).toEqual([wire('before', 'after')])
    definition.nodes.push(node('a', 'shell', { text: 'echo a' }), node('b', 'shell', { text: 'echo b' }))
    definition.edges = [...definition.edges.filter((e) => e.pin === 'data'), wire('in', 'a'), wire('in', 'b'), wire('a', 'out'), wire('b', 'out')]
    const flat = expandPipeline(graph, { library: [definition] })
    expect(flat.edges).toEqual([wire('before', 'call/a'), wire('before', 'call/b'), wire('call/a', 'after'), wire('call/b', 'after')])
  })

  it('[DM-F02-AC13] 타입이 다른 연결·없는 변수·중복 연결·경계 노드 역방향 연결을 막는다', () => {
    const graph = caller()
    graph.nodes.push(node('text', 'text'), node('list', 'list'))
    const env = { library: [fn()] }
    expect(edgeProblem(graph, 'text', 'call', undefined, env, { toPort: 'items' })).toContain('List<String> 입력에 String')
    expect(edgeProblem(graph, 'list', 'call', undefined, env, { toPort: 'title' })).toContain('String 입력에 List<String>')
    expect(edgeProblem(graph, 'text', 'call', undefined, env, { toPort: 'missing' })).toContain('입력 변수를')
    expect(edgeProblem(graph, 'call', 'work', 'data', env, { fromPort: 'missing' })).toContain('출력 변수를')
    graph.edges.push(wire('text', 'call', undefined, 'title'))
    expect(edgeProblem(graph, 'call', 'call', 'data', env, { fromPort: 'result', toPort: 'title' })).toContain('자기 자신')
    expect(edgeProblem({ ...graph, nodes: [...graph.nodes, node('second', 'text')] }, 'second', 'call', undefined, env, { toPort: 'title' })).toContain('이미 연결된 입력')
    expect(edgeProblem(fn(), 'out', 'in')).toContain('함수의 끝')
    expect(edgeProblem(fn(), 'in', 'in')).toContain('자기 자신')
  })

  it('[DM-F02-AC13] 반환되지 않는 실행·미지정 출력·겹치는 변수 이름·함수 내부 실행 순환을 알려준다', () => {
    const definition = fn()
    definition.nodes[0].params![1].name = 'title'
    definition.edges = [wire('in', 'out')]
    expect(pipelineProblems(caller(), { library: [definition] }).join('\n')).toMatch(/겹칠 수 없습니다/)
    expect(pipelineProblems(caller(), { library: [definition] }).join('\n')).toContain('출력 변수 result에 값을 연결')
    definition.nodes[0].params![1].name = 'items'
    definition.nodes.push(node('a', 'shell', { text: 'echo a' }), node('b', 'shell', { text: 'echo b' }))
    definition.edges.push(wire('in', 'a'), wire('a', 'b'), wire('b', 'a'))
    expect(pipelineProblems(caller(), { library: [definition] }).join('\n')).toContain('고리를 이룹니다')
    expect(pipelineProblems(caller(), { library: [definition] }).join('\n')).toContain('Output으로 이어')
  })

  it('[DM-F02-AC13] 예전 템플릿의 시작·끝을 감싸고 직접 입력과 연결 데이터를 함께 보존한다', () => {
    const legacy: Pipeline = { id: 'legacy', title: '예전 템플릿', file: '', template: true, nodes: [node('s', 'start'), node('work', 'codex', { text: '검토: {{입력}}' })], edges: [wire('s', 'work')] }
    const body = withFunctionBoundary(legacy, legacy.id)
    expect(body.nodes.map((n) => n.kind)).toEqual(['function-input', 'codex', 'function-output'])
    expect(body.edges).toContainEqual(wire('work', 'legacy/output'))
    expect(withFunctionBoundary(body, legacy.id)).toBe(body)
    const graph: Graph = { nodes: [node('s', 'start'), node('t', 'text', { text: '연결 데이터' }), node('call', 'template', { ref: 'legacy', text: '직접 입력' })], edges: [wire('s', 'call'), wire('t', 'call')] }
    expect(pipelineProblems(graph, { library: [legacy] })).toEqual([])
    expect(expandPipeline(graph, { library: [legacy] }).nodes[0].text).toBe('검토: 직접 입력\n\n연결 데이터')
  })

  it('[IN-F12-AC5] 함수 변수·기본값·포트별 연결과 추출 인덱스를 저장하고 다시 읽는다', async () => {
    const ctx = await newProject()
    const definition = await savePipeline(ctx, fn())
    const graph = caller()
    const saved = await savePipeline(ctx, { id: 'caller', title: '호출', ...graph, edges: [...graph.edges, graph.edges[2]] })
    const read = await listPipelines(ctx)
    expect(read.find((p) => p.id === definition.id)?.nodes).toMatchObject(fn().nodes)
    expect(read.find((p) => p.id === saved.id)?.edges).toEqual(graph.edges)
    expect(saved.nodes.find((n) => n.id === 'item')?.index).toBe(1)
    expect(saved.nodes.find((n) => n.id === 'call')?.values).toEqual({ title: '제목', items: '하나\n둘' })
    expect(expandPipeline(saved, { library: read }).nodes[0].text).toContain('하나 / 둘')
  })
})
