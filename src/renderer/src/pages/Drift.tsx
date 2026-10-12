import { useMemo, useState } from 'react'
import AiCheck from './AiCheck'
import { Markdown } from '../Markdown'
import { api } from '../api'
import type { PageProps } from '../App'
import type { Mark, SessionInfo } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'

export default function Drift(props: PageProps) {
  const [tab, setTab] = useState<'ai' | 'manual'>('ai')
  return (
    <div className="drift-page">
      <div className="tabs drift-tabs">
        <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>
          AI 점검
        </button>
        <button className={tab === 'manual' ? 'on' : ''} onClick={() => setTab('manual')}>
          대화 직접 보기
        </button>
      </div>
      {tab === 'ai' ? <AiCheck {...props} /> : <ManualReview {...props} />}
    </div>
  )
}

/** 대화를 사람이 직접 읽으며 표시를 남기는 방식 (AI 점검을 보완) */
function ManualReview({ refreshKey, reloadBadges }: PageProps) {
  const [sessions, reloadSessions] = useLoad(() => api.pendingSessions(), [refreshKey])
  const [checks, reloadChecks] = useLoad(() => api.listChecks(), [refreshKey])
  const [domains] = useLoad(() => api.listDomains(), [refreshKey])
  const [current, setCurrent] = useState<SessionInfo | null>(null)
  const [viewed, setViewed] = useState<Set<string>>(new Set())
  const [marks, setMarks] = useState<Mark[]>([])
  const [domainId, setDomainId] = useState('')
  const [startedAt] = useState(() => new Date().toISOString())
  const [messages] = useLoad(() => (current ? api.readSession(current.file, current.agent) : Promise.resolve([])), [current?.file])

  const terms = useMemo(() => (domains ?? []).map((d) => ({ title: d.title, id: d.id })), [domains])
  const domain = domains?.find((d) => d.id === domainId)

  const open = (s: SessionInfo) => {
    setCurrent(s)
    setViewed((v) => new Set(v).add(s.id))
  }

  const addMark = (kind: Mark['kind']) => {
    const excerpt = window.getSelection()?.toString().trim()
    if (!excerpt || !current) {
      toast('대화에서 표시할 부분을 먼저 드래그해 선택하세요', 'error')
      return
    }
    if (kind === 'domain' && !domainId) {
      toast('오른쪽에서 반영할 도메인을 고르세요', 'error')
      return
    }
    const note = prompt('메모 (선택)', '') ?? ''
    setMarks((m) => [...m, { kind, excerpt, sessionId: current.id, ...(kind === 'domain' ? { domainId } : {}), ...(note ? { note } : {}) }])
  }

  const finish = async () => {
    if (viewed.size === 0 && !confirm('본 세션이 없습니다. 목록의 모든 세션을 검토됨으로 처리할까요?')) return
    const ids = viewed.size ? [...viewed] : (sessions ?? []).map((s) => s.id)
    try {
      await api.finishCheck({ sessionIds: ids, marks, startedAt })
      toast(`검토를 마쳤습니다 (세션 ${ids.length}개, 표시 ${marks.length}개)`)
      setMarks([])
      setViewed(new Set())
      setCurrent(null)
      reloadSessions()
      reloadChecks()
      reloadBadges()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="split three">
      <div className="pane-list">
        <h3>검토할 대화 ({sessions?.length ?? 0})</h3>
        <div className="muted small">지난 검토 {checks?.length ? new Date(checks[checks.length - 1].finishedAt).toLocaleDateString() : '없음'}</div>
        {sessions?.length === 0 && <Empty>지난 검토 이후 새 대화가 없습니다</Empty>}
        {sessions?.map((s) => (
          <button key={s.id} className={`tree-item ${current?.id === s.id ? 'on' : ''} ${viewed.has(s.id) ? 'seen' : ''}`} onClick={() => open(s)}>
            <Badge>{s.agent}</Badge> {s.firstPrompt.slice(0, 40) || '(내용 없음)'}
            <div className="small muted">
              {new Date(s.updatedAt).toLocaleString()} · {s.messages}개
            </div>
          </button>
        ))}
        <div className="tree-sep" />
        <h4>표시 ({marks.length})</h4>
        {marks.map((m, i) => (
          <div key={i} className="mark-item">
            <Badge>{m.kind === 'domain' ? '도메인 반영' : m.kind === 'task' ? '할 일' : '지식'}</Badge> {m.excerpt.slice(0, 50)}
            <button className="icon" onClick={() => setMarks((x) => x.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button className="primary" onClick={finish} disabled={!sessions?.length && !marks.length}>
          검토 마치기
        </button>
      </div>
      <div className="pane-main">
        {current ? (
          <>
            <div className="row">
              <span className="muted small">대화 일부를 드래그한 뒤 표시:</span>
              <button className="small" onClick={() => addMark('domain')}>
                도메인 반영
              </button>
              <button className="small" onClick={() => addMark('task')}>
                할 일
              </button>
              <button className="small" onClick={() => addMark('knowledge')}>
                지식
              </button>
            </div>
            <div className="chat">
              {(messages ?? []).map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="small muted">{m.role === 'user' ? '사람' : '에이전트'}</div>
                  <Markdown className="msg-text" source={m.text} terms={terms} onTerm={setDomainId} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty>왼쪽에서 대화를 고르세요. 판단은 사람이 합니다. 앱은 대화와 도메인을 나란히 보여줄 뿐입니다.</Empty>
        )}
      </div>
      <div className="pane-side">
        <h3>도메인</h3>
        <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          <option value="">도메인 선택</option>
          {domains?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        {domain && <Markdown className="bordered md-scroll" source={domain.content} />}
      </div>
    </div>
  )
}
