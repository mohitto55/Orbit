import { useEffect, useRef, useState } from 'react'
import { api, on } from '../api'
import type { PageProps } from '../App'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { Markdown, MdEditor } from '../Markdown'
import { DiffTable } from './DiffView'

type Agent = 'claude' | 'codex'
type Request = Awaited<ReturnType<typeof api.listRequests>>[number]
type Draft = NonNullable<Awaited<ReturnType<typeof api.requestDraft>>>

/** 요청이 어디서 왔는지 사람이 읽을 수 있는 말로 */
function sourceLabel(source: string): string {
  if (source.startsWith('ai-check:')) return 'AI 점검'
  if (source.startsWith('drift:')) return '대화 직접 보기'
  if (source.startsWith('task-')) return `할 일 완료 (${source})`
  return source
}

const requestTitle = (r: Request) => (r.note ?? r.excerpt).split(/[:\n]/)[0]

/** IR-F08: 바깥 → 도메인. 도메인을 이렇게 고치자는 요청을 보고 반영 완료 / 반려로 닫는다. */
export default function Requests({ refreshKey, reloadBadges, go, focus }: PageProps) {
  const [requests, reload] = useLoad(() => api.listRequests(), [refreshKey])
  const [docs] = useLoad(() => api.docIndex(), [refreshKey])
  const [showDone, setShowDone] = useState(false)
  // 도메인 화면에서 특정 요청을 눌러 들어오면 그 요청을 연다
  const [sel, setSel] = useState<string | null>(focus?.startsWith('request:') ? focus.slice(8) : null)
  const [note, setNote] = useState('')

  useEffect(() => { if (focus?.startsWith('request:')) setSel(focus.slice(8)) }, [focus])

  if (!requests || !docs) return null
  const list = requests
    .filter((r) => showDone || r.status === 'pending')
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created.localeCompare(a.created))
  const cur = list.find((r) => r.id === sel) ?? list[0]
  const domainTitle = (id: string) => docs[id]?.title ?? id

  const closed = () => {
    setNote('')
    setSel(null)
    reload()
    reloadBadges()
  }

  const resolve = async (status: 'done' | 'rejected') => {
    if (!cur) return
    try {
      await api.requestResolve(cur.id, status, note)
      toast(status === 'done' ? '반영 완료로 닫았습니다' : '반려했습니다')
      closed()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="split">
      <div className="pane-list">
        <h3>변경 요청</h3>
        <div className="muted small">도메인 문서를 이렇게 고치자는 요청. AI 점검·할 일 완료에서 들어옵니다.</div>
        <label className="small">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 처리한 요청도 보기
        </label>
        {list.length === 0 && <Empty>처리할 변경 요청이 없습니다</Empty>}
        {list.map((r) => (
          <button key={r.id} className={`tree-item review-item ${cur?.id === r.id ? 'on' : ''} ${r.status !== 'pending' ? 'dim' : ''}`} onClick={() => setSel(r.id)}>
            <div>{requestTitle(r).slice(0, 60)}</div>
            <div className="small muted">
              → {domainTitle(r.domain)} · {sourceLabel(r.source)}
              {r.status === 'pending' && r.draftAt && (
                <>
                  {' '}
                  <Badge>수정안 있음</Badge>
                </>
              )}
              {r.status === 'done' && ' · 반영함'}
              {r.status === 'rejected' && ' · 반려함'}
            </div>
          </button>
        ))}
      </div>
      <div className="pane-main">
        {cur ? (
          <>
            <div className="flow">
              <div className="flow-box cause">
                <div className="small muted">요청 · {sourceLabel(cur.source)}</div>
                <b>{requestTitle(cur)}</b>
                <div className="small muted">{new Date(cur.created).toLocaleString()}</div>
              </div>
              <div className="flow-arrow">
                <span>고칠 곳</span>
                <span className="arrow">→</span>
              </div>
              <div className="flow-box target">
                <div className="small muted">도메인 문서</div>
                <b>{domainTitle(cur.domain)}</b>
                <div className="small">지금 v{docs[cur.domain]?.version ?? '?'}</div>
              </div>
            </div>
            <div className="review-body">
              {cur.note && (
                <>
                  <h4>제안</h4>
                  <Markdown className="bordered" source={cur.note.includes(': ') ? cur.note.slice(cur.note.indexOf(': ') + 2) : cur.note} />
                </>
              )}
              <h4>근거</h4>
              <blockquote>{cur.excerpt}</blockquote>
              {cur.status !== 'pending' && (
                <div className="banner">
                  <div>
                    {cur.status === 'done' ? '반영 완료로 닫은 요청입니다' : '반려한 요청입니다'}
                    {cur.resolution && ` — ${cur.resolution}`}
                  </div>
                </div>
              )}
            </div>
            {cur.status === 'pending' && (
              <>
                <DraftPanel key={cur.id} request={cur} onChanged={reload} onApplied={closed} />
                <div className="decision-help small muted">
                  <b>도메인 문서 열어서 고치기</b>: 그 도메인의 역할(domain.md) 편집 화면으로 이동합니다. 요청은 열린 채로 남으니, 고친 뒤 돌아와 반영 완료를 누르세요.{' '}
                  <b>반영 완료</b>: 도메인에 반영했으면 요청을 닫습니다. <b>반려</b>: 반영하지 않기로 하고 닫습니다 (사유를 메모로 남기세요).
                </div>
                <div className="decision">
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모 (반려 사유 등, 선택)" />
                  <button onClick={() => go('domains', cur.domain)}>도메인 문서 열어서 고치기</button>
                  <button className="primary" onClick={() => resolve('done')}>
                    반영 완료
                  </button>
                  <button onClick={() => resolve('rejected')}>반려</button>
                </div>
              </>
            )}
          </>
        ) : (
          <Empty>처리할 변경 요청이 없습니다</Empty>
        )}
      </div>
    </div>
  )
}

