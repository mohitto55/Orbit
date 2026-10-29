import { EventEmitter } from 'events'
import { expect, it, vi } from 'vitest'
import { createUpdater } from '../src/main/updater'
import { tempDir } from './helpers'

const calls = vi.hoisted(() => [] as string[])
vi.mock('electron-updater', () => ({ autoUpdater: Object.assign(new EventEmitter(), {
  checkForUpdates: async () => {}, quitAndInstall: () => { calls.push('install') }
}) }))

it('[PL-F04-AC5] 다운로드가 끝난 업데이트만 설치하며 설치 프로그램 실행 전에 세션을 정리한다', async () => {
  const updater = createUpdater({ send() {}, isPackaged: true, version: '0.3.32', userData: await tempDir('orbit-update-'), beforeInstall: () => { calls.push('cleanup') } })
  await updater.api.updateInstall()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(calls).toEqual([])
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.emit('update-downloaded', { version: '0.3.33', downloadedFile: 'update.exe', files: [], path: 'update.exe', sha512: '', releaseDate: '2026-10-29T00:00:00.000Z' })
  await updater.api.updateInstall()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(calls).toEqual(['cleanup', 'install'])
})
