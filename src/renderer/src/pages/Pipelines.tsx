import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core, type NodeSingular } from 'cytoscape'
import edgehandles from 'cytoscape-edgehandles'
import { api, on } from '../api'
import type { DataShape, FunctionParam, InnerValue, NodeKind, PipeEdge, PipeNode, Pipeline, RunState, Spec, Task, TerminalInfo } from '../types'
import {
  IF_PORT, COMPARE_OPS, isLogic, isExecPort, defaultValue,
  KIND_NAME,
  PARAM_TYPE_NAME,
  AGENT_PORT,
  isAgent,
  edgeShape,
  hasTerminalInput,
  LOOP_PORT,
  withInputPort,
  functionParams,
  isFunctionBoundary,
  withFunctionBoundary,
  SHAPE_NAME,
  TEMPLATE_SEP,
  dataItems,
  dataShape,
  dataValue,
  agentSchema,
  outputRefs,
  edgeProblem,
  fillOutputs,
  hasDataOut,
  hasInput,
  isDataEdge,
  innerValues,
  isData,
  liveNodes,
  newNodeId,
  nodeInput,
  nodeName,
  pipelineProblems,
  specTarget,
  uniqueName
} from '../types'
import { Badge, Empty, errorToast, toast, useDark } from '../ui'
import { useWheelZoom } from '../cyZoom'
import { defaultOutputFields, JsonTree, OutputFields } from '../StructuredData'
import { parseJson, structuredPrompt, toPointer } from '../../../core/structuredData'

cytoscape.use(edgehandles)

type Draft = Omit<Pipeline, 'file' | 'updated'>
type Sel = { node: string } | { edge: PipeEdge } | null
/** 끌기 시작한 출력 핀: 'data'면 실행 노드의 데이터 출력, 없으면 그 노드의 기본 출력 */
type OutPin = string | undefined
const sameEdge = (a: PipeEdge, b: PipeEdge) => a.from === b.from && a.to === b.to && a.pin === b.pin && a.fromPort === b.fromPort && a.toPort === b.toPort
const edgeKey = (e: PipeEdge) => JSON.stringify([e.from, e.to, e.pin, e.fromPort, e.toPort])
const edgeOf = (from: string, to: string, pin?: OutPin, toPort?: string): PipeEdge => ({ from, to, ...(pin ? isExecPort(pin) ? { fromPort: pin } : { pin: 'data' as const, ...(pin !== 'data' ? { fromPort: pin } : {}) } : {}), ...(toPort ? { toPort } : {}) })
const isPortNode = (n: PipeNode) => isAgent(n) || n.kind === 'template' || n.kind === 'foreach' || n.kind === 'add' || n.kind === 'if' || isLogic(n) || isFunctionBoundary(n)
type SkillItem = Awaited<ReturnType<typeof api.listSkills>>[number]
type Env = { library: Pipeline[]; tasks: Task[]; skills: SkillItem[]; specs: Spec[]; terminals: TerminalInfo[] }

const KIND_LABEL = KIND_NAME
const SPEC_KINDS: NodeKind[] = ['spec', 'feature', 'ac']
const KIND_COLOR: Record<NodeKind, string> = {
  spec: '#4a7fb5',
  feature: '#4a7fb5',
  ac: '#4a7fb5',
  start: '#c2416b',
  claude: '#d97757',
  codex: '#10a37f',
  shell: '#8b919c',
  template: '#3a6fc4',
  'function-input': '#a353b9',
  'function-output': '#a353b9',
  foreach: '#aa782b',
  if: '#aa782b', compare: '#bd475a', and: '#bd475a', or: '#bd475a', not: '#bd475a', boolean: '#bd475a', number: '#359878',
  complete: '#5a8f2e',
  terminal: '#2c8ba3',
  text: '#8a63d2',
  add: '#8a63d2',
  list: '#8a63d2',
  schema: '#2f9a8a',
  dictionary: '#8a63d2',
  property: '#8a63d2',
  item: '#8a63d2',
  join: '#8a63d2',
  task: '#b98a2e',
  skill: '#2f9a8a'
}
const AGENT_KINDS: NodeKind[] = ['claude', 'codex', 'shell']
const STATUS_LABEL: Record<string, string> = { waiting: '대기', starting: '여는 중', running: '실행 중', done: '완료', failed: '실패', skipped: '건너뜀' }
const RUN_LABEL: Record<RunState['status'], string> = { running: '실행 중', done: '완료', failed: '실패', stopped: '중지됨' }

const short = (s: string, n = 26) => {
  const line = s.trim().split('\n')[0] ?? ''
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

/*
 * 핀 (블루프린트처럼 왼쪽은 입력, 오른쪽은 출력).
 * ▶ 실행 핀: 실행 노드의 윗줄. 끝나면 다음을 실행한다.
 * ● 글 핀: 실행 노드의 아랫줄 왼쪽(프롬프트에 붙일 글)·오른쪽(셸의 명령 출력), 데이터 노드의 가운데.
 *   리스트 데이터는 ▦(작은 칸 아홉 개)로, 단일 데이터는 ●로 그린다.
 * 출력 핀은 채워서, 입력 핀은 테두리만 그린다. 오른쪽 출력 핀을 눌러 끌면 선을 잇는다.
 */
const PIN = 14
const EXEC_W = 190
const EXEC_H = 58
const DATA_W = 170
const DATA_H = 44
/** 실행 노드에서 실행 핀·글 핀의 세로 위치 (노드 가운데 기준) */
const EXEC_DY = -13
const DATA_DY = 13
const DATA_COLOR = '#8a63d2'
const TERMINAL_COLOR = '#2c8ba3'
const BOOL_COLOR = '#bd475a', NUMBER_COLOR = '#359878'
type Pin = { side: 'in' | 'out'; type: 'exec' | 'data'; dy: number; list?: boolean; terminal?: boolean; shape?: DataShape; id?: string; label?: string }
const pinColor = (pin: Pin, execColor: string) => pin.type === 'exec' ? execColor : pin.terminal ? TERMINAL_COLOR : pin.shape === 'boolean' ? BOOL_COLOR : pin.shape === 'number' ? NUMBER_COLOR : DATA_COLOR
function pinsOf(kind: NodeKind): Pin[] {
  const list = dataShape({ kind }) === 'list'
  if (kind === 'terminal') return [{ side: 'out', type: 'data', dy: 0, terminal: true }]
  if (isData({ kind }) && !hasInput({ kind })) return [{ side: 'out', type: 'data', dy: 0, list }]
  if (kind === 'start') return [{ side: 'out', type: 'exec', dy: 0 }]
  if (kind === 'item') return [{ side: 'in', type: 'data', dy: 0, list: true }, { side: 'out', type: 'data', dy: 0 }]
  if (kind === 'boolean' || kind === 'number') return [{ side: 'in', type: 'data', dy: 0, shape: kind }, { side: 'out', type: 'data', dy: 0, shape: kind }]
  if (isData({ kind })) return [{ side: 'in', type: 'data', dy: 0, list }, { side: 'out', type: 'data', dy: 0, list }]
  return [
    { side: 'in', type: 'exec', dy: EXEC_DY },
    { side: 'out', type: 'exec', dy: EXEC_DY },
    { side: 'in', type: 'data', dy: DATA_DY },
    ...(hasDataOut({ kind }) ? [{ side: 'out' as const, type: 'data' as const, dy: DATA_DY }] : [])
  ]
}

function functionGeometry(n: PipeNode, env: Env) {
  if (n.kind === 'if') return { width: 280, height: 128, pins: [
    { side: 'in', type: 'exec', dy: -18, label: '실행' },
    { side: 'in', type: 'data', dy: 20, id: IF_PORT.condition, shape: 'boolean', label: '조건 · Bool' },
    { side: 'out', type: 'exec', dy: -18, id: IF_PORT.yes, label: 'True (참)' },
    { side: 'out', type: 'exec', dy: 20, id: IF_PORT.no, label: 'False (거짓)' }
  ] as Pin[] }
  if (isLogic(n)) return { width: 280, height: n.kind === 'not' ? 76 : 100, pins: [
    ...functionParams(n, env).inputs.map((p, i): Pin => ({ side: 'in', type: 'data', id: p.id, label: `${p.name} · ${PARAM_TYPE_NAME[p.type]}`, shape: p.type, dy: (n.kind === 'not' ? 8 : -4) + i * 28 })),
    { side: 'out', type: 'data', dy: n.kind === 'not' ? 8 : -4, shape: 'boolean', label: '결과 · Bool' }
  ] as Pin[] }
  if (n.kind === 'add') return { width: 260, height: 100, pins: [
    ...functionParams(n, env).inputs.map((p, i): Pin => ({ side: 'in', type: 'data', id: p.id, label: `${p.name} · 텍스트`, dy: -4 + i * 28 })),
    { side: 'out', type: 'data', dy: -4, label: '결과 · 텍스트' }
  ] as Pin[] }
  if (isAgent(n)) return { width: 320, height: 168, pins: [
    { side: 'in', type: 'exec', dy: -38, label: '실행' },
    { side: 'out', type: 'exec', dy: -38, label: '실행' },
    { side: 'in', type: 'data', dy: -10, id: AGENT_PORT.prompt, label: '프롬프트' },
    { side: 'in', type: 'data', dy: 18, id: AGENT_PORT.terminal, terminal: true, label: '터미널' },
    { side: 'out', type: 'data', dy: 18, id: AGENT_PORT.terminal, terminal: true, label: '터미널' },
    { side: 'in', type: 'data', dy: 46, id: AGENT_PORT.schema, label: '출력 구조' },
    { side: 'out', type: 'data', dy: 46, id: AGENT_PORT.output, label: '응답' }
  ] as Pin[] }
  if (n.kind === 'foreach') return { width: 300, height: 158, pins: [
    { side: 'in', type: 'exec', dy: -33, label: '실행' },
    { side: 'in', type: 'data', dy: -5, id: LOOP_PORT.list, list: true, label: '리스트' },
    { side: 'out', type: 'exec', dy: -33, id: LOOP_PORT.body, label: '반복 본문' },
    { side: 'out', type: 'data', dy: -5, id: LOOP_PORT.item, label: '항목' },
    { side: 'out', type: 'data', dy: 23, id: LOOP_PORT.index, label: '인덱스 (0부터)' },
    { side: 'out', type: 'exec', dy: 51, id: LOOP_PORT.done, label: '완료' }
  ] as Pin[] }
  const { inputs, outputs } = functionParams(n, env)
  const height = 72 + Math.max(inputs.length, outputs.length) * 28
  const top = -height / 2 + 46
  const pins: Pin[] = [
    ...(n.kind !== 'function-input' ? [{ side: 'in' as const, type: 'exec' as const, dy: top, label: '실행' }] : []),
    ...(n.kind !== 'function-output' ? [{ side: 'out' as const, type: 'exec' as const, dy: top, label: '실행' }] : []),
    ...inputs.map((p, i): Pin => ({ side: 'in', type: 'data', id: p.id, label: `${p.name} · ${PARAM_TYPE_NAME[p.type]}`, list: p.type === 'list', terminal: p.type === 'terminal', shape: p.type, dy: top + (i + 1) * 28 })),
    ...outputs.map((p, i): Pin => ({ side: 'out', type: 'data', id: p.id, label: `${p.name} · ${PARAM_TYPE_NAME[p.type]}`, list: p.type === 'list', terminal: p.type === 'terminal', shape: p.type, dy: top + (i + 1) * 28 }))
  ]
  return { pins, width: n.kind === 'template' ? 360 : 260, height }
}
const NODE_KINDS_UI = Object.keys(KIND_LABEL) as NodeKind[]
type Pt = { x: number; y: number }
const toRendered = (c: Core, m: Pt): Pt => ({ x: m.x * c.zoom() + c.pan().x, y: m.y * c.zoom() + c.pan().y })
/** 노드의 출력 핀: 기본 출력(데이터 노드는 글, 실행 노드는 ▶), pin이 'data'면 실행 노드의 데이터 출력 */
const outPin = (node: NodeSingular, pin?: OutPin) => {
  const outs = (node.data('pins') as Pin[] ?? pinsOf(node.data('kind'))).filter((p) => p.side === 'out')
  return (pin ? outs.find((p) => pin === 'data' ? p.type === 'data' : p.id === pin) : outs.find((p) => p.type === 'exec') ?? outs[0]) ?? { dy: 0 }
}
/** 선이 나오는 출력 핀의 위치 (노드 가운데 기준) */
function sourceOffset(e: cytoscape.EdgeSingular): Pt {
  const s = e.source()
  return { x: s.width() / 2 + 2, y: outPin(s, e.data('fromPort') ?? e.data('pin')).dy }
}
/** 선이 들어가는 입력 핀의 위치. 끌고 있는 동안의 임시 끝점(커서)이면 null */
function targetOffset(e: cytoscape.EdgeSingular): Pt | null {
  const t = e.target()
  const kind = t.data('kind') as NodeKind | undefined
  if (!kind) return null
  const fromData = isData({ kind: e.source().data('kind') }) || e.data('pin') === 'data'
  const pins = t.data('pins') as Pin[] | undefined
  const pin = pins?.find((p) => p.side === 'in' && (e.data('toPort') ? p.id === e.data('toPort') : p.type === (fromData ? 'data' : 'exec')))
  return { x: -t.width() / 2 - 2, y: pin?.dy ?? (isData({ kind }) ? 0 : fromData ? DATA_DY : EXEC_DY) }
}
/**
 * 핀에서 가로로 나와 가로로 들어가는 베지어 곡선. 조절점 둘(출력 핀 오른쪽, 입력 핀 왼쪽)을
 * cytoscape unbundled-bezier 형식(양 끝을 잇는 선 위의 비율과 그 선에서의 수직 거리)으로 바꾼다.
 */
function bezierCtrl(e: cytoscape.EdgeSingular): { w: number[]; d: number[] } {
  const sp = e.source().position()
  const tp = e.target().position()
  const so = sourceOffset(e)
  const to = targetOffset(e) ?? { x: 0, y: 0 }
  const a = { x: sp.x + so.x, y: sp.y + so.y }
  const b = { x: tp.x + to.x, y: tp.y + to.y }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = Math.max(dx * dx + dy * dy, 1)
  const l = Math.sqrt(l2)
  const k = Math.min(Math.max(Math.abs(dx) * 0.5, 40), 240)
  const ctrl = [{ x: a.x + k, y: a.y }, { x: b.x - k, y: b.y }]
  return {
    w: ctrl.map((c) => ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2),
    d: ctrl.map((c) => ((c.x - a.x) * -dy + (c.y - a.y) * dx) / l)
  }
}
function pinSvg(p: Pin, execColor: string, bg: string): string {
  const color = pinColor(p, execColor)
  const fill = p.side === 'out' ? color : bg
  // 리스트: 블루프린트의 배열 핀처럼 작은 칸 아홉 개 (입력은 가운데 칸만 비운다)
  const grid = () =>
    [0, 1, 2]
      .flatMap((r) => [0, 1, 2].map((c) => [r, c]))
      .map(([r, c]) => `<rect x="${1 + c * 4.3}" y="${1 + r * 4.3}" width="3.4" height="3.4" fill="${p.side === 'in' && r === 1 && c === 1 ? bg : color}"/>`)
      .join('')
  const shape =
    p.type === 'exec'
      ? `<polygon points="2,2 8,2 13,7 8,12 2,12" fill="${fill}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
      : p.list
        ? grid()
        : `<circle cx="7" cy="7" r="5" fill="${fill}" stroke="${color}" stroke-width="1.8"/>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14">${shape}</svg>`)}`
}
/** 종류마다 핀을 배경 그림으로 그리는 스타일 */
function pinStyle(pins: Pin[], execColor: string, bg: string) {
  const each = <T,>(f: (p: Pin) => T) => pins.map(f)
  return {
    'background-image': each((p) => pinSvg(p, execColor, bg)),
    'background-width': each(() => `${PIN}px`),
    'background-height': each(() => `${PIN}px`),
    'background-position-x': each((p) => (p.side === 'out' ? '100%' : '0%')),
    'background-position-y': each(() => '50%'),
    'background-offset-x': each((p) => (p.side === 'out' ? PIN / 2 : -PIN / 2)),
    'background-offset-y': each((p) => p.dy),
    'background-clip': each(() => 'none'),
    'background-image-containment': each(() => 'over'),
    'background-image-opacity': each(() => 1)
  }
}

function functionStyle(n: PipeNode, env: Env, color: string, bg: string) {
  const { pins, width, height } = functionGeometry(n, env)
  const style = pinStyle(pins, color, bg)
  const xml = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!)
  const heading = n.kind === 'compare' ? `${nodeName(n)} · ${COMPARE_OPS[n.operation ?? 'eq']}` : n.kind === 'template' ? `${nodeName(n)} · ${env.library.find((p) => p.id === n.ref)?.title ?? '함수 선택'}` : isAgent(n) || n.kind === 'add' || n.kind === 'if' || isLogic(n) ? `${nodeName(n)}${nodeName(n).startsWith(KIND_LABEL[n.kind]) ? '' : ` · ${KIND_LABEL[n.kind]}`}` : KIND_LABEL[n.kind]
  const labels = pins.map((p) => `<text x="${p.side === 'in' ? 14 : width - 14}" y="${height / 2 + p.dy + 4}" text-anchor="${p.side === 'in' ? 'start' : 'end'}" font-size="12" fill="${pinColor(p, color)}">${xml(short(p.label ?? '', n.kind === 'template' ? 16 : 26))}</text>`).join('')
  const svg = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="21" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="12" fill="${color}">${xml(short(heading, 36))}</text><path d="M12 30H${width - 12}" stroke="${color}" opacity=".2"/>${labels}</svg>`)}`
  return {
    width, height, label: '', ...style,
    'background-image': [svg, ...style['background-image']],
    'background-width': [`${width}px`, ...style['background-width']],
    'background-height': [`${height}px`, ...style['background-height']],
    'background-position-x': ['50%', ...style['background-position-x']],
    'background-position-y': ['50%', ...style['background-position-y']],
    'background-offset-x': [0, ...style['background-offset-x']],
    'background-offset-y': [0, ...style['background-offset-y']],
    'background-clip': ['none', ...style['background-clip']],
    'background-image-containment': ['over', ...style['background-image-containment']],
    'background-image-opacity': [1, ...style['background-image-opacity']]
  }
}

