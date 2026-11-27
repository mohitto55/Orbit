import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, protocol, session, shell, net } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import { ProjectWindows } from './projectWindows'
import { AgentAccountStore } from './agentAccountStore'
import { probeAgentAccount } from './agentAccountProbe'
import { createUpdater } from './updater'
import { createTheme } from './theme'
import { createDialogApi } from './dialogs'
import type { Ctx } from '../core/workspace'
import { NotifyLog, afterTime } from '../core/notify'
import { documentImageResponse } from './documentImages'
import { SKILL_LOCATIONS } from '../core/skillLocations'

protocol.registerSchemesAsPrivileged([{ scheme: 'orbit-image', privileges: { standard: true, secure: true } }])

const windows = new Map<number, BrowserWindow>()
const windowSlots = new Map<number, number>()
const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? [...windows.values()].at(-1) ?? null

/** 앱 이름을 Girsktop → Orbit으로 바꾸면서 설정 위치가 바뀌었다. 예전 최근 프로젝트·업데이트 설정을 한 번 옮겨온다. */
function migrateOldSettings() {
  const oldDir = path.join(app.getPath('appData'), 'Girsktop')
  const newDir = app.getPath('userData')
  for (const name of ['recent.json', 'update-settings.json']) {
    const from = path.join(oldDir, name)
    const to = path.join(newDir, name)
    try {
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(newDir, { recursive: true })
        copyFileSync(from, to)
      }
    } catch {
      // 옮기지 못해도 새로 시작하면 된다
    }
  }
}
migrateOldSettings()
// 실행기를 하나만 두고 다시 실행할 때마다 독립된 창을 연다.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => { void app.whenReady().then(createWindow) })

