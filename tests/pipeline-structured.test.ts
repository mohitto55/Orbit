import { describe, expect, it, vi } from 'vitest'
import { AGENT_PORT as P, PipelineRunner, agentSchema, dataValue, edgeProblem, expandPipeline, fillOutputs, innerValues, outputRefs, pipelineProblems, withInputPort, type Graph, type PipeNode, type Pipeline, type RunnerDeps } from '../src/core/pipeline'
import { fromPointer, parseJson, readOutputSchema, schemaFromFields, toPointer, validateOutput, type OutputField } from '../src/core/structuredData'
import { listPipelines, savePipeline } from '../src/core/pipelineStore'
import { newProject } from './helpers'

const fields: OutputField[] = [{ name: 'people', type: 'string', description: '이름을 쉼표로 구분하고 없으면 빈 문자열을 쓰세요' }, { name: 'detail', type: 'object', description: '이름과 점수를 포함하세요' }]
const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
function graph(kind: 'claude' | 'codex' = 'codex'): Pipeline {
  return { id: 'g', title: '구조화 출력', file: '', nodes: [
    node('start', 'start'), node('prompt', 'text', { text: '참여자를 정리하세요' }), node('schema', 'schema', { fields }),
    node('agent', kind), node('dict', 'dictionary'), node('detail', 'property', { pointer: '/detail' }),
    node('name', 'property', { pointer: '/name' }), node('next', kind, { text: '다음 사람을 검토하세요' })
  ], edges: [
    { from: 'start', to: 'agent' }, { from: 'agent', to: 'next' }, { from: 'prompt', to: 'agent' },
    { from: 'schema', to: 'agent', toPort: P.schema }, { from: 'agent', to: 'dict', pin: 'data', fromPort: P.output },
    { from: 'dict', to: 'detail' }, { from: 'detail', to: 'name' }, { from: 'name', to: 'next' }
  ] }
}
const result = { people: '민수', detail: { name: '민수', score: 0, approved: false, nickname: '', tags: ['한글', { name: '안녕' }] } }

