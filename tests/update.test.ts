import { describe, expect, it } from 'vitest'
import { DEFAULT_UPDATE_SETTINGS, notesText, reduceUpdate, shouldAutoCheck, type UpdateStatus } from '../src/core/update'

const start: UpdateStatus = { state: 'idle', currentVersion: '0.1.0' }
const now = new Date('2026-10-12T12:00:00Z')

describe('앱 기반 · 자동 업데이트', () => {
  it('[PL-F04-AC1] 새 버전 확인 → 내려받기 → 설치 준비됨으로 상태가 바뀐다', () => {
    let s = reduceUpdate(start, { type: 'checking' }, now)
    expect(s.state).toBe('checking')
    s = reduceUpdate(s, { type: 'available', version: '0.2.0' }, now)
    expect(s).toMatchObject({ state: 'available', version: '0.2.0', checkedAt: now.toISOString() })
    s = reduceUpdate(s, { type: 'progress', percent: 41.6, transferred: 416, total: 1000 }, now)
    expect(s).toMatchObject({ state: 'downloading', percent: 42, version: '0.2.0' })
    s = reduceUpdate(s, { type: 'downloaded', version: '0.2.0' }, now)
    expect(s).toMatchObject({ state: 'downloaded', percent: 100 })
    // 받아둔 뒤 다시 확인해도 설치 준비 상태를 잃지 않는다
    expect(reduceUpdate(s, { type: 'checking' }, now).state).toBe('downloaded')
  })

  it('[PL-F04-AC2] 확인에 실패해도 오류 상태로만 남고, 받아둔 업데이트는 유지된다', () => {
    expect(reduceUpdate(start, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }, now)).toMatchObject({ state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' })
    const ready: UpdateStatus = { ...start, state: 'downloaded', version: '0.2.0' }
    expect(reduceUpdate(ready, { type: 'error', message: 'x' }, now).state).toBe('downloaded')
  })

  it('[PL-F04-AC4] 자동 확인은 켜져 있고 6시간이 지났을 때만 한다', () => {
    const checked = { ...start, state: 'not-available' as const, checkedAt: '2026-10-12T08:00:00Z' }
    expect(shouldAutoCheck(DEFAULT_UPDATE_SETTINGS, start, now)).toBe(true)
    expect(shouldAutoCheck(DEFAULT_UPDATE_SETTINGS, checked, now)).toBe(false)
    expect(shouldAutoCheck(DEFAULT_UPDATE_SETTINGS, checked, new Date('2026-10-12T14:00:00Z'))).toBe(true)
    expect(shouldAutoCheck({ ...DEFAULT_UPDATE_SETTINGS, autoCheck: false }, start, now)).toBe(false)
    expect(shouldAutoCheck(DEFAULT_UPDATE_SETTINGS, { ...start, state: 'dev' }, now)).toBe(false)
  })

  it('릴리스 노트는 문자열과 배열 모두 읽는다', () => {
    expect(notesText('고친 점')).toBe('고친 점')
    expect(notesText([{ version: '0.2.0', note: 'a' }, { version: '0.1.1', note: 'b' }])).toBe('a\n\nb')
    expect(notesText(null)).toBeUndefined()
  })
})