function send(channel: string, payload: unknown) {
  for (const win of windows.values()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

function watch(ctx: Ctx, changed: () => void) {
  let timer: NodeJS.Timeout | null = null
  const watcher = chokidar.watch(ctx.dataRoot, {
    ignoreInitial: true,
    ignored: (p: string) => p.includes(`${path.sep}.cache`)
  })
  // WS-F05: 앱 밖에서 바뀐 md를 반영한다 (짧은 시간의 변경은 묶어서 한 번 알림)
  watcher.on('all', (_e, file) => {
    if (!file.endsWith('.md')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(changed, 300)
  })
  return () => { if (timer) clearTimeout(timer); void watcher.close().catch((error: unknown) => console.error('Orbit 파일 감시 종료 실패:', error)) }
}

const accounts = new AgentAccountStore(path.join(app.getPath('userData'), 'agent-accounts'), () => {
  send('accounts-changed', null)
  // 다른 창에서 로그인·정책·사용량이 바뀌어도 대기 중인 예약에 적용한다.
  for (const api of projects.all()) void api.recheckAccountSchedules()?.catch((error: unknown) => console.error('계정 변경 후 예약 확인 실패:', error))
}, (account) => probeAgentAccount(account, undefined, net.fetch))
const projects = new ProjectWindows({
  send: (id, channel, payload) => { const win = windows.get(id); if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload) },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(focusedWindow()!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  recentFile: path.join(app.getPath('userData'), 'recent.json'),
  watch, accounts
})

const updater = createUpdater({ send, userData: app.getPath('userData'), isPackaged: app.isPackaged, version: app.getVersion(), beforeInstall: cleanup })

const theme = createTheme({ userData: app.getPath('userData') })
const dialogs = createDialogApi(focusedWindow)

for (const name of projects.methods) ipcMain.handle(`api:${name}`, (event, ...args) => projects.invoke(event.sender.id, name, args))
for (const [name, fn] of Object.entries({ ...updater.api, ...theme.api, ...dialogs, newWindow: () => { createWindow() } })) {
  ipcMain.handle(`api:${name}`, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
}

/** 알림: 하루에 종류별로 한 번만 보낸다 (PL-F02). */
const notifyLog = new NotifyLog()
function notifyOnce(kind: string, title: string, body: string) {
  if (!Notification.isSupported() || !notifyLog.take(kind)) return
  new Notification({ title, body }).show()
}

async function checkReminders() {
  try {
    for (const api of projects.all()) {
      const project = await api.currentProject()
      if (!project) continue
      const d = await api.dashboard()
      if (d.inbox > 0 && afterTime(d.settings.reminderTime)) notifyOnce('inbox', 'Inbox 정리', `분류하지 않은 할 일이 ${d.inbox}개 있습니다`)
      if (d.dueTasks.length > 0) notifyOnce('due', '할 일 시기 도래', `${d.dueTasks.length}개의 Task가 지금 할 때입니다`)
      if (d.driftDue) notifyOnce('drift', '도메인 검토 요청', `검토하지 않은 작업 대화가 ${d.pendingSessions}개 있습니다`)
      if (d.pendingReviews > 0) notifyOnce('review', '확인 필요', `확인을 기다리는 항목이 ${d.pendingReviews}개 있습니다`)
    }
  } catch {
    // 알림 실패는 무시한다
  }
}

function createWindow() {
  // 창마다 이미지 경로와 화면 설정을 분리하되 다시 열어도 설정을 보존한다.
  let slot = 0
  while ([...windowSlots.values()].includes(slot)) slot++
  const windowSession = slot === 0 ? session.defaultSession : session.fromPartition(`persist:orbit-window-${slot}`)
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'Orbit',
    // 설치본은 electron-builder가 build/icon.* 으로 실행 파일 아이콘을 넣는다. 개발 중에는 창 아이콘만 직접 지정한다.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '../../build/icon.png') }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      session: windowSession,
      sandbox: false
    }
  })
  const id = win.webContents.id
  windows.set(id, win); windowSlots.set(id, slot); projects.register(id)
  windowSession.protocol.handle('orbit-image', async (request) => documentImageResponse(request.url, await projects.current(id), SKILL_LOCATIONS.map((location) => path.join(app.getPath('home'), `.${location}`, 'skills'))))
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => { windows.delete(id); windowSlots.delete(id); windowSession.protocol.unhandle('orbit-image'); void projects.closeWindow(id).catch((error: unknown) => console.error('창 종료 실패:', error)) })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

/** 개발용 스모크 확인: ORBIT_SMOKE=<프로젝트 폴더> 로 실행하면 열고, 화면을 캡처하고, 종료한다. */
async function smoke(win: BrowserWindow, dir: string, out?: string) {
  try {
    await projects.invoke(win.webContents.id, 'openProject', [dir])
    const api = projects.all()[0]
    if (process.env.ORBIT_SMOKE_RUNTESTS) {
      const run = await api.runTests()
      console.log('SMOKE_RUN', JSON.stringify({ total: run.total, passed: run.passed, failed: run.failed, error: run.error }))
    }
    win!.webContents.reload()
    await new Promise<void>((r) => win!.webContents.once('did-finish-load', () => r()))
    await new Promise((r) => setTimeout(r, 1500))
    // ORBIT_SMOKE_CLICK="도메인,기능 명세 표 (2층)" 처럼 버튼 텍스트를 차례로 누른다
    for (const label of (process.env.ORBIT_SMOKE_CLICK ?? '').split(',').filter(Boolean)) {
      await win!.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(label)}))?.click()`
      )
      await new Promise((r) => setTimeout(r, 1200))
    }
    if (process.env.ORBIT_SMOKE_JS) {
      const r = await win!.webContents.executeJavaScript(process.env.ORBIT_SMOKE_JS)
      console.log('SMOKE_JS', JSON.stringify(r))
    }
    const text = await win!.webContents.executeJavaScript('document.body.innerText')
    const dash = await api.dashboard()
    console.log('SMOKE_DASHBOARD', JSON.stringify({ ...dash, settings: undefined }))
    console.log('SMOKE_TEXT', JSON.stringify(text.slice(0, 600)))
    if (out) {
      const { writeFile } = await import('fs/promises')
      await writeFile(out, (await win!.webContents.capturePage()).toPNG())
    }
  } catch (e) {
    console.error('SMOKE_FAIL', e)
    process.exitCode = 1
  }
  app.quit()
}

app.whenReady().then(async () => {
  await theme.load()
  const win = createWindow()
  if (process.env.ORBIT_SMOKE) {
    win.webContents.once('did-finish-load', () => void smoke(win, process.env.ORBIT_SMOKE!, process.env.ORBIT_SMOKE_PNG))
    return
  }
  // TK-F01: 어디서나 할 일 추가
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    const win = focusedWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('quick-capture', null)
  })
  setInterval(checkReminders, 10 * 60 * 1000)
  setTimeout(checkReminders, 15 * 1000)
  void updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  globalShortcut.unregisterAll()
  // 종료 중 저장/PTY 오류가 Electron 오류 대화상자를 띄워 숨은 앱을 남기지 않게 한다.
  projects.shutdown()
}
app.on('before-quit', cleanup)
app.on('will-quit', cleanup)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
