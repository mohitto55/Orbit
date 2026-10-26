import type { TerminalInfo, TerminalKind } from './terminal'
import { modelProblem } from './agentModel'
import { boolValue, calculate, calculationInputs, fillCalculations, type CompareOp, type CompareType } from './pipelineLogic'
export { COMPARE_OPS } from './pipelineLogic'
import { fillSelections, fromPointer, isObject, parseJson, readOutputSchema, schemaFromFields, selectJson, selectionInputs, structuredPrompt, toPointer, validateOutput, type JsonObject, type OutputField } from './structuredData'

/**
 * 연동: 터미널 작업 그래프 (블루프린트처럼 두 종류의 선).
 * - 실행 노드(Claude Code·Codex·셸·템플릿·할 일 완료)를 잇는 선은 "앞 작업이 끝나면 다음 작업 실행"이다.
 *   갈래가 나뉘면 동시에, 여러 선이 모이면 모두 끝난 뒤에 실행한다.
 * - 데이터 노드(텍스트·합치기·할 일)에서 나가는 선은 글을 넘긴다. 실행 노드로 들어가면 프롬프트(명령) 뒤에 붙고,
 *   템플릿 노드로 들어가면 템플릿 안의 {{입력}} 자리에 들어간다. 할 일 노드를 "할 일 완료"에 이으면 그 할 일을 완료한다.
 * 선의 종류는 출발 핀이 정한다. 실행 노드의 실행 출력(▶)에서 데이터 노드로는 이을 수 없다.
 * 결과를 내보내는 실행 노드(셸)는 데이터 출력 핀도 있다: 그 선(pin: 'data')은 실행이 끝난 뒤의 결과(명령 출력)를 넘긴다.
 * 데이터는 단일(글 하나) 또는 리스트(글 여러 개)다. 리스트가 실행 노드로 들어가면 항목을 한 번에 이어 붙인다.
 */

/**
 * start: 실행을 시작하는 자리 (실행 출력만 있다). 시작 노드가 있으면 거기서 실행 선으로 닿는 노드만 실행한다.
 * template: 다른 작업 그래프(템플릿)를 그 자리에 펼쳐 실행한다. complete: 이어진 할 일을 완료로 바꾼다 (터미널 없음).
 * text·join·task·skill: 글을 만드는 데이터 노드 (skill은 Claude Code 스킬의 본문을 실행할 때마다 읽어 내보낸다)
 * list: 글 여러 개를 담는 리스트 데이터 노드 (적어 둔 항목, 또는 들어온 데이터를 항목으로 모은다)
 * spec·feature·ac: 도메인의 기능 명세 / 그 안의 기능 하나 / 기능의 수용 기준 하나 (실행할 때마다 명세의 지금 내용을 읽는다).
 *   명세 노드에서 기능 노드를, 기능 노드에서 수용 기준 노드를, 리스트 노드에서 항목을 텍스트 노드로 꺼낼 수 있다 (innerValues).
 */
export const NODE_KINDS = ['start', 'claude', 'codex', 'shell', 'template', 'function-input', 'function-output', 'foreach', 'if', 'print', 'compare', 'and', 'or', 'not', 'boolean', 'number', 'complete', 'terminal', 'schema', 'dictionary', 'property', 'text', 'add', 'list', 'item', 'join', 'task', 'skill', 'spec', 'feature', 'ac'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const DATA_KINDS: NodeKind[] = ['compare', 'and', 'or', 'not', 'boolean', 'number', 'terminal', 'schema', 'dictionary', 'property', 'text', 'add', 'list', 'item', 'join', 'task', 'skill', 'spec', 'feature', 'ac']
export const isData = (n: Pick<PipeNode, 'kind'>) => DATA_KINDS.includes(n.kind)
export const isAgent = (n: Pick<PipeNode, 'kind'>) => n.kind === 'claude' || n.kind === 'codex'

/** 데이터의 형태. 터미널은 탭 참조이며 텍스트로 변환하지 않는다. */
export type DataShape = 'single' | 'list' | 'terminal' | 'json' | 'schema' | 'boolean' | 'number'
export const isLogic = (n: Pick<PipeNode, 'kind'>) => ['compare', 'and', 'or', 'not'].includes(n.kind)
export const dataShape = (n: Pick<PipeNode, 'kind'>): DataShape => n.kind === 'boolean' || isLogic(n) ? 'boolean' : n.kind === 'number' ? 'number' : n.kind === 'terminal' ? 'terminal' : n.kind === 'schema' ? 'schema' : n.kind === 'dictionary' || n.kind === 'property' ? 'json' : n.kind === 'list' || n.kind === 'spec' ? 'list' : 'single'
export const SHAPE_NAME: Record<DataShape, string> = { single: '단일', list: '리스트', terminal: '터미널', json: 'JSON', schema: '출력 구조', boolean: 'Bool', number: '숫자' }
export const PARAM_TYPE_NAME: Record<DataShape, string> = { single: '텍스트', list: '텍스트 리스트', terminal: '터미널', json: 'JSON', schema: '출력 구조', boolean: 'Bool', number: '숫자' }
export interface FunctionParam { id: string; name: string; type: DataShape }
export const isFunctionBoundary = (n: Pick<PipeNode, 'kind'>) => n.kind === 'function-input' || n.kind === 'function-output'
export const LOOP_PORT = { body: '$body', done: '$done', list: '$list', item: '$item', index: '$index' } as const
export const AGENT_PORT = { prompt: '$prompt', terminal: '$terminal', schema: '$schema', output: '$output' } as const
export const ADD_PORT = { a: '$a', b: '$b' } as const
export const IF_PORT = { condition: '$condition', yes: '$true', no: '$false' } as const
export const isLoopExecPort = (port?: string) => port === LOOP_PORT.body || port === LOOP_PORT.done
export const isIfExecPort = (port?: string) => port === IF_PORT.yes || port === IF_PORT.no
export const isExecPort = (port?: string) => isLoopExecPort(port) || isIfExecPort(port)

/** 작업 결과를 데이터로 내보내는 실행 노드 (셸: 명령 출력) */
export const hasDataOut = (n: Pick<PipeNode, 'kind'>) => isAgent(n) || n.kind === 'shell' || n.kind === 'template' || n.kind === 'foreach' || isFunctionBoundary(n)

/** 실행용으로 해석한 터미널 참조. 글과 섞거나 그래프 파일에 저장하지 않는다. */
export type TerminalInput = { tabId: string } | { nodeId: string }

export interface PipeNode {
  /** 노드를 가리키는 값 (새 노드는 uuid, 예전 그래프의 노드는 n1·n2…). 선은 이 값으로 잇는다 */
  id: string
  /** 사람이 붙이는 이름. 한 그래프 안에서 겹치지 않는다 (기본은 노드 종류 이름, 겹치면 뒤에 숫자) */
  name?: string
  /** 실행용으로 펼친 노드가 상태를 표시할 원본 노드들. 그래프 파일에는 저장하지 않는다. */
  sourceIds?: string[]
  terminalInput?: TerminalInput
  /** 실행 시 평가할 Bool 식. 그래프 파일에는 저장하지 않는다. */
  condition?: string
  kind: NodeKind
  /**
   * 에이전트면 프롬프트, 셸이면 명령, 템플릿이면 {{입력}} 자리에 넣을 글 (들어오는 데이터 선의 글이 뒤에 붙는다).
   * 텍스트 노드면 그 글, 합치기 노드면 구분자 (비우면 빈 줄).
   */
  text: string
  operation?: CompareOp
  compareType?: CompareType
  /** 리스트 노드: 적어 둔 항목 (입력이 들어오면 대신 들어온 데이터를 항목으로 쓴다) */
  items?: string[]
  /** 출력 구조 노드 또는 에이전트에 직접 지정한 출력 필드. */
  fields?: OutputField[]
  /** JSON 필드 노드가 선택할 JSON Pointer. */
  pointer?: string
  /** 실행할 때 해석한 출력 계약. 그래프 파일에는 저장하지 않는다. */
  outputSchema?: string
  /** 리스트 항목 노드가 읽을 0부터 시작하는 위치 */
  index?: number
  /** 함수 입·출력 노드의 고정 ID를 가진 변수들. 이름 변경으로 연결이 바뀌지 않는다. */
  params?: FunctionParam[]
  /** 함수 호출·텍스트 Add 등의 연결되지 않은 입력 기본값. 리스트는 한 줄에 한 항목. */
  values?: Record<string, string>
  /** 터미널 입력이 없을 때: new는 지정한 세션 또는 새 탭, continue는 같은 종류의 앞 노드 터미널. */
  terminal: 'new' | 'continue'
  /**
   * Claude Code·Codex 노드: 이어서 쓸 로컬 세션 id. 이미 열린 탭이 있으면 그대로 쓴다 (세션 불러오기).
   * 비우면 새 세션으로 연다. "이어서"(continue) 노드는 앞 노드의 터미널을 쓰므로 쓰지 않는다.
   */
  session?: string
  /** 이 작업을 실행할 모델. 비우면 기존 세션/CLI 설정을 유지한다. */
  model?: string
  /**
   * 템플릿 노드: 작업 그래프 id (실행할 때마다 지금 내용을 읽는다). 할 일·할 일 완료 노드: Task id.
   * 명세 노드: 명세 id, 기능 노드: "명세 id#기능 ID", 수용 기준 노드: "명세 id#AC ID" (예: spec-x#DM-F02-AC1)
   * 터미널 데이터 노드: Orbit 터미널 탭 id (AI가 바꾸는 세션 이름과 무관).
   */
  ref?: string
  x?: number
  y?: number
}

export interface PipeEdge {
  from: string
  to: string
  /** 'data': 실행 노드의 데이터 출력 핀에서 나온 선 (실행이 끝난 뒤의 결과를 넘긴다). 없으면 출발 노드의 기본 출력 */
  pin?: 'data'
  fromPort?: string
  toPort?: string
}

export interface Pipeline {
  id: string
  title: string
  /** 다른 그래프에서 템플릿 노드로 가져다 쓸 수 있다 */
  template?: boolean
  nodes: PipeNode[]
  edges: PipeEdge[]
  updated?: string
  file: string
}

export type Graph = Pick<Pipeline, 'nodes' | 'edges'>

/** 그래프 밖에서 가져오는 것: 템플릿으로 쓸 작업 그래프들, 할 일 */
export interface Env {
  library?: Pick<Pipeline, 'id' | 'title' | 'nodes' | 'edges'>[]
  tasks?: { id: string; title: string; body: string; status: string }[]
  /** 스킬: id는 "project:이름" / "user:이름" */
  skills?: { id: string; name: string; body: string }[]
  /** 도메인의 기능·규칙 명세 */
  specs?: EnvSpec[]
  terminals?: Pick<TerminalInfo, 'id' | 'title' | 'kind' | 'exited' | 'activity'>[]
}

export interface EnvFeature {
  id: string
  name: string
  purpose: string
  acs: { id: string; num: number; text: string }[]
}
export interface EnvSpec {
  id: string
  title: string
  features: EnvFeature[]
}

/** 새 노드의 id */
export function newNodeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 3) | 8).toString(16)
  })
}

