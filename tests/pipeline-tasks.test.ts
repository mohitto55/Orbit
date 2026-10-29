import { describe, expect, it } from 'vitest'
import {
  completeTargets, dataShape, edgeProblem, expandPipeline, pipelineProblems, taskText, withInputPort,
  type FunctionParam, type PipeEdge, type PipeNode, type Pipeline
} from '../src/core/pipeline'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
const param = (id: string, type: FunctionParam['type'] = 'task'): FunctionParam => ({ id, name: id, type })
const wire = (from: string, to: string, fromPort?: string, toPort?: string): PipeEdge => ({ from, to, ...(fromPort ? { pin: 'data', fromPort } : {}), ...(toPort ? { toPort } : {}) })
const tasks = [
  { id: 'task-1', title: '로그인 수정', body: '## 내용\n세션을 유지한다.', status: '진행' },
  { id: 'task-2', title: '다른 할 일', body: '다른 내용', status: '대기' }
]
const fn = (): Pipeline => ({ id: 'fn', title: 'Task 처리', file: '', template: true, nodes: [
  node('in', 'function-input', { params: [param('job')] }), node('work', 'codex', { text: '검토' }),
  node('out', 'function-output', { params: [param('result')] })
], edges: [wire('in', 'work'), wire('work', 'out'), wire('in', 'work', 'job'), wire('in', 'out', 'job', 'result')] })
const caller = (): Pipeline => ({ id: 'caller', title: '할 일 전달', file: '', nodes: [
  node('start', 'start'), node('task', 'task', { ref: 'task-1' }), node('call', 'template', { ref: 'fn' }),
  node('after', 'claude', { text: '다시 검토' }), node('done', 'complete')
], edges: [wire('start', 'call'), wire('call', 'after'), wire('after', 'done'), wire('task', 'call', undefined, 'job'), wire('call', 'after', 'result'), wire('call', 'done', 'result')] })

describe('함수의 Task 입력·출력', () => {
  it('[DM-F02-AC24] 중첩 함수에서 할 일 참조를 반환하고 프롬프트와 완료 대상에 같은 할 일을 사용한다', () => {
    const inner = fn(), outer = fn(), graph = caller()
    outer.id = 'outer'
    outer.nodes[1] = node('nested', 'template', { ref: 'fn' })
    outer.edges = [wire('in', 'nested'), wire('nested', 'out'), wire('in', 'nested', 'job', 'job'), wire('nested', 'out', 'result', 'result')]
    outer.nodes[0].params![0].name = '처리할 할 일'
    graph.nodes.find((n) => n.id === 'call')!.ref = outer.id
    const env = { tasks, library: [inner, outer] }
    expect(pipelineProblems(graph, env)).toEqual([])
    expect(expandPipeline(graph, env).nodes).toMatchObject([
      { id: 'call/nested/work', text: `검토\n\n${taskText(tasks[0])}` },
      { id: 'after', text: `다시 검토\n\n${taskText(tasks[0])}` }, { id: 'done', text: 'task-1' }
    ])
    expect(completeTargets(graph, 'done', env)).toEqual(['task-1'])
    const changed = { ...env, tasks: [{ ...tasks[0], body: '수정한 최신 내용' }, tasks[1]] }
    expect(expandPipeline(graph, changed).nodes[0].text).toContain('수정한 최신 내용')
  })

  it('[DM-F02-AC24] 기본값으로 선택한 할 일보다 연결한 Task를 우선하고 호출별 값을 분리한다', () => {
    const graph = caller(), env = { tasks, library: [fn()] }
    graph.nodes.find((n) => n.id === 'call')!.values = { job: 'task-2' }
    expect(expandPipeline(graph, env).nodes.find((n) => n.id === 'done')!.text).toBe('task-1')
    graph.edges = graph.edges.filter((e) => e.from !== 'task')
    graph.nodes.push(node('second', 'template', { ref: 'fn', values: { job: 'task-1' } }))
    graph.edges.push(wire('start', 'second'))
    const flat = expandPipeline(graph, env)
    expect(flat.nodes.find((n) => n.id === 'call/work')!.text).toContain(tasks[1].title)
    expect(flat.nodes.find((n) => n.id === 'second/work')!.text).toContain(tasks[0].title)
    expect(flat.nodes.find((n) => n.id === 'done')!.text).toBe('task-2')
  })

  it('[DM-F02-AC24] Task 입력은 텍스트와 구분하고 노드에 놓으면 Task 포트를 우선 선택한다', () => {
    const definition = fn(), graph = caller(), env = { tasks, library: [definition] }
    definition.nodes[0].params!.unshift(param('text', 'single'))
    graph.nodes.push(node('text', 'text', { text: 'task-1' }))
    graph.edges = graph.edges.filter((e) => e.from !== 'task')
    expect(dataShape({ kind: 'task' })).toBe('task')
    expect(withInputPort(graph, wire('task', 'call'), env).toPort).toBe('job')
    expect(edgeProblem(graph, 'text', 'call', undefined, env, { toPort: 'job' })).toContain('Task 입력')
    expect(edgeProblem(graph, 'text', 'done', undefined, env)).toContain('Task 타입')
    // 기존 텍스트 입력에 할 일 내용을 붙이던 연결도 그대로 사용한다.
    expect(edgeProblem(graph, 'task', 'call', undefined, env, { toPort: 'text' })).toBeNull()
    expect(edgeProblem(graph, 'task', 'after', undefined, env)).toBeNull()
  })

  it('[DM-F02-AC24] 비어 있거나 삭제된 기본값과 중복 Task 입력을 실행 전에 알린다', () => {
    const graph = caller(), env = { tasks, library: [fn()] }
    graph.edges = graph.edges.filter((e) => e.from !== 'task')
    expect(pipelineProblems(graph, env).join('\n')).toContain('할 일을 연결하거나 고르세요')
    graph.nodes.find((n) => n.id === 'call')!.values = { job: 'task-deleted' }
    expect(pipelineProblems(graph, env).join('\n')).toContain('할 일을 찾을 수 없습니다 (task-deleted)')
    graph.nodes.push(node('other', 'task', { ref: 'task-2' }))
    graph.edges.push(wire('task', 'call', undefined, 'job'), wire('other', 'call', undefined, 'job'))
    expect(pipelineProblems(graph, env).join('\n')).toContain('이미 연결된 입력')
  })

  it('[DM-F02-AC24] Task 변수·기본값·연결을 저장하고 다시 열어도 같은 할 일을 전달한다', async () => {
    const ctx = await newProject(), graph = caller()
    graph.nodes.find((n) => n.id === 'call')!.values = { job: 'task-2' }
    await savePipeline(ctx, fn()); await savePipeline(ctx, graph)
    const library = await listPipelines(ctx), restored = library.find((p) => p.id === graph.id)!
    expect(library.find((p) => p.id === 'fn')!.nodes[0].params).toEqual([param('job')])
    expect(restored.nodes.find((n) => n.id === 'call')!.values).toEqual({ job: 'task-2' })
    expect(restored.edges).toEqual(graph.edges)
    expect(expandPipeline(restored, { tasks, library }).nodes.find((n) => n.id === 'done')!.text).toBe('task-1')
  })
})