const nodeRuns = (run: RunState | undefined, id: string) => run ? Object.entries(run.nodes).filter(([key, state]) => state.sourceIds ? state.sourceIds.includes(id) : key === id || key.startsWith(`${id}${TEMPLATE_SEP}`)) : []

/** 함수 호출·반복 노드와 반복 본문은 원본 노드에 각 실행의 상태를 모아 보여준다 */
function nodeStatus(run: RunState | undefined, id: string): string | undefined {
  if (!run) return undefined
  if (run.nodes[id]) return run.nodes[id].status
  const inner = nodeRuns(run, id).map(([, v]) => v.status)
  if (!inner.length) return undefined
  for (const s of ['failed', 'running', 'starting'] as const) if (inner.includes(s)) return s
  if (inner.some((s) => s === 'done') && inner.every((s) => s === 'done' || s === 'skipped')) return 'done'
  if (inner.every((s) => s === 'skipped')) return 'skipped'
  return inner.some((s) => s === 'done') ? 'running' : 'waiting'
}

/** 이 프로젝트에서 실행 중이거나 마지막으로 실행한 결과 (그래프마다 하나) */
function useRuns(): Map<string, RunState> {
  const [runs, setRuns] = useState(new Map<string, RunState>())
  useEffect(() => {
    void api.pipelineRuns().then((list) => setRuns(new Map(list.map((r) => [r.pipelineId, r]))))
    return on('pipeline-state', (r: RunState) => {
      setRuns((m) => {
        const prev = m.get(r.pipelineId)
        if (r.status === 'done' && prev?.status === 'running') toast(`"${r.title}" 작업 그래프를 모두 마쳤습니다`)
        if (r.status === 'failed' && prev?.status === 'running') toast(`"${r.title}" 작업 그래프에서 실패한 작업이 있습니다`, 'error')
        return new Map(m).set(r.pipelineId, r)
      })
    })
  }, [])
  return runs
}