/** 화면과 안내 문구에 쓰는 노드 이름 (이름이 없는 예전 노드는 id) */
export const nodeName = (n: Pick<PipeNode, 'id' | 'name'>) => n.name || n.id

/** 겹치지 않는 이름: 이미 있으면 뒤에 숫자를 1씩 늘려 붙인다 ("텍스트" → "텍스트 1" → "텍스트 2") */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const want = base.trim()
  if (!used.has(want)) return want
  const m = want.match(/^(.*\S)\s+(\d+)$/)
  const root = m ? m[1] : want
  for (let k = m ? Number(m[2]) + 1 : 1; ; k++) if (!used.has(`${root} ${k}`)) return `${root} ${k}`
}

/** 이름이 없거나 겹치는 노드에 이름을 붙인다 (앞에 있는 노드가 먼저 이름을 갖는다) */
export function withNames(nodes: PipeNode[]): PipeNode[] {
  const taken = new Set<string>()
  return nodes.map((n) => {
    const name = uniqueName(n.name?.trim() || KIND_NAME[n.kind], taken)
    taken.add(name)
    return { ...n, name }
  })
}

/** 명세 계열 노드가 가리키는 명세·기능·수용 기준 */
export function specTarget(n: Pick<PipeNode, 'kind' | 'ref'>, env: Env): { spec?: EnvSpec; feature?: EnvFeature; ac?: EnvFeature['acs'][number] } {
  if (!n.ref) return {}
  const [specId, sub] = n.ref.split('#')
  const spec = env.specs?.find((s) => s.id === specId)
  if (!spec || n.kind === 'spec') return { spec }
  if (n.kind === 'feature') return { spec, feature: spec.features.find((f) => f.id === sub) }
  for (const f of spec.features) {
    const ac = f.acs.find((a) => a.id === sub)
    if (ac) return { spec, feature: f, ac }
  }
  return { spec }
}

const plain = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').trim()
const acLine = (a: { num: number; text: string }) => `AC${a.num}: ${plain(a.text)}`
export function featureText(f: EnvFeature): string {
  return [`기능 ${f.id} ${f.name}`, f.purpose.trim() && `목적: ${plain(f.purpose)}`, f.acs.length ? `수용 기준:\n${f.acs.map(acLine).join('\n')}` : '']
    .filter(Boolean)
    .join('\n')
}
export const specText = (s: EnvSpec) => [`# ${s.title}`, ...s.features.map(featureText)].join('\n\n')

/** 데이터 노드에서 꺼낼 수 있는 안쪽 값 (블루프린트의 구조체 나누기처럼). 꺼내면 그 값을 담은 데이터 노드가 된다 */
export interface InnerValue {
  kind: NodeKind
  /** 명세 계열 노드로 꺼낼 때 가리킬 대상 */
  ref?: string
  /** 텍스트 노드로 꺼낼 때 담을 글 (리스트의 항목) */
  text?: string
  index?: number
  pointer?: string
  label: string
}
export function innerValues(n: Pick<PipeNode, 'kind' | 'ref' | 'items' | 'fields'> & { id?: string }, env: Env, graph?: Graph, outputs?: (id: string) => string | undefined): InnerValue[] {
  if ((n.kind === 'dictionary' || n.kind === 'property' || isAgent(n)) && graph && n.id) {
    const source = dataValue(graph, n.id, env)
    if (outputRefs(source).every((id) => outputs?.(id) !== undefined)) {
      const value = parseJson(fillOutputs(source, (id) => outputs?.(id) ?? ''))
      if (isObject(value) || Array.isArray(value)) return Object.keys(value).map((key) => ({ kind: 'property', pointer: toPointer([key]), label: key }))
    }
    const schema = dataSchema(graph, n.id, env)
    if (schema) return Object.keys(readOutputSchema(schema).properties).map((key) => ({ kind: 'property', pointer: toPointer([key]), label: key }))
    return []
  }
  // 리스트 노드: 적어 둔 항목 하나하나를 단일 텍스트 노드로
  if (n.kind === 'list') return (graph && n.id ? dataItems(graph, n.id, env) : n.items ?? []).filter((t) => t.trim()).map((t, index) => ({ kind: 'item', index, label: plain(t).split('\n')[0] }))
  const { spec, feature } = specTarget(n, env)
  if (n.kind === 'spec' && spec) return spec.features.map((f) => ({ kind: 'feature', ref: `${spec.id}#${f.id}`, label: `${f.id} ${f.name}` }))
  if (n.kind === 'feature' && spec && feature) return feature.acs.map((a) => ({ kind: 'ac', ref: `${spec.id}#${a.id}`, label: `AC${a.num} ${plain(a.text).split('\n')[0]}` }))
  return []
}

/** 템플릿 안의 노드 id는 "템플릿 노드 id/안쪽 id"로 펼친다 */
export const TEMPLATE_SEP = '/'
/** 템플릿 프롬프트·명령에서 템플릿 노드의 입력으로 바뀌는 자리 */
export const TEMPLATE_INPUT = '{{입력}}'

/** 예전 템플릿도 입·출력 경계가 있는 함수로 읽는다. 기존 실행 흐름은 경계 사이에 둔다. */
export function withFunctionBoundary(p: Graph, key = 'function'): Graph {
  const input = p.nodes.find((n) => n.kind === 'function-input')
  const output = p.nodes.find((n) => n.kind === 'function-output')
  if (input && output) return p
  const starts = p.nodes.filter((n) => n.kind === 'start')
  const entry: PipeNode = input ?? { id: starts[0]?.id ?? `${key}/input`, name: '함수 Input', kind: 'function-input', text: '', terminal: 'new', x: -260, y: 0, params: [{ id: 'input', name: '입력', type: 'single' }] }
  const exit: PipeNode = output ?? { id: `${key}/output`, name: '함수 Output', kind: 'function-output', text: '', terminal: 'new', x: Math.max(0, ...p.nodes.map((n) => n.x ?? 0)) + 280, y: 0, params: [] }
  const nodes = [entry, ...p.nodes.filter((n) => n.kind !== 'start' && !isFunctionBoundary(n)), exit]
  const oldStarts = new Set(starts.map((n) => n.id))
  const edges = p.edges.map((e) => ({ ...e, from: oldStarts.has(e.from) ? entry.id : e.from, to: oldStarts.has(e.to) ? entry.id : e.to }))
  const actions = nodes.filter((n) => !isData(n) && !isFunctionBoundary(n))
  const execution = execEdges({ nodes, edges })
  if (!input && !starts.length) for (const n of actions.filter((n) => !execution.some((e) => e.to === n.id))) edges.push({ from: entry.id, to: n.id })
  if (!output) {
    const bodies = new Set(actions.filter((n) => n.kind === 'foreach').flatMap((n) => [...loopScope({ nodes, edges }, n).body]))
    for (const n of actions.filter((n) => !bodies.has(n.id))) {
      const fromPort = n.kind === 'foreach' ? LOOP_PORT.done : undefined
      if (!execution.some((e) => e.from === n.id && (!fromPort || e.fromPort === fromPort))) edges.push({ from: n.id, to: exit.id, ...(fromPort ? { fromPort } : {}) })
    }
  }
  if (!actions.length && !edges.some((e) => e.from === entry.id && e.to === exit.id)) edges.push({ from: entry.id, to: exit.id })
  return { nodes, edges }
}

export function functionParams(n: PipeNode, env: Env): { inputs: FunctionParam[]; outputs: FunctionParam[] } {
  if (n.kind === 'if') return { inputs: [{ id: IF_PORT.condition, name: '조건', type: 'boolean' }], outputs: [] }
  if (isLogic(n)) return {
    inputs: (n.kind === 'not' ? [ADD_PORT.a] : [ADD_PORT.a, ADD_PORT.b]).map((id) => ({ id, name: id === ADD_PORT.a ? 'A' : 'B', type: n.kind === 'compare' ? n.compareType ?? 'number' : 'boolean' })),
    outputs: []
  }
  if (n.kind === 'add') return {
    inputs: [{ id: ADD_PORT.a, name: 'A', type: 'single' }, { id: ADD_PORT.b, name: 'B', type: 'single' }],
    outputs: []
  }
  if (isAgent(n)) return {
    inputs: [{ id: AGENT_PORT.prompt, name: '프롬프트', type: 'single' }, { id: AGENT_PORT.terminal, name: '터미널', type: 'terminal' }, { id: AGENT_PORT.schema, name: '출력 구조', type: 'schema' }],
    outputs: [{ id: AGENT_PORT.terminal, name: '터미널', type: 'terminal' }, { id: AGENT_PORT.output, name: '응답', type: 'single' }]
  }
  if (n.kind === 'foreach') return {
    inputs: [{ id: LOOP_PORT.list, name: '리스트', type: 'list' }],
    outputs: [{ id: LOOP_PORT.item, name: '항목', type: 'single' }, { id: LOOP_PORT.index, name: '인덱스', type: 'single' }]
  }
  if (n.kind === 'function-input') return { inputs: [], outputs: n.params ?? [] }
  if (n.kind === 'function-output') return { inputs: n.params ?? [], outputs: [] }
  if (n.kind !== 'template') return { inputs: [], outputs: [] }
  const definition = env.library?.find((p) => p.id === n.ref)
  const graph = definition && withFunctionBoundary(definition, definition.id)
  return {
    inputs: graph?.nodes.find((x) => x.kind === 'function-input')?.params ?? [],
    outputs: graph?.nodes.find((x) => x.kind === 'function-output')?.params ?? []
  }
}

const inputToken = (node: string, port: string) => `\u0000입력:${JSON.stringify([node, port])}\u0000`
function resolveInputs(text: string, p: Graph, env: Env, seen: string[] = []): string {
  return text.replace(/\u0000입력:([^\u0000]+)\u0000/g, (_match, value: string) => {
    const [id, port] = JSON.parse(value) as [string, string]
    return portItems(p, id, port, env, seen).join('\n\n')
  })
}

const preds = (p: Pick<Pipeline, 'edges'>, id: string) => p.edges.filter((e) => e.to === id).map((e) => e.from)
const byId = (p: Graph, id: string) => p.nodes.find((n) => n.id === id)

/** 글을 넘기는 선인지: 데이터 노드에서 나오거나 실행 노드의 데이터 출력에서 나온 선 */
export function isDataEdge(p: Graph, e: PipeEdge): boolean {
  const a = byId(p, e.from)
  return e.pin === 'data' || (!!a && isData(a))
}

export function edgeShape(p: Graph, e: PipeEdge, env: Env = {}): DataShape {
  const n = byId(p, e.from)
  if (!n) return 'single'
  const outputs = n.kind === 'function-output' ? n.params ?? [] : functionParams(n, env).outputs
  return outputs.find((param) => param.id === (e.fromPort ?? outputs[0]?.id))?.type ?? dataShape(n)
}

export const hasTerminalInput = (p: Graph, n: PipeNode, env: Env = {}) => isAgent(n) &&
  (!!n.terminalInput || p.edges.some((e) => e.to === n.id && isDataEdge(p, e) && (e.toPort === AGENT_PORT.terminal || edgeShape(p, e, env) === 'terminal')))