describe('구조화 출력 계약과 Dictionary', () => {
  const nested: OutputField[] = [{ name: 'items', type: 'array', description: '검토 결과', items: {
    type: 'object', description: '항목', fields: [
      { name: 'value', type: 'string', description: '결과' },
      { name: 'scores', type: 'array', description: '', items: { type: 'array', description: '', items: { type: 'number', description: '점수' } } },
      { name: 'active', type: 'boolean', description: '' }, { name: 'empty', type: 'null', description: '' }
    ]
  } }]
  const item = { value: '', scores: [[0, 1]], active: false, empty: null }

  it('[DM-F02-AC18] Array의 Items·Object Properties·중첩 Array 계약을 저장하고 응답의 모든 항목을 검증한다', async () => {
    const schema = schemaFromFields(nested), text = JSON.stringify(schema)
    expect(readOutputSchema(text)).toEqual(schema)
    expect(validateOutput(JSON.stringify({ items: [item, item] }), text)).toEqual({ items: [item, item] })
    expect(validateOutput('{"items":[]}', text)).toEqual({ items: [] })
    const ctx = await newProject(), g = graph()
    g.nodes.find((n) => n.id === 'schema')!.fields = nested
    await savePipeline(ctx, g)
    const stored = (await listPipelines(ctx))[0]
    expect(stored.nodes.find((n) => n.id === 'schema')?.fields).toEqual(nested)
    expect(JSON.parse(agentSchema(stored, 'agent')!)).toEqual(schema)
  })

  it.each([
    [{ ...item, value: 1 }, 'items[1].value'], [{ ...item, scores: [[0, '1']] }, 'items[1].scores[0][1]'],
    [{ ...item, active: 'false' }, 'items[1].active'], [{ ...item, empty: '' }, 'items[1].empty'],
    [{ ...item, extra: true }, 'items[1].extra'], [{ scores: [], active: false, empty: null }, 'items[1].value']
  ])('중첩 응답 %j의 잘못된 항목 경로 %s를 알린다', (bad, path) => {
    expect(() => validateOutput(JSON.stringify({ items: [item, bad] }), JSON.stringify(schemaFromFields(nested)))).toThrow(path)
  })

  it('직접 연결한 계약도 중첩 필수 필드 오류를 거부하고 기존 unconstrained Object·Array를 보존한다', () => {
    const malformed = schemaFromFields(nested)
    malformed.properties.items.items!.required = ['missing']
    expect(() => readOutputSchema(JSON.stringify(malformed))).toThrow('output.items[]')
    const old = JSON.stringify(schemaFromFields([{ name: 'items', type: 'array', description: '' }, { name: 'value', type: 'object', description: '' }]))
    expect(validateOutput('{"items":[0,false,null,"",{}],"value":{"custom":[]}}', old)).toEqual({ items: [0, false, null, '', {}], value: { custom: [] } })
    const empty = JSON.stringify(schemaFromFields([{ name: 'value', type: 'object', description: '', fields: [] }]))
    expect(validateOutput('{"value":{}}', empty)).toEqual({ value: {} })
    expect(validateOutput('{"value":{"content":1}}', empty)).toEqual({ value: { content: 1 } })
  })

  it('[DM-F02-AC18] 필드 없는 Array<Object>는 작업 내용을 허용하고 v0.3.29의 빈 Properties도 복구한다', () => {
    const schema = schemaFromFields([{ name: 'works', type: 'array', description: '클라이언트가 하는 일들 나열하기', items: { type: 'object', description: '', fields: [] } }])
    expect(schema.properties.works.items).toEqual({ type: 'object', description: '' })
    const response = { works: [{ title: '채팅방 목록 페이지네이션', details: ['추가 로딩', '재시도 UI'], active: true }] }
    expect(validateOutput(JSON.stringify(response), JSON.stringify(schema))).toEqual(response)
    const old = { ...schema, properties: { works: { ...schema.properties.works, items: { type: 'object', description: '', properties: {}, required: [], additionalProperties: false } } } }
    expect(readOutputSchema(JSON.stringify(old))).toEqual(schema)
    expect(validateOutput(JSON.stringify(response), JSON.stringify(old))).toEqual(response)
    expect(() => validateOutput('{"works":["문자열"]}', JSON.stringify(schema))).toThrow('works[0]')
    expect(() => validateOutput('{"works":[null]}', JSON.stringify(schema))).toThrow('works[0]')
    expect(() => validateOutput('{"works":[],"extra":1}', JSON.stringify(schema))).toThrow('extra')
  })

  it('필드 작성 규칙을 계약에 담고 키·타입·추가 필드와 JSON 형식을 검사한다', () => {
    const schema = JSON.stringify(schemaFromFields(fields))
    expect(schema).toContain(fields[0].description)
    expect(validateOutput('```json\n' + JSON.stringify(result) + '\n```', schema)).toEqual(result)
    expect(() => validateOutput('{"people":null,"detail":{}}', schema)).toThrow('String')
    expect(() => validateOutput('{"detail":{}}', schema)).toThrow('people')
    expect(() => validateOutput(JSON.stringify({ ...result, extra: true }), schema)).toThrow('extra')
    expect(() => validateOutput('설명\n' + JSON.stringify(result), schema)).toThrow('JSON')
    expect(() => validateOutput('[]', schema)).toThrow('Dictionary')
    expect(() => parseJson('{"n":1e999}')).toThrow('JSON')
    expect(() => schemaFromFields([...fields, fields[0]])).toThrow('겹칠')
    expect(() => schemaFromFields([{ name: '', type: 'string', description: '' }])).toThrow('이름')
  })

  it('중첩 값·배열·특수 키·빈 문자열·false·0·null을 손실 없이 선택하고 원본 변경을 반영한다', () => {
    const value = { 'a/b~.': { '': [false, 0, '', null, { name: '처음' }] }, constructor: '값' }
    const pointer = toPointer(['a/b~.', '', '4', 'name'])
    expect(fromPointer(pointer)).toEqual(['a/b~.', '', '4', 'name'])
    const g: Graph = { nodes: [node('d', 'dictionary', { text: JSON.stringify(value) }), node('p', 'property', { pointer })], edges: [{ from: 'd', to: 'p' }] }
    expect(dataValue(g, 'p')).toBe('"처음"')
    g.nodes[0].text = JSON.stringify({ 'a/b~.': { '': [false, 0, '', null, { name: '바뀜' }] } })
    expect(dataValue(g, 'p')).toBe('"바뀜"')
    for (const [i, expected] of ['false', '0', '""', 'null'].entries()) {
      g.nodes[1].pointer = toPointer(['a/b~.', '', String(i)])
      expect(dataValue(g, 'p')).toBe(expected)
    }
    g.nodes[1].pointer = '/missing'
    expect(() => dataValue(g, 'p')).toThrow('missing')
    g.nodes[1].pointer = '/__proto__'
    expect(() => dataValue(g, 'p')).toThrow('__proto__')
    g.edges.push({ from: 'p', to: 'd' })
    expect(() => dataValue(g, 'p')).toThrow('고리')
  })

  it('출력 구조를 별도 핀으로 연결하고 실행 전부터 계약의 필드를 꺼낼 수 있다', () => {
    const g = graph()
    expect(withInputPort(g, { from: 'schema', to: 'agent' }, {})).toEqual({ from: 'schema', to: 'agent', toPort: P.schema })
    expect(edgeProblem(g, 'prompt', 'agent', undefined, {}, { toPort: P.schema })).toContain('출력 구조')
    expect(edgeProblem(g, 'schema', 'agent', undefined, {}, { toPort: P.prompt })).toContain('출력 구조')
    expect(pipelineProblems(g)).toEqual([])
    expect(innerValues(g.nodes.find((n) => n.id === 'dict')!, {}, g)).toEqual([
      { kind: 'property', pointer: '/people', label: 'people' }, { kind: 'property', pointer: '/detail', label: 'detail' }
    ])
    const flat = expandPipeline(g)
    expect(flat.nodes[0].text).toBe('참여자를 정리하세요')
    expect(flat.nodes[0].outputSchema).toBe(agentSchema(g, 'agent'))
    expect(outputRefs(flat.nodes[1].text)).toEqual(['agent'])
    expect(fillOutputs(flat.nodes[1].text, () => JSON.stringify(result))).toContain('"민수"')
    expect(fillOutputs(flat.nodes[1].text, () => '[응답]', true)).toContain('["detail"]["name"]')
    const unordered = { ...g, edges: [...g.edges.filter((e) => !(e.from === 'agent' && e.to === 'next')), { from: 'start', to: 'next' }] }
    expect(pipelineProblems(unordered).join('\n')).toContain('실행 선으로 먼저')
  })

  it('필드·경로·출력 구조/JSON 함수 타입과 포트를 저장 후 다시 읽는다', async () => {
    const ctx = await newProject()
    const g = graph()
    g.nodes.push(node('unused', 'function-output', { params: [{ id: 'j', name: '값', type: 'json' }, { id: 's', name: '구조', type: 'schema' }] }))
    await savePipeline(ctx, g)
    const stored = (await listPipelines(ctx))[0]
    expect(stored.nodes.find((n) => n.id === 'schema')?.fields).toEqual(fields)
    expect(stored.nodes.find((n) => n.id === 'name')?.pointer).toBe('/name')
    expect(stored.nodes.find((n) => n.id === 'unused')?.params?.map((p) => p.type)).toEqual(['json', 'schema'])
    expect(stored.edges).toEqual(g.edges)
  })

  it('함수로 전달한 출력 구조와 반환 JSON에서도 실행 의존성과 필드 선택을 유지한다', () => {
    const definition: Pipeline = { id: 'f', title: '분석 함수', file: '', template: true, nodes: [
      node('in', 'function-input', { params: [{ id: 'schema', name: '구조', type: 'schema' }] }),
      node('ai', 'codex', { text: '분석' }), node('dict', 'dictionary'),
      node('out', 'function-output', { params: [{ id: 'json', name: '결과', type: 'json' }] })
    ], edges: [
      { from: 'in', to: 'ai' }, { from: 'ai', to: 'out' },
      { from: 'in', to: 'ai', pin: 'data', fromPort: 'schema', toPort: P.schema },
      { from: 'ai', to: 'dict', pin: 'data', fromPort: P.output }, { from: 'dict', to: 'out', toPort: 'json' }
    ] }
    const caller: Graph = { nodes: [node('s', 'schema', { fields }), node('call', 'template', { ref: 'f' }), node('key', 'property', { pointer: '/people' }), node('next', 'codex', { text: '검토' })], edges: [
      { from: 's', to: 'call', toPort: 'schema' }, { from: 'call', to: 'next' },
      { from: 'call', to: 'key', pin: 'data', fromPort: 'json' }, { from: 'key', to: 'next' }
    ] }
    expect(pipelineProblems(caller, { library: [definition] })).toEqual([])
    const flat = expandPipeline(caller, { library: [definition] })
    expect(flat.nodes.find((n) => n.id === 'call/ai')?.outputSchema).toContain('people')
    expect(outputRefs(flat.nodes.find((n) => n.id === 'next')!.text)).toEqual(['call/ai'])
    expect(fillOutputs(flat.nodes.find((n) => n.id === 'next')!.text, () => JSON.stringify(result))).toBe('검토\n\n"민수"')
  })

  it('반복 본문의 JSON 선택은 각 항목 실행의 응답을 참조한다', () => {
    const g = graph()
    g.nodes.push(node('loop', 'foreach', { values: { $list: '첫째\n둘째' } }))
    g.edges = [...g.edges.filter((e) => e.from !== 'start'), { from: 'start', to: 'loop' }, { from: 'loop', to: 'agent', fromPort: '$body' }]
    expect(pipelineProblems(g)).toEqual([])
    const flat = expandPipeline(g)
    for (const index of [0, 1]) {
      const text = flat.nodes.find((n) => n.id === `loop/${index}/next`)!.text
      expect(outputRefs(text)).toEqual([`loop/${index}/agent`])
      expect(fillOutputs(text, (id) => JSON.stringify({ ...result, detail: { name: id } }))).toContain(`loop/${index}/agent`)
    }
  })
})

