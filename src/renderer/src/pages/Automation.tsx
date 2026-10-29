import { useEffect, useRef, useState } from 'react'
import { api, on } from '../api'
import type { PageProps } from '../App'
import { RUN_LABEL, useAutomation } from '../Automation'
import type { PipelineRunSummary, RunFilter } from '../../../core/pipelineExecution'
import { SOURCE_KINDS, type SourceKind } from '../../../core/pipeline'
import type { TerminalInfo } from '../types'
import { Empty, errorToast } from '../ui'
import PipelineEditor from './Pipelines'

export default function Automation({ focus, go }: PageProps) {
  const [view, setView] = useState<'runs' | 'graphs'>('runs'), [opened, setOpened] = useState(false)
  const [filter, setFilter] = useState<RunFilter>({}), [rows, setRows] = useState<PipelineRunSummary[]>([]), [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 })
  const [tabs, setTabs] = useState<TerminalInfo[]>([]), [revision, setRevision] = useState(0), [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const automation = useAutomation()
  useEffect(() => {
    if (focus?.startsWith('graphs')) { setView('graphs'); setOpened(true); return }
    if (!focus) return
    setView('runs')
    if (focus.startsWith('source:')) {
      const [, kind, ...id] = focus.split(':')
      if (SOURCE_KINDS.includes(kind as SourceKind)) setFilter({ source: { kind: kind as SourceKind, id: id.join(':') } })
    } else setFilter({})
  }, [focus])
  useEffect(() => {
    let alive = true
    setLoading(true)
    void api.listPipelineRuns(filter).then((result) => { if (alive) { setRows(result.runs); setTotal(result.total); setCounts(result.counts) } }).catch(errorToast).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [filter, revision])
  useEffect(() => {
    const off = on('pipeline-state', () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setRevision((n) => n + 1), 150)
    })
    return () => { off(); clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    if (!opened) return
    let alive = true
    const load = () => { void api.termLayout().then((layout) => { if (alive) setTabs(layout.tabs) }).catch(errorToast) }
    load()
    const offCreated = on('term-created', load), offExit = on('term-exit', load)
    const offInfo = on('term-info', (t: TerminalInfo) => setTabs((all) => all.map((x) => x.id === t.id ? { ...x, ...t } : x)))
    return () => { alive = false; offCreated(); offExit(); offInfo() }
  }, [opened])
  const offset = filter.offset ?? 0
  const [acting, setActing] = useState(false)
  const groupAction = async (retry: boolean) => {
    if (!filter.groupId || acting) return
    setActing(true)
    try {
      if (retry) {
        const runs = await api.retryPipelineGroup(filter.groupId)
        if (runs.length) setFilter({ groupId: runs[0].groupId })
      } else await api.stopPipelineGroup(filter.groupId)
      setRevision((n) => n + 1)
    } catch (error) { errorToast(error) } finally { setActing(false) }
  }
  return <div className="page automation-page">
    <div className="row between"><h2>자동화</h2><div className="seg"><button className={view === 'runs' ? 'on' : ''} onClick={() => setView('runs')}>실행</button><button className={view === 'graphs' ? 'on' : ''} onClick={() => { setView('graphs'); setOpened(true) }}>그래프</button></div></div>
    {opened && <div className="automation-editor" hidden={view !== 'graphs'}><PipelineEditor tabs={tabs} onShowTerminal={(id) => go('terminal', id)} /></div>}
    <div hidden={view !== 'runs'}>
      <div className="row between"><div className="row"><select aria-label="실행 상태 필터" value={filter.status ?? ''} onChange={(e) => setFilter({ ...filter, status: e.target.value as RunFilter['status'] || undefined, offset: 0 })}><option value="">모든 상태</option><option value="waiting">대기</option>{Object.entries(RUN_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {(filter.source || filter.groupId) && <button onClick={() => setFilter({})}>필터 해제</button>}<span className="muted small">{total}건{filter.source ? ` · ${rows.flatMap((r) => r.sources).find((s) => s.id === filter.source?.id)?.title ?? filter.source.id}` : ''}</span></div>
        <button onClick={() => automation.open([])}>그래프 실행</button>
      </div>
      <p className="small muted">실행 중 {counts.running} · 대기 {counts.waiting} · 완료 {counts.done} · 실패 {counts.failed} · 중지 {counts.stopped}</p>
      {filter.groupId && <div className="row"><button disabled={acting} onClick={() => void groupAction(false)}>이 묶음 중지</button><button disabled={acting} onClick={() => void groupAction(true)}>실패한 항목만 처음부터 재실행</button></div>}
      {rows.length ? <table className="table run-table"><thead><tr><th>대상 / 그래프</th><th>현재 단계</th><th>상태</th><th>시작</th><th /></tr></thead><tbody>{rows.map((run) => <tr key={run.runId}>
        <td><button className="link" onClick={() => automation.inspect(run.runId)}>{run.sources.map((s) => s.title).join(', ') || run.title}</button><div className="small muted">{run.title}{run.retryOf ? ' · 재실행' : ''}</div></td>
        <td>{run.stage}<div className="small muted">{run.message ?? `${run.done} / ${run.total} 노드 완료`}</div></td>
        <td><span className={`run-status ${run.waiting && run.status === 'running' ? 'waiting' : run.status}`}>● {run.waiting && run.status === 'running' ? '대기' : RUN_LABEL[run.status]}</span></td>
        <td className="small">{new Date(run.started).toLocaleString()}</td>
        <td><div className="row"><button className="small" onClick={() => automation.inspect(run.runId)}>결과 보기</button>{run.groupId && <button className="small ghost" onClick={() => setFilter({ groupId: run.groupId })}>같이 실행한 항목</button>}</div></td>
      </tr>)}</tbody></table> : <Empty>{loading ? '실행 기록을 불러오는 중…' : '실행 기록이 없습니다. 할일·변경 이력·기능 명세에서 대상을 선택해 그래프로 실행하세요.'}</Empty>}
      <div className="row between"><button disabled={!offset} onClick={() => setFilter({ ...filter, offset: Math.max(0, offset - 30) })}>이전</button><span className="small muted">{total ? offset + 1 : 0}–{Math.min(offset + rows.length, total)} / {total}</span><button disabled={offset + rows.length >= total} onClick={() => setFilter({ ...filter, offset: offset + 30 })}>다음</button></div>
    </div>
  </div>
}
