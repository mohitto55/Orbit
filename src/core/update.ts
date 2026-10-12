/** 앱 기반: 자동 업데이트 상태. electron-updater 이벤트를 화면에 보여줄 상태로 바꾼다. */

export type UpdateState =
  | 'dev' // 개발 실행: 업데이트는 설치판에서만
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** 새 버전 */
  version?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  error?: string
  checkedAt?: string
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

export interface UpdateSettings {
  /** 시작할 때와 주기적으로 새 버전을 확인한다 */
  autoCheck: boolean
  /** 새 버전이 있으면 바로 내려받는다 (끄면 사람이 "내려받기"를 누른다) */
  autoDownload: boolean
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true, autoDownload: true }
export const CHECK_INTERVAL_HOURS = 6

export function reduceUpdate(s: UpdateStatus, e: UpdateEvent, now = new Date()): UpdateStatus {
  const base = { currentVersion: s.currentVersion }
  switch (e.type) {
    case 'checking':
      // 이미 받아둔 업데이트가 있으면 다시 확인해도 "설치 준비됨"을 잃지 않는다
      return s.state === 'downloaded' ? s : { ...base, state: 'checking', checkedAt: s.checkedAt }
    case 'available':
      return { ...base, state: 'available', version: e.version, releaseNotes: e.releaseNotes, checkedAt: now.toISOString() }
    case 'not-available':
      return { ...base, state: 'not-available', checkedAt: now.toISOString() }
    case 'progress':
      return { ...s, state: 'downloading', percent: Math.round(e.percent), transferred: e.transferred, total: e.total }
    case 'downloaded':
      return { ...s, state: 'downloaded', version: e.version, percent: 100 }
    case 'error':
      // 실패해도 앱은 계속 동작한다. 받아둔 업데이트는 그대로 둔다
      return s.state === 'downloaded' ? { ...s, error: e.message } : { ...s, state: 'error', error: e.message, checkedAt: now.toISOString() }
  }
}

/** 자동 확인할 때인가: 켜져 있고, 마지막 확인 후 주기가 지났을 때 */
export function shouldAutoCheck(settings: UpdateSettings, status: UpdateStatus, now = new Date(), hours = CHECK_INTERVAL_HOURS): boolean {
  if (!settings.autoCheck || status.state === 'dev') return false
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'downloaded') return false
  if (!status.checkedAt) return true
  return now.getTime() - new Date(status.checkedAt).getTime() >= hours * 3600 * 1000
}

/** 릴리스 노트는 문자열 또는 [{version, note}] 배열로 온다 */
export function notesText(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) return notes.map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note ?? '') : '')).join('\n\n')
  return undefined
}
