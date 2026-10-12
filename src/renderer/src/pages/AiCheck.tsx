import { useEffect, useRef, useState } from 'react'
import { api, on } from '../api'
import type { PageProps } from '../App'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'

type Agent = 'claude' | 'codex'
const KIND_LABEL: Record<string, string> = { domain: '도메인 수정 제안', task: '할 일', knowledge: '지식' }
const ACCEPT_LABEL: Record<string, string> = { domain: '변경 요청으로 받기', task: 'Inbox에 넣기', knowledge: '지식 초안으로' }

/** DR-F07·F08: AI에게 지난 점검 이후를 점검시키고, 찾은 항목을 사람이 하나씩 받아들이거나 무시한다. */
export default function AiCheck({ refreshKey, reloadBadges, go }: PageProps) {
  const [checks, reloadChecks] = useLoad(() => api.aiChecks(), [refreshKey])
  const [since, reloadSince] = useLoad(() => api.aiLastCheckAt(), [refreshKey])
  const [docs] = useLoad(() => api.docIndex(), [refreshKey])
  const [agent, setAgent] = useState<Agent>('claude')
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    api.aiCheckRunning().then(setRunning).catch(() => {})
    return on('aicheck-output', (chunk: string) => setLog((l) => (l + chunk).slice(-50000)))
  }, [])
  useEffect(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), [log])

  const list = [...(checks ?? [])].reverse()
  const check = list.find((c) => c.id === selected) ?? list[0]

  const run = async () => {
    setLog('')
    setRunning(true)
    try {
      const c = await api.aiCheckRun(agent)
      setSelected(c.id)
      if (c.error) toast(`점검 실패: ${c.error}`, 'error')
      else toast(c.findings.length ? `점검 완료: 항목 ${c.findings.length}개` : '점검 완료: 고칠 것이 없습니다')
      reloadChecks()
      reloadSince()
    } catch (e) {
      errorToast(e)
    } finally {
      setRunning(false)
    }
  }

  const decide = async (findingId: string, accept: boolean) => {
    if (!check) return
    try {
      await api.aiDecide(check.id, findingId, accept)
      reloadChecks()
      reloadBadges()
    } catch (e) {
      errorToast(e)
    }
  }

  const pendingCount = check ? check.findings.filter((f) => f.status === 'pending').length : 0

  return (
    <div className="split">
      <div className="pane-list">
        <h3>AI 점검</h3>
        <p className="muted small">
          {since ? `지난 점검(${new Date(since).toLocaleString()}) 이후` : '처음부터'}의 작업 대화와 커밋을 현재 도메인 문서와 비교해, 맞지 않는 곳을 찾게 합니다. AI는 제안만 하고, 반영할지는 직접 고릅니다.
        </p>
        <div className="seg">
          <button className={agent === 'claude' ? 'on' : ''} onClick={() => setAgent('claude')}>
            Claude Code
          </button>
          <button className={agent === 'codex' ? 'on' : ''} onClick={() => setAgent('codex')}>
            Codex
          </button>
        </div>
        <button className="primary" disabled={running} onClick={run}>
          {running ? '점검 중…' : '점검 실행'}
        </button>
        <div className="tree-sep" />
        <h4>점검 기록</h4>
        {list.length === 0 && <div className="muted small">아직 점검하지 않았습니다</div>}
        {list.map((c) => {
          const left = c.findings.filter((f) => f.status === 'pending').length
          return (
            <button key={c.id} className={`tree-item ${check?.id === c.id ? 'on' : ''}`} onClick={() => setSelected(c.id)}>
              {new Date(c.finishedAt).toLocaleString()} <Badge>{c.agent === 'claude' ? 'Claude' : 'Codex'}</Badge>
              <div className="small muted">{c.error ? '실패' : `항목 ${c.findings.length}개${left ? ` · 남음 ${left}` : ''}`}</div>
            </button>
          )
        })}
      </div>
      <div className="pane-main">
        {(running || (log && !check)) && (
          <>
            <h4>진행 상황</h4>
            <pre className="log" ref={logRef}>
              {log || 'AI에게 점검을 요청하는 중입니다…'}
            </pre>
          </>
        )}
        {!running && check ? (
          <>
            <div className="row between">
              <h2>점검 결과</h2>
              <span className="muted small">
                {check.since ? `${new Date(check.since).toLocaleString()} 이후` : '처음부터'} · 대화 {check.sessions.length}개 · {check.agent === 'claude' ? 'Claude Code' : 'Codex'}
              </span>
            </div>
            {check.error ? (
              <div className="banner warn">
                <div>
                  <b>점검 실패</b>: {check.error}
                </div>
              </div>
            ) : (
              <>
                <div className="banner">
                  <div>{check.summary || '요약 없음'}</div>
                </div>
                {check.findings.length === 0 && <Empty>도메인 문서가 실제 작업과 맞습니다. 고칠 것이 없습니다.</Empty>}
                {pendingCount > 0 && <div className="muted small">남은 항목 {pendingCount}개 · 받아들이면 도메인 변경 요청 / 할 일 / 지식으로 넘어갑니다</div>}
                <div className="findings">
                  {check.findings.map((f) => (
                    <div key={f.id} className={`finding ${f.status}`}>
                      <div className="row between">
                        <div>
                          <Badge kind={f.kind === 'domain' ? 'review' : ''}>{KIND_LABEL[f.kind]}</Badge>{' '}
                          {f.domainId && <span className="small muted">{docs?.[f.domainId]?.title ?? f.domainId}</span>}
                        </div>
                        {f.status !== 'pending' && <span className="small muted">{f.status === 'accepted' ? '받아들임' : '무시함'}</span>}
                      </div>
                      <b>{f.title}</b>
                      {f.detail && <div>{f.detail}</div>}
                      {f.evidence && <blockquote>{f.evidence}</blockquote>}
                      {f.status === 'pending' && (
                        <div className="row">
                          <button className="small primary" onClick={() => decide(f.id, true)}>
                            {ACCEPT_LABEL[f.kind]}
                          </button>
                          <button className="small ghost" onClick={() => decide(f.id, false)}>
                            무시
                          </button>
                        </div>
                      )}
                      {f.status === 'accepted' && f.kind === 'domain' && f.domainId && (
                        <button className="small link" onClick={() => go('domains', f.domainId)}>
                          도메인에서 변경 요청 보기 →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          !running && !log && <Empty>점검 실행을 누르면 AI가 지난 점검 이후의 작업을 도메인 문서와 비교합니다.</Empty>
        )}
      </div>
    </div>
  )
}
