import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { ProjectSettings } from '../types'
import type { ThemeMode } from '../../../core/theme'
import { errorToast, toast, useLoad } from '../ui'

const THEMES: [ThemeMode, string][] = [
  ['system', '시스템 설정 따라가기'],
  ['light', '밝게'],
  ['dark', '어둡게']
]

export default function Settings({ onSaved }: PageProps & { onSaved: () => void }) {
  const [project] = useLoad(() => api.currentProject(), [])
  const [s, setS] = useState<ProjectSettings | null>(null)
  const [themeMode, setThemeMode] = useState<ThemeMode | null>(null)
  useEffect(() => {
    api.themeMode().then(setThemeMode).catch(errorToast)
  }, [])
  const changeTheme = async (m: ThemeMode) => {
    setThemeMode(m)
    try {
      setThemeMode(await api.setThemeMode(m))
    } catch (e) {
      errorToast(e)
    }
  }
  useEffect(() => {
    if (project) setS(project.settings)
  }, [project])
  if (!s || !project) return null
  const set = (p: Partial<ProjectSettings>) => setS({ ...s, ...p })

  return (
    <div className="page narrow-page">
      <h2>설정</h2>
      <h3 className="settings-section">화면</h3>
      <div className="field">
        <label>테마 (이 컴퓨터의 Orbit 전체에 바로 적용)</label>
        <div className="seg">
          {THEMES.map(([m, label]) => (
            <button key={m} className={themeMode === m ? 'on' : ''} onClick={() => void changeTheme(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <h3 className="settings-section">프로젝트</h3>
      <div className="muted small">
        {project.projectDir} · 데이터 폴더 {project.dataRoot} {project.isGit ? '' : '· git 저장소 아님'}
      </div>
      <div className="field">
        <label>프로젝트 이름</label>
        <input value={s.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="grid2">
        <div className="field">
          <label>Drift 검토 주기 (일)</label>
          <input type="number" min={1} value={s.driftIntervalDays} onChange={(e) => set({ driftIntervalDays: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Inbox 정리 알림 시각</label>
          <input type="time" value={s.reminderTime} onChange={(e) => set({ reminderTime: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>테스트 명령 (JUnit XML을 만들어야 합니다)</label>
        <input className="mono" value={s.testCommand ?? ''} onChange={(e) => set({ testCommand: e.target.value })} placeholder="npx vitest run --reporter=junit --outputFile.junit=test-results/junit.xml" />
      </div>
      <div className="field">
        <label>JUnit 결과 파일 (프로젝트 기준 경로)</label>
        <input className="mono" value={s.junitPath ?? ''} onChange={(e) => set({ junitPath: e.target.value })} placeholder="test-results/junit.xml" />
      </div>
      <div className="field">
        <label>GitHub 저장소 (owner/repo)</label>
        <input value={s.githubRepo ?? ''} onChange={(e) => set({ githubRepo: e.target.value })} />
      </div>
      <div className="row end">
        <button
          className="primary"
          onClick={async () => {
            try {
              await api.saveSettings(s)
              toast('저장했습니다')
              onSaved()
            } catch (e) {
              errorToast(e)
            }
          }}
        >
          저장
        </button>
      </div>
    </div>
  )
}
