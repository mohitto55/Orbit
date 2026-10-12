import { useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { InboxItem, Task, TaskStatus } from '../types'
import { HORIZONS, TASK_STATUSES, TASK_TYPES } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'

export default function Tasks({ refreshKey, reloadBadges, focus }: PageProps) {
  const [inbox, reloadInbox] = useLoad(() => api.listInbox(), [refreshKey])
  const [tasks, reloadTasks] = useLoad(() => api.listTasks(), [refreshKey])
  const [due] = useLoad(() => api.dueTasks(), [refreshKey, tasks])
  const [domains] = useLoad(() => api.listDomains(), [refreshKey])
  const [text, setText] = useState('')
  const [group, setGroup] = useState<'horizon' | 'type'>('horizon')
  const [showDone, setShowDone] = useState(false)
  const [completing, setCompleting] = useState<Task | null>(null)

  const refresh = () => {
    reloadInbox()
    reloadTasks()
    reloadBadges()
  }

  const add = async () => {
    if (!text.trim()) return
    await api.addInbox(text).catch(errorToast)
    setText('')
    refresh()
  }

  const setStatus = async (t: Task, status: TaskStatus) => {
    try {
      await api.updateTask(t.id, { status })
      if (status === '완료') setCompleting(t)
      refresh()
    } catch (e) {
      errorToast(e)
    }
  }

  const visible = (tasks ?? []).filter((t) => showDone || (t.status !== '완료' && t.status !== '취소'))
  const keys = group === 'horizon' ? [...HORIZONS] : [...TASK_TYPES]
  const dueIds = new Set((due ?? []).map((t) => t.id))

  return (
    <div className="page">
      <h2>할 일</h2>
      <div className="row">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="빠른 기록: 한 줄 쓰고 Enter (Ctrl+Shift+Space로 어디서나)" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add}>Inbox에 추가</button>
      </div>

      {completing && domains && (
        <CompletePrompt task={completing} domains={domains.map((d) => ({ id: d.id, title: d.title }))} onDone={() => { setCompleting(null); refresh() }} />
      )}

      <h3>
        Inbox <span className="muted small">유형과 시기를 붙여야 Task가 됩니다</span>
      </h3>
      {inbox && inbox.length === 0 && <Empty>비어 있습니다</Empty>}
      {inbox?.map((i) => <InboxRow key={i.id} item={i} onDone={refresh} />)}

      {due && due.length > 0 && (
        <div className="banner warn">
          <div>
            <b>지금 할 때</b>
            <ul>
              {due.map((t) => (
                <li key={t.id}>{t.title}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="row between">
        <h3>Task</h3>
        <div className="row">
          <div className="seg small">
            <button className={group === 'horizon' ? 'on' : ''} onClick={() => setGroup('horizon')}>
              시기별
            </button>
            <button className={group === 'type' ? 'on' : ''} onClick={() => setGroup('type')}>
              유형별
            </button>
          </div>
          <label className="small">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료·취소 보기
          </label>
        </div>
      </div>
      {keys.map((k) => {
        const list = visible.filter((t) => (group === 'horizon' ? t.horizon : t.type) === k)
        if (!list.length) return null
        return (
          <div key={k} className="group">
            <h4>
              {k} <span className="muted small">{list.length}</span>
            </h4>
            <table className="table">
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className={`${focus === t.id ? 'focus' : ''} ${dueIds.has(t.id) ? 'due' : ''}`}>
                    <td className="mono small" style={{ width: 90 }}>
                      {t.id}
                    </td>
                    <td>
                      {t.title}
                      {t.links.length > 0 && <div className="small muted">{t.links.join(', ')}</div>}
                    </td>
                    <td style={{ width: 110 }}>
                      <Badge>{group === 'horizon' ? t.type : t.horizon}</Badge>
                    </td>
                    <td className="small" style={{ width: 120 }}>
                      {t.due ? `기한 ${String(t.due).slice(0, 10)}` : t.trigger ? `트리거: ${t.trigger.kind} ${t.trigger.ref}` : ''}
                    </td>
                    <td style={{ width: 100 }}>
                      <select value={t.status} onChange={(e) => setStatus(t, e.target.value as TaskStatus)}>
                        {TASK_STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
      {visible.length === 0 && <Empty>Task가 없습니다</Empty>}
    </div>
  )
}

function InboxRow({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const [type, setType] = useState('')
  const [horizon, setHorizon] = useState('')
  const [due, setDue] = useState('')
  const classify = async () => {
    try {
      const t = await api.classifyInbox(item.id, { type, horizon, due: due || undefined })
      toast(`${t.id}로 옮겼습니다`)
      onDone()
    } catch (e) {
      errorToast(e)
    }
  }
  return (
    <div className="inbox-row">
      <div className="grow">
        <div>{item.title}</div>
        {item.source && <div className="small muted">출처: {item.source}</div>}
      </div>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">유형</option>
        {TASK_TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <select value={horizon} onChange={(e) => setHorizon(e.target.value)}>
        <option value="">시기</option>
        {HORIZONS.map((h) => (
          <option key={h}>{h}</option>
        ))}
      </select>
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} title="기한 (선택)" />
      <button className="primary" disabled={!type || !horizon} onClick={classify}>
        Task로
      </button>
      <button
        className="ghost"
        onClick={async () => {
          await api.discardInbox(item.id).catch(errorToast)
          onDone()
        }}
      >
        버림
      </button>
    </div>
  )
}

/** TK-F07 AC2: 완료 시 도메인 로직이 바뀌었는지 묻는다. */
function CompletePrompt({ task, domains, onDone }: { task: Task; domains: { id: string; title: string }[]; onDone: () => void }) {
  const [domain, setDomain] = useState('')
  const [note, setNote] = useState('')
  return (
    <div className="banner">
      <div className="grow">
        <b>{task.title}</b> 완료. 이 작업으로 도메인 로직이 바뀌었나요?
        <div className="row">
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">대상 도메인</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <input className="grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="무엇이 바뀌었나" />
          <button
            disabled={!domain || !note.trim()}
            onClick={async () => {
              await api.requestDomainChange(domain, note, task.id).catch(errorToast)
              toast('도메인 변경 요청을 남겼습니다')
              onDone()
            }}
          >
            예, 변경 요청
          </button>
          <button className="ghost" onClick={onDone}>
            아니요
          </button>
        </div>
      </div>
    </div>
  )
}
