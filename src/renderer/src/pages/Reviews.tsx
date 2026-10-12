import { useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { Decision } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { MdViewer } from '../Markdown'

const LAYER: Record<string, string> = { spec: '기능 명세 표', design: '설계', test: '테스트' }

export default function Reviews({ refreshKey, reloadBadges }: PageProps) {
  const [pending, reload] = useLoad(() => api.pendingItems(), [refreshKey])
  const [reviews] = useLoad(() => api.listReviews(), [refreshKey])
  const [sel, setSel] = useState(0)
  const cur = pending?.[Math.min(sel, (pending?.length ?? 1) - 1)]
  const [changes] = useLoad(() => (cur ? api.changesById(cur.item.changes) : Promise.resolve([])), [cur?.review.id, cur?.item.target])
  const [specs] = useLoad(() => api.listSpecs(), [refreshKey])
  const [designs] = useLoad(() => api.listDesigns(), [refreshKey])
  const [tests] = useLoad(() => api.scanTests(), [refreshKey])
  const [note, setNote] = useState('')

  if (!pending) return null

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
    const links = (tests ?? []).filter((l) => l.acId === ac)
    return `${ac}에 연결된 테스트\n\n` + links.map((l) => `${l.file}:${l.line}\n  ${l.text}`).join('\n\n')
  }

  const references = (reviews ?? []).filter((r) => r.reference.length > 0).slice(-5)

  return (
    <div className="split">
      <div className="pane-list">
        <h3>확인표시 ({pending.length})</h3>
        {pending.length === 0 && <Empty>모든 확인을 마쳤습니다</Empty>}
        {pending.map((p, i) => (
          <button key={p.review.id + p.item.target} className={`tree-item ${cur === p ? 'on' : ''}`} onClick={() => setSel(i)}>
            <Badge>{LAYER[p.item.layer]}</Badge> {p.item.target}
            {p.item.changes.length > 1 && <span className="count">{p.item.changes.length}</span>}
          </button>
        ))}
        {references.length > 0 && (
          <>
            <div className="tree-sep" />
            <h4>참고 목록 (확인표시 없음)</h4>
            {references.map((r) => (
              <div key={r.id} className="small muted">
                {r.trigger}: {r.reference.join(', ')}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="pane-main">
        {cur ? (
          <>
            <h2>
              {LAYER[cur.item.layer]} 확인: {cur.item.target}
            </h2>
            <div className="compare">
              <div>
                <h4>위 층 변경 내역</h4>
                {(changes ?? []).map((c) => (
                  <div key={c.id} className="change-card">
                    <div>
                      <b>{c.target}</b> v{c.from} → v{c.to} <Badge kind={c.size}>{c.size === 'major' ? '큰 변경' : '작은 변경'}</Badge>
                    </div>
                    <div>{c.summary}</div>
                    {c.changed.length > 0 && <div className="small muted">바뀐 항목: {c.changed.join(', ')}</div>}
                    <div className="small muted">{new Date(c.created).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div>
                <h4>아래 층 내용</h4>
                {cur.item.layer === 'test' ? <pre className="doc">{targetBody()}</pre> : <MdViewer source={targetBody()} />}
              </div>
            </div>
            <div className="field">
              <label>메모 (선택)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="row">
              <button className="primary" onClick={() => decideItem('unchanged')}>
                변경 불필요 (기준 버전만 갱신)
              </button>
              <button onClick={() => decideItem('modify')}>{cur.item.layer === 'test' ? '수정 필요 (test Task 생성)' : '수정 필요 (수정 후 기준 갱신)'}</button>
              <button onClick={() => decideItem('defer')}>보류 (Task 생성)</button>
            </div>
          </>
        ) : (
          <Empty>처리할 항목이 없습니다</Empty>
        )}
      </div>
    </div>
  )
}
