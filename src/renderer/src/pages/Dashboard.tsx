import { api } from '../api'
import type { Page, PageProps } from '../App'
import { Empty, useLoad } from '../ui'
import { Logo } from '../Logo'

interface Item {
  label: string
  value: number | string
  hint: string
  page: Page
  /** 0보다 크면 "확인할 것"으로 위에 올린다 */
  attention: number
}

export default function Dashboard({ refreshKey, go }: PageProps) {
  const [d] = useLoad(() => api.dashboard(), [refreshKey])
  if (!d) return null
  const items: Item[] = [
    { label: '변경 검토', value: d.pendingReviews, hint: '위 층이 크게 바뀌어 확인할 아래 문서', page: 'reviews', attention: d.pendingReviews },
    { label: '낡은 기능 명세', value: d.staleSpecs.length, hint: '기준 도메인에 큰 변경이 있음', page: 'domains', attention: d.staleSpecs.length },
    { label: 'Inbox', value: d.inbox, hint: '분류하지 않은 할 일', page: 'tasks', attention: d.inbox },
    { label: '시기 도래', value: d.dueTasks.length, hint: '기한이 지났거나 트리거 충족', page: 'tasks', attention: d.dueTasks.length },
    { label: '도메인 변경 요청', value: d.pendingRequests, hint: '도메인 점검·할 일에서 온 요청', page: 'domains', attention: d.pendingRequests },
    {
      label: '검토할 대화',
      value: d.pendingSessions,
      hint: d.driftDue ? '검토 주기가 지났습니다' : '지난 검토 이후 세션',
      page: 'drift',
      attention: d.driftDue ? d.pendingSessions : 0
    },
    {
      label: '실패한 테스트',
      value: d.lastRun?.failed ?? 0,
      hint: d.lastRun ? `${d.lastRun.passed}/${d.lastRun.total} 통과, ${new Date(d.lastRun.at).toLocaleString()}` : '',
      page: 'verification',
      attention: d.lastRun?.failed ?? 0
    }
  ]
  const todo = items.filter((i) => i.attention > 0)
  const stats: { label: string; value: number | string; page: Page }[] = [
    { label: '진행 중 Task', value: d.openTasks, page: 'tasks' },
    { label: '테스트 통과', value: d.lastRun ? `${d.lastRun.passed}/${d.lastRun.total}` : '-', page: 'verification' },
    ...items.filter((i) => i.attention === 0 && i.label !== '실패한 테스트').map((i) => ({ label: i.label, value: i.value, page: i.page }))
  ]

  return (
    <div className="page">
      <div className="dash">
        <div className="dash-head">
          <h2>대시보드</h2>
          <span className="muted small">{todo.length > 0 ? `확인할 것 ${todo.length}가지` : '확인할 것이 없습니다'}</span>
        </div>

        {todo.length > 0 ? (
          <div className="attention">
            {todo.map((i) => (
              <button key={i.label} className="attention-row" onClick={() => go(i.page)}>
                <span className="attention-num">{i.value}</span>
                <span className="attention-text">
                  <span className="attention-label">{i.label}</span>
                  <span className="muted small">{i.hint}</span>
                </span>
                <span className="attention-go">열기</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="calm">
            <Logo size={20} />
            도메인, 기능 명세, 설계, 테스트가 서로 맞습니다.
          </div>
        )}

        <div className="stats">
          {stats.map((s) => (
            <button key={s.label} className="stat" onClick={() => go(s.page)}>
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </button>
          ))}
        </div>

        <h3 className="section-title">
          지금 할 때인 Task <span className="muted small">{d.dueTasks.length > 0 ? d.dueTasks.length : ''}</span>
        </h3>
        {d.dueTasks.length === 0 ? (
          <Empty>시기가 된 Task가 없습니다</Empty>
        ) : (
          <ul className="due-list">
            {d.dueTasks.map((t) => (
              <li key={t.id}>
                <button className="link" onClick={() => go('tasks', t.id)}>
                  {t.title}
                </button>
                <span className="muted small">
                  {t.type} · {t.horizon} {t.due ? `· 기한 ${String(t.due).slice(0, 10)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
