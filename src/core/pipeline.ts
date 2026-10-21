import type { TerminalInfo, TerminalKind } from './terminal'

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
export const NODE_KINDS = ['start', 'claude', 'codex', 'shell', 'template', 'complete', 'text', 'list', 'join', 'task', 'skill', 'spec', 'feature', 'ac'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const DATA_KINDS: NodeKind[] = ['text', 'list', 'join', 'task', 'skill', 'spec', 'feature', 'ac']
export const isData = (n: Pick<PipeNode, 'kind'>) => DATA_KINDS.includes(n.kind)

/** 데이터의 형태: 단일은 글 하나, 리스트는 글 여러 개 (기능 명세는 기능들의 리스트) */
export type DataShape = 'single' | 'list'
export const dataShape = (n: Pick<PipeNode, 'kind'>): DataShape => (n.kind === 'list' || n.kind === 'spec' ? 'list' : 'single')
export const SHAPE_NAME: Record<DataShape, string> = { single: '단일', list: '리스트' }

/** 작업 결과를 데이터로 내보내는 실행 노드 (셸: 명령 출력) */
export const hasDataOut = (n: Pick<PipeNode, 'kind'>) => n.kind === 'shell'

export interface PipeNode {
  /** 노드를 가리키는 값 (새 노드는 uuid, 예전 그래프의 노드는 n1·n2…). 선은 이 값으로 잇는다 */
  id: string
  /** 사람이 붙이는 이름. 한 그래프 안에서 겹치지 않는다 (기본은 노드 종류 이름, 겹치면 뒤에 숫자) */
  name?: string
  kind: NodeKind
  /**
   * 에이전트면 프롬프트, 셸이면 명령, 템플릿이면 {{입력}} 자리에 넣을 글 (들어오는 데이터 선의 글이 뒤에 붙는다).
   * 텍스트 노드면 그 글, 합치기 노드면 구분자 (비우면 빈 줄).
   */
  text: string
  /** 리스트 노드: 적어 둔 항목 (입력이 들어오면 대신 들어온 데이터를 항목으로 쓴다) */
  items?: string[]
  /** new: 지정한 세션 또는 새 탭에서, continue: 앞 노드(같은 종류)의 터미널에서 이어서 (대화 맥락 유지) */
  terminal: 'new' | 'continue'
  /**
   * Claude Code·Codex 노드: 이어서 쓸 로컬 세션 id. 이미 열린 탭이 있으면 그대로 쓴다 (세션 불러오기).
   * 비우면 새 세션으로 연다. "이어서"(continue) 노드는 앞 노드의 터미널을 쓰므로 쓰지 않는다.
   */
  session?: string
  /**
   * 템플릿 노드: 작업 그래프 id (실행할 때마다 지금 내용을 읽는다). 할 일·할 일 완료 노드: Task id.
   * 명세 노드: 명세 id, 기능 노드: "명세 id#기능 ID", 수용 기준 노드: "명세 id#AC ID" (예: spec-x#DM-F02-AC1)
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

type Graph = Pick<Pipeline, 'nodes' | 'edges'>

/** 그래프 밖에서 가져오는 것: 템플릿으로 쓸 작업 그래프들, 할 일 */
export interface Env {
  library?: Pick<Pipeline, 'id' | 'title' | 'nodes' | 'edges'>[]
  tasks?: { id: string; title: string; body: string; status: string }[]
  /** 스킬: id는 "project:이름" / "user:이름" */
  skills?: { id: string; name: string; body: string }[]
  /** 도메인의 기능·규칙 명세 */
  specs?: EnvSpec[]
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
  label: string
}
export function innerValues(n: Pick<PipeNode, 'kind' | 'ref' | 'items'>, env: Env): InnerValue[] {
  // 리스트 노드: 적어 둔 항목 하나하나를 단일 텍스트 노드로
  if (n.kind === 'list') return (n.items ?? []).filter((t) => t.trim()).map((t) => ({ kind: 'text', text: t, label: plain(t).split('\n')[0] }))
  const { spec, feature } = specTarget(n, env)
  if (n.kind === 'spec' && spec) return spec.features.map((f) => ({ kind: 'feature', ref: `${spec.id}#${f.id}`, label: `${f.id} ${f.name}` }))
  if (n.kind === 'feature' && spec && feature) return feature.acs.map((a) => ({ kind: 'ac', ref: `${spec.id}#${a.id}`, label: `AC${a.num} ${plain(a.text).split('\n')[0]}` }))
  return []
}

/** 템플릿 안의 노드 id는 "템플릿 노드 id/안쪽 id"로 펼친다 */
export const TEMPLATE_SEP = '/'
/** 템플릿 프롬프트·명령에서 템플릿 노드의 입력으로 바뀌는 자리 */
export const TEMPLATE_INPUT = '{{입력}}'

const preds = (p: Pick<Pipeline, 'edges'>, id: string) => p.edges.filter((e) => e.to === id).map((e) => e.from)
const byId = (p: Graph, id: string) => p.nodes.find((n) => n.id === id)

/** 글을 넘기는 선인지: 데이터 노드에서 나오거나 실행 노드의 데이터 출력에서 나온 선 */
export function isDataEdge(p: Graph, e: PipeEdge): boolean {
  const a = byId(p, e.from)
  return e.pin === 'data' || (!!a && isData(a))
}

/** 실행 노드끼리의 선만 (데이터 선을 뺀 실행 흐름) */
export function execEdges(p: Graph): PipeEdge[] {
  return p.edges.filter((e) => {
    const a = byId(p, e.from)
    const b = byId(p, e.to)
    return a && b && !isData(a) && !isData(b) && e.pin !== 'data'
  })
}

/** 노드로 글을 넘기는 노드 (데이터 노드, 또는 결과를 내보내는 실행 노드). 위에 있는 노드부터 (같으면 왼쪽부터). */
function dataPreds(p: Graph, id: string): PipeNode[] {
  return p.edges
    .filter((e) => e.to === id && isDataEdge(p, e))
    .map((e) => byId(p, e.from)!)
    .filter(Boolean)
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
}

/**
 * 실행 노드의 결과가 들어갈 자리. 실행 전에는 결과를 모르므로 글에 이 표시를 넣어 두고,
 * 실행기가 그 노드가 끝난 뒤 결과로 바꾼다 (fillOutputs).
 */
export const outputToken = (id: string) => `\u0000출력:${id}\u0000`
const OUTPUT_TOKEN = /\u0000출력:([^\u0000]*)\u0000/g
/** 글에 들어 있는 결과 자리의 노드 id들 */
export const outputRefs = (text: string) => [...text.matchAll(OUTPUT_TOKEN)].map((m) => m[1])
/** 결과 자리를 결과로 바꾼다 (화면에서 "[셸의 출력]"처럼 보여 줄 때도 쓴다) */
export const fillOutputs = (text: string, value: (id: string) => string) => text.replace(OUTPUT_TOKEN, (_m, id: string) => value(id))

/** 할 일 노드가 내보내는 글 */
export function taskText(t: { id: string; title: string; body: string }): string {
  return [`할 일 ${t.id}: ${t.title}`, t.body.trim()].filter(Boolean).join('\n\n')
}

/** 데이터 노드가 내보내는 글. 리스트는 항목을 빈 줄로 이어 한 번에 내보낸다. 실행 노드면 그 결과가 들어갈 자리 */
export function dataValue(p: Graph, id: string, env: Env = {}, seen: string[] = []): string {
  if (seen.includes(id)) throw new Error(`데이터 선이 고리를 이룹니다: ${[...seen, id].join(' → ')}`)
  const n = byId(p, id)
  if (!n) return ''
  if (!isData(n)) return outputToken(n.id)
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
  const inputs = dataPreds(p, id).map((x) => dataValue(p, x.id, env, [...seen, id]))
  // 텍스트 노드: 입력이 들어오면 적어 둔 글 대신 들어온 글을 그대로 내보낸다
  if (n.kind === 'text') return inputs.length ? inputs.filter((t) => t.trim()).join('\n\n') : n.text
  // 합치기: 리스트가 들어오면 그 항목들을 하나씩 잇는다
  const sep = n.text ? n.text.replace(/\\n/g, '\n') : '\n\n'
  return dataPreds(p, id)
    .flatMap((x) => dataItems(p, x.id, env, [...seen, id]))
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
  const from = dataPreds(p, id)
  const items = from.length ? from.flatMap((x) => dataItems(p, x.id, env, [...seen, id])) : (n.items ?? [])
  return items.filter((t) => t.trim())
}

/** 입력 핀이 있는 노드인지 (시작·할 일·스킬·명세 계열 노드는 출력만 있다) */
export const hasInput = (n: Pick<PipeNode, 'kind'>) => !['task', 'start', 'skill', 'spec', 'feature', 'ac'].includes(n.kind)

/**
 * 실행되는 노드: 시작 노드가 있으면 시작에서 실행 선을 따라 닿는 노드만, 없으면 모든 실행 노드.
 * 그 노드들에 글을 넘기는 데이터 노드도 넣는다. 여기 없는 노드는 실행하지도 검사하지도 않는다.
 */
export function liveNodes(p: Graph): Set<string> {
  const ex = execEdges(p)
  const live = new Set<string>()
  const starts = p.nodes.filter((n) => n.kind === 'start').map((n) => n.id)
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
export function edgeProblem(p: Graph, from: string, to: string, pin?: PipeEdge['pin']): string | null {
  const a = byId(p, from)
  const b = byId(p, to)
  if (!a || !b) return '노드를 찾을 수 없습니다'
  if (from === to) return '자기 자신에게는 이을 수 없습니다'
  if (pin === 'data' && (isData(a) || !hasDataOut(a))) return `${KIND_NAME[a.kind]} 노드에는 결과를 내보내는 데이터 출력이 없습니다`
  if (!pin && !isData(a) && isData(b)) return '실행 노드의 실행 출력에서 데이터 노드로는 이을 수 없습니다'
  if (!hasInput(b)) return `${KIND_NAME[b.kind]} 노드에는 입력이 없습니다`
  return null
}

export const KIND_NAME: Record<NodeKind, string> = {
  start: '시작',
  claude: 'Claude Code',
  codex: 'Codex',
  shell: '셸',
  template: '템플릿',
  complete: '할 일 완료',
  text: '텍스트',
  list: '리스트',
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
  return [n.text, ...dataPreds(p, id).map((x) => dataValue(p, x.id, env))]
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n')
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
export function expandPipeline(p: Graph, env: Env = {}, stack: string[] = []): Graph {
  const nodes: PipeNode[] = []
  const edges: PipeEdge[] = []
  const entries = new Map<string, string[]>()
  const exits = new Map<string, string[]>()
  const live = liveNodes(p)
  for (const n of p.nodes) {
    // 시작 노드는 자리만 표시한다: 빼면 그 뒤 노드가 앞 노드 없는 첫 노드가 된다
    if (isData(n) || n.kind === 'start' || !live.has(n.id)) continue
    if (n.kind !== 'template') {
      nodes.push({ ...n, text: n.kind === 'complete' ? completeTargets(p, n.id).join(',') : nodeInput(p, n.id, env) })
      entries.set(n.id, [n.id])
      exits.set(n.id, [n.id])
      continue
    }
    const tpl = env.library?.find((t) => t.id === n.ref)
    if (!tpl) throw new Error(`${nodeName(n)}: 템플릿을 찾을 수 없습니다 (${n.ref ?? '고르지 않음'})`)
    if (stack.includes(tpl.id)) throw new Error(`${nodeName(n)}: 템플릿 "${tpl.title}"이(가) 자기 자신을 다시 씁니다`)
    const inner = expandPipeline(tpl, env, [...stack, tpl.id])
    if (!inner.nodes.length) throw new Error(`${nodeName(n)}: 템플릿 "${tpl.title}"에 실행할 노드가 없습니다`)
    const input = nodeInput(p, n.id, env)
    const id = (x: string) => `${n.id}${TEMPLATE_SEP}${x}`
    for (const x of inner.nodes)
      nodes.push({
        ...x,
        id: id(x.id),
        name: `${nodeName(n)}${TEMPLATE_SEP}${nodeName(x)}`,
        // 템플릿 안쪽 노드의 결과 자리도 펼친 id로 (바깥 입력은 바꾼 뒤에 넣는다)
        text: x.kind === 'complete' ? x.text : fillOutputs(x.text, (o) => outputToken(id(o))).split(TEMPLATE_INPUT).join(input)
      })
    for (const e of inner.edges) edges.push({ from: id(e.from), to: id(e.to) })
    entries.set(n.id, inner.nodes.filter((x) => !inner.edges.some((e) => e.to === x.id)).map((x) => id(x.id)))
    exits.set(n.id, inner.nodes.filter((x) => !inner.edges.some((e) => e.from === x.id)).map((x) => id(x.id)))
  }
  for (const e of execEdges(p)) for (const a of exits.get(e.from) ?? []) for (const b of entries.get(e.to) ?? []) edges.push({ from: a, to: b })
  return { nodes, edges }
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
    for (const src of new Set(outputRefs(n.text)))
      if (!before(src, n.id)) out.push(`${nodeName(n)}: ${name(src)}의 출력을 쓰려면 ${name(src)}이(가) 실행 선으로 먼저 실행되어야 합니다`)
  return out
}

/** "이어서" 노드가 쓸 터미널의 주인: 같은 종류의 첫 앞 노드 */
export function continueFrom(p: Graph, node: PipeNode): PipeNode | undefined {
  if (node.terminal !== 'continue') return undefined
  return preds(p, node.id)
    .map((id) => byId(p, id)!)
    .find((n) => n && n.kind === node.kind)
}

/**
 * 실행 전에 고쳐야 할 점. 비어 있으면 실행할 수 있다. 템플릿은 env.library에서 찾아 펼친 뒤 검사한다.
 * requireStart: 직접 실행하는 그래프는 시작 노드가 있어야 한다 (템플릿은 없어도 된다).
 * 시작에서 닿지 않는 노드는 실행하지 않으므로 검사하지 않는다.
 */
export function pipelineProblems(p: Graph, env: Env = {}, opts: { requireStart?: boolean } = {}): string[] {
  const out: string[] = []
  const name = (id: string) => nodeName(byId(p, id) ?? { id })
  const hasStart = p.nodes.some((n) => n.kind === 'start')
  if (opts.requireStart && !hasStart) out.push('시작 노드가 없습니다. 실행은 시작 노드에서 실행 선을 따라 진행됩니다')
  const live = liveNodes(p)
  if (!p.nodes.some((n) => live.has(n.id) && !isData(n) && n.kind !== 'start'))
    out.push(hasStart ? '시작 노드에 이어진 실행 노드가 없습니다. 시작의 ▶ 핀을 끌어 다음 노드에 이으세요' : '실행할 노드(Claude·Codex·셸·템플릿·할 일 완료)가 없습니다')
  for (const e of p.edges) {
    const why = edgeProblem(p, e.from, e.to, e.pin)
    if (why) out.push(`${name(e.from)} → ${name(e.to)}: ${why}`)
  }
  if (cyclic({ nodes: p.nodes, edges: execEdges(p) })) out.push('실행 선이 고리를 이룹니다 (끝나지 않는 순환)')
  for (const n of p.nodes) {
    if (!live.has(n.id) || n.kind === 'start') continue
    const who = nodeName(n)
    if (n.kind === 'template' && !n.ref) out.push(`${who}: 쓸 템플릿을 고르세요`)
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
      if (n.kind !== 'template' && !nodeInput(p, n.id, env)) out.push(`${who}: 내용이 비어 있습니다`)
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
  for (const n of flat.nodes) if (n.kind !== 'complete' && !n.text.trim()) out.push(`${nodeName(n)}: 내용이 비어 있습니다`)
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
    if (n.terminal !== 'continue' || n.kind === 'complete') continue
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
  status: NodeStatus
  termId?: string
  /** 셸 명령의 종료 코드 */
  code?: number
  /** 셸 명령의 출력 (데이터 출력 핀으로 뒤 노드에 넘긴다) */
  output?: string
  message?: string
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
  createTerminal: (kind: TerminalKind, label: string, session?: string) => Promise<TerminalInfo>
  hasTerminal: (termId: string) => boolean
  whenReady: (termId: string) => Promise<void>
  submit: (termId: string, text: string) => void
  runCommand: (termId: string, command: string) => void
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

  start(pipe: Pipeline): RunState {
    const problems = pipelineProblems(pipe)
    if (problems.length) throw new Error(problems.join('\n'))
    if ([...this.runs.values()].some((r) => r.pipelineId === pipe.id && r.status === 'running')) throw new Error('이 작업 그래프는 이미 실행 중입니다')
    // 같은 그래프의 지난 실행 기록은 새 실행으로 바꾼다
    for (const [id, r] of this.runs) if (r.pipelineId === pipe.id) this.runs.delete(id)
    const run: Run = {
      runId: `run-${++this.seq}`,
      pipelineId: pipe.id,
      title: pipe.title,
      status: 'running',
      nodes: Object.fromEntries(pipe.nodes.map((n) => [n.id, { status: 'waiting' as NodeStatus }])),
      started: new Date(this.now()).toISOString(),
      pipe: JSON.parse(JSON.stringify(pipe)),
      sentAt: {}
    }
    this.runs.set(run.runId, run)
    this.tick(run)
    return this.publish(run)
  }

  /** 앞 노드가 모두 끝난 대기 노드를 시작하고, 더 할 것이 없으면 실행을 끝낸다. */
  private tick(run: Run): void {
    if (run.status !== 'running') return
    const { pipe } = run
    for (const n of pipe.nodes) {
      const st = run.nodes[n.id]
      if (st.status !== 'waiting') continue
      const before = preds(pipe, n.id).map((id) => run.nodes[id].status)
      if (before.some((s) => s === 'failed' || s === 'skipped')) {
        st.status = 'skipped'
        st.message = '앞 작업이 실패해 건너뛰었습니다'
        continue
      }
      if (before.every((s) => s === 'done')) void this.launch(run, n)
    }
    // 건너뜀이 다음 노드로 번지도록 바뀐 게 있으면 한 번 더
    const pending = pipe.nodes.filter((n) => run.nodes[n.id].status === 'waiting')
    if (pending.some((n) => preds(pipe, n.id).some((id) => ['failed', 'skipped'].includes(run.nodes[id].status)))) return this.tick(run)
    const active = pipe.nodes.some((n) => ['waiting', 'starting', 'running'].includes(run.nodes[n.id].status))
    if (!active) run.status = pipe.nodes.some((n) => run.nodes[n.id].status === 'failed') ? 'failed' : 'done'
  }

  private async launch(run: Run, node: PipeNode) {
    const st = run.nodes[node.id]
    st.status = 'starting'
    try {
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
      const from = continueFrom(run.pipe, node)
      if (from) {
        termId = run.nodes[from.id].termId!
        if (!termId || !this.deps.hasTerminal(termId)) throw new Error(`${nodeName(from)}의 터미널이 닫혀 이어서 실행할 수 없습니다`)
      } else {
        const session = node.kind === 'claude' || node.kind === 'codex' ? node.session : undefined
        termId = (await this.deps.createTerminal(node.kind as TerminalKind, nodeName(node), session)).id
        await this.deps.whenReady(termId)
      }
      if (run.status !== 'running') return
      if (this.owner.has(termId)) throw new Error('이 세션의 터미널에서 다른 작업 노드가 실행 중입니다. 해당 작업이 끝난 뒤 다시 실행하세요')
      st.termId = termId
      st.status = 'running'
      this.owner.set(termId, { runId: run.runId, nodeId: node.id })
      run.sentAt[node.id] = this.now()
      // 앞에서 끝난 노드의 결과를 이제 넣는다
      const text = fillOutputs(node.text, (id) => run.nodes[id]?.output ?? '')
      if (node.kind === 'shell') this.deps.runCommand(termId, text)
      else this.deps.submit(termId, text)
    } catch (e) {
      if (st.termId && this.owner.get(st.termId)?.runId === run.runId && this.owner.get(st.termId)?.nodeId === node.id) this.owner.delete(st.termId)
      st.status = 'failed'
      st.message = e instanceof Error ? e.message : String(e)
      this.tick(run)
    }
    this.publish(run)
  }

  private finish(termId: string, ok: boolean, patch: Partial<NodeRun> = {}, manual = false): RunState | null {
    const o = this.owner.get(termId)
    if (!o) return null
    const run = this.runs.get(o.runId)
    if (!run) return null
    if (!manual && this.now() - (run.sentAt[o.nodeId] ?? 0) < GRACE_MS) return null
    this.owner.delete(termId)
    const st = run.nodes[o.nodeId]
    if (st.status !== 'running') return null
    Object.assign(st, patch, { status: ok ? 'done' : 'failed' })
    this.tick(run)
    return this.publish(run)
  }

  /** 에이전트가 응답을 끝냈을 때 */
  agentDone(termId: string, manual = false): RunState | null {
    const o = this.owner.get(termId)
    if (!o) return null
    const kind = this.runs.get(o.runId)?.pipe.nodes.find((n) => n.id === o.nodeId)?.kind
    if (kind === 'shell') return null
    return this.finish(termId, true, {}, manual)
  }

  /** 셸 명령이 끝났을 때. 종료 코드가 0이 아니면 실패로 두고 뒤 작업은 건너뛴다. 출력은 데이터 출력으로 넘긴다. */
  commandDone(termId: string, code: number, output?: string): RunState | null {
    return this.finish(termId, code === 0, { code, ...(output !== undefined ? { output } : {}), ...(code ? { message: `종료 코드 ${code}` } : {}) }, true)
  }

  /** 사람이 직접 "이 노드는 끝났다"고 넘긴다 (신호를 놓쳤을 때) */
  markDone(runId: string, nodeId: string): RunState | null {
    const st = this.runs.get(runId)?.nodes[nodeId]
    if (!st?.termId || st.status !== 'running') return null
    return this.finish(st.termId, true, {}, true)
  }

  terminalExit(termId: string): RunState | null {
    return this.finish(termId, false, { message: '터미널이 닫혔습니다' }, true)
  }

  /** 실행을 멈춘다. 이미 열린 터미널은 그대로 둔다. */
  stop(runId: string): RunState | null {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'running') return null
    run.status = 'stopped'
    for (const [termId, o] of this.owner) if (o.runId === runId) this.owner.delete(termId)
    for (const st of Object.values(run.nodes)) if (st.status === 'waiting' || st.status === 'starting' || st.status === 'running') st.status = 'skipped'
    return this.publish(run)
  }
}
