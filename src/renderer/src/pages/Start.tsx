import { api, type Project } from '../api'
import { errorToast, useLoad } from '../ui'

export default function Start({ onOpen }: { onOpen: (p: Project) => void }) {
  const [recent] = useLoad(() => api.recentProjects(), [])

  const open = async (dir?: string | null) => {
    const target = dir ?? (await api.pickFolder())
    if (!target) return
    try {
      onOpen(await api.openProject(target))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('찾을 수 없습니다') && confirm(`${target}\n\nGirsktop 프로젝트가 아닙니다. 이 폴더를 새 프로젝트로 만들까요?`)) {
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

  return (
    <div className="start">
      <div className="start-card">
        <h1>Girsktop</h1>
        <p className="muted">도메인 → 기능 명세 → 설계 → 검증을 한곳에서. 위 층이 바뀌면 아래 층에 확인표시를 띄웁니다.</p>
        <div className="row">
          <button className="primary" onClick={() => open()}>
            프로젝트 폴더 열기
          </button>
          <button onClick={() => create()}>새 프로젝트 만들기</button>
        </div>
        {recent && recent.length > 0 && (
          <>
            <h4>최근 프로젝트</h4>
            <ul className="list">
              {recent.map((r) => (
                <li key={r}>
                  <button className="link" onClick={() => open(r)}>
                    {r}
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