/** 실행 노드끼리의 선만 (데이터 선을 뺀 실행 흐름) */
export function execEdges(p: Graph): PipeEdge[] {
  return p.edges.filter((e) => {
    const a = byId(p, e.from)
    const b = byId(p, e.to)
    return a && b && !isData(a) && !isData(b) && e.pin !== 'data'
  })
}

/** 노드로 글을 넘기는 노드 (데이터 노드, 또는 결과를 내보내는 실행 노드). 위에 있는 노드부터 (같으면 왼쪽부터). */
function incomingData(p: Graph, id: string): PipeEdge[] {
  return p.edges
    .filter((e) => e.to === id && isDataEdge(p, e))
    .filter((e) => byId(p, e.from))
    .sort((a, b) => {
      const x = byId(p, a.from)!, y = byId(p, b.from)!
      return (x.y ?? 0) - (y.y ?? 0) || (x.x ?? 0) - (y.x ?? 0)
    })
}
const dataPreds = (p: Graph, id: string) => incomingData(p, id).map((e) => byId(p, e.from)!)

export const defaultValue = (type: DataShape): string => type === 'boolean' ? 'false' : type === 'number' ? '0' : ''
function inputValue(p: Graph, n: PipeNode, param: FunctionParam, env: Env, seen: string[]): string {
  const edges = incomingData(p, n.id).filter((e) => (e.toPort ?? functionParams(n, env).inputs[0]?.id) === param.id)
  if (edges.length > 1) throw new Error(`${nodeName(n)}: ${param.name} 입력은 하나만 연결할 수 있습니다`)
  return edges.length ? edgeItems(p, edges[0], env, seen).join('') : resolveInputs(n.values?.[param.id] ?? defaultValue(param.type), p, env, seen)
}

function portItems(p: Graph, id: string, port: string | undefined, env: Env, seen: string[]): string[] {
  const n = byId(p, id)
  const param = n?.params?.find((v) => v.id === (port ?? n.params?.[0]?.id))
  if (!n || !param) throw new Error(`${n ? nodeName(n) : id}: 함수 변수를 찾을 수 없습니다`)
  if (param.type === 'terminal') throw new Error(`${param.name}: 터미널 변수는 터미널 핀으로 연결하세요`)
  const key = `${id}#${param.id}`
  if (seen.includes(key)) throw new Error('함수 데이터 선이 고리를 이룹니다')
  const next = [...seen, key]
  const edges = incomingData(p, id).filter((e) => (e.toPort ?? n.params?.[0]?.id) === param.id)
  if (edges.length) {
    const items = edges.flatMap((e) => edgeItems(p, e, env, next))
    // 이름 없는 예전 템플릿 입력은 직접 쓴 글 뒤에 연결된 데이터를 붙였다.
    if (n.kind === 'function-input' && edges.some((e) => !e.toPort) && n.text.trim()) items.unshift(resolveInputs(n.text, p, env, next))
    return param.type === 'boolean' || param.type === 'number' ? [calculate(param.type, param.type, items)] : items
  }
  const literal = n.values?.[param.id]
  if (literal === undefined) return n.kind === 'function-input' ? [`{{${param.name}}}`] : param.type === 'boolean' || param.type === 'number' ? [defaultValue(param.type)] : []
  const items = (param.type === 'list' ? literal.split('\n').filter((x) => x.trim()) : [literal]).map((x) => resolveInputs(x, p, env, next))
  return param.type === 'boolean' || param.type === 'number' ? [calculate(param.type, param.type, items)] : items
}

function edgeItems(p: Graph, edge: PipeEdge, env: Env, seen: string[] = []): string[] {
  if (edgeShape(p, edge, env) === 'terminal') throw new Error('터미널은 텍스트로 사용할 수 없습니다')
  const n = byId(p, edge.from)
  if (n?.kind === 'foreach') return [edge.fromPort === LOOP_PORT.index ? '[반복 인덱스]' : '[반복 항목]']
  if (n && isFunctionBoundary(n)) return portItems(p, n.id, edge.fromPort, env, seen)
  // 편집 중 미리 보기에도 함수의 리스트 형태를 보존한다. 실행되지 않는 호출의 결과는 실행 순서 검사에서 알린다.
  if (n?.kind === 'template' && liveNodes(p).has(n.id)) {
    const graph = lowerFunctions(p, env, [])
    const definition = env.library?.find((x) => x.id === n.ref)!
    const exit = withFunctionBoundary(definition, definition.id).nodes.find((x) => x.kind === 'function-output')!
    return portItems(graph, `${n.id}${TEMPLATE_SEP}${exit.id}`, edge.fromPort, env, seen)
  }
  return dataItems(p, edge.from, env, seen)
}

/**
 * 실행 노드의 결과가 들어갈 자리. 실행 전에는 결과를 모르므로 글에 이 표시를 넣어 두고,
 * 실행기가 그 노드가 끝난 뒤 결과로 바꾼다 (fillOutputs).
 */
export const outputToken = (id: string) => `\u0000출력:${id}\u0000`
const OUTPUT_TOKEN = /\u0000출력:([^\u0000]*)\u0000/g
/** 글에 들어 있는 결과 자리의 노드 id들 */
export const outputRefs = (text: string): string[] => [...new Set([
  ...[...text.matchAll(OUTPUT_TOKEN)].map((m) => m[1]),
  ...[...selectionInputs(text), ...calculationInputs(text)].flatMap(outputRefs)
])]
/** 결과 자리를 결과로 바꾼다 (화면에서 "[셸의 출력]"처럼 보여 줄 때도 쓴다) */
export const fillOutputs = (text: string, value: (id: string) => string, preview = false): string =>
  fillCalculations(fillSelections(text, (input) => fillOutputs(input, value, preview), preview), (input) => fillOutputs(input, value, preview), preview)
    .replace(OUTPUT_TOKEN, (_m, id: string) => value(id))

/** 할 일 노드가 내보내는 글 */
export function taskText(t: { id: string; title: string; body: string }): string {
  return [`할 일 ${t.id}: ${t.title}`, t.body.trim()].filter(Boolean).join('\n\n')
}

/** 데이터 노드가 내보내는 글. 리스트는 항목을 빈 줄로 이어 한 번에 내보낸다. 실행 노드면 그 결과가 들어갈 자리 */
export function dataValue(p: Graph, id: string, env: Env = {}, seen: string[] = []): string {
  if (seen.includes(id)) throw new Error(`데이터 선이 고리를 이룹니다: ${[...seen, id].join(' → ')}`)
  const n = byId(p, id)
  if (!n) return ''
  if (n.kind === 'boolean' || n.kind === 'number') {
    const edges = incomingData(p, id)
    if (edges.length > 1) throw new Error(`${nodeName(n)}: 원본 데이터는 하나만 연결할 수 있습니다`)
    const value = edges.length ? edgeItems(p, edges[0], env, [...seen, id]).join('') : resolveInputs(n.text || defaultValue(n.kind), p, env, [...seen, id])
    return calculate(n.kind, n.kind, [value])
  }
  if (isLogic(n)) {
    const op = n.kind === 'compare' ? n.operation ?? 'eq' : n.kind as 'and' | 'or' | 'not'
    return calculate(op, n.kind === 'compare' ? n.compareType ?? 'number' : 'boolean', functionParams(n, env).inputs.map((param) => inputValue(p, n, param, env, [...seen, id])))
  }
  if (n.kind === 'terminal') throw new Error('터미널은 텍스트로 사용할 수 없습니다')
  if (n.kind === 'schema') return JSON.stringify(schemaFromFields(n.fields ?? []), null, 2)
  if (n.kind === 'dictionary' || n.kind === 'property') {
    const from = incomingData(p, id)
    if (from.length > 1) throw new Error(`${nodeName(n)}: 원본 데이터는 하나만 연결할 수 있습니다`)
    if (n.kind === 'property' && !from.length) throw new Error(`${nodeName(n)}: 원본 JSON 데이터를 연결하세요`)
    const input = from.length ? edgeItems(p, from[0], env, [...seen, id]).join('\n\n') : resolveInputs(n.text || '{}', p, env, [...seen, id])
    return selectJson(input, n.kind === 'property' ? fromPointer(n.pointer ?? '') : [], n.kind === 'dictionary')
  }
  if (!isData(n)) return outputToken(n.id)
  if (n.kind === 'item') {
    const source = incomingData(p, id)[0]
    if (!source) throw new Error(`${nodeName(n)}: 원본 리스트를 연결하세요`)
    const items = edgeItems(p, source, env, [...seen, id])
    const index = n.index ?? 0
    if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error(`${nodeName(n)}: 리스트에 ${index + 1}번째 항목이 없습니다`)
    return items[index]
  }
  if (n.kind === 'list') return dataItems(p, id, env, seen).join('\n\n')
  if (n.kind === 'task') {
    const t = env.tasks?.find((x) => x.id === n.ref)
    return t ? taskText(t) : ''
  }
  if (n.kind === 'skill') return env.skills?.find((x) => x.id === n.ref)?.body ?? ''
  if (n.kind === 'spec' || n.kind === 'feature' || n.kind === 'ac') {
    const { spec, feature, ac } = specTarget(n, env)
    if (n.kind === 'spec') return spec ? specText(spec) : ''
    if (!feature) return ''
    if (n.kind === 'feature') return featureText(feature)
    return ac ? `기능 ${feature.id} ${feature.name}의 수용 기준 ${acLine(ac)}` : ''
  }
  // 텍스트 Add: 위치와 무관하게 A + B 순서로 붙이며 공백·빈 문자열도 그대로 보존한다.
  if (n.kind === 'add') {
    const edges = incomingData(p, id)
    return functionParams(n, env).inputs.map((param) => {
      const source = edges.find((e) => (e.toPort ?? ADD_PORT.a) === param.id)
      return source ? edgeItems(p, source, env, [...seen, id]).join('') : resolveInputs(n.values?.[param.id] ?? '', p, env, [...seen, id])
    }).join('')
  }
  const inputs = incomingData(p, id).map((e) => edgeItems(p, e, env, [...seen, id]).join('\n\n'))
  // 텍스트 노드: 입력이 들어오면 적어 둔 글 대신 들어온 글을 그대로 내보낸다
  if (n.kind === 'text') return inputs.length ? inputs.filter((t) => t.trim()).join('\n\n') : resolveInputs(n.text, p, env, [...seen, id])
  // 합치기: 리스트가 들어오면 그 항목들을 하나씩 잇는다
  const sep = n.text ? n.text.replace(/\\n/g, '\n') : '\n\n'
  return incomingData(p, id)
    .flatMap((e) => edgeItems(p, e, env, [...seen, id]))
    .filter((t) => t.trim())
    .join(sep)
}

/**
 * 데이터를 항목으로: 단일이면 글 하나, 리스트면 항목들.
 * 리스트 노드는 입력이 들어오면 적어 둔 항목 대신 들어온 데이터를 항목으로 모은다 (리스트 입력은 펼쳐서).
 */
