import { useEffect, useState } from 'react'
import { api, on } from './api'
import type { UpdateSettings, UpdateStatus } from '../../core/update'
import { Modal, errorToast } from './ui'
import { Markdown } from './Markdown'

const STATE_LABEL: Record<UpdateStatus['state'], string> = {
  dev: '개발 실행 중 — 업데이트는 설치판에서만 동작합니다',
  idle: '아직 확인하지 않았습니다',
  checking: '새 버전을 확인하는 중…',
  available: '새 버전이 있습니다',
  'not-available': '최신 버전입니다',
  downloading: '내려받는 중…',
  downloaded: '설치 준비가 됐습니다. 재시작하면 새 버전으로 바뀝니다',
  error: '업데이트 확인에 실패했습니다 (앱은 그대로 쓸 수 있습니다)'
}

function size(bytes?: number) {
  return bytes == null ? '' : `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** PL-F04: 사이드바의 버전 표시 + 업데이트 창. 새 버전이 있으면 배지로 알린다. */
export default function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [settings, setSettings] = useState<UpdateSettings | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api.updateStatus().then(setStatus).catch(() => {})
    api.updateSettings().then(setSettings).catch(() => {})
    return on('update-status', setStatus)
  }, [])

  if (!status) return null
  const ready = status.state === 'downloaded'
  const hasNew = status.state === 'available' || status.state === 'downloading' || ready

  const run = (fn: () => Promise<unknown>) => () => fn().catch(errorToast)
  const saveSettings = async (next: Partial<UpdateSettings>) => {
    if (!settings) return
    try {
      setSettings(await api.saveUpdateSettings({ ...settings, ...next }))
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <>
      <button className={`version-btn ${hasNew ? 'has-update' : ''}`} onClick={() => setOpen(true)} title="앱 업데이트">
        v{status.currentVersion}
        {hasNew && <span className="update-badge">{ready ? '재시작해서 업데이트' : '업데이트'}</span>}
      </button>
      {open && (
        <Modal title="앱 업데이트" onClose={() => setOpen(false)}>
          <div className="update-panel">
            <div className="row between">
              <span>
                지금 버전 <b>v{status.currentVersion}</b>
                {status.version && status.version !== status.currentVersion && (
                  <>
                    {' '}
                    → 새 버전 <b>v{status.version}</b>
                  </>
                )}
              </span>
              {status.checkedAt && <span className="muted small">확인 {new Date(status.checkedAt).toLocaleString()}</span>}
            </div>
            <div className={`update-state ${status.state}`}>{STATE_LABEL[status.state]}</div>
            {status.error && <div className="small muted mono">{status.error}</div>}
            {status.state === 'downloading' && (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${status.percent ?? 0}%` }} />
                <span className="small">
                  {status.percent ?? 0}% {status.total ? `(${size(status.transferred)} / ${size(status.total)})` : ''}
                </span>
              </div>
            )}
            {status.releaseNotes && (
              <details>
                <summary className="small">바뀐 점 보기</summary>
                {/* GitHub 릴리스 노트(HTML/md)는 걸러서 렌더링한다 */}
                <Markdown className="small" source={status.releaseNotes} />
              </details>
            )}
            <div className="row end">
              {status.state !== 'dev' && !ready && status.state !== 'downloading' && (
                <button onClick={run(api.updateCheck)} disabled={status.state === 'checking'}>
                  지금 확인
                </button>
              )}
              {status.state === 'available' && settings && !settings.autoDownload && (
                <button className="primary" onClick={run(api.updateDownload)}>
                  내려받기
                </button>
              )}
              {ready && (
                <button className="primary" onClick={run(api.updateInstall)}>
                  재시작해서 설치
                </button>
              )}
            </div>
            {settings && (
              <div className="update-settings">
                <label className="small">
                  <input type="checkbox" checked={settings.autoCheck} onChange={(e) => saveSettings({ autoCheck: e.target.checked })} /> 시작할 때와 6시간마다 새 버전 확인
                </label>
                <label className="small">
                  <input type="checkbox" checked={settings.autoDownload} onChange={(e) => saveSettings({ autoDownload: e.target.checked })} /> 새 버전이 있으면 바로 내려받기
                </label>
                <div className="muted small">받아둔 업데이트는 앱을 닫을 때도 자동으로 설치됩니다.</div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
