import { describe, expect, it, vi } from 'vitest'
import { AGENT_PORT as A, IF_PORT as I, LOOP_PORT as L, PipelineRunner, edgeProblem, expandPipeline, pipelineProblems, type Env, type Graph, type PipeNode, type Pipeline } from '../src/core/pipeline'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '', terminal: 'new', ...extra })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
async function start(graph: Graph, env: Env = {}) {
  expect(pipelineProblems(graph, env)).toEqual([])
  let response: string | undefined
  const create = vi.fn(async (kind: 'shell' | 'codex' | 'claude', title: string) => ({ id: title, kind, title, pid: 1 }))
  const submit = vi.fn(), command = vi.fn()
  const runner = new PipelineRunner({ createTerminal: create, hasTerminal: () => true, getTerminal: () => undefined, whenReady: async () => {},
    submit, runCommand: command, completeTasks: async () => {}, emit: () => {}, readAgentOutput: () => response })
  runner.start({ id: 'g', title: 'Print', file: '', ...expandPipeline(graph, env) })
  await flush()
  return { runner, create, submit, command, state: () => runner.list()[0], respond: (value: string) => { response = value } }
}

describe('Print 실행과 출력 기록', () => {
  it.each(['', '  앞\n\n뒤  ', '<img src=x onerror=alert(1)>'])('[DM-F02-AC17] %j를 그대로 출력하고 터미널 없이 다음 Print를 실행한다', async (text) => {
    const h = await start({ nodes: [node('s', 'start'), node('p', 'print', { text }), node('next', 'print', { text: '끝' })], edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'next' }] })
    expect(h.state()).toMatchObject({ status: 'done', nodes: { p: { kind: 'print', output: text, outputOrder: 1, status: 'done' }, next: { output: '끝', outputOrder: 2 } } })
    expect(h.state().nodes.p.outputAt).toMatch(/^\d{4}-/)
    expect(h.create).not.toHaveBeenCalled()
  })

  it.each([
    [node('v', 'boolean', { text: 'false' }), 'false'], [node('v', 'number', { text: '0' }), '0'],
    [node('v', 'list', { items: ['첫째', '둘째'] }), '첫째\n\n둘째'],
    [node('v', 'dictionary', { text: '{"value":null}' }), '{\n  "value": null\n}']
  ] as const)('연결한 %j 값을 출력하고 저장 후에도 Print를 읽는다', async (value, expected) => {
    const g: Pipeline = { id: 'g', title: 'Print', file: '', nodes: [node('s', 'start'), value, node('p', 'print', { text: '이전 기본값' })], edges: [{ from: 's', to: 'p' }, { from: 'v', to: 'p' }] }
    const ctx = await newProject()
    await savePipeline(ctx, g)
    const h = await start((await listPipelines(ctx))[0])
    expect(h.state().nodes.p.output).toBe(expected)
    expect(h.create).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude', 'shell'] as const)('%s 응답을 받은 다음 Print하고 출력 순서를 기록한다', async (kind) => {
    const h = await start({ nodes: [node('s', 'start'), node('ai', kind, { text: '처리' }), node('p', 'print')], edges: [
      { from: 's', to: 'ai' }, { from: 'ai', to: 'p' }, { from: 'ai', to: 'p', pin: 'data', ...(kind !== 'shell' ? { fromPort: A.output } : {}) }
    ] })
    expect(h.state().nodes.p.status).toBe('waiting')
    const output = '중간 응답\n두 번째 줄'
    h.respond(output)
    if (kind === 'shell') h.runner.commandDone(h.state().nodes.ai.termId!, 0, output)
    else h.runner.agentDone(h.state().nodes.ai.termId!)
    await flush()
    expect(h.state()).toMatchObject({ status: 'done', nodes: { ai: { output, outputOrder: 1 }, p: { output, outputOrder: 2 } } })
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('병렬 작업은 완료 순서대로 출력하고 실패 뒤 Print는 건너뛴다', async () => {
    const h = await start({ nodes: [node('s', 'start'), node('a', 'shell', { text: 'a' }), node('b', 'shell', { text: 'b' }), node('p', 'print')],
      edges: [{ from: 's', to: 'a' }, { from: 's', to: 'b' }, { from: 'a', to: 'p' }, { from: 'b', to: 'p' }] })
    h.runner.commandDone(h.state().nodes.b.termId!, 0, '먼저')
    h.runner.commandDone(h.state().nodes.a.termId!, 1, '실패 내용')
    await flush()
    expect(h.state()).toMatchObject({ status: 'failed', nodes: { b: { outputOrder: 1 }, a: { outputOrder: 2, output: '실패 내용' }, p: { status: 'skipped' } } })
    expect(h.state().nodes.p.output).toBeUndefined()
  })

  it('For Each 안의 함수에서 Print한 값은 항목별로 기록하고 선택하지 않은 분기는 출력하지 않는다', async () => {
    const fn: Pipeline = { id: 'fn', title: '출력 함수', template: true, file: '', nodes: [
      node('in', 'function-input', { params: [{ id: 'value', name: '값', type: 'single' }] }), node('p', 'print'), node('out', 'function-output', { params: [] })
    ], edges: [{ from: 'in', to: 'p' }, { from: 'p', to: 'out' }, { from: 'in', to: 'p', fromPort: 'value', pin: 'data' }] }
    const h = await start({ nodes: [node('s', 'start'), node('loop', 'foreach', { values: { [L.list]: '하나\n둘' } }), node('call', 'template', { ref: 'fn' }),
      node('if', 'if', { values: { [I.condition]: 'false' } }), node('yes', 'print', { text: '선택 안 함' }), node('no', 'print', { text: '마침' })], edges: [
      { from: 's', to: 'loop' }, { from: 'loop', to: 'call', fromPort: L.body }, { from: 'loop', to: 'call', pin: 'data', fromPort: L.item, toPort: 'value' },
      { from: 'loop', to: 'if', fromPort: L.done }, { from: 'if', to: 'yes', fromPort: I.yes }, { from: 'if', to: 'no', fromPort: I.no }
    ] }, { library: [fn] })
    expect(h.state().status).toBe('done')
    const printed = Object.values(h.state().nodes).filter((n) => n.output !== undefined).sort((a, b) => a.outputOrder! - b.outputOrder!)
    expect(printed.map((n) => n.output)).toEqual(['하나', '둘', '마침'])
    expect(printed[0].sourceIds).toContain('call')
    expect(h.state().nodes.yes.output).toBeUndefined()
    expect(h.create).not.toHaveBeenCalled()
  })

  it('Print 데이터 입력은 하나이며 터미널·출력 구조는 받지 않는다', () => {
    const g: Graph = { nodes: [node('p', 'print'), node('a', 'text'), node('b', 'text'), node('t', 'terminal'), node('s', 'schema')], edges: [{ from: 'a', to: 'p' }] }
    expect(edgeProblem(g, 'b', 'p')).toContain('하나만')
    for (const id of ['t', 's']) expect(edgeProblem(g, id, 'p')).toContain('Print에는')
  })
})
