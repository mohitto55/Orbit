import { api } from '../api'
import type { PageProps } from '../App'
import { Empty, useLoad } from '../ui'

export default function Dashboard({ refreshKey, go }: PageProps) {
  const [d] = useLoad(() => api.dashboard(), [refreshKey])
  if (!d) return null
  const cards = [
    { label: '확인 필요', value: d.pendingReviews, hint: '위 층 큰 변경으로 생긴 확인표시', page: 'reviews' as const, warn: d.pendingReviews > 0 },
    { label: '낡은 기능 명세', value: d.staleSpecs.length, hint: '기준 도메인에 큰 변경이 있음', page: 'domains' as const, warn: d.staleSpecs.length > 0 },
    { label: 'Inbox', value: d.inbox, hint: '분류하지 않은 할 일', page: 'tasks' as const, warn: d.inbox > 0 },
    { label: '시기 도래', value: d.dueTasks.length, hint: '기한이 지났거나 트리거 충족', page: 'tasks' as const, warn: d.dueTasks.length > 0 },
    { label: '진행 중 Task', value: d.openTasks, hint: '대기 + 진행', page: 'tasks' as const },
    { label: '도메인 변경 요청', value: d.pendingRequests, hint: 'Drift·Task에서 온 요청', page: 'domains' as const, warn: d.pendingRequests > 0 },
    { label: '검토할 대화', value: d.pendingSessions, hint: d.driftDue ? '검토 주기가 지났습니다' : '지난 검토 이후 세션', page: 'drift' as const, warn: d.driftDue },
    {
      label: '테스트',
      value: d.lastRun ? `${d.lastRun.passed}/${d.lastRun.total}` : '-',
      hint: d.lastRun ? `실패 ${d.lastRun.failed} · ${new Date(d.lastRun.at).toLocaleString()}` : '아직 실행하지 않음',
      page: 'verification' as const,
      warn: (d.lastRun?.failed ?? 0) > 0
    }
  ]
  return (
    <div className="page">
      <h2>대시보드</h2>
      <div className="cards">
        {cards.map((c) => (
          <button key={c.label} className={`card ${c.warn ? 'warn' : ''}`} onClick={() => go(c.page)}>
            <div className="card-value">{c.value}</div>
            <div className="card-label">{c.label}</div>
            <div className="muted small">{c.hint}</div>
          </button>
        ))}
      </div>
      <h3>지금 할 때인 Task</h3>
      {d.dueTasks.length === 0 ? (
        <Empty>시기가 된 Task가 없습니다</Empty>
      ) : (
        <ul className="list">
          {d.dueTasks.map((t) => (
            <li key={t.id}>
              <button className="link" onClick={() => go('tasks', t.id)}>
                {t.title}
              </button>{' '}
              <span className="muted small">
                {t.type} · {t.horizon} {t.due ? `· 기한 ${String(t.due).slice(0, 10)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
