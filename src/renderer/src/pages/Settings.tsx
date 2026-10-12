import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { HarnessTarget, ProjectSettings } from '../types'
import { errorToast, toast, useLoad } from '../ui'

export default function Settings({ onSaved }: PageProps & { onSaved: () => void }) {
  const [project] = useLoad(() => api.currentProject(), [])
  const [s, setS] = useState<ProjectSettings | null>(null)
  useEffect(() => {
    if (project) setS(project.settings)
  }, [project])
  if (!s || !project) return null
  const set = (p: Partial<ProjectSettings>) => setS({ ...s, ...p })
  const toggle = (t: HarnessTarget) => set({ harnessTargets: s.harnessTargets.includes(t) ? s.harnessTargets.filter((x) => x !== t) : [...s.harnessTargets, t] })

  return (
    <div className="page narrow-page">
      <h2>설정</h2>
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
      <div className="field">
        <label>하네스 대상</label>
        <div className="row">
          <label className="chip">
            <input type="checkbox" checked={s.harnessTargets.includes('claude')} onChange={() => toggle('claude')} /> Claude Code
          </label>
          <label className="chip">
            <input type="checkbox" checked={s.harnessTargets.includes('codex')} onChange={() => toggle('codex')} /> Codex
          </label>
        </div>
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