export function dataItems(p: Graph, id: string, env: Env = {}, seen: string[] = []): string[] {
  const n = byId(p, id)
  if (!n) return []
  if (n.kind === 'spec') return specTarget(n, env).spec?.features.map(featureText) ?? []
  if (n.kind !== 'list') return [dataValue(p, id, env, seen)]
  if (seen.includes(id)) throw new Error(`데이터 선이 고리를 이룹니다: ${[...seen, id].join(' → ')}`)
  const from = incomingData(p, id)
  const items = from.length ? from.flatMap((e) => edgeItems(p, e, env, [...seen, id])) : (n.items ?? []).map((x) => resolveInputs(x, p, env, [...seen, id]))
  return items.filter((t) => t.trim())
}

/** 입력 핀이 있는 노드인지 (시작·할 일·스킬·명세 계열 노드는 출력만 있다) */
export const hasInput = (n: Pick<PipeNode, 'kind'>) => !['schema', 'terminal', 'task', 'start', 'skill', 'spec', 'function-input'].includes(n.kind)

/**
 * 실행되는 노드: 시작 노드가 있으면 시작에서 실행 선을 따라 닿는 노드만, 없으면 모든 실행 노드.
 * 그 노드들에 글을 넘기는 데이터 노드도 넣는다. 여기 없는 노드는 실행하지도 검사하지도 않는다.
 */
export function liveNodes(p: Graph): Set<string> {
  const ex = execEdges(p)
  const live = new Set<string>()
  const starts = p.nodes.filter((n) => n.kind === 'start' || (n.kind === 'function-input' && !ex.some((e) => e.to === n.id))).map((n) => n.id)
  if (starts.length) {
    const stack = [...starts]
    while (stack.length) {
      const id = stack.pop()!
      if (live.has(id)) continue
      live.add(id)
      for (const e of ex) if (e.from === id) stack.push(e.to)
    }
  } else for (const n of p.nodes) if (!isData(n)) live.add(n.id)
  const stack = [...live]
  while (stack.length) {
    // 실행 노드의 결과는 그 노드가 실행 선으로 닿을 때만 생긴다 (데이터 선으로 끌어와 실행하지 않는다)
    for (const d of dataPreds(p, stack.pop()!)) {
      if (live.has(d.id) || !isData(d)) continue
      live.add(d.id)
      stack.push(d.id)
    }
  }
  return live
}

/** from → to 선을 그을 수 있는지. 안 되면 이유. pin: 'data'면 실행 노드의 데이터 출력 핀에서 나온 선 */
export function edgeProblem(p: Graph, from: string, to: string, pin?: PipeEdge['pin'], env: Env = {}, ports: Pick<PipeEdge, 'fromPort' | 'toPort'> = {}): string | null {
  const a = byId(p, from)
  const b = byId(p, to)
  if (!a || !b) return '노드를 찾을 수 없습니다'
  if (from === to) return '자기 자신에게는 이을 수 없습니다'
  if (a.kind === 'function-output') return '함수 Output은 함수의 끝입니다'
  if (pin === 'data' && (isData(a) || !hasDataOut(a))) return `${KIND_NAME[a.kind]} 노드에는 결과를 내보내는 데이터 출력이 없습니다`
  if (!pin && !isData(a) && isData(b)) return '실행 노드의 실행 출력에서 데이터 노드로는 이을 수 없습니다'
  if (!hasInput(b)) return `${KIND_NAME[b.kind]} 노드에는 입력이 없습니다`
  const data = pin === 'data' || isData(a)
  if (!data && (ports.toPort || (ports.fromPort && !(a.kind === 'foreach' && isLoopExecPort(ports.fromPort)) && !(a.kind === 'if' && isIfExecPort(ports.fromPort))))) return '데이터 변수에는 데이터 핀을 연결하세요'
  if (data) {
    const sourcePorts = functionParams(a, env).outputs
    const source = sourcePorts.find((v) => v.id === (ports.fromPort ?? sourcePorts[0]?.id))
    if ((a.kind === 'template' || a.kind === 'function-input' || a.kind === 'foreach') && !source) return '출력 변수를 고르세요'
    if (ports.fromPort && !source) return '존재하지 않는 출력 변수입니다'
    const shape = source?.type ?? dataShape(a)
    if (b.kind === 'print') {
      if (shape === 'terminal' || shape === 'schema') return 'Print에는 텍스트·리스트·JSON·Bool·숫자 값을 연결하세요'
      if (incomingData(p, to).some((e) => e.from !== from || e.fromPort !== ports.fromPort)) return '출력할 값은 하나만 연결할 수 있습니다'
    }
    if (b.kind === 'item' && shape !== 'list') return '리스트 항목에는 리스트를 연결하세요'
    if (b.kind === 'feature' && a.kind !== 'spec') return '기능에는 원본 기능 명세를 연결하세요'
    if (b.kind === 'ac' && a.kind !== 'feature') return '수용 기준에는 원본 기능을 연결하세요'
    if (['item', 'feature', 'ac', 'dictionary', 'property', 'boolean', 'number'].includes(b.kind) && incomingData(p, to).some((e) => e.from !== from || e.fromPort !== ports.fromPort)) return '원본 데이터는 하나만 연결할 수 있습니다'
    if ((b.kind === 'boolean' || b.kind === 'number') && !['single', 'json', b.kind].includes(shape)) return `${PARAM_TYPE_NAME[b.kind]} 또는 변환할 텍스트·JSON 값을 연결하세요`
    if (['dictionary', 'property'].includes(b.kind) && shape !== 'single' && shape !== 'json') return 'JSON 객체 또는 응답 텍스트를 연결하세요'
    if (b.kind === 'feature' && b.ref?.split('#')[0] !== a.ref) return '이 기능의 원본 명세가 아닙니다'
    if (b.kind === 'ac' && b.ref && a.ref) {
      const target = specTarget(b, env)
      if (target.feature && `${target.spec?.id}#${target.feature.id}` !== a.ref) return '이 수용 기준의 원본 기능이 아닙니다'
    }
    if (isAgent(b)) {
      const target = ports.toPort ?? (shape === 'terminal' ? AGENT_PORT.terminal : shape === 'schema' ? AGENT_PORT.schema : AGENT_PORT.prompt)
      if (target === AGENT_PORT.schema) {
        if (shape !== 'schema') return '출력 구조 핀에는 출력 구조 노드를 연결하세요'
        if (incomingData(p, to).some((e) => (e.toPort === AGENT_PORT.schema || edgeShape(p, e, env) === 'schema') && (e.from !== from || e.fromPort !== ports.fromPort))) return '출력 구조는 하나만 연결할 수 있습니다'
        return null
      }
      if (shape === 'schema') return '출력 구조는 출력 구조 핀에 연결하세요'
      if (target !== AGENT_PORT.prompt && target !== AGENT_PORT.terminal) return '존재하지 않는 입력 변수입니다'
      if ((target === AGENT_PORT.terminal) !== (shape === 'terminal')) return '터미널 핀에는 터미널만, 프롬프트 핀에는 텍스트·리스트만 연결하세요'
      if (target === AGENT_PORT.terminal) {
        if (isAgent(a) && a.kind !== b.kind) return `${KIND_NAME[b.kind]} 노드에는 같은 종류의 터미널을 연결하세요`
        if (incomingData(p, to).some((e) => (e.toPort === AGENT_PORT.terminal || edgeShape(p, e, env) === 'terminal') && (e.from !== from || e.fromPort !== ports.fromPort))) return '터미널은 하나만 연결할 수 있습니다'
      }
    } else if (b.kind === 'template' || b.kind === 'function-output' || b.kind === 'foreach' || b.kind === 'add' || b.kind === 'if' || isLogic(b)) {
      const targetPorts = functionParams(b, env).inputs
      const target = targetPorts.find((v) => v.id === (ports.toPort ?? targetPorts[0]?.id))
      if (!target) return b.kind === 'add' ? '텍스트 Add의 A 또는 B 입력을 고르세요' : '함수의 입력 변수를 고르세요'
      // 예전 템플릿의 이름 없는 입력 선은 글을 합쳐 넘기던 동작을 유지한다.
      if ((ports.toPort || b.kind !== 'template' || !['single', 'list'].includes(target.type) || !['single', 'list'].includes(shape)) && target.type !== shape) return `${target.name}: ${PARAM_TYPE_NAME[target.type]} 입력에 ${PARAM_TYPE_NAME[shape]}을 연결할 수 없습니다`
      if ((ports.toPort || b.kind !== 'template') && p.edges.some((e) => e.to === to && (e.toPort ?? targetPorts[0]?.id) === target.id && isDataEdge(p, e) && (e.from !== from || e.fromPort !== ports.fromPort))) return `${target.name}: 이미 연결된 입력입니다`
    } else if (shape === 'terminal') return '터미널은 터미널 타입의 입력 핀에 연결하세요'
    else if (ports.toPort) return '존재하지 않는 입력 변수입니다'
  }
  return null
}

/** 노드 본체에 놓거나 검색으로 새 노드를 만들 때 타입이 맞는 입력을 찾는다. 명시한 핀은 바꾸지 않는다. */
export function withInputPort(p: Graph, edge: PipeEdge, env: Env): PipeEdge {
  if (edge.toPort || !isDataEdge(p, edge)) return edge
  const target = byId(p, edge.to)
  if (!target) return edge
  // 기존 프롬프트 연결은 이름 없는 핀을 유지한다.
  if (isAgent(target)) {
    const shape = edgeShape(p, edge, env)
    return shape === 'terminal' ? { ...edge, toPort: AGENT_PORT.terminal } : shape === 'schema' ? { ...edge, toPort: AGENT_PORT.schema } : edge
  }
  const inputs = functionParams(target, env).inputs
  const port = inputs.find((param) => !edgeProblem(p, edge.from, edge.to, edge.pin, env, { ...edge, toPort: param.id })) ?? inputs[0]
  return port ? { ...edge, toPort: port.id } : edge
}

export const KIND_NAME: Record<NodeKind, string> = {
  start: '시작',
  claude: 'Claude Code',
  codex: 'Codex',
  shell: '셸',
  template: '함수 호출',
  'function-input': '함수 Input',
  'function-output': '함수 Output',
  foreach: 'For Each',
  if: 'If', compare: '비교', and: 'AND', or: 'OR', not: 'NOT', boolean: 'Bool', number: '숫자',
  print: 'Print',
  complete: '할 일 완료',
  terminal: '터미널',
  schema: '출력 구조',
  dictionary: 'Dictionary',
  property: 'JSON 필드',
  text: '텍스트',
  add: '텍스트 Add',
  list: '리스트',
  item: '리스트 항목',
  join: '합치기',
  task: '할 일',
  skill: '스킬',
  spec: '기능 명세',
  feature: '기능',
  ac: '수용 기준'
}