/** IN-F11~F13: 터미널 작업을 노드로 잇는 작업 그래프 (블루프린트처럼 실행 선과 데이터 선). */
export default function PipelineEditor({ tabs, onShowTerminal }: { tabs: TerminalInfo[]; onShowTerminal: (termId: string) => void }) {
  const [list, setList] = useState<Pipeline[] | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [specs, setSpecs] = useState<Spec[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const runs = useRuns()
  const run = draft ? runs.get(draft.id) : undefined
  const running = run?.status === 'running'

  const toDraft = (p: Pipeline): Draft => ({ id: p.id, title: p.title, template: p.template, nodes: p.nodes, edges: p.edges })
  const reload = async (pick?: string) => {
    const [l, t, s, sp] = await Promise.all([api.listPipelines(), api.listTasks(), api.listSkills().catch(() => []), api.listSpecs().catch(() => [])])
    setList(l)
    setTasks(t)
    setSkills(s)
    setSpecs(sp)
    const p = l.find((x) => x.id === (pick ?? draft?.id)) ?? l[0]
    if (p && (pick || !draft)) setDraft(toDraft(p))
    if (!p) setDraft(null)
  }
  useEffect(() => {
    void reload().catch(errorToast)
    // 할 일·명세는 다른 화면에서 바뀔 수 있다 (스킬은 데이터 폴더 밖이라 감시하지 않으므로 이때 같이 다시 읽는다)
    return on('files-changed', () => {
      void api.listTasks().then(setTasks).catch(() => {})
      void api.listSpecs().then(setSpecs).catch(() => {})
      void api.listSkills().then(setSkills).catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 고칠 때마다 잠시 뒤 저장한다
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const update = (fn: (d: Draft) => Draft) => {
    setDraft((d) => {
      if (!d) return d
      const next = fn(d)
      dirty.current = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(next), 500)
      return next
    })
  }
  const flush = async (d: Draft) => {
    if (!dirty.current) return
    dirty.current = false
    try {
      const saved = await api.savePipeline(d)
      setList((l) => (l ? l.map((x) => (x.id === saved.id ? saved : x)) : l))
    } catch (e) {
      errorToast(e)
    }
  }
  const switchTo = async (id: string) => {
    if (draft) await flush(draft)
    const p = list?.find((x) => x.id === id)
    if (p) setDraft(toDraft(p))
    setSel(null)
    setConnectFrom(null)
  }

  const create = async (template: boolean) => {
    try {
      if (draft) await flush(draft)
      const nodes: PipeNode[] = template ? [
        { id: newNodeId(), name: '함수 Input', kind: 'function-input', text: '', terminal: 'new', x: 0, y: 0, params: [{ id: newNodeId(), name: '입력', type: 'single' }] },
        { id: newNodeId(), name: '함수 Output', kind: 'function-output', text: '', terminal: 'new', x: 500, y: 0, params: [{ id: newNodeId(), name: '결과', type: 'single' }] }
      ] : [{ id: newNodeId(), name: KIND_LABEL.start, kind: 'start', text: '', terminal: 'new', x: 0, y: 0 }]
      const p = await api.savePipeline({ title: template ? '새 함수' : '새 작업 그래프', template, nodes, edges: template ? [{ from: nodes[0].id, to: nodes[1].id }] : [] })
      await reload(p.id)
    } catch (e) {
      errorToast(e)
    }
  }
  const remove = async () => {
    if (!draft || !confirm(`"${draft.title}"을(를) 지울까요?`)) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    dirty.current = false
    try {
      await api.deletePipeline(draft.id)
      setDraft(null)
      await reload()
    } catch (e) {
      errorToast(e)
    }
  }

  /** 새 노드의 이름: 노드 종류 이름, 이미 있으면 뒤에 숫자 */
  const freshName = (d: Draft, kind: NodeKind) => uniqueName(KIND_LABEL[kind], d.nodes.map(nodeName))
  /** after: 그 노드의 출력(pin)에 이어 붙인다. */
  const addNode = (kind: NodeKind, extra: Partial<PipeNode> = {}, after?: PipeNode, link = true, pin?: OutPin) => {
    if (!draft) return
    const id = newNodeId()
    const last = draft.nodes[draft.nodes.length - 1]
    const step = isAgent({ kind }) || (after && isAgent(after)) ? 380 : 260
    const node: PipeNode = {
      id,
      name: freshName(draft, kind),
      kind,
      text: kind === 'boolean' || kind === 'number' ? defaultValue(kind) : '',
      ...(kind === 'schema' ? { fields: defaultOutputFields() } : {}),
      // 같은 종류의 에이전트 뒤에 붙이면 대화 맥락을 잇는 쪽이 자연스럽다
      terminal: after && after.kind === kind && (kind === 'claude' || kind === 'codex') ? 'continue' : 'new',
      // 데이터 노드는 위쪽에, 실행 노드는 오른쪽으로 이어서 놓는다
      x: after?.x !== undefined ? after.x + step : (last?.x ?? 0) + (isData({ kind }) ? 0 : step),
      y: after?.y ?? (last?.y ?? 120) + (isData({ kind }) ? -110 : 0),
      ...extra
    }
    const graph = { ...draft, nodes: [...draft.nodes, node] }
    const edge = after && link ? withInputPort(graph, edgeOf(after.id, id, pin), env) : undefined
    const why = edge && edgeProblem(graph, edge.from, edge.to, edge.pin, env, edge)
    if (why) return toast(why, 'error')
    update((d) => ({ ...d, nodes: [...d.nodes, node], edges: edge ? [...d.edges, edge] : d.edges }))
    setSel({ node: id })
  }
  /** 데이터 노드의 안쪽 값(명세의 기능, 기능의 수용 기준, 리스트의 항목)을 새 데이터 노드로 꺼낸다 */
  const extract = (from: PipeNode, v: InnerValue, at?: Pt) => {
    // 패널에서 꺼낼 때는 같은 종류가 겹치지 않게 아래로 쌓는다
    const i = draft?.nodes.filter((n) => n.kind === v.kind).length ?? 0
    addNode(v.kind, { ...innerExtra(v), name: uniqueName(v.label, draft?.nodes.map(nodeName) ?? []), ...(at ?? { x: (from.x ?? 0) + 350, y: (from.y ?? 0) + 60 * i }) }, from, true, isAgent(from) ? AGENT_PORT.output : undefined)
  }
  /** 이름 바꾸기. 겹치면 뒤에 숫자를 붙인다 */
  const rename = (id: string, want: string) => {
    if (!draft) return
    const others = draft.nodes.filter((n) => n.id !== id).map(nodeName)
    const name = uniqueName(want.trim() || KIND_LABEL[draft.nodes.find((n) => n.id === id)?.kind ?? 'text'], others)
    if (name !== want.trim() && want.trim()) toast(`"${want.trim()}"은(는) 이미 있는 이름이라 "${name}"(으)로 붙였습니다`)
    patchNode(id, { name })
  }
  const patchNode = (id: string, patch: Partial<PipeNode>) => update((d) => {
    const removed = new Set((d.nodes.find((n) => n.id === id)?.params ?? []).filter((p) => patch.params && !patch.params.some((v) => v.id === p.id)).map((p) => p.id))
    return {
      ...d,
      nodes: d.nodes.map((n) => n.id === id ? { ...n, ...patch } : n),
      edges: d.edges.filter((e) => !(e.from === id && removed.has(e.fromPort ?? '')) && !(e.to === id && removed.has(e.toPort ?? '')))
    }
  })
  const nm = (id: string) => nodeName(draft?.nodes.find((n) => n.id === id) ?? { id })
  const removeNode = (id: string) => {
    if (draft?.nodes.some((n) => n.id === id && isFunctionBoundary(n))) return toast('함수 Input·Output은 고정 노드입니다')
    update((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from !== id && e.to !== id) }))
    setSel(null)
  }
  const canConnect = (d: Draft, from: string, to: string, pin?: OutPin, toPort?: string) => {
    const edge = withInputPort(d, edgeOf(from, to, pin, toPort), env)
    return !edgeProblem(d, from, to, edge.pin, env, edge) && !d.edges.some((e) => sameEdge(e, edge))
  }
  const connect = (from: string, to: string, pin?: OutPin, toPort?: string) => {
    if (!draft) return
    const edge = withInputPort(draft, edgeOf(from, to, pin, toPort), env)
    const why = edgeProblem(draft, from, to, edge.pin, env, edge)
    if (why) return toast(why, 'error')
    if (draft.edges.some((e) => sameEdge(e, edge))) return
    update((d) => ({ ...d, edges: [...d.edges, edge] }))
  }
  // 우클릭(또는 핀을 빈 곳에 놓기)으로 연 노드 검색 메뉴
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; pos: { x: number; y: number }; from?: string; pin?: OutPin } | null>(null)
  const addFromMenu = (item: MenuItem) => {
    if (!menu || !draft) return
    const from = menu.from ? draft.nodes.find((n) => n.id === menu.from) : undefined
    // 노드 가운데가 아니라 왼쪽 입력 핀이 놓은 자리에 오도록
    const w = item.kind === 'template' ? 360 : item.kind === 'foreach' || isAgent({ kind: item.kind }) ? 300 : item.kind === 'add' ? 260 : isData({ kind: item.kind }) ? DATA_W : EXEC_W
    addNode(item.kind, { ...item.extra, x: Math.round(menu.pos.x + (from ? w / 2 : 0)), y: Math.round(menu.pos.y) }, from, true, menu.pin)
    setMenu(null)
  }
  const disconnect = (edge: PipeEdge) => {
    update((d) => ({ ...d, edges: d.edges.filter((e) => !sameEdge(e, edge)) }))
    setSel(null)
  }

  const start = async () => {
    if (!draft) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    dirty.current = true
    await flush(draft)
    try {
      await api.runPipeline(draft.id)
    } catch (e) {
      errorToast(e)
    }
  }

  // 지금 고치는 그래프는 저장 전이라도 지금 내용으로 검사한다
  const env: Env = useMemo(
    () => ({ library: (list ?? []).map((p) => (draft && p.id === draft.id ? { ...p, ...draft } : p)), tasks, skills, specs, terminals: tabs }),
    [list, draft, tasks, skills, specs, tabs]
  )
  const problems = useMemo(() => (draft ? pipelineProblems(draft, env, { requireStart: !draft.template }) : []), [draft, env])
  // 시작 노드가 있을 때, 시작에서 닿지 않아 실행되지 않는 노드
  const unused = useMemo(() => {
    if (!draft?.nodes.some((n) => n.kind === 'start')) return []
    const live = liveNodes(draft)
    return draft.nodes.filter((n) => !live.has(n.id)).map(nodeName)
  }, [draft])
  /** 시작 노드를 맨 왼쪽에 두고, 앞 노드가 없는 실행 노드들에 잇는다 (예전에 만든 그래프용) */
  const addStart = () =>
    update((d) => {
      const id = newNodeId()
      const isExecEdge = (e: PipeEdge) => !isDataEdge(d, e)
      const roots = d.nodes.filter((n) => !isData(n) && !d.edges.some((e) => e.to === n.id && isExecEdge(e)))
      const minX = Math.min(0, ...d.nodes.map((n) => n.x ?? 0))
      const start: PipeNode = { id, name: freshName(d, 'start'), kind: 'start', text: '', terminal: 'new', x: minX - 260, y: roots[0]?.y ?? 0 }
      return { ...d, nodes: [...d.nodes, start], edges: [...d.edges, ...roots.map((r) => ({ from: id, to: r.id }))] }
    })
  /** "텍스트 1: ..." 처럼 노드 이름으로 시작하는 문제를 누르면 그 노드를 고른다 (긴 이름부터 맞춰 본다) */
  const focusProblem = (p: string) => {
    const hit = [...(draft?.nodes ?? [])]
      .sort((a, b) => nodeName(b).length - nodeName(a).length)
      .find((n) => p.startsWith(nodeName(n)) && /^[:\s/의]/.test(p.slice(nodeName(n).length)))
    if (hit) setSel({ node: hit.id })
  }
  const selNode = sel && 'node' in sel ? draft?.nodes.find((n) => n.id === sel.node) : undefined
  const selEdge = sel && 'edge' in sel ? sel.edge : undefined

  // Delete 키로 고른 노드·선을 지운다 (입력 중일 때는 제외)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || running) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select')) return
      if (selNode) removeNode(selNode.id)
      else if (selEdge) disconnect(selEdge)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!list) return null
  const graphs = list.filter((p) => !p.template)
  const templates = list.filter((p) => p.template)
  const usableTemplates = templates.filter((t) => t.id !== draft?.id)
  return (
    <div className="pipe-layout">
      <div className="pipe-list">
        <div className="pipe-list-head">
          작업 그래프
          <button className="ghost" title="새 작업 그래프" onClick={() => create(false)}>
            +
          </button>
        </div>
        {graphs.map((p) => (
          <div key={p.id} className={`tree-item ${draft?.id === p.id ? 'on' : ''}`} onClick={() => void switchTo(p.id)}>
            {p.title}
            {runs.get(p.id)?.status === 'running' && <span title="실행 중"> ⟳</span>}
          </div>
        ))}
        <div className="pipe-list-head">
          함수
          <button className="ghost" title="새 함수" onClick={() => create(true)}>
            +
          </button>
        </div>
        {templates.length === 0 && <div className="small muted">입·출력 변수가 있는 함수를 만들어 다른 그래프에서 호출할 수 있습니다</div>}
        {templates.map((p) => (
          <div key={p.id} className={`tree-item ${draft?.id === p.id ? 'on' : ''}`} onClick={() => void switchTo(p.id)}>
            {p.title}
          </div>
        ))}
      </div>

      {!draft && <Empty>작업 그래프가 없습니다. 왼쪽 "+"로 만드세요.</Empty>}
      {draft && (
        <div className="pipe-main">
          <div className="row between" style={{ marginTop: 0 }}>
            <div className="row" style={{ margin: 0, flex: 1 }}>
              <input className="pipe-title" value={draft.title} onChange={(e) => update((d) => ({ ...d, title: e.target.value }))} disabled={running} />
              <label className="small">
                <input type="checkbox" checked={!!draft.template} disabled={running || !!draft.template} onChange={() => update((d) => ({ ...d, template: true, ...withFunctionBoundary(d, d.id) }))} /> 함수로 쓰기
              </label>
            </div>
            <div className="row" style={{ margin: 0 }}>
              {running ? (
                <button className="danger" onClick={() => run && void api.stopPipeline(run.runId)}>
                  ■ 중지
                </button>
              ) : (
                <button className="primary" disabled={!!draft.template || problems.length > 0} title={draft.template ? '함수는 작업 그래프에서 호출해 실행합니다' : problems.join('\n')} onClick={start}>
                  ▶ 실행
                </button>
              )}
              <button className="ghost danger" disabled={running} onClick={remove}>
                삭제
              </button>
            </div>
          </div>
          <div className="pipe-palette">
            <span className="small muted">실행</span>
            <button disabled={running || !!draft.template} onClick={() => addNode('start')}>
              <span className="dot" style={{ background: KIND_COLOR.start }} /> 시작
            </button>
            {AGENT_KINDS.map((k) => (
              <button key={k} disabled={running} onClick={() => addNode(k)}>
                <span className={`dot ${k}`} /> {KIND_LABEL[k]}
              </button>
            ))}
            <select value="" disabled={running || !usableTemplates.length} onChange={(e) => e.target.value && addNode('template', { ref: e.target.value })}>
              <option value="">{usableTemplates.length ? '+ 함수 호출' : '함수 없음'}</option>
              {usableTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button disabled={running} onClick={() => addNode('complete')}>
              할 일 완료
            </button>
            <span className="small muted">유틸리티</span>
            <button disabled={running} onClick={() => addNode('foreach')} title="리스트를 한 항목씩 순서대로 처리합니다">For Each</button>
            <button disabled={running} onClick={() => addNode('if')} title="Bool 조건에 따라 True 또는 False 경로를 실행합니다">If</button>
            <select aria-label="비교 노드 추가" value="" disabled={running} onChange={(e) => e.target.value && addNode('compare', { operation: e.target.value as PipeNode['operation'] })}>
              <option value="">+ 비교</option>
              {Object.entries(COMPARE_OPS).map(([op, label]) => <option key={op} value={op}>{label}</option>)}
            </select>
            {(['and', 'or', 'not'] as const).map((kind) => <button key={kind} disabled={running} onClick={() => addNode(kind)}>{KIND_LABEL[kind]}</button>)}
            <span className="small muted" style={{ marginLeft: 8 }}>
              데이터
            </span>
            <button disabled={running} onClick={() => addNode('terminal')}>
              터미널
            </button>
            <button disabled={running} onClick={() => addNode('boolean')}>Bool</button>
            <button disabled={running} onClick={() => addNode('number')}>숫자</button>
            <button disabled={running} onClick={() => addNode('text')}>
              텍스트
            </button>
            <button disabled={running} onClick={() => addNode('add')} title="A 뒤에 B를 그대로 이어 붙입니다">텍스트 Add</button>
            <button disabled={running} onClick={() => addNode('list', { items: [''] })}>
              리스트
            </button>
            <button disabled={running} onClick={() => addNode('join')}>
              합치기
            </button>
            <button disabled={running} onClick={() => addNode('schema')}>출력 구조</button>
            <button disabled={running} onClick={() => addNode('dictionary', { text: '{}' })}>Dictionary</button>
            <select value="" disabled={running} onChange={(e) => e.target.value && addNode('task', { ref: e.target.value })}>
              <option value="">+ 할 일</option>
              {tasks
                .filter((t) => t.status === '대기' || t.status === '진행')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {t.title}
                  </option>
                ))}
            </select>
            <select value="" disabled={running || !skills.length} onChange={(e) => e.target.value && addNode('skill', { ref: e.target.value })}>
              <option value="">{skills.length ? '+ 스킬' : '스킬 없음'}</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.scope === 'user' ? ' (내 스킬)' : ''}
                </option>
              ))}
            </select>
            <select value="" disabled={running || !specs.length} onChange={(e) => e.target.value && addNode('spec', { ref: e.target.value })}>
              <option value="">{specs.length ? '+ 기능 명세' : '기능 명세 없음'}</option>
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          {run && (
            <div className="small">
              <Badge kind={run.status === 'done' ? 'pass' : run.status === 'failed' ? 'fail' : ''}>{RUN_LABEL[run.status]}</Badge>{' '}
              <span className="muted">
                {Object.values(run.nodes).filter((n) => n.status === 'done').length}/{Object.keys(run.nodes).length} 완료 · {new Date(run.started).toLocaleTimeString()} 시작
              </span>
            </div>
          )}
          {!running && problems.length > 0 && (
            <div className="banner warn pipe-problems">
              <div>
                <b>실행할 수 없는 이유</b>
                <ul>
                  {problems.map((p) => (
                    <li key={p} onClick={() => focusProblem(p)}>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              {!draft.template && !draft.nodes.some((n) => n.kind === 'start') && <button onClick={addStart}>시작 노드 추가</button>}
            </div>
          )}
          {unused.length > 0 && <div className="small muted">시작에서 이어지지 않아 실행되지 않는 노드: {unused.join(', ')}</div>}
          <div className="pipe-body">
            <Canvas
              draft={draft}
              env={env}
              run={run}
              sel={sel}
              connectFrom={connectFrom}
              locked={running}
              canConnect={(a, b, pin, toPort) => canConnect(draft, a, b, pin, toPort)}
              onConnect={connect}
              onTapNode={(id) => {
                if (connectFrom) {
                  connect(connectFrom, id)
                  setConnectFrom(null)
                }
                setSel({ node: id })
              }}
              onOpenNode={(id) => {
                const n = draft.nodes.find((x) => x.id === id)
                if (n?.kind === 'template' && n.ref) void switchTo(n.ref)
              }}
              onTapEdge={(edge) => setSel({ edge })}
              onTapBackground={() => {
                setSel(null)
                setConnectFrom(null)
              }}
              onMoved={(id, x, y) => patchNode(id, { x, y })}
              onMenu={(at, pos, from, pin) => setMenu({ at, pos, from, pin })}
            >
              {menu && (
                <SearchMenu
                  at={menu.at}
                  items={menuItems(env, draft, menu.from, menu.pin)}
                  title={menu.from ? `${nm(menu.from)}에 이어 붙이거나 꺼낼 노드` : '노드 추가'}
                  onPick={addFromMenu}
                  onClose={() => setMenu(null)}
                />
              )}
            </Canvas>
            <div className="pipe-panel">
              {connectFrom && <div className="banner warn small">{nm(connectFrom)}에서 이을 노드를 누르세요 (빈 곳을 누르면 취소)</div>}
              {!selNode && !selEdge && <Help empty={!draft.nodes.length} />}
              {selEdge && (
                <>
                  <h4>
                    {nm(selEdge.from)} → {nm(selEdge.to)}
                  </h4>
                  <div className="small muted">
                    {selEdge.pin === 'data'
                      ? `${nm(selEdge.from)}이(가) 끝난 뒤 그 출력을 ${nm(selEdge.to)}에 넘깁니다. ${nm(selEdge.from)}은(는) 실행 선으로 먼저 실행되어야 합니다.`
                      : isDataEdge(draft, selEdge)
                        ? `${nm(selEdge.from)}의 글을 ${nm(selEdge.to)}에 넘깁니다.`
                        : `${nm(selEdge.from)}이(가) 끝나면 ${nm(selEdge.to)}을(를) 실행합니다.`}
                  </div>
                  <button className="danger" disabled={running} onClick={() => disconnect(selEdge)}>
                    연결 끊기 (Delete)
                  </button>
                </>
              )}
              {selNode && (
                <NodePanel
                  node={selNode}
                  draft={draft}
                  env={env}
                  run={run}
                  tabs={tabs}
                  locked={running}
                  onPatch={(p) => patchNode(selNode.id, p)}
                  onRename={(name) => rename(selNode.id, name)}
                  onExtract={(v) => extract(selNode, v)}
                  onConnect={() => setConnectFrom(selNode.id)}
                  onAddAfter={(k) => addNode(k, {}, selNode)}
                  onRemove={() => removeNode(selNode.id)}
                  onOpenTemplate={(id) => void switchTo(id)}
                  onShowTerminal={onShowTerminal}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface MenuItem {
  key: string
  kind: NodeKind
  label: string
  group: string
  /** 검색어로 찾을 말 (한글·영문) */
  words: string
  extra?: Partial<PipeNode>
}

/** 꺼낸 안쪽 값으로 만드는 새 데이터 노드의 내용 */
const innerExtra = (v: InnerValue): Partial<PipeNode> => ({ ...(v.ref ? { ref: v.ref } : {}), ...(v.text !== undefined ? { text: v.text } : {}), ...(v.index !== undefined ? { index: v.index } : {}), ...(v.pointer !== undefined ? { pointer: v.pointer } : {}) })

const KIND_WORDS: Record<NodeKind, string> = {
  claude: 'claude code 클로드 에이전트 agent 프롬프트',
  codex: 'codex 코덱스 에이전트 agent openai',
  shell: 'shell 셸 쉘 터미널 명령 command cmd',
  template: 'function 함수 호출 template 템플릿 모듈 module',
  'function-input': '함수 입력 input',
  'function-output': '함수 출력 output',
  foreach: 'for foreach for each loop 반복 순회 유틸 리스트 배열 항목 인덱스',
  if: 'if branch 조건 분기 참 거짓 true false bool',
  compare: 'compare 비교 계산 같음 다름 크다 작다 == != > >= < <=',
  and: 'and 논리 모두 참 &&', or: 'or 논리 하나라도 참 ||', not: 'not 논리 부정 반전 !',
  boolean: 'bool boolean 불리언 참 거짓 true false 변환', number: 'number 숫자 수 변환',
  item: '리스트 항목 array get index',
  complete: 'complete done 할일완료 완료 task',
  terminal: 'terminal 터미널 탭 세션 입력 input 기존 재사용',
  text: 'text 텍스트 글 문자열 string 단일',
  add: 'add text string 텍스트 문자열 더하기 이어붙이기 concat append +',
  list: 'list array 리스트 목록 배열 여러',
  schema: 'schema 구조화 출력 형식 필드 규칙 json',
  dictionary: 'dictionary dict object 객체 JSON 데이터 결과',
  property: 'property key path 필드 키 경로 JSON 꺼내기',
  join: 'join append 합치기 더하기 이어붙이기 concat',
  task: 'task todo 할일 할 일',
  start: 'start begin 시작 이벤트 event',
  skill: 'skill 스킬 claude 절차 규칙',
  spec: 'spec 기능명세 기능 명세 도메인 domain 명세서',
  feature: 'feature 기능',
  ac: 'ac 수용기준 수용 기준 acceptance'
}

/** 검색 메뉴에 보일 노드. 핀을 끌어 놓은 경우에는 그 핀에 이을 수 있는 것만 */
function menuItems(env: Env, draft: Draft, from?: string, pin?: OutPin): MenuItem[] {
  const base = (k: NodeKind, group: string): MenuItem => ({ key: k, kind: k, label: KIND_LABEL[k], group, words: KIND_WORDS[k] })
  const items: MenuItem[] = [
    ...(!draft.template ? [base('start', '실행')] : []),
    ...AGENT_KINDS.map((k) => base(k, '실행')),
    base('complete', '실행'),
    base('foreach', '유틸리티'),
    base('if', '유틸리티'),
    ...Object.entries(COMPARE_OPS).map(([op, label]): MenuItem => ({ ...base('compare', '비교'), key: `compare:${op}`, label, extra: { operation: op as PipeNode['operation'] } })),
    ...(['and', 'or', 'not'] as const).map((kind) => base(kind, '논리')),
    base('boolean', '데이터'), base('number', '데이터'),
    base('terminal', '데이터'),
    base('text', '데이터'),
    base('add', '데이터'),
    { ...base('schema', '데이터'), extra: { fields: defaultOutputFields() } },
    { ...base('dictionary', '데이터'), extra: { text: '{}' } },
    base('property', '데이터'),
    { ...base('list', '데이터'), extra: { items: [''] } },
    { ...base('item', '데이터'), extra: { index: 0 } },
    base('join', '데이터'),
    ...env.library
      .filter((p) => p.template && p.id !== draft.id)
      .map((p) => ({ key: `tpl:${p.id}`, kind: 'template' as NodeKind, label: p.title, group: '함수', words: `${KIND_WORDS.template} ${p.title}`, extra: { ref: p.id } })),
    ...env.tasks
      .filter((t) => t.status === '대기' || t.status === '진행')
      .map((t) => ({ key: `task:${t.id}`, kind: 'task' as NodeKind, label: `${t.id} ${t.title}`, group: '할 일', words: `${KIND_WORDS.task} ${t.id} ${t.title}`, extra: { ref: t.id } })),
    ...env.skills.map((s) => ({
      key: `skill:${s.id}`,
      kind: 'skill' as NodeKind,
      label: s.name,
      group: '스킬',
      words: `${KIND_WORDS.skill} ${s.name} ${s.description}`,
      extra: { ref: s.id }
    })),
    ...env.specs.map((s) => ({ key: `spec:${s.id}`, kind: 'spec' as NodeKind, label: s.title, group: '기능 명세', words: `${KIND_WORDS.spec} ${s.title}`, extra: { ref: s.id } }))
  ]
  const src = from ? draft.nodes.find((n) => n.id === from) : undefined
  if (!src) return items
  // 데이터 출력을 빈 곳에 놓으면 그 노드가 가진 안쪽 값을 새 데이터 노드로 꺼낼 수 있다 (맨 위에)
  const values = (() => { try { return innerValues(src, env, draft) } catch { return [] } })()
  const inner: MenuItem[] = values.map((v, i) => ({
    key: `inner:${v.ref ?? i}`,
    kind: v.kind,
    label: v.label,
    group: `${nodeName(src)}에서 꺼내기`,
    words: `${KIND_WORDS[v.kind]} ${v.label}`,
    extra: innerExtra(v)
  }))
  // 실행 핀에서는 실행 노드만, 글 핀(데이터 노드·실행 노드의 데이터 출력)에서는 입력이 있는 노드만
  return [...inner, ...items].filter((item) => {
    const candidate: PipeNode = { id: '__candidate', kind: item.kind, text: '', terminal: 'new', ...item.extra }
    const graph = { ...draft, nodes: [...draft.nodes, candidate] }
    const edge = withInputPort(graph, edgeOf(src.id, candidate.id, pin), env)
    return !edgeProblem(graph, edge.from, edge.to, edge.pin, env, edge)
  })
}

/** 블루프린트처럼 우클릭한 자리에 뜨는 노드 검색 메뉴 */
function SearchMenu({ at, items, title, onPick, onClose }: { at: { x: number; y: number }; items: MenuItem[]; title: string; onPick: (i: MenuItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = items.filter((i) => words.every((w) => `${i.label} ${i.words}`.toLowerCase().includes(w)))
  useEffect(() => setCur(0), [q])
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [onClose])
  // 메뉴가 떠 있는 동안 그래프 위에서 굴린 휠은 줌 대신 메뉴 목록을 스크롤한다 (줌 핸들러보다 먼저 받도록 window 캡처)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const list = box.current?.querySelector<HTMLElement>('.pipe-menu-list')
      const wrap = box.current?.parentElement
      if (!list || !wrap?.contains(e.target as Node)) return
      e.stopPropagation()
      if (list.contains(e.target as Node)) return
      e.preventDefault()
      list.scrollTop += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1)
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])
  useEffect(() => {
    box.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [cur])
  // 화면 밖으로 나가지 않게
  const parent = box.current?.parentElement
  const left = Math.min(at.x, (parent?.clientWidth ?? 9999) - 270)
  const top = Math.min(at.y, (parent?.clientHeight ?? 9999) - 330)
  let group = ''
  return (
    <div ref={box} className="pipe-menu" style={{ left: Math.max(4, left), top: Math.max(4, top) }}>
      <div className="small muted">{title}</div>
      <input
        autoFocus
        value={q}
        placeholder="검색 (예: 텍스트, claude, 리뷰)"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCur((c) => Math.min(c + 1, shown.length - 1))
          else if (e.key === 'ArrowUp') setCur((c) => Math.max(c - 1, 0))
          else if (e.key === 'Enter' && shown[cur]) onPick(shown[cur])
          else if (e.key === 'Escape') onClose()
          else return
          e.preventDefault()
        }}
      />
      <div className="pipe-menu-list">
        {shown.length === 0 && <div className="small muted">찾는 노드가 없습니다</div>}
        {shown.map((i, idx) => {
          const head = i.group !== group ? (group = i.group) : null
          return (
            <div key={i.key}>
              {head && <div className="pipe-menu-group">{head}</div>}
              <div className={`pipe-menu-item ${idx === cur ? 'on' : ''}`} onMouseEnter={() => setCur(idx)} onMouseDown={(e) => (e.preventDefault(), onPick(i))}>
                <span className="pipe-menu-swatch" style={{ background: KIND_COLOR[i.kind] }} />
                {i.label}
                {i.group !== '실행' && i.group !== '데이터' && <span className="small muted"> · {KIND_LABEL[i.kind]}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Help({ empty }: { empty: boolean }) {
  return (
    <div className="small muted">
      {empty ? <p>빈 곳을 <b>우클릭</b>해 노드를 검색하거나 위의 버튼으로 첫 노드를 추가하세요.</p> : null}
      <p>
        <b>핀</b>: 왼쪽은 입력, 오른쪽은 출력입니다. 채워진 핀이 출력, 테두리만 있는 핀이 입력입니다.
      </p>
      <p>
        <b>▶ 실행 핀</b>(흰색)을 이으면 "앞 작업이 끝나면 다음 실행"입니다. 한 노드에서 여러 선이 나가면 동시에, 여러 선이 모이면 모두 끝난 뒤에 실행합니다.
      </p>
      <p>
        <b>● 글 핀</b>(보라색)은 글을 넘깁니다. 실행 노드의 아래쪽 글 입력으로 들어가면 프롬프트 뒤에 붙고, 함수의 변수 핀으로 들어가면 해당 인자로 전달됩니다. 텍스트 노드에 글이 들어오면 그 글을 그대로 내보냅니다. 할 일을 "할 일 완료"에 이으면 그 할 일을 완료합니다.
      </p>
      <p>
        <b>단일·리스트</b>: 데이터는 글 하나(● 단일)이거나 글 여러 개(▦ 리스트)입니다. 리스트 노드는 항목을 적거나 들어온 데이터를 항목으로 모읍니다. 리스트가 실행 노드에 들어가면 항목을 빈 줄로 이어 한 번에 붙이고, 합치기에 들어가면 항목마다 구분자로 잇습니다. 기능 명세 노드는 기능들의 리스트입니다.
      </p>
      <p>
        <b>셸의 데이터 출력</b>: 셸 노드 오른쪽 아래 ● 핀은 명령이 끝난 뒤의 출력을 넘깁니다. 출력을 받는 노드는 그 셸보다 실행 선으로 뒤에 있어야 합니다.
      </p>
      <p>
        <b>구조화된 출력</b>: Claude·Codex에서 출력 형식을 고르거나 출력 구조 노드를 연결해 필드 이름·타입·작성 규칙을 지정하세요. 응답을 Dictionary로 연결하면 결과를 펼쳐 보고 원하는 키·배열 인덱스를 JSON 필드 노드로 꺼낼 수 있습니다. 응답이 구조와 다르면 뒤 작업을 멈춥니다.
      </p>
      <p>
        <b>잇기</b>: 오른쪽 출력 핀을 눌러 다른 노드까지 끌어 놓으세요. 빈 곳에 놓으면 이어 붙일 노드를 검색합니다. 선을 누르고 Delete로 끊습니다.
      </p>
      <p>
        <b>꺼내기</b>: 리스트·기능 명세·기능 노드의 데이터 출력 핀을 빈 곳에 놓거나, 오른쪽 패널에서 항목을 고르세요. 꺼낸 노드는 원본에 자동으로 연결됩니다. 리스트 항목은 인덱스로 원본의 현재 값을 읽습니다.
      </p>
      <p>
        <b>이름</b>: 노드를 누르고 오른쪽에서 이름을 바꿀 수 있습니다. 같은 이름은 둘 수 없어 겹치면 뒤에 숫자가 붙습니다.
      </p>
      <p>
        <b>For Each</b>: 리스트 입력을 연결하고 반복 본문 핀에 실행할 작업을 이으세요. 항목·인덱스 핀은 본문 안에서 사용합니다. 한 항목의 작업이 모두 끝나면 다음 항목을 처리하고, 빈 리스트이거나 모든 항목을 마치면 완료 핀으로 넘어갑니다.
      </p>
      <p>
        <b>함수</b>: 새 함수에는 고정된 Input·Output 노드가 있습니다. 각 노드에서 변수 이름과 타입을 정하고, 변수 핀으로 값을 연결하세요. 함수 호출 노드에도 같은 변수가 나타납니다. 함수를 고치면 호출하는 곳 모두 다음 실행부터 바뀝니다.
      </p>
    </div>
  )
}

/** 노드 이름. 입력을 마치면(Enter·포커스 이동) 바꾼다. Esc는 되돌린다 */
function NameField({ name, kind, disabled, onRename }: { name: string; kind: string; disabled: boolean; onRename: (name: string) => void }) {
  const [v, setV] = useState(name)
  useEffect(() => setV(name), [name])
  const commit = () => v !== name && onRename(v)
  return (
    <input
      className="pipe-node-name"
      value={v}
      disabled={disabled}
      placeholder={kind}
      title="노드 이름 (같은 그래프 안에서 겹칠 수 없습니다)"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setV(name)
      }}
    />
  )
}

type AgentSession = Awaited<ReturnType<typeof api.agentSessions>>[number]

/** DM-F02-AC4: 세션 불러오기. 로컬 세션의 열린 터미널을 재사용하고, 없으면 새 탭에서 이어 쓴다 */
function SessionField({ kind, value, disabled, onChange }: { kind: 'claude' | 'codex'; value?: string; disabled: boolean; onChange: (session?: string) => void }) {
  const [list, setList] = useState<AgentSession[] | null>(null)
  const load = () => {
    setList(null)
    api.agentSessions(kind).then(setList).catch((e) => {
      setList([])
      errorToast(e)
    })
  }
  useEffect(load, [kind])
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const label = (s: AgentSession) => `${s.name || s.firstPrompt.split('\n')[0].slice(0, 60) || '(이름 없는 세션)'} · ${when(s.updatedAt)} (${s.messages})`
  const missing = !!value && !!list && !list.some((s) => s.id === value)
  return (
    <div className="field">
      <label>세션 불러오기</label>
      <div className="row" style={{ margin: 0 }}>
        <select value={value ?? ''} disabled={disabled || !list} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">새 세션으로 시작</option>
          {missing && <option value={value}>찾을 수 없는 세션</option>}
          {list?.map((s) => (
            <option key={s.id} value={s.id}>
              {label(s)}
            </option>
          ))}
        </select>
        <button disabled={!list} title="세션 목록을 다시 읽습니다" onClick={load}>
          새로고침
        </button>
      </div>
      <div className="small muted">
        {!list ? '세션을 읽는 중…' : value ? '이미 열린 세션은 기존 탭을 사용하고, 없으면 새 탭에서 이어서 실행합니다' : `이 프로젝트에 저장된 ${KIND_LABEL[kind]} 세션 ${list.length}개`}
      </div>
    </div>
  )
}

function FunctionParameters({ node, locked, onPatch }: { node: PipeNode; locked: boolean; onPatch: (patch: Partial<PipeNode>) => void }) {
  const params = node.params ?? []
  const input = node.kind === 'function-input'
  return <div className="field">
    <label>{input ? '함수 입력 변수' : '함수 출력 변수'}</label>
    <div className="small muted">변수마다 별도의 핀이 생깁니다. 이름을 바꿔도 연결은 유지됩니다.</div>
    {params.map((param) => <div className="pipe-parameter" key={param.id}>
      <input aria-label={`${input ? '입력' : '출력'} 변수 이름`} value={param.name} disabled={locked} onChange={(e) => onPatch({ params: params.map((p) => p.id === param.id ? { ...p, name: e.target.value } : p) })} />
      <select aria-label={`${param.name} 타입`} value={param.type} disabled={locked} onChange={(e) => onPatch({ params: params.map((p) => p.id === param.id ? { ...p, type: e.target.value as DataShape } : p) })}>
        {Object.entries(PARAM_TYPE_NAME).map(([type, name]) => <option key={type} value={type}>{name}</option>)}
      </select>
      <button className="ghost" title={`${param.name} 변수 삭제`} disabled={locked} onClick={() => onPatch({ params: params.filter((p) => p.id !== param.id) })}>×</button>
    </div>)}
    <button disabled={locked} onClick={() => onPatch({ params: [...params, { id: newNodeId(), name: uniqueName(input ? '입력' : '결과', params.map((p) => p.name)), type: 'single' }] })}>+ {input ? '입력' : '출력'} 변수</button>
  </div>
}

function TerminalField({ terminals, value, disabled, label = '사용할 터미널', onChange }: { terminals: TerminalInfo[]; value?: string; disabled: boolean; label?: string; onChange: (id: string) => void }) {
  const available = terminals.filter((t) => isAgent(t) && t.exited === undefined)
  return <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    <option value="">열려 있는 터미널을 고르세요</option>
    {value && !available.some((t) => t.id === value) && <option value={value}>닫힌 터미널 · 다시 선택하세요</option>}
    {available.map((t) => <option key={t.id} value={t.id}>{t.title} · {KIND_LABEL[t.kind]}{t.activity === 'working' ? ' (작업 중)' : ''}</option>)}
  </select>
}

function FunctionValues({ node, params, draft, env, locked, onPatch }: { node: PipeNode; params: FunctionParam[]; draft: Draft; env: Env; locked: boolean; onPatch: (patch: Partial<PipeNode>) => void }) {
  return <>{params.map((param, index) => {
    const linked = draft.edges.some((e) => e.to === node.id && isDataEdge(draft, e) && (e.toPort ?? params[0]?.id) === param.id)
    return <div className="field" key={param.id}>
      <label>{param.name} · {PARAM_TYPE_NAME[param.type]}{linked ? ' (핀으로 연결됨)' : ''}</label>
      {param.type === 'terminal'
        ? linked ? <div className="small muted">연결된 터미널을 사용합니다.</div> : <TerminalField terminals={env.terminals} label={`${param.name} 기본값`} disabled={locked} value={node.values?.[param.id]} onChange={(id) => onPatch({ values: { ...node.values, [param.id]: id } })} />
        : param.type === 'boolean' ? <select aria-label={`${param.name} 기본값`} disabled={locked || linked} value={linked ? '' : node.values?.[param.id] ?? 'false'} onChange={(e) => onPatch({ values: { ...node.values, [param.id]: e.target.value } })}>{linked ? <option value="">연결된 Bool 값을 사용합니다</option> : <><option value="false">False (거짓)</option><option value="true">True (참)</option></>}</select>
        : param.type === 'number' ? <input aria-label={`${param.name} 기본값`} type="number" step="any" disabled={locked || linked} value={linked ? '' : node.values?.[param.id] ?? '0'} placeholder={linked ? '연결된 숫자 값을 사용합니다' : ''} onChange={(e) => onPatch({ values: { ...node.values, [param.id]: e.target.value } })} />
        : <textarea aria-label={`${param.name} 기본값`} rows={2} disabled={locked || linked} value={node.values?.[param.id] ?? (node.kind === 'template' && index === 0 ? node.text : '')} placeholder={linked ? '연결된 노드의 값을 사용합니다' : param.type === 'list' ? '한 줄에 한 항목' : '핀을 연결하거나 기본값을 입력하세요'} onChange={(e) => onPatch({ values: { ...node.values, [param.id]: e.target.value } })} />}
    </div>
  })}</>
}

function NodePanel({
  node,
  draft,
  env,
  run,
  tabs,
  locked,
  onPatch,
  onRename,
  onExtract,
  onConnect,
  onAddAfter,
  onRemove,
  onOpenTemplate,
  onShowTerminal
}: {
  node: PipeNode
  draft: Draft
  env: Env
  run?: RunState
  tabs: TerminalInfo[]
  locked: boolean
  onPatch: (p: Partial<PipeNode>) => void
  onRename: (name: string) => void
  onExtract: (v: InnerValue) => void
  onConnect: () => void
  onAddAfter: (k: NodeKind) => void
  onRemove: () => void
  onOpenTemplate: (id: string) => void
  onShowTerminal: (termId: string) => void
}) {
  const status = nodeStatus(run, node.id)
  const runs = nodeRuns(run, node.id)
  const nm = (id: string) => nodeName(draft.nodes.find((n) => n.id === id) ?? { id })
  const inputs = draft.edges.filter((e) => e.to === node.id).map((e) => nm(e.from))
  const outputs = draft.edges.filter((e) => e.from === node.id).map((e) => nm(e.to))
  const output = (id: string) => run?.nodes[id]?.status === 'done' ? run.nodes[id].output : undefined
  const inner = (() => { try { return innerValues(node, env, draft, output) } catch { return [] } })()
  const schemaLinked = draft.edges.some((e) => e.to === node.id && isDataEdge(draft, e) && (e.toPort === AGENT_PORT.schema || edgeShape(draft, e, env) === 'schema'))
  const jsonResult = (() => {
    if (node.kind !== 'dictionary' && node.kind !== 'property') return undefined
    try {
      const text = dataValue(draft, node.id, env)
      if (outputRefs(text).some((id) => output(id) === undefined)) return undefined
      return { value: parseJson(fillOutputs(text, (id) => output(id) ?? '')) }
    } catch { return undefined }
  })()
  const target = specTarget(node, env)
  const linkedTerminal = hasTerminalInput(draft, node, env)
  // 실행 노드의 결과가 들어갈 자리는 "[셸의 출력]"처럼 보여 준다
  const preview = (() => {
    try {
      if (node.kind === 'terminal') return env.terminals.find((t) => t.id === node.ref)?.title ?? '사용할 터미널을 고르세요'
      let text = isData(node) ? dataValue(draft, node.id, env) : node.kind === 'complete' ? '' : nodeInput(draft, node.id, env)
      const schema = agentSchema(draft, node.id, env)
      if (schema) text = structuredPrompt(text, schema)
      const refs = outputRefs(text)
      const pending = refs.some((id) => output(id) === undefined) || (!refs.length && text.includes('\u0000계산:'))
      return fillOutputs(text, (id) => output(id) ?? `[${nm(id)}의 출력]`, pending)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  })()
  const listItems = (() => {
    try {
      return node.kind === 'list' && inputs.length ? dataItems(draft, node.id, env).map((t) => fillOutputs(t, (id) => output(id) ?? `[${nm(id)}의 출력]`, outputRefs(t).some((id) => output(id) === undefined))) : []
    } catch {
      return []
    }
  })()
  const items = node.items ?? []
  const tpl = node.kind === 'template' ? env.library.find((p) => p.id === node.ref) : undefined
  const task = node.kind === 'task' || node.kind === 'complete' ? env.tasks.find((t) => t.id === node.ref) : undefined
  const linkedTasks =
    node.kind === 'complete'
      ? draft.edges
          .filter((e) => e.to === node.id)
          .map((e) => draft.nodes.find((n) => n.id === e.from))
          .filter((n) => n?.kind === 'task')
      : []

  return (
    <>
      <NameField key={node.id} name={nodeName(node)} kind={KIND_LABEL[node.kind]} disabled={locked || isFunctionBoundary(node)} onRename={onRename} />
      {node.kind === 'if' && <>
        <div className="small muted">Bool 조건이 참이면 True, 거짓이면 False 경로로 실행합니다. 비교·논리 노드의 빨간 출력 핀을 조건에 연결하세요.</div>
        <FunctionValues node={node} params={functionParams(node, env).inputs} draft={draft} env={env} locked={locked} onPatch={onPatch} />
      </>}
      {isLogic(node) && <>
        {node.kind === 'compare' && <div className="grid2">
          <div className="field"><label>비교 타입</label><select aria-label="비교 타입" disabled={locked} value={node.compareType ?? 'number'} onChange={(e) => {
            const compareType = e.target.value as NonNullable<PipeNode['compareType']>
            onPatch({ compareType, operation: compareType !== 'number' && !['eq', 'ne'].includes(node.operation ?? 'eq') ? 'eq' : node.operation, values: Object.fromEntries(functionParams(node, env).inputs.map((p) => [p.id, defaultValue(compareType)])) })
          }}>{(['number', 'single', 'boolean'] as const).map((type) => <option key={type} value={type}>{PARAM_TYPE_NAME[type]}</option>)}</select></div>
          <div className="field"><label>비교 연산</label><select aria-label="비교 연산" disabled={locked} value={node.operation ?? 'eq'} onChange={(e) => onPatch({ operation: e.target.value as PipeNode['operation'] })}>
            {Object.entries(COMPARE_OPS).filter(([op]) => !node.compareType || node.compareType === 'number' || ['eq', 'ne'].includes(op)).map(([op, label]) => <option key={op} value={op}>{label}</option>)}
          </select></div>
        </div>}
        <div className="small muted">{node.kind === 'compare' ? '같은 타입의 A와 B를 비교합니다. 텍스트는 대소문자·공백까지 일치해야 같습니다.' : node.kind === 'and' ? 'A와 B가 모두 참이면 True입니다.' : node.kind === 'or' ? 'A와 B 중 하나라도 참이면 True입니다.' : '입력 Bool 값을 반전합니다.'}</div>
        <FunctionValues node={node} params={functionParams(node, env).inputs} draft={draft} env={env} locked={locked} onPatch={onPatch} />
      </>}
      {(node.kind === 'boolean' || node.kind === 'number') && <div className="field">
        <label>{KIND_LABEL[node.kind]} 값</label>
        {inputs.length ? <div className="small muted">연결된 값을 {KIND_LABEL[node.kind]}로 변환합니다. {node.kind === 'boolean' ? 'true 또는 false만 허용합니다.' : '유효한 숫자만 허용합니다.'}</div>
          : node.kind === 'boolean' ? <select aria-label="Bool 값" disabled={locked} value={node.text || 'false'} onChange={(e) => onPatch({ text: e.target.value })}><option value="false">False (거짓)</option><option value="true">True (참)</option></select>
          : <input aria-label="숫자 값" type="number" step="any" disabled={locked} value={node.text || '0'} onChange={(e) => onPatch({ text: e.target.value })} />}
      </div>}
      {node.kind === 'schema' && <div className="field">
        <label>출력 필드</label>
        <OutputFields fields={node.fields ?? []} disabled={locked} onChange={(fields) => onPatch({ fields })} />
        <div className="small muted">Claude·Codex의 출력 구조 핀에 연결하면 이 형식으로 응답을 요청합니다.</div>
      </div>}
      {node.kind === 'dictionary' && <div className="field">
        <label>Dictionary 값</label>
        {inputs.length ? <div className="small muted">{inputs.join(', ')}의 JSON 객체를 읽습니다. 다시 실행하면 새 결과를 표시합니다.</div> : <textarea aria-label="Dictionary JSON" rows={6} disabled={locked} value={node.text} placeholder={'{ "people": "민수" }'} onChange={(e) => onPatch({ text: e.target.value })} />}
      </div>}
      {node.kind === 'property' && <div className="field">
        <label>필드 경로</label>
        <input aria-label="JSON 필드 경로" value={node.pointer ?? ''} disabled={locked} placeholder="/people 또는 /people/0/name" onChange={(e) => onPatch({ pointer: e.target.value })} />
        <div className="small muted">연결된 원본에서 해당 키나 배열 인덱스를 읽습니다. 빈 경로는 전체 값입니다. 키의 /는 ~1, ~는 ~0으로 적으세요.</div>
      </div>}
      {jsonResult && <div className="field pipe-json-result">
        <label>현재 데이터</label>
        <JsonTree value={jsonResult.value} disabled={locked} onExtract={(path) => onExtract({ kind: 'property', pointer: toPointer(path), label: path.join(' / ') })} />
      </div>}
      {isFunctionBoundary(node) && <>
        <div className="small muted">함수의 고정 {node.kind === 'function-input' ? '입력' : '출력'} 노드입니다.</div>
        <FunctionParameters node={node} locked={locked} onPatch={onPatch} />
        {node.kind === 'function-output' && <FunctionValues node={node} params={node.params ?? []} draft={draft} env={env} locked={locked} onPatch={onPatch} />}
      </>}
      {node.kind === 'terminal' && <div className="field">
        <label>사용할 터미널</label>
        <TerminalField terminals={env.terminals} value={node.ref} disabled={locked} onChange={(ref) => onPatch({ ref })} />
        <div className="small muted">출력 핀을 같은 종류의 Codex·Claude Code 노드의 터미널 입력에 연결하세요. 선택한 탭에서 실행합니다.</div>
      </div>}
      {node.kind === 'item' && <div className="field">
        <label>항목 인덱스 (0부터 시작)</label>
        <input aria-label="항목 인덱스" type="number" min="0" step="1" value={node.index ?? 0} disabled={locked} onChange={(e) => onPatch({ index: Math.max(0, Math.trunc(Number(e.target.value))) })} />
        <div className="small muted">연결된 리스트의 해당 항목을 읽습니다. 원본 값이 바뀌면 함께 바뀝니다.</div>
      </div>}
      {node.kind === 'foreach' && <>
        <div className="small muted">리스트를 한 항목씩 순서대로 처리합니다. 반복 본문에 작업을 연결하고 항목·인덱스 핀으로 값을 넘기세요. 본문 끝을 다시 연결할 필요가 없습니다. 모든 반복을 마치면 완료 핀으로 넘어갑니다.</div>
        <FunctionValues node={node} params={functionParams(node, env).inputs} draft={draft} env={env} locked={locked} onPatch={onPatch} />
      </>}
      <div className="small muted" title="이름을 바꿔도 이어진 선은 그대로입니다">
        {isData(node) ? `데이터 노드 (${SHAPE_NAME[dataShape(node)]})` : '액션 노드'} · {KIND_LABEL[node.kind]}
      </div>
      {status && <Badge kind={status === 'done' ? 'pass' : status === 'failed' ? 'fail' : ''}>{STATUS_LABEL[status]}</Badge>}
      {runs.length > 0 && (
        <div className="pipe-runs">
          {runs.map(([k, st]) => (
            <div key={k} className="row" style={{ margin: '4px 0' }}>
              {k !== node.id && <span className="small">{st.name ?? nodeName(node)}</span>}
              <Badge kind={st.status === 'done' ? 'pass' : st.status === 'failed' ? 'fail' : ''}>{STATUS_LABEL[st.status]}</Badge>
              {st.message && <span className="small muted">{st.message}</span>}
              {st.termId && tabs.some((t) => t.id === st.termId) && <button onClick={() => onShowTerminal(st.termId!)}>터미널 보기</button>}
              {st.output !== undefined && (
                <details className="pipe-preview" style={{ width: '100%' }}>
                  <summary className="small">{isAgent(node) ? '최종 응답' : '명령 출력 (데이터 출력으로 넘긴 글)'}</summary>
                  <pre>{st.output || '(출력 없음)'}</pre>
                </details>
              )}
              {st.structuredOutput && <div className="pipe-json-result" style={{ width: '100%' }}>
                <JsonTree value={st.structuredOutput} disabled={locked} onExtract={(path) => onExtract({ kind: 'property', pointer: toPointer(path), label: path.join(' / ') })} />
              </div>}
              {st.status === 'running' && !st.code && (
                <button title="응답 끝 신호가 오지 않았을 때 직접 넘깁니다" onClick={() => run && void api.markNodeDone(run.runId, k)}>
                  끝남으로 넘기기
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {AGENT_KINDS.includes(node.kind) && (
        <>
          <div className="grid2">
            <div className="field">
              <label>종류</label>
              <select value={node.kind} disabled={locked} onChange={(e) => onPatch({ kind: e.target.value as NodeKind, session: undefined })}>
                {AGENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>터미널</label>
              <select aria-label="터미널 실행 방식" value={linkedTerminal ? 'input' : node.terminal} disabled={locked || linkedTerminal} onChange={(e) => onPatch({ terminal: e.target.value as PipeNode['terminal'] })}>
                {linkedTerminal && <option value="input">입력 핀에 연결한 터미널</option>}
                <option value="new">{node.session ? '선택한 세션에서' : '새 탭에서'}</option>
                <option value="continue">앞 노드 터미널에서 이어서</option>
              </select>
            </div>
          </div>
          {linkedTerminal && <div className="small muted">터미널 입력에 연결된 탭에서 실행합니다. 터미널 출력으로 뒤 노드에 같은 탭을 넘길 수 있습니다.</div>}
          {(node.kind === 'claude' || node.kind === 'codex') && node.terminal === 'new' && !linkedTerminal && (
            <SessionField kind={node.kind} value={node.session} disabled={locked} onChange={(session) => onPatch({ session })} />
          )}
          <div className="field">
            <label>{node.kind === 'shell' ? '명령 (여러 줄이면 차례로 실행)' : '프롬프트'}</label>
            <textarea
              className="task-body"
              value={node.text}
              disabled={locked}
              placeholder={node.kind === 'shell' ? '예: npm test' : `예: 로그인 API를 구현해${draft.template ? ' (Input의 변수 핀을 연결하거나 {{변수 이름}}을 사용하세요)' : ''}`}
              onChange={(e) => onPatch({ text: e.target.value })}
            />
          </div>
          {isAgent(node) && <div className="field">
            <label>출력 형식</label>
            <select aria-label="출력 형식" value={schemaLinked || node.fields ? 'json' : 'text'} disabled={locked || schemaLinked} onChange={(e) => onPatch({ fields: e.target.value === 'json' ? defaultOutputFields() : undefined })}>
              <option value="text">자유 텍스트</option>
              <option value="json">구조화된 JSON</option>
            </select>
            {schemaLinked ? <div className="small muted">출력 구조 핀에 연결한 노드의 필드·작성 규칙을 사용합니다.</div> : node.fields && <OutputFields fields={node.fields} disabled={locked} onChange={(fields) => onPatch({ fields })} />}
            <div className="small muted">프롬프트 핀에 텍스트·데이터를 연결할 수 있습니다. 구조화된 응답은 필수 키와 타입을 검사하며, 맞지 않으면 뒤 작업을 멈춥니다.</div>
            <button disabled={locked} onClick={() => onExtract({ kind: 'dictionary', label: `${nodeName(node)} 결과` })}>+ 결과 Dictionary</button>
          </div>}
        </>
      )}

      {node.kind === 'template' && (
        <>
          <div className="field">
            <label>호출할 함수</label>
            <div className="row" style={{ margin: 0 }}>
              <select value={node.ref ?? ''} disabled={locked} onChange={(e) => onPatch({ ref: e.target.value })}>
                {!tpl && <option value="">골라 주세요</option>}
                {env.library
                  .filter((p) => p.template && p.id !== draft.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
              </select>
              {tpl && <button onClick={() => onOpenTemplate(tpl.id)}>열기</button>}
            </div>
          </div>
          {tpl && (
            <div className="small muted">
              함수의 Input·Output에서 변수 이름과 타입을 설정합니다. 함수 변경은 다음 호출부터 반영됩니다.
            </div>
          )}
          <FunctionValues node={node} params={functionParams(node, env).inputs} draft={draft} env={env} locked={locked} onPatch={onPatch} />
          <div className="small muted">출력: {functionParams(node, env).outputs.map((p) => `${p.name} (${PARAM_TYPE_NAME[p.type]})`).join(', ') || '없음'}</div>
        </>
      )}

      {node.kind === 'add' && <>
        <div className="small muted">A 뒤에 B를 그대로 이어 붙입니다. 입력 핀에 텍스트를 연결하거나 아래에 직접 적으세요. 공백·줄바꿈은 입력한 만큼만 들어갑니다.</div>
        <FunctionValues node={node} params={functionParams(node, env).inputs} draft={draft} env={env} locked={locked} onPatch={onPatch} />
      </>}

      {node.kind === 'text' &&
        (inputs.length > 0 ? (
          <div className="field">
            <label>글 (입력 {inputs.join(', ')}에서 들어온 글을 그대로 내보냅니다 · 고칠 수 없음)</label>
            <textarea className="task-body" value={preview} readOnly disabled title="입력 선을 끊으면 직접 적을 수 있습니다" />
          </div>
        ) : (
          <div className="field">
            <label>글</label>
            <textarea className="task-body" value={node.text} disabled={locked} placeholder="프롬프트에 붙일 글" onChange={(e) => onPatch({ text: e.target.value })} />
          </div>
        ))}

      {node.kind === 'list' &&
        (inputs.length > 0 ? (
          <div className="field">
            <label>항목 {listItems.length}개 (입력 {inputs.join(', ')}에서 들어온 데이터를 항목으로 모읍니다 · 고칠 수 없음)</label>
            <ol className="pipe-list-items small">
              {listItems.map((t, i) => (
                <li key={i}>{short(t, 60)}</li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="field">
            <label>항목 {items.filter((t) => t.trim()).length}개 (실행 노드에 들어가면 빈 줄로 이어 한 번에 붙습니다)</label>
            <div className="pipe-list-items">
              {items.map((t, i) => (
                <div key={i} className="row" style={{ margin: 0, alignItems: 'flex-start' }}>
                  <span className="small muted">{i + 1}</span>
                  <textarea
                    rows={2}
                    value={t}
                    disabled={locked}
                    placeholder="항목 글"
                    onChange={(e) => onPatch({ items: items.map((x, k) => (k === i ? e.target.value : x)) })}
                  />
                  <button className="ghost" title="항목 지우기" disabled={locked} onClick={() => onPatch({ items: items.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button disabled={locked} onClick={() => onPatch({ items: [...items, ''] })}>
              + 항목
            </button>
          </div>
        ))}

      {node.kind === 'join' && (
        <div className="field">
          <label>구분자 (비우면 빈 줄, \n은 줄바꿈)</label>
          <input value={node.text} disabled={locked} onChange={(e) => onPatch({ text: e.target.value })} />
          <div className="small muted">들어오는 글을 위에 있는 노드부터 차례로 잇습니다. 리스트가 들어오면 그 항목들을 하나씩 잇습니다.</div>
        </div>
      )}

      {(node.kind === 'task' || node.kind === 'complete') && (
        <div className="field">
          <label>{node.kind === 'task' ? '가져올 할 일' : '완료할 할 일 (이어진 할 일 노드도 완료합니다)'}</label>
          <select value={node.ref ?? ''} disabled={locked} onChange={(e) => onPatch({ ref: e.target.value || undefined })}>
            <option value="">{node.kind === 'task' ? '골라 주세요' : '이어진 할 일 노드만'}</option>
            {env.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title} ({t.status})
              </option>
            ))}
          </select>
          {node.ref && !task && <div className="small" style={{ color: 'var(--bad)' }}>할 일을 찾을 수 없습니다 ({node.ref})</div>}
          {linkedTasks.length > 0 && <div className="small muted">이어진 할 일: {linkedTasks.map((n) => n!.ref).join(', ')}</div>}
        </div>
      )}

      {node.kind === 'skill' && (
        <div className="field">
          <label>스킬 (실행할 때마다 스킬 파일의 지금 내용을 내보냅니다)</label>
          <select value={node.ref ?? ''} disabled={locked} onChange={(e) => onPatch({ ref: e.target.value || undefined })}>
            {!env.skills.some((s) => s.id === node.ref) && <option value="">골라 주세요</option>}
            {env.skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.scope === 'user' ? ' (내 스킬)' : ''}
              </option>
            ))}
          </select>
          {(() => {
            const s = env.skills.find((x) => x.id === node.ref)
            if (!s) return node.ref ? <div className="small" style={{ color: 'var(--bad)' }}>스킬을 찾을 수 없습니다 ({node.ref})</div> : null
            return (
              <div className="small muted">
                {s.description}
                <br />
                <code>{s.file}</code>
              </div>
            )
          })()}
        </div>
      )}

      {SPEC_KINDS.includes(node.kind) && (
        <div className="field">
          <label>{node.kind === 'spec' ? '기능 명세 (실행할 때마다 명세의 지금 내용을 내보냅니다)' : node.kind === 'feature' ? '기능' : '수용 기준'}</label>
          <select
            value={node.ref ?? ''}
            disabled={locked}
            onChange={(e) => onPatch({ ref: e.target.value || undefined })}
          >
            {!(node.kind === 'spec' ? target.spec : node.kind === 'feature' ? target.feature : target.ac) && <option value="">골라 주세요</option>}
            {env.specs.map((s) =>
              node.kind === 'spec' ? (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ) : (
                <optgroup key={s.id} label={s.title}>
                  {s.features.flatMap((f) =>
                    node.kind === 'feature'
                      ? [
                          <option key={f.id} value={`${s.id}#${f.id}`}>
                            {f.id} {f.name}
                          </option>
                        ]
                      : f.acs.map((a) => (
                          <option key={a.id} value={`${s.id}#${a.id}`}>
                            {f.id} AC{a.num} {short(a.text, 40)}
                          </option>
                        ))
                  )}
                </optgroup>
              )
            )}
          </select>
          {node.ref && !(node.kind === 'spec' ? target.spec : node.kind === 'feature' ? target.feature : target.ac) && (
            <div className="small" style={{ color: 'var(--bad)' }}>
              {KIND_LABEL[node.kind]}을(를) 찾을 수 없습니다 ({node.ref})
            </div>
          )}
        </div>
      )}

      {inner.length > 0 && (
        <div className="field">
          <label>꺼내기 ({node.kind === 'spec' ? '기능' : node.kind === 'list' ? '항목' : node.kind === 'feature' ? '수용 기준' : '필드'}를 새 데이터 노드로 · 출력 핀을 빈 곳에 놓아도 됩니다)</label>
          <div className="pipe-inner">
            {inner.map((v, i) => (
              <button key={v.ref ?? i}className="ghost" disabled={locked} title={v.label} onClick={() => onExtract(v)}>
                + {short(v.label, 34)}
              </button>
            ))}
          </div>
        </div>
      )}

      {preview && node.kind !== 'text' && node.kind !== 'foreach' && (
        <details className="pipe-preview" open={isData(node)}>
          <summary className="small">{node.kind === 'if' ? '조건 (Bool)' : isLogic(node) ? '계산 결과 (Bool)' : node.kind === 'terminal' ? '선택한 터미널' : isData(node) ? '내보내는 값' : node.kind === 'template' ? '함수에 넘길 입력' : '실제로 보낼 글'}</summary>
          <pre>{preview}</pre>
        </details>
      )}

      <div className="small muted">
        들어옴: {inputs.length ? inputs.join(', ') : '없음'} · 나감: {outputs.length ? outputs.join(', ') : '없음'}
      </div>
      <div className="row">
        <button disabled={locked || node.kind === 'function-output'} onClick={onConnect}>
          → 이어 줄 노드 고르기
        </button>
        {!isData(node) && node.kind !== 'function-output' && (
          <select value="" disabled={locked} onChange={(e) => e.target.value && onAddAfter(e.target.value as NodeKind)}>
            <option value="">+ 뒤에 새 노드</option>
            {AGENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
            <option value="complete">{KIND_LABEL.complete}</option>
          </select>
        )}
        <button className="danger" disabled={locked || isFunctionBoundary(node)} onClick={onRemove}>
          노드 삭제
        </button>
      </div>
    </>
  )
}

/** 그래프 그리기. 처음 한 번 만들고, 이후에는 바뀐 노드·선·상태만 고친다. */
function Canvas({
  draft,
  env,
  run,
  sel,
  connectFrom,
  locked,
  canConnect,
  onConnect,
  onTapNode,
  onOpenNode,
  onTapEdge,
  onTapBackground,
  onMoved,
  onMenu,
  children
}: {
  draft: Draft
  env: Env
  run?: RunState
  sel: Sel
  connectFrom: string | null
  locked: boolean
  canConnect: (from: string, to: string, pin?: OutPin, toPort?: string) => boolean
  onConnect: (from: string, to: string, pin?: OutPin, toPort?: string) => void
  onTapNode: (id: string) => void
  onOpenNode: (id: string) => void
  onTapEdge: (edge: PipeEdge) => void
  onTapBackground: () => void
  onMoved: (id: string, x: number, y: number) => void
  /** 노드 검색 메뉴 열기: 화면 위치, 그래프 위치, 핀을 끌어 놓은 경우 그 출발 노드와 핀 */
  onMenu: (rendered: Pt, model: Pt, from?: string, pin?: OutPin) => void
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const dark = useDark()
  const fitted = useRef<string | null>(null)
  const shown = useRef(0)
  const h = useRef({ canConnect, onConnect, onTapNode, onOpenNode, onTapEdge, onTapBackground, onMoved, onMenu, locked })
  h.current = { canConnect, onConnect, onTapNode, onOpenNode, onTapEdge, onTapBackground, onMoved, onMenu, locked }
  useWheelZoom(ref, cy)

  useEffect(() => {
    if (!ref.current) return
    const accent = dark ? '#3fbfae' : '#0b7a70'
    const execColor = dark ? '#e4e7ec' : '#3d4454'
    const bg = dark ? '#1c2026' : '#ffffff'
    const instance = cytoscape({
      container: ref.current,
      minZoom: 0.25,
      maxZoom: 2.5,
      style: [
        {
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            'background-color': 'data(color)',
            'background-opacity': 0.16,
            'border-width': 1.5,
            'border-color': 'data(color)',
            label: 'data(label)',
            'text-wrap': 'wrap',
            'text-valign': 'center',
            color: dark ? '#e4e7ec' : '#1c2230',
            'font-family': 'Pretendard Variable, Pretendard, sans-serif',
            'font-size': 11,
            width: EXEC_W,
            height: EXEC_H,
            'text-margin-y': 2,
            'bounds-expansion': PIN
          }
        },
        { selector: 'node[?data]', style: { height: DATA_H, width: DATA_W, 'border-style': 'dashed', 'background-opacity': 0.12 } },
        ...NODE_KINDS_UI.map((k) => ({ selector: `node[kind = "${k}"]`, style: pinStyle(pinsOf(k), execColor, bg) as unknown as cytoscape.Css.Node })),
        { selector: 'node[kind = "template"]', style: { 'border-width': 3, 'border-style': 'double' } },
        { selector: 'node.running, node.starting', style: { 'border-width': 3.5, 'border-color': accent, 'background-opacity': 0.32 } },
        { selector: 'node.done', style: { 'border-color': '#5a8f2e', 'border-width': 2.5 } },
        { selector: 'node.failed', style: { 'border-color': '#c53030', 'border-width': 3 } },
        { selector: 'node.skipped', style: { opacity: 0.45 } },
        { selector: 'node.unused', style: { opacity: 0.4 } },
        { selector: 'node[kind = "start"]', style: { shape: 'round-rectangle', width: 110, height: 40, 'background-opacity': 0.3, 'font-weight': 'bold' } },
        { selector: 'node.sel', style: { 'overlay-color': accent, 'overlay-opacity': 0.12, 'overlay-padding': 6 } },
        // 상세 패널의 sel과 별개로 Shift+클릭·영역 선택된 모든 노드에 외곽선을 표시한다.
        { selector: 'node:selected', style: { 'outline-color': accent, 'outline-width': 2, 'outline-offset': 4 } },
        { selector: 'node.source, node.eh-source', style: { 'border-color': '#d0702a', 'border-width': 3 } },
        { selector: 'node.eh-target', style: { 'border-color': accent, 'border-width': 3.5 } },
        {
          // 선은 출력 핀 중심에서 나와 맞는 입력 핀 중심으로 들어간다
          selector: 'edge',
          style: {
            width: 2.4,
            'line-color': execColor,
            'curve-style': 'unbundled-bezier',
            'edge-distances': 'endpoints',
            'control-point-weights': (e: cytoscape.EdgeSingular) => bezierCtrl(e).w,
            'control-point-distances': (e: cytoscape.EdgeSingular) => bezierCtrl(e).d,
            'source-endpoint': (e: cytoscape.EdgeSingular) => {
              const o = sourceOffset(e)
              return `${o.x}px ${o.y}px`
            },
            'target-endpoint': (e: cytoscape.EdgeSingular) => {
              const o = targetOffset(e)
              // 임시 끝점은 커서 가운데 (edge-distances: endpoints는 양 끝이 모두 직접 정한 위치여야 한다)
              return o ? `${o.x}px ${o.y}px` : '0px 0px'
            }
          } as unknown as cytoscape.Css.Edge
        },
        { selector: 'edge.data', style: { 'line-color': DATA_COLOR, width: 2 } },
        { selector: 'edge.terminal', style: { 'line-color': TERMINAL_COLOR, width: 2 } },
        { selector: 'edge.boolean', style: { 'line-color': BOOL_COLOR, width: 2 } },
        { selector: 'edge.number', style: { 'line-color': NUMBER_COLOR, width: 2 } },
        { selector: 'edge.sel, edge.hover', style: { 'line-color': accent, width: 3.4 } },
        { selector: '.eh-ghost-edge, edge.eh-preview', style: { 'line-color': '#d0702a', 'line-style': 'dashed', width: 2 } },
        { selector: '.eh-ghost-edge.eh-preview-active', style: { opacity: 0 } }
      ]
    })
    // 지금 끌고 있는 출력 핀 (실행 노드의 데이터 출력이면 'data')
    let dragPin: OutPin
    let pointer: Pt | undefined
    const targetPins = (source: NodeSingular, target: NodeSingular) => {
      const type = (dragPin && !isExecPort(dragPin)) || source.data('data') ? 'data' : 'exec'
      return ((target.data('pins') as Pin[] | undefined) ?? []).filter((p) => p.side === 'in' && p.type === type)
    }
    const targetPort = (source: NodeSingular, target?: NodeSingular): string | undefined => {
      if (!target || target.empty()) return undefined
      const all = targetPins(source, target)
      const compatible = all.filter((p) => h.current.canConnect(source.id(), target.id(), dragPin, p.id))
      const pins = compatible.length ? compatible : all
      const y = (pointer?.y ?? target.position().y) - target.position().y
      return pins.sort((a, b) => Math.abs(a.dy - y) - Math.abs(b.dy - y))[0]?.id
    }
    instance.on('mousemove tapdrag', (event) => {
      if (event.position) pointer = event.position
      instance.edges('.eh-preview').forEach((e) => {
        const port = targetPort(e.source(), e.target())
        if (port) e.data('toPort', port)
      })
    })
    const eh = (instance as unknown as { edgehandles: (o: object) => { start: (n: NodeSingular) => void } }).edgehandles({
      // 빈 곳에 놓을 때는 대상이 비어서 오는데, 여기서 막으면 ehcancel(→ 검색 메뉴)이 오지 않는다
      // edgehandles는 노드 단위로 결과를 기억한다. 가능한 포트가 있으면 허용하고, 놓을 때 고른 포트를 검사한다.
      canConnect: (s: NodeSingular, t: NodeSingular) => !t || t.empty() || targetPins(s, t).some((p) => h.current.canConnect(s.id(), t.id(), dragPin, p.id)),
      // 미리 보기 선도 끌고 있는 핀에서 나오게
      edgeParams: (s: NodeSingular, t: NodeSingular) => ({ data: { ...edgeOf(s.id(), t?.id() ?? '', dragPin, targetPort(s, t)) } }),
      snap: true,
      snapThreshold: 30,
      hoverDelay: 80
    })
    // 핀을 누르면 노드를 옮기지 않고 선을 끈다. 핀은 반쯤 노드 밖에 걸쳐 있으므로 노드가 아니라 화면 전체에서 거리로 찾는다
    let grabbed: NodeSingular | null = null
    instance.on('tapstart', (e) => {
      if (h.current.locked) return
      const r = e.renderedPosition
      const z = instance.zoom()
      const reach = Math.max(9, (PIN / 2 + 4) * z)
      // 실행 노드는 출력 핀이 둘(▶ 실행, ● 데이터)일 수 있다: 누른 쪽을 고른다
      const hits = instance.nodes().toArray().flatMap((x) => {
        const c = x.renderedPosition()
        const kind = x.data('kind') as NodeKind | undefined
        if (!kind) return []
        const pins = ((x.data('pins') as Pin[] | undefined) ?? pinsOf(kind)).filter((p) => p.side === 'out')
        return pins.map((p) => ({ node: x, pin: p.id ?? (p.type === 'data' && !isData({ kind }) ? 'data' : undefined), distance: Math.hypot(r.x - (c.x + x.renderedWidth() / 2), r.y - (c.y + p.dy * z)) })).filter((p) => p.distance <= reach)
      })
      const hit = hits.sort((a, b) => a.distance - b.distance)[0]
      if (!hit) return
      hit.node.ungrabify()
      grabbed = hit.node
      dragPin = hit.pin
      eh.start(hit.node)
    })
    instance.on('tapend', () => {
      grabbed?.grabify()
      grabbed = null
    })
    instance.on('ehcomplete', (event, source: NodeSingular, target: NodeSingular, added: cytoscape.EdgeSingular) => {
      if (event.position) pointer = event.position
      added.remove()
      h.current.onConnect(source.id(), target.id(), dragPin, targetPort(source, target))
    })
    // 블루프린트처럼: 핀을 빈 곳에 놓으면 그 자리에 이어 붙일 노드를 검색한다
    instance.on('ehcancel', (e, source: NodeSingular) => {
      const m = e.position
      if (m) pointer = m
      const s = source.position()
      if (!m || Math.hypot(m.x - s.x, m.y - s.y) < source.width() / 2 + 30) return
      // 노드 위에 놓았는데 머문 시간이 짧아 대상으로 잡히지 않았으면 그 노드에 바로 잇는다
      const over = instance.nodes().filter((n) => {
        const bb = n.boundingBox({ includeLabels: false, includeOverlays: false })
        // 끄는 동안 커서 밑에 있는 edgehandles의 보이지 않는 노드는 빼고 그래프의 노드만 (kind가 있는 것)
        return !!n.data('kind') && n.id() !== source.id() && m.x >= bb.x1 && m.x <= bb.x2 && m.y >= bb.y1 && m.y <= bb.y2
      })[0]
      if (over) return h.current.onConnect(source.id(), over.id(), dragPin, targetPort(source, over))
      h.current.onMenu(toRendered(instance, m), m, source.id(), dragPin)
    })
    // 빈 곳을 우클릭하면 그 자리에 놓을 노드를 검색한다
    instance.on('cxttap', (e) => {
      if (e.target !== instance || h.current.locked) return
      h.current.onMenu(e.renderedPosition, e.position)
    })
    instance.on('tap', 'node', (e) => h.current.onTapNode(e.target.id()))
    instance.on('dbltap', 'node', (e) => h.current.onOpenNode(e.target.id()))
    instance.on('tap', 'edge', (e) => {
      h.current.onTapEdge(edgeOf(e.target.data('source'), e.target.data('target'), e.target.data('fromPort') ?? e.target.data('pin'), e.target.data('toPort')))
    })
    instance.on('tap', (e) => e.target === instance && h.current.onTapBackground())
    // 곡선 조절점은 양 끝 위치로 정하므로 노드가 움직이면 다시 계산한다
    instance.on('position', 'node', (e) => e.target.connectedEdges().updateStyle())
    instance.on('dragfree', 'node', (e) => {
      const p = e.target.position()
      h.current.onMoved(e.target.id(), Math.round(p.x), Math.round(p.y))
    })
    instance.on('mouseover', 'edge', (e) => e.target.addClass('hover'))
    instance.on('mouseout', 'edge', (e) => e.target.removeClass('hover'))
    instance.on('mouseover', 'node, edge', () => ref.current && (ref.current.style.cursor = 'pointer'))
    instance.on('mouseout', 'node, edge', () => ref.current && (ref.current.style.cursor = 'default'))
    cy.current = instance
    // 확인용: 개발 도구나 스모크 확인에서 그래프 상태를 볼 수 있게 노출
    ;(window as unknown as { __orbitPipe?: Core }).__orbitPipe = instance
    fitted.current = null
    return () => {
      instance.destroy()
      cy.current = null
    }
  }, [dark])

  // 다른 그래프로 바꿨거나, 빈 그래프에 첫 노드가 생겼거나, 새 노드가 화면 밖이면 화면에 맞춘다
  useEffect(() => {
    const c = cy.current
    if (!c) return
    const ids = new Set(draft.nodes.map((n) => n.id))
    const key = `${draft.id}:${draft.nodes.length > 0}`
    // 시작 노드가 있으면 거기서 닿지 않는 노드는 흐리게 (실행되지 않는다)
    const live = draft.nodes.some((n) => n.kind === 'start') ? liveNodes(draft) : null
    c.batch(() => {
      if (!fitted.current?.startsWith(`${draft.id}:`)) c.elements().remove()
      c.nodes().forEach((n) => void (ids.has(n.id()) || n.remove()))
      for (const n of draft.nodes) {
        const st = live && !live.has(n.id) ? 'unused' : nodeStatus(run, n.id)
        const label = nodeLabel(n, env, draft)
        const functional = isPortNode(n)
        const pins = functional ? functionGeometry(n, env).pins : pinsOf(n.kind)
        const data = { id: n.id, kind: n.kind, data: isData(n), label: functional ? '' : label, pins, color: KIND_COLOR[n.kind] }
        let el = c.getElementById(n.id)
        if (el.empty()) el = c.add({ group: 'nodes', data, position: { x: n.x ?? 0, y: n.y ?? 0 } })
        else el.data(data)
        const color = dark ? '#e4e7ec' : '#3d4454', background = dark ? '#1c2026' : '#ffffff'
        el.style((functional ? functionStyle(n, env, color, background) : { ...pinStyle(pins, color, background), label, width: n.kind === 'start' ? 110 : isData(n) ? DATA_W : EXEC_W, height: n.kind === 'start' ? 40 : isData(n) ? DATA_H : EXEC_H }) as unknown as cytoscape.Css.Node)
        const selected = !!sel && 'node' in sel && sel.node === n.id
        el.classes([st ?? '', selected ? 'sel' : '', connectFrom === n.id ? 'source' : ''].filter(Boolean))
      }
      const want = new Set(draft.edges.map(edgeKey))
      c.edges().forEach((e) => void (want.has(e.id()) || e.remove()))
      for (const e of draft.edges) {
        const id = edgeKey(e)
        let el = c.getElementById(id)
        if (el.empty()) el = c.add({ group: 'edges', data: { id, source: e.from, target: e.to, pin: e.pin, fromPort: e.fromPort, toPort: e.toPort } })
        const s = !!sel && 'edge' in sel && sameEdge(sel.edge, e)
        el.classes([...(isDataEdge(draft, e) ? ['data', edgeShape(draft, e, env)] : []), ...(s ? ['sel'] : [])])
      }
    })
    c.style().update()
    const ext = c.extent()
    const outside = c.nodes().some((n) => {
      const b = n.boundingBox({})
      return b.x1 < ext.x1 || b.x2 > ext.x2 || b.y1 < ext.y1 || b.y2 > ext.y2
    })
    if (fitted.current !== key || (outside && draft.nodes.length > shown.current)) {
      fitted.current = key
      if (draft.nodes.length) c.fit(undefined, 50)
      c.zoom(Math.min(c.zoom(), 1.2))
      if (draft.nodes.length) c.center()
    }
    shown.current = draft.nodes.length
  }, [draft, env, run, sel, connectFrom, dark])

  return (
    <div className="graph-wrap pipe-canvas" onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="graph" />
      {children}
    </div>
  )
}

function nodeLabel(n: PipeNode, env: Env, draft: Draft): string {
  const name = nodeName(n)
  const head = `${name}${name.startsWith(KIND_LABEL[n.kind]) ? '' : ` · ${KIND_LABEL[n.kind]}`}${n.terminal === 'continue' && AGENT_KINDS.includes(n.kind) ? ' (이어서)' : n.session ? ' (세션 불러옴)' : ''}`
  let body = ''
  if (n.kind === 'terminal') body = env.terminals.find((t) => t.id === n.ref)?.title ?? '(터미널 선택)'
  else if (n.kind === 'template') body = env.library.find((p) => p.id === n.ref)?.title ?? '(함수 없음)'
  else if (SPEC_KINDS.includes(n.kind)) {
    const { spec, feature, ac } = specTarget(n, env)
    body =
      n.kind === 'spec'
        ? (spec?.title ?? '(명세 없음)')
        : n.kind === 'feature'
          ? feature
            ? `${feature.id} ${feature.name}`
            : '(기능 없음)'
          : ac && feature
            ? `${feature.id} AC${ac.num} ${ac.text}`
            : '(수용 기준 없음)'
  }
  else if (n.kind === 'task' || n.kind === 'complete') {
    const t = env.tasks.find((x) => x.id === n.ref)
    body = t ? `${t.id} ${t.title}` : n.kind === 'complete' ? '이어진 할 일' : '(할 일 없음)'
  } else if (n.kind === 'skill') body = env.skills.find((s) => s.id === n.ref)?.name ?? '(스킬 없음)'
  else if (n.kind === 'item') {
    try { body = `[${n.index ?? 0}] ${dataValue(draft, n.id, env)}` }
    catch { body = `[${n.index ?? 0}] 원본 리스트 확인` }
  }
  else if (n.kind === 'join') body = '입력을 차례로 이어 붙임'
  else if (n.kind === 'list') {
    const from = draft.edges.filter((e) => e.to === n.id).map((e) => e.from)
    const filled = (n.items ?? []).filter((t) => t.trim())
    body = from.length
      ? `← ${from.map((id) => nodeName(draft.nodes.find((x) => x.id === id) ?? { id })).join(', ')}`
      : filled.length
        ? `${filled.length}개 · ${filled[0]}`
        : ''
  }
  else if (n.kind === 'start') body = '실행하면 여기서 시작'
  else {
    const from = draft.edges.filter((e) => e.to === n.id).map((e) => e.from)
    body = n.kind === 'text' && from.length ? `← ${from.map((id) => nodeName(draft.nodes.find((x) => x.id === id) ?? { id })).join(', ')}` : n.text
  }
  return `${head}\n${short(body) || '(비어 있음)'}`
}
