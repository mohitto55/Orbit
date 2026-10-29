import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, on } from './api'
import type { Page } from './App'
import { summarizeRun, isListShape, nodeName, SHAPE_NAME, sourceKind, type Pipeline, type PipelineExecution, type RunState, type SourceRef } from '../../core/pipeline'
import type { PipelineRunSummary } from '../../core/pipelineExecution'
import type { TerminalInfo } from './types'
import { Empty, errorToast, toast } from './ui'
import { PipelineValue } from './PipelineValue'

type Selection = { sources: SourceRef[]; pipelineId?: string }
interface AutomationActions {
  open: (sources: SourceRef[], pipelineId?: string) => void
  inspect: (runId: string) => void
  history: (source?: SourceRef) => void
}
const AutomationContext = createContext<AutomationActions>({ open: () => {}, inspect: () => {}, history: () => {} })
const RunSummariesContext = createContext<PipelineRunSummary[]>([])
export const useAutomation = () => useContext(AutomationContext)
export const RUN_LABEL: Record<RunState['status'], string> = { running: '실행 중', done: '완료', failed: '실패', stopped: '중지됨' }

export function AutomationProvider({ children, go }: { children: ReactNode; go: (page: Page, focus?: string) => void }) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<PipelineRunSummary[]>([])
  useEffect(() => {
    let alive = true
    void api.listPipelineRuns({ limit: 100 }).then((r) => { if (alive) setSummaries((current) => [...new Map([...r.runs, ...current].map((s) => [s.runId, s])).values()].sort((a, b) => b.started.localeCompare(a.started)).slice(0, 100)) }).catch(errorToast)
    const off = on('pipeline-state', (state: RunState) => setSummaries((all) => [summarizeRun(state), ...all.filter((r) => r.runId !== state.runId)].sort((a, b) => b.started.localeCompare(a.started)).slice(0, 100)))
    return () => { alive = false; off() }
  }, [])
  const actions = useMemo<AutomationActions>(() => ({ open: (sources, pipelineId) => setSelection({ sources, pipelineId }), inspect: setDetail, history: (source) => go('automation', source ? `source:${source.kind}:${source.id}` : 'runs') }), [go])
  return <AutomationContext.Provider value={actions}><RunSummariesContext.Provider value={summaries}>
    {children}
    {selection && <RunPanel selection={selection} onClose={() => setSelection(null)} onGraphs={() => { setSelection(null); go('automation', 'graphs') }} />}
    {detail && <RunDetail runId={detail} onClose={() => setDetail(null)} go={(page, focus) => { setDetail(null); go(page, focus) }} onRetry={setDetail} />}
  </RunSummariesContext.Provider></AutomationContext.Provider>
}

export function RunButton({ sources, disabled = false, label = '그래프로 실행' }: { sources: SourceRef[]; disabled?: boolean; label?: string }) {
  const automation = useAutomation()
  return <button className="small" disabled={disabled || !sources.length} onClick={() => automation.open(sources)}>{label}</button>
}

export function SourceRuns({ source }: { source: SourceRef }) {
  const automation = useAutomation()
  const latest = useContext(RunSummariesContext).find((r) => r.sources.some((s) => s.kind === source.kind && s.id === source.id))
  return <button className={`link small run-status ${latest?.waiting ? 'waiting' : latest?.status ?? ''}`} onClick={() => automation.history(source)}>{latest ? `● ${latest.waiting && latest.status === 'running' ? '대기' : RUN_LABEL[latest.status]}` : '실행 기록'}</button>
}

/** 기존 화면 위에 열며 닫으면 키보드 포커스도 원래 버튼으로 돌아간다. */
export function RunDrawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const elements = [...ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []].filter((e) => e.getClientRects().length)
      const first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  return <div className="run-backdrop" onMouseDown={onClose}>
    <section className="run-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <header className="row between"><h2>{title}</h2><button className="ghost" aria-label="닫기" onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>
}