/** 실행 노드가 실제로 쓰는 글: 노드에 적은 글 + 들어오는 데이터 선의 글 (빈 줄로 잇는다) */
export function nodeInput(p: Graph, id: string, env: Env = {}): string {
  const n = byId(p, id)
  if (!n) return ''
  if (n.kind === 'if') return n.condition ?? calculate('boolean', 'boolean', [inputValue(p, n, functionParams(n, env).inputs[0], env, [id])])
  if (n.kind === 'print') {
    const edges = incomingData(p, id)
    if (edges.length > 1) throw new Error(`${nodeName(n)}: 출력할 값은 하나만 연결할 수 있습니다`)
    return edges.length ? edgeItems(p, edges[0], env).join('\n\n') : resolveInputs(n.text, p, env)
  }
  return [resolveInputs(n.text, p, env), ...incomingData(p, id).filter((e) => !['terminal', 'schema'].includes(edgeShape(p, e, env)) && e.toPort !== AGENT_PORT.terminal && e.toPort !== AGENT_PORT.schema).map((e) => edgeItems(p, e, env).join('\n\n'))]
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function agentSchema(p: Graph, id: string, env: Env = {}): string | undefined {
  const node = byId(p, id)
  if (!node || !isAgent(node)) return undefined
  const edges = incomingData(p, id).filter((e) => e.toPort === AGENT_PORT.schema || edgeShape(p, e, env) === 'schema')
  if (edges.length > 1) throw new Error(`${nodeName(node)}: 출력 구조는 하나만 연결할 수 있습니다`)
  const text = edges.length ? edgeItems(p, edges[0], env).join('\n\n') : node.outputSchema ?? (node.fields ? JSON.stringify(schemaFromFields(node.fields), null, 2) : undefined)
  if (text) readOutputSchema(text)
  return text
}

/** 실행 전에도 Dictionary에서 계약에 선언한 키를 꺼낼 수 있다. */
function dataSchema(p: Graph, id: string, env: Env, seen: string[] = []): string | undefined {
  if (seen.includes(id)) return undefined
  const node = byId(p, id)
  if (!node) return undefined
  if (isAgent(node)) return agentSchema(p, id, env)
  if (node.kind !== 'dictionary') return undefined
  const source = incomingData(p, id)[0]
  return source && dataSchema(p, source.from, env, [...seen, id])
}

/** "할 일 완료" 노드가 완료할 Task: 노드에서 고른 것 + 데이터 선으로 이어진 할 일 노드 */
export function completeTargets(p: Graph, id: string): string[] {
  const n = byId(p, id)
  if (!n) return []
  const linked = dataPreds(p, id)
    .filter((x) => x.kind === 'task' && x.ref)
    .map((x) => x.ref!)
  // 펼친 뒤에는 text에 id가 쉼표로 담겨 있다
  const expanded = n.text.split(',').map((x) => x.trim()).filter(Boolean)
  return [...new Set([...(n.ref ? [n.ref] : []), ...linked, ...expanded])]
}

/**
 * 데이터를 계산해 실행 노드의 글에 넣고, 템플릿 노드를 템플릿의 지금 내용으로 펼친다 (템플릿 안의 템플릿도).
 * 앞 노드 → 템플릿의 시작 노드들, 템플릿의 끝 노드들 → 뒤 노드로 잇는다.
 * 템플릿의 시작 노드가 "이어서"면 바깥 앞 노드의 터미널을 이어 쓴다. 결과에는 실행 노드만 남는다.
 * "할 일 완료" 노드는 완료할 Task id들을 쉼표로 이어 text에 담는다.
 */
/** 함수 호출을 고유한 범위로 펼치고, 입·출력 변수의 선을 호출자와 연결한다. */
function lowerFunctions(p: Graph, env: Env, stack: string[]): Graph {
  p = withBranchReturns(p)
  let graph: Graph = { nodes: [...p.nodes], edges: [...p.edges] }
  const live = liveNodes(p)
  for (const call of p.nodes.filter((n) => n.kind === 'template' && live.has(n.id))) {
    const definition = env.library?.find((n) => n.id === call.ref)
    if (!definition) throw new Error(`${nodeName(call)}: 함수를 찾을 수 없습니다 (${call.ref ?? '고르지 않음'})`)
    if (stack.includes(definition.id)) throw new Error(`${nodeName(call)}: 함수 "${definition.title}"이(가) 자기 자신을 다시 씁니다`)
    const body = withBranchReturns(withFunctionBoundary(definition, definition.id))
    const problems = functionProblems(body, env)
    if (problems.length) throw new Error(`${nodeName(call)}: ${problems.join('\n')}`)
    const entry = body.nodes.find((n) => n.kind === 'function-input')!
    const exit = body.nodes.find((n) => n.kind === 'function-output')!
    const id = (value: string) => `${call.id}${TEMPLATE_SEP}${value}`
    const substitute = (text: string) => (entry.params ?? []).reduce((value, param) => value.split(`{{${param.name}}}`).join(inputToken(id(entry.id), param.id)), text)
    const nodes = body.nodes.map((n) => ({
      ...n, id: id(n.id), name: `${nodeName(call)}${TEMPLATE_SEP}${nodeName(n)}`, sourceIds: call.sourceIds ?? [call.id],
      text: substitute(n.text),
      ...(n.items ? { items: n.items.map(substitute) } : {}),
      ...(n.values ? { values: Object.fromEntries(Object.entries(n.values).map(([k, v]) => [k, substitute(v)])) } : {})
    }))
    const boundEntry = nodes.find((n) => n.id === id(entry.id))!
    boundEntry.text = call.text
    boundEntry.values = Object.fromEntries((entry.params ?? []).map((param, i) => [param.id, call.values?.[param.id] ?? (i === 0 && call.text ? call.text : defaultValue(param.type))]))
    // 호출 밖에서 여러 데이터를 합치는 순서는 함수 정의의 배치가 아니라 호출 노드의 배치를 따른다.
    const boundExit = nodes.find((n) => n.id === id(exit.id))!
    boundExit.x = call.x
    boundExit.y = call.y
    const inner = lowerFunctions({ nodes, edges: body.edges.map((e) => ({ ...e, from: id(e.from), to: id(e.to) })) }, env, [...stack, definition.id])
    graph = {
      nodes: graph.nodes.flatMap((n) => n.id === call.id ? inner.nodes : [n]),
      edges: [...graph.edges.map((e) => ({
        ...e,
        from: e.from === call.id ? id(exit.id) : e.from,
        to: e.to === call.id ? id(entry.id) : e.to
      })), ...inner.edges]
    }
  }
  return graph
}

function reachable(execution: PipeEdge[], roots: string[], stop = new Set<string>()): Set<string> {
  const seen = new Set<string>(), pending = [...roots]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id) || stop.has(id)) continue
    seen.add(id)
    pending.push(...execution.filter((e) => e.from === id).map((e) => e.to))
  }
  return seen
}

function loopScope(p: Graph, loop: PipeNode) {
  const execution = execEdges(p)
  const roots = execution.filter((e) => e.from === loop.id && e.fromPort !== LOOP_PORT.done).map((e) => e.to)
  const stops = new Set(p.nodes.filter((n) => n.kind === 'function-output' && n.ref === '$iteration-end').map((n) => n.id))
  const body = reachable(execution, roots, stops)
  const completed = execution.filter((e) => (e.from === loop.id && e.fromPort === LOOP_PORT.done) || (body.has(e.from) && stops.has(e.to)))
  return { execution, roots, completed, body }
}

function loopProblems(p: Graph, loop: PipeNode): string[] {
  const out: string[] = []
  const { execution, roots, completed, body } = loopScope(p, loop)
  const name = nodeName(loop)
  if (!incomingData(p, loop.id).length && loop.values?.[LOOP_PORT.list] === undefined) out.push(`${name}: 리스트를 연결하거나 기본 항목을 입력하세요`)
  if (!roots.length) out.push(`${name}: 반복 본문 핀에 실행할 노드를 연결하세요`)
  if ([...reachable(execution, completed.map((e) => e.to))].some((id) => body.has(id))) out.push(`${name}: 반복 본문과 완료 경로는 따로 연결하세요`)
  if (body.has(loop.id)) out.push(`${name}: 본문 끝을 For Each로 다시 연결하지 마세요. 다음 항목은 자동으로 실행됩니다`)
  if (execution.some((e) => body.has(e.to) && !body.has(e.from) && e.from !== loop.id)) out.push(`${name}: 반복 본문은 For Each의 본문 핀에서만 실행해야 합니다`)
  // 현재 항목·인덱스와 본문 실행 결과는 그 반복 안에서만 유효하다.
  const dataScope = new Set([loop.id, ...body]), pending = [...dataScope]
  while (pending.length) {
    const id = pending.pop()!
    for (const e of p.edges.filter((e) => e.from === id && isDataEdge(p, e))) {
      const target = byId(p, e.to)
      if (!target) continue
      if (!isData(target) && !body.has(target.id)) out.push(`${name}: 항목·인덱스와 본문 결과는 반복 본문 안에서만 연결할 수 있습니다`)
      if (isData(target) && !dataScope.has(target.id)) { dataScope.add(target.id); pending.push(target.id) }
    }
  }
  return [...new Set(out)]
}

/** 각 반복의 본문을 별도 범위로 펼치고, 모든 갈래가 끝난 뒤 다음 항목을 실행한다. */
function lowerLoops(p: Graph, env: Env): Graph {
  let graph = p
  for (;;) {
    const live = liveNodes(graph)
    const loops = graph.nodes.filter((n) => n.kind === 'foreach' && live.has(n.id))
    if (!loops.length) return graph
    // 바깥 반복의 항목을 먼저 바인딩해야 안쪽 반복의 입력을 계산할 수 있다.
    const loop = loops.find((n) => !loops.some((other) => other.id !== n.id && loopScope(graph, other).body.has(n.id)))
    if (!loop) throw new Error('For Each의 실행 선이 고리를 이룹니다')
    const problems = loopProblems(graph, loop)
    if (problems.length) throw new Error(problems.join('\n'))
    const { execution, roots, completed, body } = loopScope(graph, loop)
    const input = incomingData(graph, loop.id)
    const items = input.length ? input.flatMap((e) => edgeItems(graph, e, env)) : (loop.values?.[LOOP_PORT.list] ?? '').split('\n').filter((s) => s.trim())
    const scope = new Set(body), pending = [...body]
    while (pending.length) {
      for (const n of dataPreds(graph, pending.pop()!)) if (isData(n) && !scope.has(n.id)) { scope.add(n.id); pending.push(n.id) }
    }
    if (graph.nodes.length + items.length * (scope.size + 3) > 10000) throw new Error(`${nodeName(loop)}: 반복을 펼친 노드는 10,000개까지 실행할 수 있습니다. 리스트를 나누어 실행하세요`)
    const leaves = [...body].filter((id) => byId(graph, id)?.kind !== 'if' && !execution.some((e) => e.from === id && body.has(e.to)))
    const emptyBranches = graph.nodes.filter((n) => body.has(n.id) && n.kind === 'if').flatMap((n) =>
      [IF_PORT.yes, IF_PORT.no].filter((port) => !execution.some((e) => e.from === n.id && body.has(e.to) && (e.fromPort ?? IF_PORT.yes) === port)).map((fromPort) => ({ from: n.id, fromPort })))
    const gate = (id: string): PipeNode => ({ id, kind: 'function-output', text: '', terminal: 'new' })
    const nodes = graph.nodes.filter((n) => !body.has(n.id)).map((n) => n.id === loop.id ? gate(n.id) : n)
    const edges = graph.edges.filter((e) => !body.has(e.from) && !body.has(e.to) && e.from !== loop.id && !(e.to === loop.id && isDataEdge(graph, e)))
    let previous = loop.id
    for (const [index, value] of items.entries()) {
      const prefix = `${loop.id}/${index}/`
      const id = (old: string) => scope.has(old) ? `${prefix}${old}` : old
      const rewrite = (text: string) => fillOutputs(text.replace(/\u0000입력:([^\u0000]+)\u0000/g, (_match, raw: string) => {
        const [source, port] = JSON.parse(raw) as [string, string]
        return inputToken(id(source), port)
      }), (source) => outputToken(id(source)))
      const itemId = `${prefix}$item`, indexId = `${prefix}$index`, end = `${prefix}$end`
      nodes.push({ id: itemId, kind: 'text', text: value, terminal: 'new', x: loop.x, y: loop.y }, { id: indexId, kind: 'text', text: String(index), terminal: 'new', x: loop.x, y: loop.y }, { ...gate(end), ref: '$iteration-end' })
      nodes.push(...graph.nodes.filter((n) => scope.has(n.id)).map((n) => ({
        ...n, id: id(n.id), name: `${nodeName(loop)}[${index}]/${nodeName(n)}`, text: rewrite(n.text),
        sourceIds: [...new Set([...(n.sourceIds ?? [n.id]), ...(loop.sourceIds ?? [loop.id])])],
        ...(n.items ? { items: n.items.map(rewrite) } : {}),
        ...(n.values ? { values: Object.fromEntries(Object.entries(n.values).map(([k, v]) => [k, rewrite(v)])) } : {})
      })))
      for (const e of graph.edges.filter((e) => scope.has(e.to))) {
        if (e.from === loop.id) {
          if (isDataEdge(graph, e)) edges.push({ from: e.fromPort === LOOP_PORT.index ? indexId : itemId, to: id(e.to), ...(e.toPort ? { toPort: e.toPort } : {}) })
        } else edges.push({ ...e, from: id(e.from), to: id(e.to) })
      }
      edges.push(...roots.map((root) => ({ from: previous, to: id(root) })), ...leaves.map((leaf) => ({ from: id(leaf), to: end })))
      edges.push(...emptyBranches.map((e) => ({ ...e, from: id(e.from), to: end })))
      previous = end
    }
    edges.push(...completed.map((e) => ({ from: previous, to: e.to })))
    graph = { nodes, edges }
  }
}

