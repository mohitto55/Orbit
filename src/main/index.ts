import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { createApi } from './api'
import { createAiCheckApi } from './aiCheckApi'
import { createUpdater } from './updater'
import { createTheme } from './theme'
import type { Ctx } from '../core/workspace'
import { NotifyLog, afterTime } from '../core/notify'

let win: BrowserWindow | null = null

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
let watcher: FSWatcher | null = null

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

function watch(ctx: Ctx) {
  void watcher?.close()
  let timer: NodeJS.Timeout | null = null
  watcher = chokidar.watch(ctx.dataRoot, {
    ignoreInitial: true,
    ignored: (p: string) => p.includes(`${path.sep}.cache`)
  })
  // WS-F05: 앱 밖에서 바뀐 md를 반영한다 (짧은 시간의 변경은 묶어서 한 번 알림)
  watcher.on('all', (_e, file) => {
    if (!file.endsWith('.md')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => send('files-changed', null), 300)
  })
}

const api = createApi({
  send,
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  recentFile: path.join(app.getPath('userData'), 'recent.json'),
  onProjectOpened: watch
})

const aiCheckApi = createAiCheckApi({
  send,
  getCtx: async () => {
    const p = await api.currentProject()
    return p ? { projectDir: p.projectDir, dataRoot: p.dataRoot } : null
  }
})

const updater = createUpdater({ send, userData: app.getPath('userData'), isPackaged: app.isPackaged, version: app.getVersion() })

const theme = createTheme({ userData: app.getPath('userData') })

for (const [name, fn] of Object.entries({ ...api, ...aiCheckApi, ...updater.api, ...theme.api })) {
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
    const project = await api.currentProject()
    if (!project) return
    const d = await api.dashboard()
    if (d.inbox > 0 && afterTime(d.settings.reminderTime)) notifyOnce('inbox', 'Inbox 정리', `분류하지 않은 할 일이 ${d.inbox}개 있습니다`)
    if (d.dueTasks.length > 0) notifyOnce('due', '할 일 시기 도래', `${d.dueTasks.length}개의 Task가 지금 할 때입니다`)
    if (d.driftDue) notifyOnce('drift', '도메인 검토 요청', `검토하지 않은 작업 대화가 ${d.pendingSessions}개 있습니다`)
    if (d.pendingReviews > 0) notifyOnce('review', '확인 필요', `확인을 기다리는 항목이 ${d.pendingReviews}개 있습니다`)
  } catch {
    // 알림 실패는 무시한다
  }
}

function createWindow() {
  win = new BrowserWindow({
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
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/** 개발용 스모크 확인: ORBIT_SMOKE=<프로젝트 폴더> 로 실행하면 열고, 화면을 캡처하고, 종료한다. */
async function smoke(dir: string, out?: string) {
  try {
    await api.openProject(dir)
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
  createWindow()
  if (process.env.ORBIT_SMOKE) {
    win!.webContents.once('did-finish-load', () => void smoke(process.env.ORBIT_SMOKE!, process.env.ORBIT_SMOKE_PNG))
    return
  }
  // TK-F01: 어디서나 할 일 추가
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('quick-capture', null)
  })
  setInterval(checkReminders, 10 * 60 * 1000)
  setTimeout(checkReminders, 15 * 1000)
  void updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  api.killAllTerminals()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
