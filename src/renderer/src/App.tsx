import { Fragment, memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, on, type Dashboard as DashboardData, type Project } from './api'
import { ChangeDialog, Modal, Toasts, UndoBar, errorToast, toast } from './ui'
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
import UpdateButton from './UpdatePanel'
import { Logo } from './Logo'
import Automation from './pages/Automation'
import { AutomationProvider } from './Automation'

export type Page = 'dashboard' | 'domains' | 'reviews' | 'tasks' | 'verification' | 'drift' | 'knowledge' | 'graph' | 'terminal' | 'automation' | 'settings'

const NAV: { id: Page; label: string; group?: string; badge?: (d: DashboardData) => number }[] = [
  { id: 'dashboard', label: '대시보드', group: '작업' },
  { id: 'domains', label: '도메인' },
  { id: 'reviews', label: '변경 검토', badge: (d) => d.pendingReviews + d.pendingRequests },
  { id: 'tasks', label: '할 일', badge: (d) => d.inbox + d.dueTasks.length },
  { id: 'verification', label: '테스트', group: '확인', badge: (d) => d.lastRun?.failed ?? 0 },
  { id: 'drift', label: '도메인 점검', badge: (d) => (d.driftDue ? d.pendingSessions : 0) },
  { id: 'knowledge', label: '지식', group: '자료' },
  { id: 'graph', label: '관계도' },
  { id: 'automation', label: '자동화', group: '도구' },
  { id: 'terminal', label: '터미널' },
  { id: 'settings', label: '설정' }
]

export interface PageProps {
  refreshKey: number
  go: (page: Page, focus?: string) => void
  focus?: string
  reloadBadges: () => void
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null)
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem('orbit:last-page')
    return NAV.find((item) => item.id === saved)?.id ?? 'dashboard'
  })
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
    const offError = on('project-error', (message: string) => errorToast(new Error(message)))
    const offTests = on('test-done', () => setRefreshKey((k) => k + 1))
    const offCapture = on('quick-capture', () => setCapture(true))
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') setCapture(true)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offFiles()
      offError()
      offTests()
      offCapture()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const go = (p: Page, f?: string) => {
    setPage(p)
    localStorage.setItem('orbit:last-page', p)
    setFocus(f)
  }

  if (!project) {
    return (
      <>
        <Start onOpen={setProject} />
        <div className="start-version">
          <UpdateButton />
        </div>
        <Toasts />
        <UndoBar />
      </>
    )
  }

  const props: PageProps = { refreshKey, go, reloadBadges: () => setRefreshKey((k) => k + 1) }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-name">
            <Logo size={22} /> {project.settings.name || 'Orbit'}
          </span>
          <small title={project.projectDir}>{project.projectDir.split(/[\\/]/).pop()}</small>
        </div>
        <nav>
          {NAV.map((n) => {
            const count = badges && n.badge ? n.badge(badges) : 0
            return (
              <Fragment key={n.id}>
                {n.group && <div className="nav-group">{n.group}</div>}
                <button className={page === n.id ? 'on' : ''} onClick={() => go(n.id)}>
                  {n.label}
                  {count > 0 && <span className="count">{count}</span>}
                </button>
              </Fragment>
            )
          })}
        </nav>
        <div className="side-foot">
          <UpdateButton />
          <button className="ghost" onClick={() => setCapture(true)} title="Ctrl+Shift+Space">
            + 할 일 추가
          </button>
          <button
            className="ghost"
            onClick={async () => {
              await api.closeProject()
              setFocus(undefined)
              setProject(null)
            }}
          >
            프로젝트 닫기
          </button>
        </div>
      </aside>
      <main className="main" key={project.projectDir}>
        <AutomationProvider go={go}>
        <PageView visible={page === 'dashboard'}><Dashboard {...props} /></PageView>
        <PageView visible={page === 'domains'}><Domains {...props} focus={page === 'domains' ? focus : undefined} /></PageView>
        <PageView visible={page === 'reviews'}><Reviews {...props} focus={page === 'reviews' ? focus : undefined} /></PageView>
        <PageView visible={page === 'tasks'}><Tasks {...props} focus={page === 'tasks' ? focus : undefined} /></PageView>
        <PageView visible={page === 'verification'}><Verification {...props} /></PageView>
        <PageView visible={page === 'drift'}><Drift {...props} /></PageView>
        <PageView visible={page === 'knowledge'}><KnowledgePage {...props} /></PageView>
        <PageView visible={page === 'graph'}><GraphPage {...props} /></PageView>
        <PageView visible={page === 'settings'}><Settings {...props} onSaved={() => api.currentProject().then(setProject)} /></PageView>
        <PageView visible={page === 'automation'}><Automation {...props} focus={page === 'automation' ? focus : undefined} /></PageView>
        <Terminals visible={page === 'terminal'} focus={page === 'terminal' ? focus : undefined} onGraphs={() => go('automation', 'graphs')} />
        </AutomationProvider>
      </main>
      {capture && <QuickCapture onClose={() => setCapture(false)} onSaved={() => setRefreshKey((k) => k + 1)} />}
      <ChangeDialog />
      <Toasts />
      <UndoBar />
    </div>
  )
}

/** PL-F01-AC3: 처음 연 화면만 유지한다. 숨긴 화면의 데이터 갱신은 다시 볼 때 반영한다. */
const PageView = memo(function PageView({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(visible)
  useEffect(() => { if (visible) setOpened(true) }, [visible])
  return visible || opened ? <div className="page-view" hidden={!visible}>{children}</div> : null
}, (previous, next) => !previous.visible && !next.visible)

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
    <Modal title="할 일 추가" onClose={onClose}>
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