/** 함수의 연결하지 않은 If 갈래는 함수를 반환한다. 반복 안에서는 다음 항목으로 넘어간다. */
function withBranchReturns(p: Graph): Graph {
  const outputs = p.nodes.filter((n) => n.kind === 'function-output')
  if (outputs.length !== 1 || !p.nodes.some((n) => n.kind === 'function-input')) return p
  const bodies = new Set(p.nodes.filter((n) => n.kind === 'foreach').flatMap((n) => [...loopScope(p, n).body]))
  const execution = execEdges(p)
  const returns = p.nodes.filter((n) => n.kind === 'if' && !bodies.has(n.id)).flatMap((n) =>
    [IF_PORT.yes, IF_PORT.no].filter((port) => !execution.some((e) => e.from === n.id && (e.fromPort ?? IF_PORT.yes) === port)).map((fromPort) => ({ from: n.id, to: outputs[0].id, fromPort })))
  return { nodes: p.nodes, edges: [...p.edges, ...returns] }
}

function functionProblems(p: Graph, env: Env): string[] {
  p = withBranchReturns(p)
  const problems: string[] = []
  const boundaries = p.nodes.filter(isFunctionBoundary)
  if (!boundaries.length) return problems
  for (const kind of ['function-input', 'function-output'] as const) {
    if (boundaries.filter((n) => n.kind === kind).length !== 1) problems.push(`${KIND_NAME[kind]} 노드는 하나만 있어야 합니다`)
  }
  for (const n of boundaries) {
    const names = new Set<string>(), ids = new Set<string>()
    for (const param of n.params ?? []) {
      if (!param.name.trim() || /[{}\u0000-\u001f]/.test(param.name)) problems.push(`${nodeName(n)}: 변수 이름을 입력하세요 (중괄호·제어 문자는 쓸 수 없습니다)`)
      if (!param.id || names.has(param.name.trim()) || ids.has(param.id)) problems.push(`${nodeName(n)}: 변수 이름과 ID는 비어 있거나 겹칠 수 없습니다`)
      names.add(param.name.trim()); ids.add(param.id)
      if (!Object.hasOwn(PARAM_TYPE_NAME, param.type)) problems.push(`${nodeName(n)}: 지원하지 않는 변수 타입입니다`)
      if (n.kind === 'function-output' && !['boolean', 'number'].includes(param.type) && !incomingData(p, n.id).some((e) => (e.toPort ?? n.params?.[0]?.id) === param.id) && n.values?.[param.id] === undefined) problems.push(`${nodeName(n)}: 출력 변수 ${param.name}에 값을 연결하세요`)
    }
  }
  const live = liveNodes(p)
  const output = boundaries.find((n) => n.kind === 'function-output')
  if (output && !live.has(output.id)) problems.push('함수 Input에서 Output까지 실행 선을 연결하세요')
  const execution = execEdges(p)
  if (cyclic({ nodes: p.nodes, edges: execution })) problems.push('함수의 실행 선이 고리를 이룹니다')
  if (output) {
    const returning = new Set<string>(), pending = [output.id]
    while (pending.length) {
      const id = pending.pop()!
      if (returning.has(id)) continue
      returning.add(id)
      pending.push(...execution.filter((e) => e.to === id).map((e) => e.from))
    }
    for (const loop of p.nodes.filter((n) => n.kind === 'foreach' && returning.has(n.id))) for (const id of loopScope(p, loop).body) returning.add(id)
    for (const n of p.nodes) if (live.has(n.id) && !isData(n) && !returning.has(n.id)) problems.push(`${nodeName(n)}: 실행이 끝나면 함수 Output으로 이어 주세요`)
  }
  for (const edge of p.edges) {
    const why = edgeProblem(p, edge.from, edge.to, edge.pin, env, edge)
    if (why) problems.push(`${nodeName(byId(p, edge.to) ?? { id: edge.to })}: ${why}`)
  }
  return problems
}

/** 함수를 펼친 뒤 터미널 포트를 따라가 탭 또는 앞 실행 노드의 참조를 찾는다. */
function terminalSource(p: Graph, edge: PipeEdge, seen = new Set<string>()): TerminalInput {
  const n = byId(p, edge.from)
  if (!n) throw new Error('연결된 터미널 노드를 찾을 수 없습니다')
  if (n.kind === 'terminal') {
    if (!n.ref) throw new Error(`${nodeName(n)}: 사용할 터미널을 고르세요`)
    return { tabId: n.ref }
  }
  if (isAgent(n)) return { nodeId: n.id }
  const param = n.params?.find((v) => v.id === (edge.fromPort ?? n.params?.[0]?.id))
  if (!isFunctionBoundary(n) || param?.type !== 'terminal') throw new Error(`${nodeName(n)}: 터미널 타입의 출력 핀을 연결하세요`)
  const key = JSON.stringify([n.id, param.id])
  if (seen.has(key)) throw new Error('터미널 데이터 선이 고리를 이룹니다')
  const edges = incomingData(p, n.id).filter((e) => (e.toPort ?? n.params?.[0]?.id) === param.id)
  if (edges.length > 1) throw new Error(`${nodeName(n)}: ${param.name} 터미널은 하나만 연결할 수 있습니다`)
  if (edges.length) return terminalSource(p, edges[0], new Set([...seen, key]))
  const tabId = n.values?.[param.id]
  if (!tabId) throw new Error(`${nodeName(n)}: ${param.name} 터미널을 연결하거나 고르세요`)
  return { tabId }
}

function resolveTerminalInput(p: Graph, n: PipeNode, env: Env): TerminalInput | undefined {
  if (!isAgent(n)) return undefined
  const edges = incomingData(p, n.id).filter((e) => e.toPort === AGENT_PORT.terminal || edgeShape(p, e, env) === 'terminal')
  if (edges.length > 1) throw new Error(`${nodeName(n)}: 터미널은 하나만 연결할 수 있습니다`)
  return edges.length ? terminalSource(p, edges[0]) : n.terminalInput
}

/** 값 보기에서도 실행기와 같은 함수·반복 바인딩을 사용한다. 그래프나 실행 상태는 바꾸지 않는다. */
export function dataPreviews(p: Graph, id: string, env: Env = {}): { id: string; name: string; shape: DataShape; items: string[]; preview: boolean }[] {
  let graph = p
  let preview = p.nodes.some(isFunctionBoundary)
  if (p.nodes.some((n) => n.kind === 'template' || n.kind === 'foreach')) {
    try { graph = lowerLoops(lowerFunctions(p, env, []), env) }
    catch { preview = true } // 편집 중인 다른 함수·반복이 불완전해도 현재 설정은 볼 수 있다.
  }
  const copies = graph.nodes.filter((n) => isData(n) && n.id !== id && n.sourceIds?.includes(id))
  const expanded = new Set<string>()
  for (const copy of copies) {
    let suffix = copy.id
    while (suffix.includes('/')) { suffix = suffix.slice(suffix.indexOf('/') + 1); expanded.add(suffix) }
  }
  const nodes = copies.length ? copies.filter((n) => !expanded.has(n.id)) : graph.nodes.filter((n) => n.id === id && isData(n))
  return nodes.map((n) => ({ id: n.id, name: nodeName(n), shape: dataShape(n), preview,
    items: dataShape(n) === 'list' ? dataItems(graph, n.id, env) : [dataValue(graph, n.id, env)] }))
}

export function expandPipeline(p: Graph, env: Env = {}, stack: string[] = []): Graph {
  const graph = lowerLoops(lowerFunctions(p, env, stack), env)
  const live = liveNodes(graph)
  const actions = graph.nodes.filter((n) => live.has(n.id) && !isData(n) && n.kind !== 'start' && !isFunctionBoundary(n))
  const execution = execEdges(graph)
  const actionIds = new Set(actions.map((n) => n.id))
  const next = (id: string, seen = new Set<string>()): string[] => {
    if (actionIds.has(id)) return [id]
    if (seen.has(id)) throw new Error('함수의 실행 선이 고리를 이룹니다')
    return execution.filter((e) => e.from === id).flatMap((e) => next(e.to, new Set([...seen, id])))
  }
  const edges: PipeEdge[] = []
  for (const n of actions) for (const e of execution.filter((e) => e.from === n.id)) for (const to of next(e.to)) {
    const fromPort = n.kind === 'if' ? e.fromPort ?? IF_PORT.yes : undefined
    if (!edges.some((edge) => edge.from === n.id && edge.to === to && edge.fromPort === fromPort)) edges.push({ from: n.id, to, ...(fromPort ? { fromPort } : {}) })
  }
  return {
    nodes: actions.map((n) => {
      const terminalInput = resolveTerminalInput(graph, n, env)
      const outputSchema = agentSchema(graph, n.id, env)
      return { ...n, ...(terminalInput ? { terminalInput } : {}), ...(outputSchema ? { outputSchema } : {}), ...(n.kind === 'if' ? { condition: nodeInput(graph, n.id, env), text: '' } : { text: n.kind === 'complete' ? completeTargets(graph, n.id).join(',') : nodeInput(graph, n.id, env) }) }
    }),
    edges
  }
}

