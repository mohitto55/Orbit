import { describe, expect, it, vi } from 'vitest'
import {
  LOOP_PORT as P, PipelineRunner, expandPipeline, pipelineProblems, withFunctionBoundary, withInputPort,
  type Graph, type PipeEdge, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import { savePipeline, listPipelines } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
const exec = (from: string, to: string, fromPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { fromPort } : {}) })
const data = (from: string, to: string, fromPort?: string, toPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { pin: 'data', fromPort } : {}), ...(toPort ? { toPort } : {}) })
function graph(items = ['첫째', '둘째']): Pipeline {
  return { id: 'loop-test', title: '반복', file: '', nodes: [node('s', 'start'), node('list', 'list', { items }), node('loop', 'foreach'), node('work', 'shell', { text: '처리' }), node('after', 'shell', { text: '완료' })],
    edges: [exec('s', 'loop'), data('list', 'loop', undefined, P.list), exec('loop', 'work', P.body), data('loop', 'work', P.item), exec('loop', 'after', P.done)] }
}

describe('For Each 유틸리티', () => {
  it('[DM-F02-AC14] 항목·인덱스를 각각 바인딩하고 본문은 순서대로, 완료 경로는 한 번 실행한다', () => {
    const g = graph()
    g.edges.push(data('loop', 'work', P.index))
    expect(pipelineProblems(g)).toEqual([])
    const flat = expandPipeline(g)
    expect(flat.nodes.find((n) => n.id === 'loop/0/work')?.text).toBe('처리\n\n첫째\n\n0')
    expect(flat.nodes.find((n) => n.id === 'loop/1/work')?.text).toBe('처리\n\n둘째\n\n1')
    expect(flat.nodes.find((n) => n.id === 'loop/1/work')?.sourceIds).toEqual(['work', 'loop'])
    expect(flat.nodes.filter((n) => n.id === 'after')).toHaveLength(1)
    expect(flat.edges).toEqual([exec('loop/0/work', 'loop/1/work'), exec('loop/1/work', 'after')])
  })

  it('[DM-F02-AC14] 빈 리스트는 본문을 실행하지 않고 완료 경로로 넘어간다', () => {
    expect(pipelineProblems(graph([]))).toEqual([])
    expect(expandPipeline(graph([]))).toMatchObject({ nodes: [{ id: 'after', text: '완료' }], edges: [] })
    const g = graph([])
    g.nodes.push(node('before', 'shell', { text: '준비' }))
    g.edges = [...g.edges.filter((e) => e.from !== 's'), exec('s', 'before'), exec('before', 'loop')]
    expect(expandPipeline(g).edges).toEqual([exec('before', 'after')])
  })

  it('[DM-F02-AC14] 본문의 병렬 갈래가 모두 끝나야 다음 항목을 시작한다', () => {
    const g = graph()
    g.nodes.push(node('parallel', 'shell', { text: '다른 작업' }))
    g.edges.push(exec('loop', 'parallel', P.body))
    const flat = expandPipeline(g)
    for (const from of ['work', 'parallel']) for (const to of ['work', 'parallel']) expect(flat.edges).toContainEqual(exec(`loop/0/${from}`, `loop/1/${to}`))
    expect(flat.edges).toContainEqual(exec('loop/1/work', 'after'))
    expect(flat.edges).toContainEqual(exec('loop/1/parallel', 'after'))
  })

  it('[DM-F02-AC14] 중첩 반복은 바깥 항목별로 안쪽 반복을 끝내며 항목을 섞지 않는다', () => {
    const g = graph(['A', 'B'])
    g.nodes.push(node('inner', 'foreach', { values: { [P.list]: 'X\nY' } }))
    g.edges = g.edges.filter((e) => !(e.from === 'loop' && e.to === 'work' && !e.pin))
    g.edges.push(exec('loop', 'inner', P.body), exec('inner', 'work', P.body), data('inner', 'work', P.item))
    expect(pipelineProblems(g)).toEqual([])
    const flat = expandPipeline(g)
    expect(flat.nodes.filter((n) => n.id !== 'after').map((n) => n.text)).toEqual(['처리\n\nA\n\nX', '처리\n\nA\n\nY', '처리\n\nB\n\nX', '처리\n\nB\n\nY'])
    expect(flat.edges).toHaveLength(4)
  })

  it('[DM-F02-AC14] 함수의 리스트 인자를 반복하고 본문에서도 다른 함수를 호출할 수 있다', () => {
    const echo: Pipeline = { id: 'echo', title: '항목 처리', file: '', template: true, nodes: [node('in', 'function-input', { params: [{ id: 'arg', name: '값', type: 'single' }] }), node('sh', 'shell', { text: 'echo {{값}}' }), node('out', 'function-output', { params: [] })], edges: [exec('in', 'sh'), exec('sh', 'out')] }
    const each: Pipeline = { ...graph(), id: 'each', title: '목록 처리', template: true }
    each.nodes = [node('in', 'function-input', { params: [{ id: 'items', name: '목록', type: 'list' }] }), node('loop', 'foreach'), node('call', 'template', { ref: 'echo' }), node('out', 'function-output', { params: [] })]
    each.edges = [exec('in', 'loop'), data('in', 'loop', 'items', P.list), exec('loop', 'call', P.body), data('loop', 'call', P.item, 'arg'), exec('loop', 'out', P.done)]
    const caller: Graph = { nodes: [node('s', 'start'), node('run', 'template', { ref: 'each', values: { items: 'one\ntwo' } }), node('after', 'shell', { text: 'done' })], edges: [exec('s', 'run'), exec('run', 'after')] }
    const env = { library: [each, echo] }
    expect(pipelineProblems(caller, env)).toEqual([])
    const flat = expandPipeline(caller, env)
    expect(flat.nodes.filter((n) => n.id !== 'after').map((n) => n.text)).toEqual(['echo one', 'echo two'])
    expect(flat.nodes.filter((n) => n.id !== 'after').every((n) => n.sourceIds?.includes('run'))).toBe(true)
    expect(flat.edges).toHaveLength(2)
  })

  it('[DM-F02-AC14] 함수가 반환한 리스트의 항목 경계를 보존해 반복한다', () => {
    const fn: Pipeline = { id: 'f', title: '목록 반환', file: '', template: true, nodes: [
      node('in', 'function-input', { params: [{ id: 'arg', name: '목록', type: 'list' }] }),
      node('out', 'function-output', { params: [{ id: 'result', name: '결과', type: 'list' }] })
    ], edges: [exec('in', 'out'), data('in', 'out', 'arg', 'result')] }
    const g = graph(['여러\n줄', '마지막'])
    g.nodes.push(node('call', 'template', { ref: 'f' }))
    g.edges = g.edges.filter((e) => e.to !== 'loop')
    g.edges.push(exec('s', 'call'), data('list', 'call', undefined, 'arg'), exec('call', 'loop'), data('call', 'loop', 'result', P.list))
    const env = { library: [fn] }
    expect(pipelineProblems(g, env)).toEqual([])
    expect(expandPipeline(g, env).nodes.filter((n) => n.id !== 'after').map((n) => n.text)).toEqual(['처리\n\n여러\n줄', '처리\n\n마지막'])
  })

  it('[DM-F02-AC14] 빈 안쪽 반복도 다음 바깥 항목과 마지막 완료로 이어진다', () => {
    const g = graph()
    g.nodes.push(node('inner', 'foreach', { values: { [P.list]: '' } }), node('tail', 'shell', { text: '항목 끝' }))
    g.edges = g.edges.filter((e) => !(e.from === 'loop' && e.to === 'work' && !e.pin))
    g.edges.push(exec('loop', 'inner', P.body), exec('inner', 'work', P.body), exec('inner', 'tail', P.done), data('loop', 'tail', P.item))
    expect(pipelineProblems(g)).toEqual([])
    const flat = expandPipeline(g)
    expect(flat.nodes.filter((n) => n.id !== 'after').map((n) => n.text)).toEqual(['항목 끝\n\n첫째', '항목 끝\n\n둘째'])
    expect(flat.edges).toEqual(expect.arrayContaining([exec('loop/0/tail', 'loop/1/tail'), exec('loop/1/tail', 'after')]))
  })

  it('[DM-F02-AC14] 현재 항목에 의존하는 합치기·리스트 데이터도 반복마다 새로 계산한다', () => {
    const g = graph()
    g.nodes.push(node('list-item', 'list'), node('join', 'join', { text: ' + ' }))
    g.edges = g.edges.filter((e) => !(e.from === 'loop' && e.pin === 'data'))
    g.edges.push(data('loop', 'list-item', P.item), data('loop', 'list-item', P.index), data('list-item', 'join'), data('join', 'work'))
    expect(expandPipeline(g).nodes.filter((n) => n.id !== 'after').map((n) => n.text)).toEqual(['처리\n\n첫째 + 0', '처리\n\n둘째 + 1'])
  })

  it('[DM-F02-AC14] 반복 그래프를 함수로 바꿀 때 본문 대신 완료 경로를 Output에 잇는다', () => {
    const g = graph()
    g.nodes = g.nodes.filter((n) => n.id !== 'after')
    g.edges = g.edges.filter((e) => e.to !== 'after')
    const converted = withFunctionBoundary(g)
    expect(converted.edges).toContainEqual(exec('loop', 'function/output', P.done))
    expect(converted.edges).not.toContainEqual(exec('work', 'function/output'))
    expect(pipelineProblems(converted)).toEqual([])
    expect(expandPipeline(converted).nodes.map((n) => n.text)).toEqual(['처리\n\n첫째', '처리\n\n둘째'])
  })

  it('[DM-F02-AC14] 반복 안에서 셸 결과를 쓰면 같은 반복의 결과를 참조한다', () => {
    const g = graph()
    g.nodes.push(node('use', 'shell'))
    g.edges.push(exec('work', 'use'), { from: 'work', to: 'use', pin: 'data' })
    expect(pipelineProblems(g)).toEqual([])
    const flat = expandPipeline(g)
    expect(flat.nodes.find((n) => n.id === 'loop/0/use')?.text).toBe('\u0000출력:loop/0/work\u0000')
    expect(flat.nodes.find((n) => n.id === 'loop/1/use')?.text).toBe('\u0000출력:loop/1/work\u0000')
  })

  it('[DM-F02-AC14] 본문·완료 경로의 겹침과 본문 밖의 항목 사용은 실행 전에 막는다', () => {
    const overlap = graph()
    overlap.edges.push(exec('work', 'after'))
    expect(pipelineProblems(overlap).join('\n')).toContain('반복 본문과 완료 경로')
    const leak = graph()
    leak.edges.push(data('loop', 'after', P.item))
    expect(pipelineProblems(leak).join('\n')).toContain('본문 안에서만')
    const wrongType = graph()
    wrongType.nodes.find((n) => n.id === 'list')!.kind = 'text'
    expect(pipelineProblems(wrongType).join('\n')).toContain('List<String> 입력에 String')
  })

  it('[IN-F12-AC5] For Each의 본문·완료·항목·인덱스 포트를 저장하고 다시 읽는다', async () => {
    const ctx = await newProject()
    const g = graph()
    g.edges.push(data('loop', 'work', P.index))
    await savePipeline(ctx, g)
    const read = (await listPipelines(ctx))[0]
    expect(read.edges).toEqual(g.edges)
    expect(expandPipeline(read).nodes.find((n) => n.id === 'loop/1/work')?.text).toContain('둘째\n\n1')
  })

  it('[DM-F02-AC13] 함수의 첫 입력이 텍스트여도 뒤의 리스트 입력을 찾고 명시한 핀은 보존한다', () => {
    const definition: Pipeline = { id: 'f', title: '함수', file: '', template: true, nodes: [node('in', 'function-input', { params: [{ id: 'name', name: '이름', type: 'single' }, { id: 'items', name: '목록', type: 'list' }] }), node('out', 'function-output', { params: [] })], edges: [exec('in', 'out')] }
    const g: Graph = { nodes: [node('list', 'list'), node('call', 'template', { ref: 'f' })], edges: [] }
    expect(withInputPort(g, data('list', 'call'), { library: [definition] })).toEqual(data('list', 'call', undefined, 'items'))
    expect(withInputPort(g, data('list', 'call', undefined, 'name'), { library: [definition] }).toPort).toBe('name')
  })

  it('[DM-F02-AC14] 실행기는 항목 완료 후 다음을 보내고 실패하면 나머지 반복·완료 경로를 건너뛴다', async () => {
    const sent: string[] = []
    let count = 0
    const runner = new PipelineRunner({ createTerminal: async (kind) => ({ id: `t${++count}`, kind, title: '', pid: 1 }), hasTerminal: () => true, getTerminal: () => undefined, whenReady: async () => {}, submit: () => {}, runCommand: (_id, text) => { sent.push(text) }, completeTasks: async () => {}, emit: () => {} })
    const g = graph()
    runner.start({ ...g, ...expandPipeline(g) })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual(['처리\n\n첫째'])
    runner.commandDone('t1', 0, '')
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toBe('처리\n\n둘째')
    runner.commandDone('t2', 1)
    expect(runner.list()[0].nodes.after.status).toBe('skipped')
    expect(runner.list()[0].status).toBe('failed')
    const empty = graph([])
    empty.nodes = empty.nodes.filter((n) => n.id !== 'after')
    empty.edges = empty.edges.filter((e) => e.to !== 'after')
    expect(runner.start({ ...empty, ...expandPipeline(empty) }, true).status).toBe('done')
    expect(sent).toHaveLength(2)
  })
})
