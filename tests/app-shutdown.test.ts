import { EventEmitter } from 'events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { TerminalManager } from '../src/core/terminal'

const mocks = vi.hoisted(() => ({ kill: vi.fn(), unregister: vi.fn(), quit: vi.fn(), beforeInstall: undefined as (() => void) | undefined }))
vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), { getPath: () => '/orbit-test-does-not-exist', getVersion: () => '0.0.0', whenReady: () => new Promise<void>(() => {}), quit: mocks.quit }),
  BrowserWindow: class {}, dialog: {}, globalShortcut: { unregisterAll: mocks.unregister }, ipcMain: { handle() {} }, Notification: {}, shell: {}
}))
vi.mock('../src/main/api', () => ({ createApi: () => ({ killAllTerminals: mocks.kill }) }))
vi.mock('../src/main/aiCheckApi', () => ({ createAiCheckApi: () => ({}) }))
vi.mock('../src/main/theme', () => ({ createTheme: () => ({ api: {} }) }))
vi.mock('../src/main/updater', () => ({ createUpdater: (deps: { beforeInstall: () => void }) => { mocks.beforeInstall = deps.beforeInstall; return { api: {} } } }))

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

it('[PL-F04-AC5] 종료 정리 오류가 오류 창을 띄우거나 종료를 막지 않고 재호출에도 한 번만 정리한다', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.kill.mockImplementation(() => { throw new Error('EBUSY: saved terminals') })
  await import('../src/main/index')
  const { app } = await import('electron')
  expect(() => { app.emit('before-quit'); app.emit('will-quit'); mocks.beforeInstall!() }).not.toThrow()
  expect(mocks.kill).toHaveBeenCalledTimes(1)
  expect(mocks.unregister).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('Orbit 종료 정리 실패:', expect.any(Error))
  log.mockRestore()
})

it('[PL-F04-AC5] 하나의 PTY 종료가 실패해도 나머지 터미널을 모두 종료한다', () => {
  const kill = vi.fn().mockImplementationOnce(() => { throw new Error('already exited') }), report = vi.fn()
  const spawn = (): IPty => ({ pid: 1, process: 'shell', cols: 80, rows: 24, handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, clear() {}, pause() {}, resume() {}, kill })
  const manager = new TerminalManager(spawn, { onData() {}, onExit() {}, onError: report })
  manager.create('shell', '.'); manager.create('shell', '.'); manager.create('shell', '.')
  expect(() => manager.killAll()).not.toThrow()
  expect(kill).toHaveBeenCalledTimes(3)
  expect(manager.list()).toEqual([])
  expect(report).toHaveBeenCalledOnce()
})
