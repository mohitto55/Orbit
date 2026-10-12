import { useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { Markdown } from '../Markdown'

/** 요청이 어디서 왔는지 사람이 읽을 수 있는 말로 */
function sourceLabel(source: string): string {
  if (source.startsWith('ai-check:')) return 'AI 점검'
  if (source.startsWith('drift:')) return '대화 직접 보기'
  if (source.startsWith('task-')) return `할 일 완료 (${source})`
  return source
}

/** IR-F08: 바깥 → 도메인. 도메인을 이렇게 고치자는 요청을 보고 반영 완료 / 반려로 닫는다. */
export default function Requests({ refreshKey, reloadBadges, go, focus }: PageProps) {
  const [requests, reload] = useLoad(() => api.listRequests(), [refreshKey])
  const [docs] = useLoad(() => api.docIndex(), [refreshKey])
  const [showDone, setShowDone] = useState(false)
  // 도메인 화면에서 특정 요청을 눌러 들어오면 그 요청을 연다
  const [sel, setSel] = useState<string | null>(focus?.startsWith('request:') ? focus.slice(8) : null)
  const [note, setNote] = useState('')

  if (!requests || !docs) return null
  const list = requests
    .filter((r) => showDone || r.status === 'pending')
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created.localeCompare(a.created))
  const cur = list.find((r) => r.id === sel) ?? list[0]
  const domainTitle = (id: string) => docs[id]?.title ?? id

  const resolve = async (status: 'done' | 'rejected') => {
    if (!cur) return
    try {
      await api.requestResolve(cur.id, status, note)
      toast(status === 'done' ? '반영 완료로 닫았습니다' : '반려했습니다')
      setNote('')
      setSel(null)
      reload()
      reloadBadges()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="split">
      <div className="pane-list">
        <h3>변경 요청</h3>
        <div className="muted small">도메인 문서를 이렇게 고치자는 요청. AI 점검·대화 직접 보기·할 일 완료에서 들어옵니다.</div>
        <label className="small">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 처리한 요청도 보기
        </label>
        {list.length === 0 && <Empty>처리할 변경 요청이 없습니다</Empty>}
        {list.map((r) => (
          <button key={r.id} className={`tree-item review-item ${cur?.id === r.id ? 'on' : ''} ${r.status !== 'pending' ? 'dim' : ''}`} onClick={() => setSel(r.id)}>
            <div>{(r.note ?? r.excerpt).split(/[:\n]/)[0].slice(0, 60)}</div>
            <div className="small muted">
              → {domainTitle(r.domain)} · {sourceLabel(r.source)}
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
                <b>{(cur.note ?? cur.excerpt).split(/[:\n]/)[0]}</b>
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
