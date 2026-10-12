import { useEffect, useRef, useState } from 'react'
import { api, on } from '../api'
import type { PageProps } from '../App'
import type { AcStatus, Spec } from '../types'
import { AC_LABEL, Badge, Empty, errorToast, toast, useLoad } from '../ui'

export default function Verification({ refreshKey, reloadBadges, go }: PageProps) {
  const [specs] = useLoad(() => api.listSpecs(), [refreshKey])
  const [links, reloadLinks] = useLoad(() => api.scanTests(), [refreshKey])
  const [run, setRun] = useState<Awaited<ReturnType<typeof api.lastRun>>>(null)
  const [statuses, setStatuses] = useState<Record<string, Record<string, AcStatus>>>({})
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState('')
  const [filter, setFilter] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    api.lastRun().then(setRun).catch(errorToast)
    const off1 = on('test-output', (chunk: string) => setLog((l) => (l + chunk).slice(-200000)))
    const off2 = on('test-done', () => setRunning(false))
    return () => {
      off1()
      off2()
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  useEffect(() => {
    if (!specs) return
    Promise.all(specs.map(async (s) => [s.id, (await api.specStatus(s.id)).acStatus] as const))
      .then((entries) => setStatuses(Object.fromEntries(entries)))
      .catch(errorToast)
  }, [specs, run, refreshKey])

  const start = async () => {
    setLog('')
    setRunning(true)
    try {
      const r = await api.runTests(filter || undefined)
      setRun(r)
      reloadLinks()
      reloadBadges()
      toast(r.error ? r.error : `통과 ${r.passed} / 실패 ${r.failed} / 전체 ${r.total}`, r.error || r.failed ? 'error' : 'ok')
    } catch (e) {
      errorToast(e)
    } finally {
      setRunning(false)
    }
  }

  const all = Object.values(statuses).flatMap((m) => Object.values(m))
  const passed = all.filter((s) => s === 'pass').length
  const known = new Set((specs ?? []).flatMap((s) => s.features.flatMap((f) => f.acs.map((a) => a.id))))
  const invalid = (links ?? []).filter((l) => !known.has(l.acId))

  return (
    <div className="page">
      <div className="row between">
        <h2>테스트</h2>
        <div className="row">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="필터 인자 (선택)" />
          {running ? (
            <button className="danger" onClick={() => api.stopTests()}>
              중단
            </button>
          ) : (
            <button className="primary" onClick={start}>
              테스트 실행
            </button>
          )}
        </div>
      </div>
      <div className="cards">
        <div className="card">
          <div className="card-value">{all.length ? Math.round((passed / all.length) * 100) : 0}%</div>
          <div className="card-label">검증률</div>
          <div className="muted small">
            통과 AC {passed} / 전체 AC {all.length}
          </div>
        </div>
        <div className="card">
          <div className="card-value">{links?.length ?? 0}</div>
          <div className="card-label">테스트 연결</div>
          <div className="muted small">테스트 이름의 [AC ID]</div>
        </div>
        <div className={`card ${run?.failed ? 'warn' : ''}`}>
          <div className="card-value">{run ? `${run.passed}/${run.total}` : '-'}</div>
          <div className="card-label">마지막 실행</div>
          <div className="muted small">{run ? new Date(run.at).toLocaleString() : '실행 기록 없음'}</div>
        </div>
      </div>
      {(running || log) && (
        <pre className="log" ref={logRef}>
          {log}
        </pre>
      )}
      {invalid.length > 0 && (
        <div className="banner warn">
          <div>
            <b>잘못된 연결</b>: 없는 AC를 가리키는 테스트
            <ul>
              {invalid.map((l, i) => (
                <li key={i}>
                  {l.acId} — {l.file}:{l.line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {specs && specs.length === 0 && <Empty>기능 명세 표가 없습니다</Empty>}
      {specs?.map((s) => <SpecAcs key={s.id} spec={s} status={statuses[s.id] ?? {}} links={links ?? []} onTask={reloadBadges} go={go} />)}
    </div>
  )
}

function SpecAcs({ spec, status, links, onTask, go }: { spec: Spec; status: Record<string, AcStatus>; links: { acId: string; file: string; line: number }[]; onTask: () => void; go: PageProps['go'] }) {
  const rows = spec.features.filter((f) => f.status !== '폐기').flatMap((f) => f.acs.map((a) => ({ f, a })))
  if (!rows.length) return null
  const makeTask = async (acId: string, type: 'test' | 'bug', text: string) => {
    try {
      const t = await api.createTask({ title: `${type === 'test' ? '테스트 작성' : '실패 수정'}: [${acId}] ${text}`, type, horizon: '다음', links: [acId] })
      toast(`${t.id}를 만들었습니다`)
      onTask()
    } catch (e) {
      errorToast(e)
    }
  }
  return (
    <div className="group">
      <h4>
        <button className="link" onClick={() => go('domains', spec.domainId)}>
          {spec.title}
        </button>
      </h4>
      <table className="table">
        <tbody>
          {rows.map(({ f, a }) => {
            const st = status[a.id] ?? 'none'
            const l = links.filter((x) => x.acId === a.id)
            return (
              <tr key={a.id}>
                <td className="mono small" style={{ width: 130 }}>
                  {a.id}
                </td>
                <td>
                  <span className="muted small">{f.name} · </span>
                  {a.text}
                  {l.length > 0 && <div className="small muted">{l.map((x) => `${x.file}:${x.line}`).join(', ')}</div>}
                </td>
                <td style={{ width: 100 }}>
                  <Badge kind={st}>{AC_LABEL[st]}</Badge>
                </td>
                <td style={{ width: 120 }}>
                  {st === 'none' && (
                    <button className="small ghost" onClick={() => makeTask(a.id, 'test', a.text)}>
                      test Task
                    </button>
                  )}
                  {st === 'fail' && (
                    <button className="small ghost" onClick={() => makeTask(a.id, 'bug', a.text)}>
                      bug Task
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
