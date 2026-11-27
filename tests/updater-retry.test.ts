import { EventEmitter } from 'events'
import { afterEach, expect, it, vi } from 'vitest'
import { createUpdater } from '../src/main/updater'
import { isTransientUpdateError, updateErrorText } from '../src/core/update'
import { tempDir } from './helpers'

// 실제로 받은 electron-updater 오류 원문 (GitHub 504, 쿠키 헤더 포함)
const GITHUB_504 = 'Unable to find latest version on GitHub (https://github.com/mohitto55/Orbit/releases/latest), please ensure a production release exists: HttpError: 504 "method: GET url: https://github.com/mohitto55/Orbit/releases/tag/v0.3.58\\n\\n Data:\\n <html><body><h1>504 Gateway Time-out</h1>\\nThe server didn\'t respond in time.\\n</body></html>\\n\\n " Headers: { "set-cookie": [ "_gh_sess=SECRET; path=/; HttpOnly" ] }\n    at createHttpError (httpExecutor.js:53:12)'

const outcomes = vi.hoisted(() => [] as (Error | undefined)[])
vi.mock('electron-updater', () => {
  const autoUpdater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => {
      autoUpdater.emit('checking-for-update')
      const error = outcomes.shift()
      if (error) { autoUpdater.emit('error', error); throw error }
      autoUpdater.emit('update-not-available', {})
    },
    quitAndInstall: () => {}
  })
  return { autoUpdater }
})

afterEach(() => { vi.useRealTimers(); outcomes.length = 0 })

it('업데이트 오류 원문을 한 줄 안내로 바꾸고 쿠키·응답 본문을 보이지 않는다', () => {
  expect(isTransientUpdateError(GITHUB_504)).toBe(true)
  expect(updateErrorText(GITHUB_504)).toContain('일시적으로 연결하지 못해')
  expect(updateErrorText(GITHUB_504)).not.toContain('SECRET')
  expect(updateErrorText('Unable to find latest version on GitHub, please ensure a production release exists')).toContain('최신 릴리스를 찾지 못했습니다')
  expect(updateErrorText('net::ERR_INTERNET_DISCONNECTED')).toContain('일시적으로')
  expect(updateErrorText('sha512 checksum mismatch\n    at verify (x.js:1:1)')).toBe('sha512 checksum mismatch')
  expect(isTransientUpdateError('sha512 checksum mismatch')).toBe(false)
})

it('GitHub 일시 오류(504)면 오류를 띄우지 않고 잠시 뒤 다시 확인하며, 계속 실패할 때만 한 줄 안내를 보인다', async () => {
  vi.useFakeTimers()
  const states: { state: string; error?: string }[] = []
  const updater = createUpdater({ send: (_c, s) => states.push(s as { state: string; error?: string }), isPackaged: true, version: '0.3.60', userData: await tempDir('orbit-update-retry-') })
  outcomes.push(new Error(GITHUB_504))
  await updater.api.updateCheck()
  expect(states.some((s) => s.state === 'error')).toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(states.at(-1)?.state).toBe('not-available')

  states.length = 0
  outcomes.push(new Error(GITHUB_504), new Error(GITHUB_504), new Error(GITHUB_504))
  await updater.api.updateCheck()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(states.some((s) => s.state === 'error')).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(states.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('일시적으로') })
  expect(JSON.stringify(states)).not.toContain('SECRET')
})
