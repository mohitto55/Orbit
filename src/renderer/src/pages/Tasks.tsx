import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { InboxItem, Priority, Task, TaskStatus } from '../types'
import { HORIZONS, PRIORITIES, TASK_STATUSES, TASK_TYPES } from '../types'
import { Badge, Empty, Modal, errorToast, offerUndo, toast, useLoad } from '../ui'

const PRIO_RANK: Record<string, number> = { 높음: 0, 보통: 1, 낮음: 2 }
const isClosed = (t: Task) => t.status === '완료' || t.status === '취소'
/** 미완료 먼저, 그다음 끌어서 정한 순서, 중요도, 종료일(없으면 뒤로) 순 */
function byPriority(a: Task, b: Task): number {
  return (
    Number(isClosed(a)) - Number(isClosed(b)) ||
    (a.order ?? Infinity) - (b.order ?? Infinity) ||
    (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1) ||
    (a.end ?? '9999').localeCompare(b.end ?? '9999') ||
    a.id.localeCompare(b.id)
  )
}

export default function Tasks({ refreshKey, reloadBadges, focus }: PageProps) {
  const [inbox, reloadInbox] = useLoad(() => api.listInbox(), [refreshKey])
  const [tasks, reloadTasks] = useLoad(() => api.listTasks(), [refreshKey])
  const [due] = useLoad(() => api.dueTasks(), [refreshKey, tasks])
  const [domains] = useLoad(() => api.listDomains(), [refreshKey])
  const [text, setText] = useState('')
  const [group, setGroup] = useState<'horizon' | 'type' | 'priority'>('horizon')
  const [view, setView] = useState<'list' | 'timeline'>('list')
  const [showDone, setShowDone] = useState(false)
  const [completing, setCompleting] = useState<Task | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState<{ inbox?: InboxItem; title?: string } | null>(null)

  const refresh = () => {
    reloadInbox()
    reloadTasks()
    reloadBadges()
  }

  /** 파일을 건드리기 전에 찍어 두고, 끝나면 좌측 아래에 되돌리기를 띄운다. created는 새로 생긴 파일. */
  const track: Track = async (label, files, action, created) => {
    const snaps = await api.snapshotFiles(files)
    const result = await action()
    const all = [...snaps, ...(created?.(result) ?? []).map((file) => ({ file, raw: null }))]
    offerUndo(label, async () => {
      await api.restoreFiles(all)
      setCompleting(null)
      refresh()
    })
    refresh()
    return result
  }

  const add = async () => {
    if (!text.trim()) return
    try {
      await track('Inbox에 추가했습니다', [], () => api.addInbox(text), (i) => [i.file])
      setText('')
    } catch (e) {
      errorToast(e)
    }
  }

  const setStatus = async (t: Task, status: TaskStatus) => {
    try {
      await track(status === '완료' ? `"${t.title}" 완료` : `"${t.title}" → ${status}`, [t.file], () => api.updateTask(t.id, { status }))
      if (status === '완료') setCompleting(t)
    } catch (e) {
      errorToast(e)
    }
  }

  const setPriority = async (t: Task, priority: Priority) => {
    try {
      await track(`중요도를 ${priority}(으)로 바꿨습니다`, [t.file], () => api.updateTask(t.id, { priority }))
    } catch (e) {
      errorToast(e)
    }
  }

  const setDates = async (t: Task, patch: { start?: string; end?: string }) => {
    try {
      await track('날짜를 바꿨습니다', [t.file], () => api.updateTask(t.id, patch))
    } catch (e) {
      errorToast(e)
    }
  }

  const byId = new Map((tasks ?? []).map((t) => [t.id, t]))
  const reorder = useCallback(
    async (ids: string[]) => {
      try {
        await track('순서를 바꿨습니다', ids.map((id) => byId.get(id)!.file), () => api.reorderTasks(ids))
      } catch (e) {
        errorToast(e)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks]
  )

  const visible = (tasks ?? []).filter((t) => showDone || !isClosed(t)).sort(byPriority)
  const keys: string[] = group === 'horizon' ? [...HORIZONS] : group === 'type' ? [...TASK_TYPES] : [...PRIORITIES]
  const groupOf = (t: Task) => (group === 'horizon' ? t.horizon : group === 'type' ? t.type : t.priority)
  const dueIds = new Set((due ?? []).map((t) => t.id))

  return (
    <div className="page">
      <h2>할 일</h2>
      <div className="row">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="빠른 기록: 한 줄 쓰고 Enter (Ctrl+Shift+Space로 어디서나)" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add}>Inbox에 추가</button>
        <button className="primary" onClick={() => setCreating({ title: text })}>
          Task 추가
        </button>
      </div>

      {creating && (
        <TaskEditor
          inbox={creating.inbox}
          initialTitle={creating.title}
          track={track}
          onClose={() => setCreating(null)}
          onSaved={() => {
            if (!creating.inbox) setText('')
            setCreating(null)
          }}
        />
      )}

      {editing && (
        <TaskEditor
          task={editing}
          track={track}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setEditing(null)
            if (t && t.status === '완료' && editing.status !== '완료') setCompleting(t)
            refresh()
          }}
        />
      )}

      {completing && domains && (
        <CompletePrompt task={completing} domains={domains.map((d) => ({ id: d.id, title: d.title }))} onDone={() => { setCompleting(null); refresh() }} />
      )}

      <h3>
        Inbox <span className="muted small">유형과 시기를 붙여야 Task가 됩니다</span>
      </h3>
      {inbox && inbox.length === 0 && <Empty>비어 있습니다</Empty>}
      {inbox?.map((i) => <InboxRow key={i.id} item={i} track={track} onPromote={() => setCreating({ inbox: i })} />)}

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
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
              목록
            </button>
            <button className={view === 'timeline' ? 'on' : ''} onClick={() => setView('timeline')}>
              타임라인
            </button>
          </div>
          {view === 'list' && (
            <div className="seg small">
              <button className={group === 'horizon' ? 'on' : ''} onClick={() => setGroup('horizon')}>
                시기별
              </button>
              <button className={group === 'type' ? 'on' : ''} onClick={() => setGroup('type')}>
                유형별
              </button>
              <button className={group === 'priority' ? 'on' : ''} onClick={() => setGroup('priority')}>
                중요도별
              </button>
            </div>
          )}
          <label className="small">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료·취소 보기
          </label>
        </div>
      </div>
      {view === 'timeline' && <Timeline tasks={visible} focus={focus} dueIds={dueIds} onOpen={setEditing} />}
      {view === 'list' &&
        keys.map((k) => {
          const list = visible.filter((t) => groupOf(t) === k)
          if (!list.length) return null
          return (
            <TaskGroup key={k} title={k} list={list} onReorder={reorder}>
              {(t, bind) => (
                <tr key={t.id} {...bind} className={`todo ${bind.className} ${isClosed(t) ? 'closed' : ''} ${focus === t.id ? 'focus' : ''} ${dueIds.has(t.id) ? 'due' : ''}`}>
                  <td className="todo-check">
                    <input
                      type="checkbox"
                      checked={t.status === '완료'}
                      onChange={(e) => setStatus(t, e.target.checked ? '완료' : '대기')}
                      title={t.status === '완료' ? '완료 취소' : '완료로 표시'}
                    />
                  </td>
                  <td>
                    <button className="link todo-title" onClick={() => setEditing(t)} title="눌러서 수정">
                      {t.title}
                    </button>
                    <div className="small muted">
                      <span className="mono">{t.id}</span>
                      {t.links.length > 0 && ` · ${t.links.join(', ')}`}
                    </div>
                  </td>
                  <td style={{ width: 84 }}>
                    <select className={`prio prio-${t.priority}`} value={t.priority} onChange={(e) => setPriority(t, e.target.value as Priority)} title="중요도">
                      {PRIORITIES.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ width: 110 }}>
                    <Badge>{group === 'type' ? t.horizon : t.type}</Badge>
                  </td>
                  <td className="small" style={{ width: 270 }}>
                    <div className="date-range">
                      <input type="date" value={t.start ?? ''} max={t.end} onChange={(e) => setDates(t, { start: e.target.value })} title="시작일" />
                      <span className="muted">~</span>
                      <input type="date" value={t.end ?? ''} min={t.start} onChange={(e) => setDates(t, { end: e.target.value })} title="종료일" />
                    </div>
                    {t.due ? <div className="muted">기한 {t.due}</div> : t.trigger ? <div className="muted">트리거: {t.trigger.kind} {t.trigger.ref}</div> : null}
                  </td>
                  <td style={{ width: 100 }}>
                    <select value={t.status} onChange={(e) => setStatus(t, e.target.value as TaskStatus)}>
                      {TASK_STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              )}
            </TaskGroup>
          )
        })}
      {view === 'list' && visible.length > 1 && <div className="small muted">Task를 잡고 위아래로 끌면 순서가 바뀝니다</div>}
      {visible.length === 0 && <Empty>Task가 없습니다</Empty>}
    </div>
  )
}

