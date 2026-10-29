import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { ChangeSet, Decision } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { MdViewer } from '../Markdown'
import DiffView from './DiffView'
import Requests from './Requests'
import { RunButton, RunDrawer, SourceRuns } from '../Automation'

const LAYER: Record<string, string> = { spec: '명세', design: '설계', test: '테스트' }
const KIND: Record<string, string> = { domain: '도메인', spec: '명세', design: '설계' }

/** 변경 검토: 변경에 대해 사람이 결정할 것을 모은다. 변경 요청(바깥 → 도메인)과 확인할 문서(도메인 → 아래). */
export default function Reviews(props: PageProps) {
  const [changeId, setChangeId] = useState<string | null>(props.focus?.startsWith('change:') ? props.focus.slice(7) : null)
  useEffect(() => { if (props.focus?.startsWith('change:')) setChangeId(props.focus.slice(7)) }, [props.focus])
  const [requests] = useLoad(() => api.listRequests(), [props.refreshKey])
  const [pending] = useLoad(() => api.pendingItems(), [props.refreshKey])
  const reqCount = (requests ?? []).filter((r) => r.status === 'pending').length
  const [tab, setTab] = useState<'requests' | 'docs' | null>(props.focus?.startsWith('request:') ? 'requests' : null)
  useEffect(() => { if (props.focus?.startsWith('request:')) setTab('requests') }, [props.focus])
  const current = tab ?? (reqCount > 0 || !(pending?.length ?? 0) ? 'requests' : 'docs')
  return (
    <div className="drift-page">
      {changeId && <RunDrawer title="변경 내용" onClose={() => setChangeId(null)}><DiffView changeId={changeId} /></RunDrawer>}
      <div className="tabs drift-tabs">
        <button className={current === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
          변경 요청 {reqCount > 0 && <span className="count">{reqCount}</span>}
        </button>
        <button className={current === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>
          확인할 문서 {(pending?.length ?? 0) > 0 && <span className="count">{pending!.length}</span>}
        </button>
      </div>
      {current === 'requests' ? <Requests {...props} /> : <ImpactReviews {...props} />}
    </div>
  )
}

/** 도메인 → 아래: 위 층이 크게 바뀌어 확인할 아래 문서 */
function ImpactReviews({ refreshKey, reloadBadges, go }: PageProps) {
  const [pending, reload] = useLoad(() => api.pendingItems(), [refreshKey])
  const [reviews] = useLoad(() => api.listReviews(), [refreshKey])
  const [docs] = useLoad(() => api.docIndex(), [refreshKey])
  // 목록에 "무엇이 바뀌어서"를 보여주기 위해 쌓인 변경 기록을 한 번에 가져온다
  const [causes] = useLoad(
    () => (pending ? api.changesById(pending.flatMap((p) => p.item.changes)) : Promise.resolve([] as ChangeSet[])),
    [pending]
  )
  const [specs] = useLoad(() => api.listSpecs(), [refreshKey])
  const [designs] = useLoad(() => api.listDesigns(), [refreshKey])
  const [tests] = useLoad(() => api.scanTests(), [refreshKey])
  const [sel, setSel] = useState(0)
  const [changeIdx, setChangeIdx] = useState(0)
  const [tab, setTab] = useState<'diff' | 'target'>('diff')
  const [note, setNote] = useState('')

  const cur = pending?.[Math.min(sel, Math.max(0, (pending?.length ?? 1) - 1))]
  useEffect(() => {
    setChangeIdx(0)
    setTab('diff')
  }, [cur?.review.id, cur?.item.target])

  if (!pending || !docs) return null

  const title = (id: string) => docs[id]?.title ?? id
  const changesOf = (ids: string[]) => (causes ?? []).filter((c) => ids.includes(c.id))
  const curChanges = cur ? changesOf(cur.item.changes) : []
  const change = curChanges[Math.min(changeIdx, Math.max(0, curChanges.length - 1))]
  const targetLabel = (_layer: string, target: string) => title(target)

  const decideItem = async (decision: Decision) => {
    if (!cur) return
    try {
      const r = await api.decide(cur.review.id, cur.item.target, decision, note)
      toast(r.taskId ? `처리했습니다. ${r.taskId}를 만들었습니다` : '처리했습니다')
      setNote('')
      reload()
      reloadBadges()
    } catch (e) {
      errorToast(e)
    }
  }

  const targetBody = () => {
    if (!cur) return ''
    const t = cur.item.target
    if (cur.item.layer === 'spec') return specs?.find((s) => s.id === t)?.content ?? ''
    if (cur.item.layer === 'design') return designs?.find((d) => d.id === t)?.content ?? ''
    const ac = t.replace(/^test:/, '')
    return `${ac}에 연결된 테스트\n\n` + (tests ?? []).filter((l) => l.acId === ac).map((l) => `${l.file}:${l.line}\n  ${l.text}`).join('\n\n')
  }

  /** 확인할 문서가 바뀐 문서의 몇 버전을 기준으로 쓰였는지 */
  const basis = (target: string, cause: string) => {
    const b = docs[target]?.basedOn.filter((x) => x.ref === cause) ?? []
    return b.length ? b.map((x) => `${x.feature ? `${x.feature} ` : ''}v${x.version}`).join(', ') : null
  }

  const references = (reviews ?? []).filter((r) => r.reference.length > 0).slice(-5)

  return (
    <div className="split">
      <div className="pane-list">
        <h3>변경 검토 ({pending.length})</h3>
        <div className="muted small">위 층 문서가 크게 바뀌어, 그걸 기준으로 쓴 아래 문서를 확인해야 하는 항목</div>
        {pending.length === 0 && <Empty>확인할 항목이 없습니다</Empty>}
        {pending.map((p, i) => {
          const cs = changesOf(p.item.changes)
          const last = cs[cs.length - 1]
          return (
            <button key={p.review.id + p.item.target} className={`tree-item review-item ${cur === p ? 'on' : ''}`} onClick={() => setSel(i)}>
              <div>
                {targetLabel(p.item.layer, p.item.target)}
              </div>
              {last && (
                <div className="small muted">
                  ← {title(last.target)} v{last.from}→v{last.to}
                  {cs.length > 1 && ` 외 ${cs.length - 1}건`}
                </div>
              )}
            </button>
          )
        })}
        {references.length > 0 && (
          <>
            <div className="tree-sep" />
            <h4>참고 목록 (확인 항목 없음)</h4>
            {references.map((r) => (
              <div key={r.id} className="small muted">
                {r.reference.map(title).join(', ')}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="pane-main">
        {cur && change ? (
          <>
            {/* 원인 → 영향 */}
            <div className="flow">
              <div className="flow-box cause">
                <div className="small muted">바뀐 문서 · {KIND[docs[change.target]?.kind] ?? '문서'}</div>
                <b>{title(change.target)}</b>
                <div>
                  v{change.from} → v{change.to} <Badge kind={change.size}>{change.size === 'major' ? '큰 변경' : '작은 변경'}</Badge>
                </div>
                <div className="flow-summary">{change.summary}</div>
                <div className="row"><RunButton sources={[{ kind: 'change', id: change.id, title: change.summary }]} /><SourceRuns source={{ kind: 'change', id: change.id, title: change.summary }} /></div>
                {change.changed.length > 0 && (
                  <div className="chips">
                    {change.changed.map((c) => (
                      <code key={c}>{c}</code>
                    ))}
                  </div>
                )}
                <div className="small muted">{new Date(change.created).toLocaleString()}</div>
              </div>
              <div className="flow-arrow">
                <span>영향</span>
                <span className="arrow">→</span>
              </div>
              <div className="flow-box target">
                <div className="small muted">확인할 문서 · {LAYER[cur.item.layer]}</div>
                <b>{targetLabel(cur.item.layer, cur.item.target)}</b>
                <div className="small">
                  {basis(cur.item.target, change.target)
                    ? `${title(change.target)} ${basis(cur.item.target, change.target)}을 기준으로 작성됨 → 지금은 v${docs[change.target]?.version}`
                    : cur.item.layer === 'test'
                      ? '이 수용 기준이 바뀌어, 연결된 테스트가 옛 기준으로 통과하고 있을 수 있음'
                      : '기준 관계로 연결됨'}
                </div>
              </div>
            </div>

            {curChanges.length > 1 && (
              <div className="row">
                <span className="small muted">쌓인 변경 {curChanges.length}건</span>
                <div className="seg small">
                  {curChanges.map((c, i) => (
                    <button key={c.id} className={i === changeIdx ? 'on' : ''} onClick={() => setChangeIdx(i)}>
                      v{c.from}→v{c.to}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="tabs">
              <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
                바뀐 내용 (비교)
              </button>
              <button className={tab === 'target' ? 'on' : ''} onClick={() => setTab('target')}>
                확인할 문서
              </button>
            </div>
            <div className="review-body">
              {tab === 'diff' ? (
                <DiffView key={change.id} changeId={change.id} />
              ) : cur.item.layer === 'test' ? (
                <pre className="doc">{targetBody()}</pre>
              ) : (
                <MdViewer source={targetBody()} />
              )}
            </div>

            <div className="decision-help small muted">
              <b>확인 완료</b>: 내용이 맞다고 확인했거나 고친 뒤 누릅니다. 문서 내용은 그대로 두고 &quot;이 버전까지 확인함&quot;으로 기준만 올린 뒤 항목을 닫습니다.{' '}
              {cur.item.layer === 'test' ? (
                <>
                  <b>테스트 고칠 할 일</b>: test 유형 할 일을 만들고 항목을 닫습니다.
                </>
              ) : (
                <>
                  <b>문서 열어서 고치기</b>: 편집 화면으로 이동합니다. 항목은 열린 채로 남으니, 고친 뒤 돌아와 확인 완료를 누르세요.
                </>
              )}{' '}
              <b>나중에</b>: 할 일을 만들고 항목을 닫습니다. 문서는 고칠 때까지 &apos;낡음&apos;으로 표시됩니다.
            </div>
            <div className="decision">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모 (선택)" />
              <button className="primary" onClick={() => decideItem('unchanged')}>
                확인 완료 · 기준을 v{docs[change.target]?.version}로
              </button>
              {cur.item.layer === 'test' ? (
                <button onClick={() => decideItem('modify')}>테스트 고칠 할 일 만들기</button>
              ) : (
                <button onClick={() => go('domains', `${docs[cur.item.target]?.domainId ?? ''}#${cur.item.layer}`)}>문서 열어서 고치기</button>
              )}
              <button onClick={() => decideItem('defer')}>나중에 · 할 일로 남기기</button>
            </div>
          </>
        ) : (
          <Empty>{pending.length ? '왼쪽에서 항목을 고르세요' : '처리할 항목이 없습니다'}</Empty>
        )}
      </div>
    </div>
  )
}