/** 결과를 쓰는 노드마다 그 결과를 낼 노드가 실행 선으로 앞에 있는지 (펼친 그래프에서) */
function outputProblems(p: Graph, name: (id: string) => string): string[] {
  const out: string[] = []
  const before = (from: string, to: string) => {
    const seen = new Set<string>()
    const stack = preds(p, to)
    while (stack.length) {
      const x = stack.pop()!
      if (x === from) return true
      if (seen.has(x)) continue
      seen.add(x)
      stack.push(...preds(p, x))
    }
    return false
  }
  for (const n of p.nodes)
    for (const src of new Set([...outputRefs(n.text), ...outputRefs(n.condition ?? ''), ...(n.terminalInput && 'nodeId' in n.terminalInput ? [n.terminalInput.nodeId] : [])]))
      if (!before(src, n.id)) out.push(`${nodeName(n)}: ${name(src)}의 출력을 쓰려면 ${name(src)}이(가) 실행 선으로 먼저 실행되어야 합니다`)
  return out
}

/** "이어서" 노드가 쓸 터미널의 주인: 같은 종류의 첫 앞 노드 */
export function continueFrom(p: Graph, node: PipeNode, available: (node: PipeNode) => boolean = () => true): PipeNode | undefined {
  if (node.terminal !== 'continue' || node.terminalInput) return undefined
  return preds(p, node.id)
    .map((id) => byId(p, id)!)
    .find((n) => n && n.kind === node.kind && available(n))
}

/**
 * 실행 전에 고쳐야 할 점. 비어 있으면 실행할 수 있다. 템플릿은 env.library에서 찾아 펼친 뒤 검사한다.
 * requireStart: 직접 실행하는 그래프는 시작 노드가 있어야 한다 (템플릿은 없어도 된다).
 * 시작에서 닿지 않는 노드는 실행하지 않으므로 검사하지 않는다.
 */
export function pipelineProblems(p: Graph, env: Env = {}, opts: { requireStart?: boolean } = {}): string[] {
  const out: string[] = functionProblems(p, env)
  const name = (id: string) => nodeName(byId(p, id) ?? { id })
  const hasStart = p.nodes.some((n) => n.kind === 'start' || n.kind === 'function-input')
  if (opts.requireStart && !hasStart) out.push('시작 노드가 없습니다. 실행은 시작 노드에서 실행 선을 따라 진행됩니다')
  const live = liveNodes(p)
  if (!p.nodes.some((n) => live.has(n.id) && !isData(n) && n.kind !== 'start'))
    out.push(hasStart ? '시작 노드에 이어진 실행 노드가 없습니다. 시작의 ▶ 핀을 끌어 다음 노드에 이으세요' : '실행할 노드(Claude·Codex·셸·함수 호출·할 일 완료)가 없습니다')
  for (const e of p.edges) {
    const why = edgeProblem(p, e.from, e.to, e.pin, env, e)
    if (why) out.push(`${name(e.from)} → ${name(e.to)}: ${why}`)
  }
  if (cyclic({ nodes: p.nodes, edges: execEdges(p) })) out.push('실행 선이 고리를 이룹니다 (끝나지 않는 순환)')
  for (const n of p.nodes) {
    if (!live.has(n.id) || n.kind === 'start' || isFunctionBoundary(n)) continue
    const who = nodeName(n)
    if (isAgent(n) && n.model && modelProblem(n.model.trim())) out.push(`${who}: ${modelProblem(n.model.trim())}`)
    if (n.kind === 'template' && !n.ref) out.push(`${who}: 호출할 함수를 고르세요`)
    if (n.kind === 'foreach') { out.push(...loopProblems(p, n)); continue }
    if (n.kind === 'task' && !n.ref) out.push(`${who}: 가져올 할 일을 고르세요`)
    if (n.kind === 'task' && n.ref && env.tasks && !env.tasks.some((t) => t.id === n.ref)) out.push(`${who}: 할 일을 찾을 수 없습니다 (${n.ref})`)
    if (n.kind === 'skill' && !n.ref) out.push(`${who}: 가져올 스킬을 고르세요`)
    if (n.kind === 'skill' && n.ref && env.skills && !env.skills.some((s) => s.id === n.ref)) out.push(`${who}: 스킬을 찾을 수 없습니다 (${n.ref})`)
    if ((n.kind === 'spec' || n.kind === 'feature' || n.kind === 'ac') && !n.ref) out.push(`${who}: 가져올 ${KIND_NAME[n.kind]}을(를) 고르세요`)
    else if ((n.kind === 'spec' || n.kind === 'feature' || n.kind === 'ac') && env.specs) {
      const t = specTarget(n, env)
      if (!(n.kind === 'spec' ? t.spec : n.kind === 'feature' ? t.feature : t.ac)) out.push(`${who}: ${KIND_NAME[n.kind]}을(를) 찾을 수 없습니다 (${n.ref})`)
    }
    if (n.kind === 'complete' && !completeTargets(p, n.id).length) out.push(`${who}: 완료할 할 일을 고르거나 할 일 노드를 이으세요`)
    if (isData(n) || n.kind === 'complete') continue
    try {
      if (n.kind !== 'template' && n.kind !== 'print' && !nodeInput(p, n.id, env)) out.push(`${who}: 내용이 비어 있습니다`)
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (out.length) return [...new Set(out)]
  let flat: Graph
  try {
    flat = expandPipeline(p, env)
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)]
  }
  for (const n of flat.nodes) {
    if (isAgent(n) && n.model && modelProblem(n.model.trim())) out.push(`${nodeName(n)}: ${modelProblem(n.model.trim())}`)
    if (n.kind !== 'complete' && n.kind !== 'if' && n.kind !== 'print' && !n.text.trim()) out.push(`${nodeName(n)}: 내용이 비어 있습니다`)
    const input = n.terminalInput
    if (!input) continue
    const terminal = 'tabId' in input ? env.terminals?.find((t) => t.id === input.tabId) : byId(flat, input.nodeId)
    if ('tabId' in input && env.terminals && (!terminal || ('exited' in terminal && terminal.exited !== undefined))) out.push(`${nodeName(n)}: 연결한 터미널이 닫혔습니다. 사용할 터미널을 다시 고르세요`)
    else if (terminal && terminal.kind !== n.kind) out.push(`${nodeName(n)}: ${KIND_NAME[n.kind]} 노드에는 같은 종류의 터미널을 연결하세요`)
  }
  const flatName = (id: string) => nodeName(flat.nodes.find((x) => x.id === id) ?? byId(p, id) ?? { id })
  return [...new Set([...out, ...outputProblems(flat, flatName), ...continueProblems(flat)])]
}

function cyclic(p: Graph): boolean {
  const state = new Map<string, number>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    const hit = p.edges.filter((e) => e.from === id).some((e) => visit(e.to))
    state.set(id, 2)
    return hit
  }
  return p.nodes.some((n) => visit(n.id))
}

/** "이어서" 노드마다 이어 쓸 같은 종류의 앞 노드가 있고, 한 터미널을 둘이 나눠 쓰지 않는지 */
function continueProblems(p: Graph): string[] {
  const out: string[] = []
  const taken = new Map<string, string>()
  for (const n of p.nodes) {
    if (n.terminal !== 'continue' || n.terminalInput || n.kind === 'complete' || n.kind === 'if' || n.kind === 'print') continue
    const from = continueFrom(p, n)
    if (!from) {
      out.push(`${nodeName(n)}: 이어서 실행하려면 같은 종류(${n.kind})의 앞 노드가 있어야 합니다`)
      continue
    }
    if (taken.has(from.id)) out.push(`${nodeName(from)}의 터미널을 ${taken.get(from.id)}와 ${nodeName(n)}가 함께 이어 쓸 수 없습니다`)
    else taken.set(from.id, nodeName(n))
  }
  return out
}

/* ---------- 실행 ---------- */

export type NodeStatus = 'waiting' | 'starting' | 'running' | 'done' | 'failed' | 'skipped'

export interface NodeRun {
  name?: string
  kind?: NodeKind
  sourceIds?: string[]
  status: NodeStatus
  termId?: string
  /** 셸 명령의 종료 코드 */
  code?: number
  /** 에이전트 응답·셸 출력·Print 값. 출력 로그와 뒤 노드에서 읽는다. */
  output?: string
  outputAt?: string
  outputOrder?: number
  /** 출력 계약을 통과한 Dictionary. */
  structuredOutput?: JsonObject
  message?: string
  conditionResult?: boolean
  skipReason?: 'condition' | 'failed'
}

export interface RunState {
  runId: string
  pipelineId: string
  title: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  nodes: Record<string, NodeRun>
  started: string
}

export interface RunnerDeps {
  /** session과 같은 세션의 열린 터미널을 재사용하고, 없으면 새 탭을 연다. */
  createTerminal: (kind: TerminalKind, label: string, session?: string, model?: string) => Promise<TerminalInfo & { reused?: boolean }>
  hasTerminal: (termId: string) => boolean
  getTerminal: (termId: string) => TerminalInfo | undefined
  whenReady: (termId: string) => Promise<void>
  submit: (termId: string, text: string) => void
  runCommand: (termId: string, command: string) => void
  setModel?: (termId: string, model: string) => Promise<void>
  beginOutputCapture?: (termId: string, prompt: string) => void
  readAgentOutput?: (termId: string) => string | undefined
  endOutputCapture?: (termId: string) => void
  /** "할 일 완료" 노드: Task를 완료 상태로 바꾼다 */
  completeTasks: (ids: string[]) => Promise<void>
  emit: (state: RunState) => void
  now?: () => number
}

/** 프롬프트를 보낸 직후 이전 응답의 끝 신호가 늦게 와도 이 노드가 끝난 것으로 보지 않는 시간 */
const GRACE_MS = 1500

interface Run extends RunState {
  pipe: Pipeline
  sentAt: Record<string, number>
}

export class PipelineRunner {
  private runs = new Map<string, Run>()
  /** 터미널 → 지금 그 터미널에서 실행 중인 노드 */
  private owner = new Map<string, { runId: string; nodeId: string }>()
  private seq = 0
  private outputSeq = 0

