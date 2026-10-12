import { promises as fs } from 'fs'
import path from 'path'
import {
  DEFAULT_UPDATE_SETTINGS,
  notesText,
  reduceUpdate,
  shouldAutoCheck,
  type UpdateEvent,
  type UpdateSettings,
  type UpdateStatus
} from '../core/update'

type AutoUpdater = typeof import('electron-updater').autoUpdater

/** PL-F04: GitHub Releases 기반 자동 업데이트. 설치판에서만 동작하고, 실패해도 앱은 계속 동작한다. */
export function createUpdater(deps: { send: (channel: string, payload: unknown) => void; userData: string; isPackaged: boolean; version: string }) {
  const settingsFile = path.join(deps.userData, 'update-settings.json')
  let settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS }
  let status: UpdateStatus = { state: deps.isPackaged ? 'idle' : 'dev', currentVersion: deps.version }
  let updater: AutoUpdater | null = null

  const emit = (e: UpdateEvent) => {
    status = reduceUpdate(status, e)
    deps.send('update-status', status)
  }

  async function load() {
    try {
      settings = { ...DEFAULT_UPDATE_SETTINGS, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) }
    } catch {
      // 설정 파일이 없으면 기본값
    }
  }

  async function getUpdater(): Promise<AutoUpdater | null> {
    if (!deps.isPackaged) return null
    if (updater) return updater
    // CJS 모듈을 동적으로 불러오면 내보낸 값이 default 안에 들어간다
    const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') }
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!autoUpdater) throw new Error('electron-updater를 불러오지 못했습니다')
    autoUpdater.autoDownload = settings.autoDownload
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
    autoUpdater.on('update-available', (i) => emit({ type: 'available', version: i.version, releaseNotes: notesText(i.releaseNotes) }))
    autoUpdater.on('update-not-available', () => emit({ type: 'not-available' }))
    autoUpdater.on('download-progress', (p) => emit({ type: 'progress', percent: p.percent, transferred: p.transferred, total: p.total }))
    autoUpdater.on('update-downloaded', (i) => emit({ type: 'downloaded', version: i.version }))
    autoUpdater.on('error', (e) => emit({ type: 'error', message: e?.message ?? String(e) }))
    updater = autoUpdater
    return updater
  }

  async function check() {
    const u = await getUpdater()
    if (!u) return status
    try {
      await u.checkForUpdates()
    } catch (e) {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
    return status
  }

  return {
    /** 앱 시작 시 호출: 자동 확인이 켜져 있으면 지금 확인하고, 이후 1시간마다 주기를 살핀다 */
    async start() {
      await load()
      const tick = () => {
        if (shouldAutoCheck(settings, status)) void check()
      }
      tick()
      setInterval(tick, 60 * 60 * 1000)
    },
    api: {
      updateStatus: () => status,
      updateCheck: () => check(),
      async updateDownload() {
        const u = await getUpdater()
        if (!u) return status
        try {
          await u.downloadUpdate()
        } catch (e) {
          emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        }
        return status
      },
      /** 받아둔 업데이트를 설치하고 앱을 다시 연다 */
      async updateInstall() {
        const u = await getUpdater()
        if (u && status.state === 'downloaded') setImmediate(() => u.quitAndInstall())
      },
      updateSettings: () => settings,
      async saveUpdateSettings(next: UpdateSettings) {
        settings = { ...settings, ...next }
        if (updater) updater.autoDownload = settings.autoDownload
        await fs.mkdir(path.dirname(settingsFile), { recursive: true })
        await fs.writeFile(settingsFile, JSON.stringify(settings), 'utf8')
        return settings
      }
    }
  }
}

export type UpdaterApi = ReturnType<typeof createUpdater>['api']