/**
 * AI 수정안. 수정안은 요청 파일에 저장되므로 화면을 나갔다 와도 남는다.
 * 적용하기 전에는 도메인 문서를 고치지 않는다.
 */
function DraftPanel({ request, onChanged, onApplied }: { request: Request; onChanged: () => void; onApplied: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [agent, setAgent] = useState<Agent>('claude')
  const [drafting, setDrafting] = useState(false)
  const [log, setLog] = useState('')
  const [view, setView] = useState<'diff' | 'full' | 'edit'>('diff')
  const [edited, setEdited] = useState('')
  const [summary, setSummary] = useState(`변경 요청 반영: ${requestTitle(request).slice(0, 60)}`)
  const [size, setSize] = useState<'minor' | 'major'>('minor')
  const logRef = useRef<HTMLPreElement>(null)

  const show = (d: Draft | null) => {
    setDraft(d)
    setEdited(d?.after ?? '')
    setView('diff')
  }

  useEffect(() => {
    api
      .requestDraft(request.id)
      .then(show)
      .catch(errorToast)
      .finally(() => setLoaded(true))
  }, [request.id])
  useEffect(() => on('request-draft-output', (chunk: string) => setLog((l) => (l + chunk).slice(-20000))), [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const make = async () => {
    setDrafting(true)
    setLog('')
    try {
      show(await api.requestAiDraft(request.id, agent))
      onChanged()
    } catch (e) {
      errorToast(e)
    } finally {
      setDrafting(false)
    }
  }

  const saveEdit = async () => {
    try {
      show(await api.requestSaveDraft(request.id, edited))
      toast('다듬은 수정안을 요청 파일에 저장했습니다')
    } catch (e) {
      errorToast(e)
    }
  }

  const discard = async () => {
    try {
      await api.requestDiscardDraft(request.id)
      show(null)
      onChanged()
    } catch (e) {
      errorToast(e)
    }
  }

  const apply = async () => {
    try {
      const r = await api.saveDomain(request.domain, { content: edited }, { size, summary, source: 'review' })
      await api.requestResolve(request.id, 'done', 'AI 수정안 적용')
      toast(`수정안을 적용하고 요청을 닫았습니다 (v${r.domain.version})`)
      onApplied()
    } catch (e) {
      errorToast(e)
    }
  }

  if (!loaded) return null
  const dirty = !!draft && edited !== draft.after
  return (
    <div className="ai-draft">
      <div className="row between">
        <h4>AI 수정안</h4>
        {!draft && (
          <div className="row">
            <div className="seg small">
              <button className={agent === 'claude' ? 'on' : ''} onClick={() => setAgent('claude')} disabled={drafting}>
                Claude Code
              </button>
              <button className={agent === 'codex' ? 'on' : ''} onClick={() => setAgent('codex')} disabled={drafting}>
                Codex
              </button>
            </div>
            <button className="primary small" onClick={make} disabled={drafting}>
              {drafting ? '수정안 만드는 중…' : '수정안 만들기'}
            </button>
          </div>
        )}
      </div>
      {!draft && !drafting && (
        <div className="small muted">AI가 이 요청을 반영한 도메인 문서 수정안을 만들어 요청 파일에 저장합니다. 나중에 바뀐 곳을 보고 적용하거나 버리면 됩니다. 적용하기 전에는 도메인 문서를 고치지 않습니다.</div>
      )}
      {drafting && (
        <pre className="log" ref={logRef}>
          {log || '응답을 기다리는 중…'}
        </pre>
      )}
      {draft && (
        <>
          <div className="small muted">
            {draft.agent === 'codex' ? 'Codex' : 'Claude Code'} · {new Date(draft.at).toLocaleString()} · v{draft.base} 기준
          </div>
          {draft.base !== draft.currentVersion && (
            <div className="banner">
              <div>
                수정안을 만든 뒤 도메인 문서가 바뀌었습니다 (v{draft.base} → v{draft.currentVersion}). 아래 비교는 지금 문서 기준이라, 그 사이 바뀐 내용이 지워지는 것으로 보일 수 있습니다. 다시 만드는 것이
                안전합니다.
              </div>
            </div>
          )}
          <div className="diff">
            <div className="diff-head">
              <span className="mono">domain.md 수정안</span>
              {view !== 'edit' && (
                <span className="diff-stat">
                  <span className="plus">+{draft.diff.added}</span> <span className="minus">−{draft.diff.removed}</span>
                </span>
              )}
              {dirty && <span className="muted small">다듬은 내용 저장 안 됨</span>}
              <span className="grow" />
              <div className="seg small">
                <button className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>
                  바뀐 곳만
                </button>
                <button className={view === 'full' ? 'on' : ''} onClick={() => setView('full')}>
                  전체
                </button>
                <button className={view === 'edit' ? 'on' : ''} onClick={() => setView('edit')}>
                  직접 다듬기
                </button>
              </div>
            </div>
            {view === 'edit' ? <MdEditor value={edited} onChange={setEdited} /> : <DiffTable diff={view === 'full' ? draft.fullDiff : draft.diff} onExpand={() => setView('full')} />}
          </div>
          {dirty && (
            <div className="row">
              <span className="small muted grow">비교는 저장된 수정안 기준입니다. 다듬은 내용을 저장하면 비교도 갱신됩니다.</span>
              <button className="small" onClick={saveEdit}>
                다듬은 내용 저장
              </button>
            </div>
          )}
          <div className="decision">
            <select value={size} onChange={(e) => setSize(e.target.value as 'minor' | 'major')}>
              <option value="minor">작은 변경</option>
              <option value="major">큰 변경</option>
            </select>
            <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="변경 요약" />
            <button className="primary" onClick={apply} disabled={!summary.trim()}>
              적용
            </button>
            <button onClick={make} disabled={drafting}>
              다시 만들기
            </button>
            <button onClick={discard}>버리기</button>
          </div>
          <div className="small muted">
            <b>적용</b>: 수정안을 도메인 문서에 새 버전으로 저장하고 이 요청을 반영 완료로 닫습니다. <b>다시 만들기</b>: 지금 문서 기준으로 새로 만들어 덮어씁니다. <b>버리기</b>: 요청 파일에서 수정안만 지우고 요청은 그대로 둡니다.
          </div>
        </>
      )}
    </div>
  )
}
