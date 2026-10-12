import { useCallback, useEffect, useState } from 'react'
import { api, on, type Dashboard as DashboardData, type Project } from './api'
import { ChangeDialog, Modal, Toasts, errorToast, toast } from './ui'
import Start from './pages/Start'
import Dashboard from './pages/Dashboard'
import Domains from './pages/Domains'
import Reviews from './pages/Reviews'
import Tasks from './pages/Tasks'
import Verification from './pages/Verification'
import Drift from './pages/Drift'
import KnowledgePage from './pages/Knowledge'
import GraphPage from './pages/Graph'
import Settings from './pages/Settings'
import Terminals from './pages/Terminals'

export type Page = 'dashboard' | 'domains' | 'reviews' | 'tasks' | 'verification' | 'drift' | 'knowledge' | 'graph' | 'terminal' | 'settings'

const NAV: { id: Page; label: string; badge?: (d: DashboardData) => number }[] = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'domains', label: '도메인', badge: (d) => d.pendingRequests },
  { id: 'reviews', label: '변경 검토', badge: (d) => d.pendingReviews },
  { id: 'tasks', label: '할 일', badge: (d) => d.inbox + d.dueTasks.length },
  { id: 'verification', label: '테스트', badge: (d) => d.lastRun?.failed ?? 0 },
  { id: 'drift', label: '도메인 점검', badge: (d) => (d.driftDue ? d.pendingSessions : 0) },
  { id: 'knowledge', label: '지식' },
  { id: 'graph', label: '관계도' },
  { id: 'terminal', label: '터미널' },
  { id: 'settings', label: '프로젝트 설정' }
]

export interface PageProps {
  refreshKey: number
  go: (page: Page, focus?: string) => void
  focus?: string
  reloadBadges: () => void
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null)
  const [page, setPage] = useState<Page>('dashboard')
  const [focus, setFocus] = useState<string | undefined>()
  const [refreshKey, setRefreshKey] = useState(0)
  const [badges, setBadges] = useState<DashboardData | null>(null)
  const [capture, setCapture] = useState(false)

  const reloadBadges = useCallback(() => {
    if (project) api.dashboard().then(setBadges).catch(() => {})
  }, [project])

  useEffect(() => {
    api.currentProject().then(setProject).catch(errorToast)
  }, [])

  useEffect(() => {
    reloadBadges()
  }, [reloadBadges, refreshKey, page])

  useEffect(() => {
    const offFiles = on('files-changed', () => setRefreshKey((k) => k + 1))
    const offCapture = on('quick-capture', () => setCapture(true))
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') setCapture(true)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offFiles()
      offCapture()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const go = (p: Page, f?: string) => {
    setPage(p)
    setFocus(f)
  }

  if (!project) {
    return (
      <>
        <Start onOpen={setProject} />
        <Toasts />
      </>
    )
  }

  const props: PageProps = { refreshKey, go, focus, reloadBadges: () => setRefreshKey((k) => k + 1) }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          Girsktop
          <small title={project.projectDir}>{project.settings.name}</small>
        </div>
        <nav>
          {NAV.map((n) => {
            const count = badges && n.badge ? n.badge(badges) : 0
            return (
              <button key={n.id} className={page === n.id ? 'on' : ''} onClick={() => go(n.id)}>
                {n.label}
                {count > 0 && <span className="count">{count}</span>}
              </button>
            )
          })}
        </nav>
        <div className="side-foot">
          <button onClick={() => setCapture(true)} title="Ctrl+Shift+Space">
            + 빠른 기록
          </button>
          <button
            className="ghost"
            onClick={async () => {
              await api.closeProject()
              setProject(null)
            }}
          >
            프로젝트 닫기
          </button>
        </div>
      </aside>
      <main className="main">
        {page === 'dashboard' && <Dashboard {...props} />}
        {page === 'domains' && <Domains {...props} />}
        {page === 'reviews' && <Reviews {...props} />}
        {page === 'tasks' && <Tasks {...props} />}
        {page === 'verification' && <Verification {...props} />}
        {page === 'drift' && <Drift {...props} />}
        {page === 'knowledge' && <KnowledgePage {...props} />}
        {page === 'graph' && <GraphPage {...props} />}
        {page === 'settings' && <Settings {...props} onSaved={() => api.currentProject().then(setProject)} />}
        <Terminals visible={page === 'terminal'} />
      </main>
      {capture && <QuickCapture onClose={() => setCapture(false)} onSaved={() => setRefreshKey((k) => k + 1)} />}
      <ChangeDialog />
      <Toasts />
    </div>
  )
}

/** TK-F01: 한 줄 입력 → Inbox 저장. 분류 입력 없음. */
function QuickCapture({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('')
  const save = async () => {
    if (!text.trim()) return
    try {
      await api.addInbox(text)
      toast('Inbox에 저장했습니다')
      onSaved()
      onClose()
    } catch (e) {
      errorToast(e)
    }
  }
  return (
    <Modal title="빠른 기록" onClose={onClose}>
      <input
        autoFocus
        value={text}
        placeholder="나중에 할 일 한 줄 (Enter로 저장, 분류는 나중에)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onClose()
        }}
      />
    </Modal>
  )
}
