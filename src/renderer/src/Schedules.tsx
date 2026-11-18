import { useEffect, useState } from 'react'
import { api, on } from './api'
import { useAutomation } from './Automation'
import { describeSchedule, type PipelineSchedule } from '../../core/automationSchedule'
import { Empty, errorToast } from './ui'

export function Schedules() {
  const automation = useAutomation()
  const [rows, setRows] = useState<PipelineSchedule[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState<string>()
  useEffect(() => {
    let alive = true
    const load = () => { void api.listPipelineSchedules().then((data) => { if (alive) { setRows(data); setError('') } }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (alive) setLoading(false) }) }
    load(); const off = on('schedules-changed', load)
    return () => { alive = false; off() }
  }, [])
  const change = async (row: PipelineSchedule, remove: boolean) => {
    if (busy) return
    if (remove && !await api.confirmAction(`“${row.title}” 예약을 삭제할까요?`)) return
    setBusy(row.id)
    try {
      if (remove) await api.deletePipelineSchedule(row.id)
      else await api.setPipelineScheduleEnabled(row.id, !row.enabled)
    } catch (e) { errorToast(e) } finally { setBusy(undefined) }
  }
  return <section aria-label="자동 실행 예약" className="schedule-list">
    <div className="row between"><p className="muted small">매일 정해진 시각 · 분/시간/일 간격 · 특정 날짜에 한 번</p><button className="primary" onClick={() => automation.schedule()}>새 예약</button></div>
    <p className="small muted">Orbit에서 이 프로젝트를 열어 두세요. 화면을 옮기거나 창을 최소화해도 실행합니다. 앱 종료·절전 중 놓친 회차는 돌아왔을 때 한 번으로 합칩니다.</p>
    {error && <p role="alert">{error}</p>}
    {!rows.length ? <Empty>{loading ? '예약을 불러오는 중…' : '등록한 예약이 없습니다.'}</Empty> : <div className="schedule-cards">{rows.map((row) => <article className="schedule-card" key={row.id} aria-label={row.title}>
      <div className="row between"><h3>{row.title}</h3><span className={`run-status ${row.enabled ? row.last?.status === 'blocked' ? 'waiting' : 'running' : 'stopped'}`}>{row.enabled ? row.last?.status === 'blocked' ? '실행 대기' : '예약 켜짐' : row.timing.kind === 'once' && row.last?.status === 'started' ? '실행됨' : '꺼짐'}</span></div>
      <p>{describeSchedule(row.timing)}</p>
      <p className="small">다음 실행: {row.enabled && row.nextRunAt ? new Date(row.nextRunAt).toLocaleString() : '없음'}</p>
      {row.enabled && row.retryAt && <p className="small">다시 확인: {new Date(row.retryAt).toLocaleString()}</p>}
      {row.last && <p className="small muted">최근 시도: {new Date(row.last.at).toLocaleString()} · {row.last.message ?? ({ started: '실행을 시작했습니다', dispatching: '실행 준비 중', failed: '실행 실패', blocked: '실행 대기' }[row.last.status])}</p>}
      <div className="row"><button onClick={() => automation.schedule(row)}>편집</button><button disabled={!!busy} onClick={() => void change(row, false)}>{row.enabled ? '일시정지' : '다시 켜기'}</button><button className="ghost danger" disabled={!!busy} onClick={() => void change(row, true)}>삭제</button>{row.last?.runIds?.map((id, i) => <button className="link" key={id} onClick={() => automation.inspect(id)}>실행 기록{row.last!.runIds!.length > 1 ? ` ${i + 1}` : ''}</button>)}</div>
    </article>)}</div>}
  </section>
}