function RunPanel({ selection, onClose, onGraphs }: { selection: Selection; onClose: () => void; onGraphs: () => void }) {
  const [graphs, setGraphs] = useState<Pipeline[]>([]), [sources, setSources] = useState<SourceRef[]>([]), [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [graphId, setGraphId] = useState(selection.pipelineId ?? ''), [port, setPort] = useState('')
  const [values, setValues] = useState<Record<string, string>>({}), [terminalIds, setTerminalIds] = useState<string[]>([])
  const [allowNew, setAllowNew] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [maxConcurrent, setMaxConcurrent] = useState('')
  const [started, setStarted] = useState<RunState[] | null>(null)
  const automation = useAutomation()
  const kind = selection.sources[0]?.kind
  const compatible = (p: Pipeline) => !p.template && (!kind || p.nodes.some((n) => n.kind === 'function-input' && n.params?.some((param) => sourceKind(param.type) === kind)))
  useEffect(() => {
    let alive = true
    void Promise.all([api.listPipelines(), api.pipelineSources(), api.termLayout()]).then(([list, data, layout]) => {
      if (!alive) return
      setGraphs(list); setSources(data); setTabs(layout.tabs)
      setTerminalIds(layout.tabs.filter((t) => t.exited === undefined).map((t) => t.id))
      if (!selection.pipelineId) setGraphId(list.find(compatible)?.id ?? '')
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (alive) setLoading(false) })
    const off = on('term-info', (tab: TerminalInfo) => setTabs((all) => all.map((t) => t.id === tab.id ? { ...t, ...tab } : t)))
    return () => { alive = false; off() }
  }, [])
  const graph = graphs.find((p) => p.id === graphId)
  const entry = graph?.nodes.find((n) => n.kind === 'function-input')
  const params = entry?.params ?? []
  const targets = params.filter((p) => sourceKind(p.type) === kind)
  const target = targets.find((p) => p.id === port) ?? targets[0]
  const count = target && !isListShape(target.type) ? selection.sources.length : 1
  const value = (id: string, type: string) => values[id] ?? entry?.values?.[id] ?? (type === 'boolean' ? 'false' : type === 'number' ? '0' : '')
  const changeGraph = (id: string) => { setGraphId(id); setPort(''); setValues({}); setError('') }
  const start = async () => {
    if (!graph || busy) return
    setBusy(true); setError('')
    try {
      const bound = Object.fromEntries(params.filter((p) => p.id !== target?.id).map((p) => [p.id, value(p.id, p.type)]))
      const runs = await api.runPipelineBatch({ pipelineId: graph.id, values: bound, ...(target ? { selection: { port: target.id, sources: selection.sources } } : {}), terminalIds, allowNew, maxConcurrent: maxConcurrent ? Number(maxConcurrent) : undefined })
      setStarted(runs); toast(`${runs.length}개의 실행을 만들었습니다`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <RunDrawer title={started ? '실행을 시작했습니다' : '그래프로 실행'} onClose={() => { if (!busy) onClose() }}>
    {started ? <>
      <p>{started.length}개의 독립 실행을 만들었습니다. 선택한 터미널에서 병렬로 진행하며, 사용 중인 터미널은 기다립니다.</p>
      <div className="run-targets">{started.map((r) => <button key={r.runId} onClick={() => { onClose(); automation.inspect(r.runId) }}>{r.sources?.map((s) => s.title).join(', ') || r.title} · 결과 보기</button>)}</div>
      <button className="primary" onClick={onClose}>원래 작업 계속하기</button>
    </> : loading ? <Empty>그래프와 입력을 불러오는 중…</Empty> : <>
      {selection.sources.length > 0 && <div className="run-targets"><b>선택한 대상 · {selection.sources.length}개</b>{selection.sources.map((s) => <span key={`${s.kind}:${s.id}`}>{s.title}</span>)}</div>}
      <div className="field"><label htmlFor="run-graph">작업 그래프</label><select id="run-graph" value={graphId} onChange={(e) => changeGraph(e.target.value)}><option value="">그래프를 고르세요</option>{graphs.filter(compatible).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
      {!graphs.some(compatible) && <div className="empty">{kind ? `${SHAPE_NAME[kind]} 또는 List<${SHAPE_NAME[kind]}> Input이 있는 그래프가 필요합니다.` : '작업 그래프를 먼저 만드세요.'}<button onClick={onGraphs}>그래프 설정</button></div>}
      {target && <div className="run-preview">
        {targets.length > 1 && <label>선택한 대상을 넣을 변수<select aria-label="대상 입력 변수" value={target.id} onChange={(e) => setPort(e.target.value)}>{targets.map((p) => <option value={p.id} key={p.id}>{p.name} · {SHAPE_NAME[p.type]}</option>)}</select></label>}
        <b>{isListShape(target.type) ? '목록으로 전달 · 1건' : `각 항목별 실행 · ${count}건`}</b><span>{target.name} · {SHAPE_NAME[target.type]}</span>
      </div>}
      {params.filter((p) => p.id !== target?.id).map((param) => {
        const sourceType = sourceKind(param.type), multiple = isListShape(param.type)
        const choices = sources.filter((s) => s.kind === sourceType)
        return <div className="field" key={param.id}><label htmlFor={`run-${param.id}`}>{param.name} · {SHAPE_NAME[param.type]}</label>
          {sourceType ? <select id={`run-${param.id}`} multiple={multiple} value={multiple ? value(param.id, param.type).split('\n') : value(param.id, param.type)} onChange={(e) => setValues({ ...values, [param.id]: [...e.target.selectedOptions].map((o) => o.value).join('\n') })}>
            {!multiple && <option value="">원본을 고르세요</option>}{choices.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.id}</option>)}
          </select> : param.type === 'terminal' ? <select id={`run-${param.id}`} value={value(param.id, param.type)} onChange={(e) => setValues({ ...values, [param.id]: e.target.value })}><option value="">터미널 선택</option>{tabs.filter((t) => t.exited === undefined).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
            : param.type === 'boolean' ? <select id={`run-${param.id}`} value={value(param.id, param.type)} onChange={(e) => setValues({ ...values, [param.id]: e.target.value })}><option value="false">False</option><option value="true">True</option></select>
            : <textarea id={`run-${param.id}`} rows={2} value={value(param.id, param.type)} placeholder={param.type === 'list' ? '한 줄에 한 항목' : '입력값'} onChange={(e) => setValues({ ...values, [param.id]: e.target.value })} />}
        </div>
      })}
      {graph && <details className="run-environment" open={tabs.length === 0 || undefined}><summary>실행 환경 · 기존 터미널 {terminalIds.length}개 사용</summary>
        <div className="field"><label htmlFor="run-concurrency">동시 터미널 작업 수</label><input id="run-concurrency" type="number" min={1} max={64} value={maxConcurrent} placeholder="가용 터미널 수에 맞춤" onChange={(e) => setMaxConcurrent(e.target.value)} /></div>
        <p className="small muted">노드에 연결한 터미널·세션을 우선합니다. 자동 배정은 아래 선택한 세션만 사용합니다. 같은 폴더를 수정하는 작업은 작업 공간을 확인하세요.</p>
        {tabs.filter((t) => t.exited === undefined).map((tab) => <label className="run-terminal" key={tab.id}><input type="checkbox" checked={terminalIds.includes(tab.id)} onChange={(e) => setTerminalIds(e.target.checked ? [...terminalIds, tab.id] : terminalIds.filter((id) => id !== tab.id))} /><span>{tab.title}<small>{tab.kind} · {tab.model || '세션 기본 모델'} · {tab.effort || '기본 effort'}{tab.activity === 'working' ? ' · 사용 중' : ''}</small></span></label>)}
        <label className="run-terminal"><input type="checkbox" checked={allowNew} onChange={(e) => setAllowNew(e.target.checked)} />사용할 세션이 없을 때 새 터미널 허용</label>
        {!terminalIds.length && !allowNew && <p className="small muted">터미널 작업이 있다면 사용할 세션을 지정하거나 새 터미널을 허용하세요.</p>}
      </details>}
      {error && <p role="alert" className="pipe-value-error">{error}</p>}
      <footer className="row between"><button onClick={onClose} disabled={busy}>취소</button><button className="primary" disabled={busy || !graph || (!!kind && !target)} onClick={() => void start()}>{busy ? '실행 준비 중…' : `${count}건 실행`}</button></footer>
    </>}
  </RunDrawer>
}

function RunDetail({ runId, onClose, go, onRetry }: { runId: string; onClose: () => void; go: (page: Page, focus?: string) => void; onRetry: (id: string) => void }) {
  const [record, setRecord] = useState<PipelineExecution | null>(null), [nodeId, setNodeId] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    let latest: RunState | undefined
    setRecord(null); setNodeId('')
    void api.pipelineExecution(runId).then((r) => { if (alive) setRecord(latest ? { ...r, state: latest } : r) }).catch(errorToast)
    const off = on('pipeline-state', (state: RunState) => { if (state.runId === runId) { latest = state; setRecord((r) => r ? { ...r, state } : r) } })
    return () => { alive = false; off() }
  }, [runId])
  const state = record?.state, snapshot = record?.options.snapshot
  const graph = snapshot?.graph ?? record?.pipe
  const node = graph?.nodes.find((n) => n.id === nodeId) ?? graph?.nodes.find((n) => state?.nodes[n.id]?.output !== undefined) ?? graph?.nodes.find((n) => state?.nodes[n.id])
  const states = Object.entries(state?.nodes ?? {}).filter(([id, s]) => id === node?.id || s.sourceIds?.includes(node?.id ?? ''))
  const action = async (retry: boolean) => {
    setBusy(true)
    try { if (retry) onRetry((await api.retryPipeline(runId)).runId); else await api.stopPipeline(runId) }
    catch (e) { errorToast(e) } finally { setBusy(false) }
  }
  return <RunDrawer title={state?.sources?.map((s) => s.title).join(', ') || state?.title || '실행 상세'} onClose={onClose}>
    {!record || !state || !graph ? <Empty>실행 기록을 불러오는 중…</Empty> : <>
      <div className="row between"><span>{state.title} · <b className={`run-status ${summarizeRun(state).waiting ? 'waiting' : state.status}`}>{summarizeRun(state).waiting ? '대기' : RUN_LABEL[state.status]}</b></span><button disabled={busy} onClick={() => void action(state.status !== 'running')}>{state.status === 'running' ? '이 실행 중지' : '같은 입력으로 처음부터 재실행'}</button></div>
      <p className="small muted">{new Date(state.started).toLocaleString()}{state.retryOf ? ' · 재실행' : ''}</p>
      {state.message && <p role="status">{state.message}</p>}
      <div className="row">{state.sources?.filter((s) => s.location).map((s) => <button className="link" key={`${s.kind}:${s.id}`} onClick={() => go(s.location!.page, s.location!.focus)}>원본: {s.title}</button>)}</div>
      <details><summary>실행 당시 입력</summary>{snapshot?.env.sources?.map((s) => <details key={`${s.kind}:${s.id}`}><summary>{SHAPE_NAME[s.kind]} · {s.title}{s.version ? ` · ${s.version.length > 16 ? s.version.slice(0, 8) : s.version}` : ''}</summary><pre className="run-text">{s.text}</pre></details>)}{snapshot && <pre className="run-text">{JSON.stringify(snapshot.values, null, 2)}</pre>}</details>
      <h3>노드와 값</h3>
      <div className="run-node-list">{graph.nodes.map((n) => {
        const runs = Object.entries(state.nodes).filter(([id, s]) => id === n.id || s.sourceIds?.includes(n.id))
        const current = runs.find(([, s]) => s.status === 'failed' || s.status === 'running' || s.status === 'waiting')?.[1] ?? runs.at(-1)?.[1]
        return <button key={n.id} className={node?.id === n.id ? 'on' : ''} onClick={() => setNodeId(n.id)}><span>{nodeName(n)}</span><small>{current?.message ?? (current ? ({ waiting: '대기', starting: '준비 중', running: '실행 중', done: '완료', failed: '실패', skipped: '건너뜀' }[current.status]) : '데이터')}</small></button>
      })}</div>
      {node && <PipelineValue node={node} graph={graph} env={snapshot?.env ?? {}} run={state} states={states} />}
      {states.map(([id, s]) => <div key={id}>{s.message && <p className="small">{s.message}</p>}{s.termId && <button onClick={() => go('terminal', s.termId)}>터미널 보기</button>}</div>)}
    </>}
  </RunDrawer>
}