type Track = <T>(label: string, files: string[], action: () => Promise<T>, created?: (r: T) => string[]) => Promise<T>

function InboxRow({ item, track, onPromote }: { item: InboxItem; track: Track; onPromote: () => void }) {
  return (
    <div className="inbox-row">
      <div className="grow">
        <div>{item.title}</div>
        {item.source && <div className="small muted">출처: {item.source}</div>}
      </div>
      <button className="primary" onClick={onPromote}>
        Task로
      </button>
      <button
        className="ghost"
        onClick={() => track(`"${item.title}"을(를) 버렸습니다`, [item.file], () => api.discardInbox(item.id)).catch(errorToast)}
      >
        버림
      </button>
    </div>
  )
}

/** task가 있으면 수정, 없으면 새로 만든다 (inbox가 있으면 그 항목을 Task로 옮긴다). */
function TaskEditor({
  task,
  inbox,
  initialTitle,
  track,
  onClose,
  onSaved
}: {
  task?: Task
  inbox?: InboxItem
  initialTitle?: string
  track: Track
  onClose: () => void
  onSaved: (t: Task | null) => void
}) {
  const [f, setF] = useState({
    title: task?.title ?? inbox?.title ?? initialTitle ?? '',
    body: task?.body ?? inbox?.body ?? '',
    type: (task?.type ?? '') as Task['type'] | '',
    horizon: (task?.horizon ?? '') as Task['horizon'] | '',
    priority: task?.priority ?? ('보통' as Priority),
    status: task?.status ?? ('대기' as TaskStatus),
    start: task?.start ?? '',
    end: task?.end ?? '',
    due: task?.due ?? '',
    links: task?.links.join(', ') ?? ''
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const badRange = !!f.start && !!f.end && f.start > f.end
  const canSave = !!f.title.trim() && !!f.type && !!f.horizon && !badRange

  const save = async () => {
    const links = f.links.split(',').map((l) => l.trim()).filter(Boolean)
    const title = f.title.trim()
    try {
      if (task) {
        onSaved(await track(`"${title}" 저장했습니다`, [task.file], () => api.updateTask(task.id, { ...f, type: f.type as Task['type'], horizon: f.horizon as Task['horizon'], links })))
        return
      }
      const input = { title, body: f.body, type: f.type, horizon: f.horizon, priority: f.priority, start: f.start || undefined, end: f.end || undefined, due: f.due || undefined, links }
      onSaved(
        inbox
          ? await track(`"${title}"을(를) Task로 옮겼습니다`, [inbox.file], () => api.classifyInbox(inbox.id, input), (t) => [t.file])
          : await track(`"${title}" Task를 추가했습니다`, [], () => api.createTask(input), (t) => [t.file])
      )
    } catch (e) {
      errorToast(e)
    }
  }
  const remove = async () => {
    if (!task) return
    try {
      await track(`"${task.title}" 삭제했습니다`, [task.file], () => api.deleteTask(task.id))
      onSaved(null)
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <Modal title={task ? `Task 수정 · ${task.id}` : inbox ? 'Inbox → Task' : '새 Task'} onClose={onClose} wide>
      {inbox?.source && <div className="small muted">출처: {inbox.source}</div>}
      <div className="field">
        <label>제목</label>
        <input autoFocus value={f.title} onChange={(e) => set('title', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canSave && save()} />
      </div>
      <div className={task ? 'grid4' : 'grid3'}>
        <div className="field">
          <label>유형</label>
          <select value={f.type} onChange={(e) => set('type', e.target.value as Task['type'])}>
            {!f.type && <option value="">골라 주세요</option>}
            {TASK_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>시기</label>
          <select value={f.horizon} onChange={(e) => set('horizon', e.target.value as Task['horizon'])}>
            {!f.horizon && <option value="">골라 주세요</option>}
            {HORIZONS.map((h) => (
              <option key={h}>{h}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>중요도</label>
          <select value={f.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        {task && (
          <div className="field">
            <label>상태</label>
            <select value={f.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
              {TASK_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="grid3">
        <div className="field">
          <label>시작일</label>
          <input type="date" value={f.start} max={f.end || undefined} onChange={(e) => set('start', e.target.value)} />
        </div>
        <div className="field">
          <label>종료일</label>
          <input type="date" value={f.end} min={f.start || undefined} onChange={(e) => set('end', e.target.value)} />
        </div>
        <div className="field">
          <label>기한 (지나면 알림)</label>
          <input type="date" value={f.due} onChange={(e) => set('due', e.target.value)} />
        </div>
      </div>
      {badRange && <div className="small" style={{ color: 'var(--bad)' }}>종료일이 시작일보다 빠릅니다</div>}
      <div className="field">
        <label>연결 (쉼표로 구분, 예: 도메인·기능 ID)</label>
        <input value={f.links} onChange={(e) => set('links', e.target.value)} />
      </div>
      <div className="field">
        <label>세부 내용</label>
        <textarea className="task-body" value={f.body} onChange={(e) => set('body', e.target.value)} placeholder="세부 내용, 메모 (마크다운)" />
      </div>
      <div className="row between">
        {task ? (
          <button className="danger" onClick={remove}>
            삭제
          </button>
        ) : (
          <span className="small muted">{!f.type || !f.horizon ? '유형과 시기를 골라야 Task가 됩니다' : ''}</span>
        )}
        <div className="row">
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={!canSave} onClick={save}>
            {task ? '저장' : 'Task 만들기'}
          </button>
        </div>
      </div>
    </Modal>
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

const DAY_W = 28
const SPAN = 42

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6
/** 오늘이 속한 주의 전 주 월요일 */
function defaultFrom(): Date {
  const t = new Date()
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return addDays(today, -((today.getDay() + 6) % 7) - 7)
}

/** 시작일~종료일을 가로 달력 위에 막대로 보여준다. 한쪽만 있으면 하루짜리로 그린다. */
function Timeline({ tasks, focus, dueIds, onOpen }: { tasks: Task[]; focus?: string; dueIds: Set<string>; onOpen: (t: Task) => void }) {
  const [from, setFrom] = useState(defaultFrom)
  const days = useMemo(() => Array.from({ length: SPAN }, (_, i) => addDays(from, i)), [from])
  const today = ymd(new Date())
  const first = ymd(from)
  const last = ymd(days[days.length - 1])

  const dated = tasks
    .filter((t) => t.start || t.end)
    .map((t) => ({ t, s: t.start ?? t.end!, e: t.end ?? t.start! }))
    .sort((a, b) => a.s.localeCompare(b.s) || a.e.localeCompare(b.e))
  const inView = dated.filter((x) => x.e >= first && x.s <= last)
  const undated = tasks.length - dated.length
  const outside = dated.length - inView.length

  const months: { label: string; span: number }[] = []
  for (const d of days) {
    const label = `${d.getFullYear()}년 ${d.getMonth() + 1}월`
    if (months.length && months[months.length - 1].label === label) months[months.length - 1].span++
    else months.push({ label, span: 1 })
  }
  const todayIdx = daysBetween(from, parseYmd(today))
  const cols = `220px repeat(${SPAN}, ${DAY_W}px)`

  return (
    <div className="timeline-wrap">
      <div className="row between">
        <div className="row">
          <button onClick={() => setFrom(addDays(from, -14))}>◀ 2주</button>
          <button onClick={() => setFrom(defaultFrom())}>오늘</button>
          <button onClick={() => setFrom(addDays(from, 14))}>2주 ▶</button>
        </div>
        <span className="muted small">
          {[undated > 0 && `날짜 없는 Task ${undated}개`, outside > 0 && `이 기간 밖 ${outside}개`].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="timeline">
        <div className="tl-line" style={{ gridTemplateColumns: cols }}>
          <div className="tl-label" />
          {months.map((m, i) => (
            <div key={i} className="tl-month" style={{ gridColumn: `span ${m.span}` }}>
              {m.label}
            </div>
          ))}
        </div>
        <div className="tl-line" style={{ gridTemplateColumns: cols }}>
          <div className="tl-label" />
          {days.map((d) => {
            const k = ymd(d)
            return (
              <div key={k} className={`tl-day ${isWeekend(d) ? 'weekend' : ''} ${d.getDay() === 1 ? 'week' : ''} ${k === today ? 'today' : ''}`}>
                <div className="tl-date">{d.getDate()}</div>
                <small>{'일월화수목금토'[d.getDay()]}</small>
              </div>
            )
          })}
        </div>
        {inView.map(({ t, s, e }) => {
          const a = Math.max(0, daysBetween(from, parseYmd(s)))
          const b = Math.min(SPAN - 1, daysBetween(from, parseYmd(e)))
          return (
            <div key={t.id} className={`tl-line tl-row ${focus === t.id ? 'focus' : ''}`} style={{ gridTemplateColumns: cols }}>
              <div className="tl-label clickable" title={t.title} onClick={() => onOpen(t)}>
                <span className={`prio-dot prio-${t.priority}`} title={`중요도 ${t.priority}`} />
                {t.title}
              </div>
              {days.map((d) => (
                <div key={ymd(d)} className={`tl-cell ${isWeekend(d) ? 'weekend' : ''} ${d.getDay() === 1 ? 'week' : ''}`} />
              ))}
              {todayIdx >= 0 && todayIdx < SPAN && <div className="tl-today" style={{ left: 220 + todayIdx * DAY_W + DAY_W / 2 }} />}
              <div
                className={`tl-bar st-${t.status} ${dueIds.has(t.id) ? 'due' : ''} ${s < first ? 'cut-l' : ''} ${e > last ? 'cut-r' : ''}`}
                style={{ left: 220 + a * DAY_W + 2, width: (b - a + 1) * DAY_W - 4 }}
                title={`${t.title}\n${s} ~ ${e} · ${t.status}`}
                onClick={() => onOpen(t)}
              >
                {t.title}
              </div>
            </div>
          )
        })}
        {inView.length === 0 && <Empty>이 기간에 걸친 Task가 없습니다. 목록에서 시작일·종료일을 넣어 보세요</Empty>}
      </div>
    </div>
  )
}

const LONG_PRESS_MS = 350
type DragState = { id: string; from: number; to: number; dy: number; h: number }

/** 행을 꾹 누르면 들어 올려서 위아래로 끌어 순서를 바꾼다. */
function useLongPressReorder(ids: string[], onReorder: (ids: string[]) => void) {
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [pressing, setPressing] = useState<string | null>(null)
  const press = useRef<{ timer: number; x: number; y: number; start: () => void } | null>(null)
  const rects = useRef<{ top: number; h: number }[]>([])
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current
      if (!p) return
      const d = dragRef.current
      if (!d) {
        // 누른 채 위아래로 움직이면 기다리지 않고 바로 끌기 시작
        if (Math.abs(e.clientY - p.y) <= 4) return
        clearTimeout(p.timer)
        p.start()
      }
      const cur = dragRef.current
      if (!cur) return
      e.preventDefault()
      const dy = e.clientY - p.y
      const r = rects.current[cur.from]
      const center = r.top + dy + r.h / 2
      let to = 0
      rects.current.forEach((x, i) => {
        if (i !== cur.from && x.top + x.h / 2 < center) to++
      })
      const next = { ...cur, dy, to }
      dragRef.current = next
      setDrag(next)
    }
    const up = () => {
      const p = press.current
      if (!p) return
      clearTimeout(p.timer)
      press.current = null
      setPressing(null)
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      setDrag(null)
      // 끌기를 마친 직후 따라오는 click(제목 버튼 등)은 삼킨다
      const swallow = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      if (d.to !== d.from) {
        const next = ids.filter((x) => x !== d.id)
        next.splice(d.to, 0, d.id)
        onReorder(next)
      }
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [ids, onReorder])

  const shift = (i: number): number => {
    if (!drag) return 0
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.h
    if (drag.from > drag.to && i >= drag.to && i < drag.from) return drag.h
    return 0
  }

  const bind = (id: string) => {
    const i = ids.indexOf(id)
    const lifted = drag?.id === id
    return {
      'data-id': id,
      className: `${lifted ? 'dragging' : ''} ${pressing === id ? 'pressing' : ''}`,
      style: drag ? { transform: `translateY(${lifted ? drag.dy : shift(i)}px)`, transition: lifted ? 'none' : undefined } : undefined,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('input, select, textarea')) return
        const start = () => {
          if (dragRef.current) return
          const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('tr[data-id]') ?? [])
          rects.current = rows.map((r) => {
            const b = r.getBoundingClientRect()
            return { top: b.top, h: b.height }
          })
          const from = ids.indexOf(id)
          if (from < 0 || !rects.current[from]) return
          setPressing(null)
          const d = { id, from, to: from, dy: 0, h: rects.current[from].h }
          dragRef.current = d
          setDrag(d)
        }
        press.current = { timer: window.setTimeout(start, LONG_PRESS_MS), x: e.clientX, y: e.clientY, start }
        setPressing(id)
      }
    }
  }

  return { bodyRef, bind, dragging: !!drag }
}

type RowBind = ReturnType<ReturnType<typeof useLongPressReorder>['bind']>

function TaskGroup({
  title,
  list,
  onReorder,
  children
}: {
  title: string
  list: Task[]
  onReorder: (ids: string[]) => void
  children: (t: Task, bind: RowBind) => ReactNode
}) {
  // 저장이 끝나 목록이 다시 읽힐 때까지 바뀐 순서를 먼저 보여준다
  const [override, setOverride] = useState<string[] | null>(null)
  const sig = list.map((t) => `${t.id}:${t.order ?? ''}:${t.status}`).join(',')
  useEffect(() => setOverride(null), [sig])
  const ordered = override ? (override.map((id) => list.find((t) => t.id === id)).filter(Boolean) as Task[]) : list
  const ids = useMemo(() => ordered.map((t) => t.id), [ordered.map((t) => t.id).join(',')])
  const commit = useCallback(
    (next: string[]) => {
      setOverride(next)
      onReorder(next)
    },
    [onReorder]
  )
  const { bodyRef, bind, dragging } = useLongPressReorder(ids, commit)
  return (
    <div className="group">
      <h4>
        {title} <span className="muted small">{list.length}</span>
      </h4>
      <table className={`table reorderable ${dragging ? 'is-dragging' : ''}`}>
        <tbody ref={bodyRef}>{ordered.map((t) => children(t, bind(t.id)))}</tbody>
      </table>
    </div>
  )
}