  constructor(private deps: RunnerDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private publish(run: Run): RunState {
    const { pipe: _p, sentAt: _s, ...state } = run
    const copy = JSON.parse(JSON.stringify(state)) as RunState
    this.deps.emit(copy)
    return copy
  }

  list(): RunState[] {
    return [...this.runs.values()].map(({ pipe: _p, sentAt: _s, ...s }) => JSON.parse(JSON.stringify(s)))
  }

  start(pipe: Pipeline, allowEmpty = false): RunState {
    const problems = allowEmpty && !pipe.nodes.length ? [] : pipelineProblems(pipe)
    if (problems.length) throw new Error(problems.join('\n'))
    if ([...this.runs.values()].some((r) => r.pipelineId === pipe.id && r.status === 'running')) throw new Error('이 작업 그래프는 이미 실행 중입니다')
    // 같은 그래프의 지난 실행 기록은 새 실행으로 바꾼다
    for (const [id, r] of this.runs) if (r.pipelineId === pipe.id) this.runs.delete(id)
    const run: Run = {
      runId: `run-${++this.seq}`,
      pipelineId: pipe.id,
      title: pipe.title,
      status: 'running',
      nodes: Object.fromEntries(pipe.nodes.map((n) => [n.id, { status: 'waiting' as NodeStatus, name: nodeName(n), kind: n.kind, sourceIds: n.sourceIds ?? [n.id] }])),
      started: new Date(this.now()).toISOString(),
      pipe: JSON.parse(JSON.stringify(pipe)),
      sentAt: {}
    }
    this.runs.set(run.runId, run)
    this.tick(run)
    return this.publish(run)
  }

  /** 앞 노드가 모두 끝난 대기 노드를 시작하고, 더 할 것이 없으면 실행을 끝낸다. */
  private tick(run: Run, readyTerminal?: string): void {
    if (run.status !== 'running') return
    const { pipe } = run
    let changed: boolean
    do {
      changed = false
      for (const n of pipe.nodes) {
        const st = run.nodes[n.id]
        if (st.status !== 'waiting') continue
        const before = pipe.edges.filter((e) => e.to === n.id).map((e) => {
          const source = run.nodes[e.from]
          if (source.status === 'failed' || (source.status === 'skipped' && source.skipReason !== 'condition')) return 'failed'
          if (source.status === 'skipped') return 'inactive'
          if (source.status !== 'done') return 'pending'
          if (source.conditionResult !== undefined && source.conditionResult !== ((e.fromPort ?? IF_PORT.yes) === IF_PORT.yes)) return 'inactive'
          return 'active'
        })
        if (before.includes('failed')) {
          Object.assign(st, { status: 'skipped', skipReason: 'failed', message: '앞 작업이 실패해 건너뛰었습니다' })
        } else if (before.includes('pending')) continue
        else if (before.length && before.every((s) => s === 'inactive')) {
          Object.assign(st, { status: 'skipped', skipReason: 'condition', message: '조건에서 선택되지 않은 경로입니다' })
        } else void this.launch(run, n, readyTerminal)
        changed = true
      }
    } while (changed)
    const active = pipe.nodes.some((n) => ['waiting', 'starting', 'running'].includes(run.nodes[n.id].status))
    if (!active) run.status = pipe.nodes.some((n) => run.nodes[n.id].status === 'failed') ? 'failed' : 'done'
  }

  private async launch(run: Run, node: PipeNode, readyTerminal?: string) {
    const st = run.nodes[node.id]
    st.status = 'starting'
    try {
      if (node.kind === 'print') {
        this.recordOutput(st, fillOutputs(node.text, (id) => {
          const output = run.nodes[id]?.output
          if (output === undefined) throw new Error(`${id}: 앞 작업의 응답을 받지 못했습니다`)
          return output
        }))
        st.status = 'done'
        return
      }
      if (node.kind === 'if') {
        st.conditionResult = boolValue(fillOutputs(node.condition ?? nodeInput(run.pipe, node.id), (id) => {
          const output = run.nodes[id]?.output
          if (output === undefined) throw new Error(`${id}: 앞 작업의 응답을 받지 못했습니다`)
          return output
        }))
        st.status = 'done'
        st.message = st.conditionResult ? 'True 경로' : 'False 경로'
        return
      }
      if (node.kind === 'complete') {
        const ids = node.text.split(',').filter(Boolean)
        await this.deps.completeTasks(ids)
        if (run.status !== 'running') return
        st.status = 'done'
        st.message = `${ids.join(', ')} 완료`
        this.tick(run)
        this.publish(run)
        return
      }
      let termId: string
      let needsReady = false
      const from = continueFrom(run.pipe, node, (n) => run.nodes[n.id].status === 'done')
      if (node.terminalInput) {
        const input = node.terminalInput
        termId = 'tabId' in input ? input.tabId : run.nodes[input.nodeId]?.termId ?? ''
      } else if (from) {
        termId = run.nodes[from.id].termId!
        if (!termId || !this.deps.hasTerminal(termId)) throw new Error(`${nodeName(from)}의 터미널이 닫혀 이어서 실행할 수 없습니다`)
      } else {
        const session = node.kind === 'claude' || node.kind === 'codex' ? node.session : undefined
        const model = isAgent(node) ? node.model?.trim() || undefined : undefined
        const terminal = model
          ? await this.deps.createTerminal(node.kind as TerminalKind, nodeName(node), session, model)
          : await this.deps.createTerminal(node.kind as TerminalKind, nodeName(node), session)
        termId = terminal.id
        needsReady = !terminal.reused
      }
      if (run.status !== 'running') return
      if (this.owner.has(termId)) throw new Error('이 세션의 터미널에서 다른 작업 노드가 실행 중입니다. 해당 작업이 끝난 뒤 다시 실행하세요')
      const terminal = this.deps.getTerminal(termId)
      if (node.terminalInput) {
        if (!terminal || terminal.exited !== undefined) throw new Error('연결한 터미널이 닫혔습니다. 사용할 터미널을 다시 고르세요')
        if (terminal.kind !== node.kind) throw new Error(`${KIND_NAME[node.kind]} 노드에는 같은 종류의 터미널을 연결하세요`)
      }
      // 완료 알림이 상태 제목(Ready)보다 먼저 올 수 있다. 방금 완료한 탭은 즉시 이어 쓴다.
      if (!needsReady && terminal?.activity === 'working' && termId !== readyTerminal) throw new Error('연결한 터미널에서 작업이 진행 중입니다. 작업이 끝난 뒤 다시 실행하세요')
      st.termId = termId
      // 새 탭의 준비를 기다리는 동안에도 다른 노드가 같은 터미널에 먼저 입력하지 못하게 한다.
      this.owner.set(termId, { runId: run.runId, nodeId: node.id })
      if (needsReady) await this.deps.whenReady(termId)
      if (run.status !== 'running') return
      if (isAgent(node) && node.model?.trim() && this.deps.setModel) await this.deps.setModel(termId, node.model.trim())
      if (run.status !== 'running') return
      const ready = this.deps.getTerminal(termId)
      if (ready && ready.kind !== node.kind) throw new Error('에이전트가 종료되었습니다. 모델과 CLI 실행 설정을 확인하세요')
      st.status = 'running'
      run.sentAt[node.id] = this.now()
      // 앞에서 끝난 노드의 결과를 이제 넣는다
      const text = fillOutputs(node.text, (id) => {
        const output = run.nodes[id]?.output
        if (output === undefined) throw new Error(`${id}: 앞 작업의 응답을 받지 못했습니다`)
        return output
      })
      if (node.kind === 'shell') this.deps.runCommand(termId, text)
      else {
        const prompt = node.outputSchema ? structuredPrompt(text, node.outputSchema) : text
        this.deps.beginOutputCapture?.(termId, prompt)
        this.deps.submit(termId, prompt)
      }
    } catch (e) {
      if (st.termId && this.owner.get(st.termId)?.runId === run.runId && this.owner.get(st.termId)?.nodeId === node.id) {
        this.deps.endOutputCapture?.(st.termId)
        this.owner.delete(st.termId)
      }
      st.status = 'failed'
      st.message = e instanceof Error ? e.message : String(e)
      this.tick(run)
    }
    this.publish(run)
  }

  private recordOutput(node: NodeRun, output: string): void {
    Object.assign(node, { output, outputAt: new Date(this.now()).toISOString(), outputOrder: ++this.outputSeq })
  }

  private finish(termId: string, ok: boolean, patch: Partial<NodeRun> = {}, manual = false): RunState | null {
    const o = this.owner.get(termId)
    if (!o) return null
    const run = this.runs.get(o.runId)
    if (!run) return null
    const st = run.nodes[o.nodeId]
    if (st.status !== 'running') return null
    if (!manual && this.now() - (run.sentAt[o.nodeId] ?? 0) < GRACE_MS) return null
    this.deps.endOutputCapture?.(termId)
    this.owner.delete(termId)
    Object.assign(st, patch, { status: ok ? 'done' : 'failed' })
    if (patch.output !== undefined) this.recordOutput(st, patch.output)
    this.tick(run, ok ? termId : undefined)
    return this.publish(run)
  }

  /** 에이전트가 응답을 끝냈을 때 */
  agentDone(termId: string, manual = false): RunState | null {
    const o = this.owner.get(termId)
    if (!o) return null
    const node = this.runs.get(o.runId)?.pipe.nodes.find((n) => n.id === o.nodeId)
    if (!node || node.kind === 'shell') return null
    const output = this.deps.readAgentOutput?.(termId)
    // 출처가 확인된 최종 응답이 없는 완료 신호로 작업을 끝내거나 스키마를 검사하지 않는다.
    if (!manual && this.deps.readAgentOutput && output === undefined) return null
    // 요청 직전에 지난 출력을 지웠으므로 실제 응답을 받았다면 빠른 완료도 놓치지 않는다.
    // 본문 없는 예전 완료 신호에는 기존 유예 시간을 적용한다.
    const received = manual || output !== undefined
    try {
      if (node.outputSchema) {
        if (output === undefined) throw new Error('최종 응답을 받지 못했습니다. CLI 완료 알림을 확인하고 다시 실행하세요')
        const structuredOutput = validateOutput(output, node.outputSchema)
        return this.finish(termId, true, { output: JSON.stringify(structuredOutput, null, 2), structuredOutput }, received)
      }
      return this.finish(termId, true, output === undefined ? {} : { output }, received)
    } catch (e) {
      return this.finish(termId, false, { output, message: e instanceof Error ? e.message : String(e) }, received)
    }
  }

  /** 셸 명령이 끝났을 때. 종료 코드가 0이 아니면 실패로 두고 뒤 작업은 건너뛴다. 출력은 데이터 출력으로 넘긴다. */
  commandDone(termId: string, code: number, output?: string): RunState | null {
    return this.finish(termId, code === 0, { code, ...(output !== undefined ? { output } : {}), ...(code ? { message: `종료 코드 ${code}` } : {}) }, true)
  }

  /** 사람이 직접 "이 노드는 끝났다"고 넘긴다 (신호를 놓쳤을 때) */
  markDone(runId: string, nodeId: string): RunState | null {
    const st = this.runs.get(runId)?.nodes[nodeId]
    if (!st?.termId || st.status !== 'running') return null
    const node = this.runs.get(runId)?.pipe.nodes.find((n) => n.id === nodeId)
    return node && isAgent(node) ? this.agentDone(st.termId, true) : this.finish(st.termId, true, {}, true)
  }

  terminalExit(termId: string): RunState | null {
    return this.finish(termId, false, { message: '터미널이 닫혔습니다' }, true)
  }

  /** 실행을 멈춘다. 이미 열린 터미널은 그대로 둔다. */
  stop(runId: string): RunState | null {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'running') return null
    run.status = 'stopped'
    for (const [termId, o] of this.owner) if (o.runId === runId) { this.deps.endOutputCapture?.(termId); this.owner.delete(termId) }
    for (const st of Object.values(run.nodes)) if (st.status === 'waiting' || st.status === 'starting' || st.status === 'running') st.status = 'skipped'
    return this.publish(run)
  }
}
