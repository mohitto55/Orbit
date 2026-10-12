import { describe, expect, it } from 'vitest'
import { NotifyLog, afterTime } from '../src/core/notify'

describe('앱 기반', () => {
  it('[PL-F02-AC1] 같은 종류의 알림은 하루에 한 번만 보낸다', () => {
    const log = new NotifyLog()
    const morning = new Date('2026-10-12T09:00:00')
    expect(log.take('inbox', morning)).toBe(true)
    expect(log.take('inbox', new Date('2026-10-12T18:00:00'))).toBe(false)
    expect(log.take('due', morning)).toBe(true)
    expect(log.take('inbox', new Date('2026-10-13T09:00:00'))).toBe(true)
  })

  it('[PL-F02-AC2] Inbox 정리 알림은 설정한 시각 이후에만 보낸다', () => {
    expect(afterTime('09:00', new Date('2026-10-12T08:59:00'))).toBe(false)
    expect(afterTime('09:00', new Date('2026-10-12T09:00:00'))).toBe(true)
  })
})
