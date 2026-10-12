import { api, type Project } from '../api'
import { errorToast, useLoad } from '../ui'
import { Logo } from '../Logo'

export default function Start({ onOpen }: { onOpen: (p: Project) => void }) {
  const [recent] = useLoad(() => api.recentProjects(), [])

  const open = async (dir?: string | null) => {
    const target = dir ?? (await api.pickFolder())
    if (!target) return
    try {
      onOpen(await api.openProject(target))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('찾을 수 없습니다') && confirm(`${target}\n\nOrbit 프로젝트가 아닙니다. 이 폴더를 새 프로젝트로 만들까요?`)) {
        await create(target)
      } else errorToast(e)
    }
  }

  const create = async (dir?: string | null) => {
    const target = dir ?? (await api.pickFolder())
    if (!target) return
    try {
      onOpen(await api.createProject(target))
    } catch (e) {
      errorToast(e)
    }
  }

  // 같은 폴더가 구분자만 달리 두 번 기록된 경우가 있어 한 번만 보여준다
  const seen = new Set<string>()
  const projects = (recent ?? []).filter((r) => {
    const key = r.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return (
    <div className="start">
      <div className="start-card">
        <h1 className="brand-name">
          <Logo size={36} /> Orbit
        </h1>
        <p className="start-lead">도메인, 기능 명세, 설계, 테스트를 한곳에서 관리합니다. 위 층이 바뀌면 아래 층에 확인할 곳을 표시합니다.</p>
        <div className="start-actions">
          <button className="primary" onClick={() => open()}>
            프로젝트 폴더 열기
          </button>
          <button onClick={() => create()}>새 프로젝트 만들기</button>
        </div>
        {projects.length > 0 && (
          <>
            <h4>최근 프로젝트</h4>
            <ul className="recent">
              {projects.map((r) => (
                <li key={r}>
                  <button onClick={() => open(r)} title={r}>
                    <span className="recent-name">{r.split(/[\\/]/).filter(Boolean).pop()}</span>
                    <span className="recent-path">{r}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