function runnerSetup() {
  let response: string | undefined
  let count = 0
  const sent: { id: string; text: string }[] = []
  const begin = vi.fn(), end = vi.fn()
  const deps: RunnerDeps = {
    createTerminal: async (kind) => ({ id: `t${++count}`, kind, title: '', pid: 1 }),
    hasTerminal: () => true, getTerminal: () => undefined, whenReady: async () => {},
    submit: (id, text) => { sent.push({ id, text }) }, runCommand: () => {}, completeTasks: async () => {}, emit: () => {},
    beginOutputCapture: begin, readAgentOutput: () => response, endOutputCapture: end
  }
  return { runner: new PipelineRunner(deps), sent, begin, end, respond: (text: string | undefined) => { response = text } }
}

describe('구조화된 에이전트 실행', () => {
  it.each(['claude', 'codex'] as const)('%s에 필드 없는 Object 목록을 보내도 내용을 검증하고 Print로 전달한다', async (kind) => {
    const ctx = await newProject()
    const fields: OutputField[] = [{ name: 'works', type: 'array', description: '클라이언트가 하는 일들 나열하기', items: { type: 'object', description: '', fields: [] } }]
    const g: Pipeline = { id: 'works', title: '작업 목록', file: '', nodes: [node('s', 'start'), node('ai', kind, { text: '현재 작업중인 내용 출력', fields }), node('print', 'print')],
      edges: [{ from: 's', to: 'ai' }, { from: 'ai', to: 'print' }, { from: 'ai', to: 'print', pin: 'data', fromPort: P.output }] }
    await savePipeline(ctx, g)
    const stored = (await listPipelines(ctx))[0], s = runnerSetup()
    s.runner.start({ ...stored, ...expandPipeline(stored) })
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    const sentSchema = JSON.parse(s.sent[0].text.slice(s.sent[0].text.indexOf('{')))
    expect(sentSchema.properties.works.items).toEqual({ type: 'object', description: '' })
    const response = { works: [{ title: '채팅방 목록 페이지네이션', status: 'in progress' }] }
    s.respond(JSON.stringify(response)); s.runner.agentDone('t1')
    expect(s.runner.list()[0]).toMatchObject({ status: 'done', nodes: { ai: { structuredOutput: response }, print: { status: 'done', output: JSON.stringify(response, null, 2) } } })
  })

  it.each(['claude', 'codex'] as const)('%s는 계약을 전달하고 검증한 응답을 Dictionary·중첩 필드·다음 노드로 넘긴다', async (kind) => {
    const g = graph(kind), s = runnerSetup()
    s.runner.start({ ...g, ...expandPipeline(g) })
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    expect(s.sent[0].text).toContain('참여자를 정리하세요')
    expect(s.sent[0].text).toContain(fields[0].description)
    expect(s.begin).toHaveBeenCalledWith('t1', s.sent[0].text)
    s.respond(JSON.stringify(result))
    s.runner.agentDone('t1') // 응답이 1.5초 안에 끝나도 완료 신호를 놓치지 않는다.
    await vi.waitFor(() => expect(s.sent).toHaveLength(2))
    expect(s.runner.list()[0].nodes.agent.structuredOutput).toEqual(result)
    expect(s.sent[1].text).toBe('다음 사람을 검토하세요\n\n"민수"')
    expect(s.end).toHaveBeenCalledWith('t1')
  })

  it.each([undefined, '{"people":2,"detail":{}}', 'JSON을 만들 수 없습니다'])('응답 %s가 계약에 맞지 않으면 수동 완료도 뒤 작업을 실행하지 않는다', async (response) => {
    const g = graph(), s = runnerSetup()
    const run = s.runner.start({ ...g, ...expandPipeline(g) })
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    s.respond(response)
    s.runner.markDone(run.runId, 'agent')
    expect(s.runner.list()[0]).toMatchObject({ status: 'failed', nodes: { agent: { status: 'failed' }, next: { status: 'skipped' } } })
    expect(s.sent).toHaveLength(1)
  })

  it('중지하면 수집을 해제하고 늦은 완료 신호를 무시한다', async () => {
    const g = graph(), s = runnerSetup()
    const run = s.runner.start({ ...g, ...expandPipeline(g) })
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    s.runner.stop(run.runId)
    expect(s.end).toHaveBeenCalledWith('t1')
    s.respond(JSON.stringify(result))
    expect(s.runner.agentDone('t1', true)).toBeNull()
    expect(s.sent).toHaveLength(1)
  })
})
