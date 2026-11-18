import type { PipelineRunRequest } from './pipelineExecution'

export type ScheduleTiming =
  | { kind: 'daily'; time: string }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
  | { kind: 'once'; at: string }

export interface ScheduleInput {
  id?: string
  title: string
  enabled: boolean
  timing: ScheduleTiming
  request: PipelineRunRequest
}

export interface PipelineSchedule extends ScheduleInput {
  id: string
  created: string
  updated: string
  anchor: string
  nextRunAt?: string
  retryAt?: string
  last?: { at: string; dueAt: string; status: 'dispatching' | 'started' | 'blocked' | 'failed'; message?: string; runIds?: string[] }
}

const MINUTE = 60_000
export const INTERVAL_UNITS = { minutes: MINUTE, hours: 60 * MINUTE, days: 24 * 60 * MINUTE } as const

export function validateTiming(timing: ScheduleTiming): void {
  if (!timing || typeof timing !== 'object') throw new Error('예약 방식을 선택하세요')
  if (timing.kind === 'daily') {
    if (typeof timing.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time)) throw new Error('매일 실행할 시각을 입력하세요')
  } else if (timing.kind === 'interval') {
    if (!Object.hasOwn(INTERVAL_UNITS, timing.unit) || !Number.isInteger(timing.every) || timing.every < 1 || timing.every * INTERVAL_UNITS[timing.unit] > 365 * INTERVAL_UNITS.days) throw new Error('반복 간격은 1분 이상, 365일 이하의 정수로 입력하세요')
  } else if (timing.kind === 'once') {
    if (typeof timing.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timing.at) || !Number.isFinite(Date.parse(timing.at)) || new Date(timing.at).toISOString() !== timing.at) throw new Error('실행할 날짜와 시각을 입력하세요')
  } else throw new Error('지원하지 않는 예약 방식입니다')
}

/** 매일 예약은 컴퓨터의 현지 시각, 간격 예약은 저장한 기준 시각부터의 경과 시간이다. */
export function nextScheduledTime(timing: ScheduleTiming, after: number, anchor = after): string | undefined {
  validateTiming(timing)
  if (!Number.isFinite(after) || !Number.isFinite(anchor)) throw new Error('예약 기준 시각이 올바르지 않습니다')
  if (timing.kind === 'once') return Date.parse(timing.at) > after ? new Date(timing.at).toISOString() : undefined
  if (timing.kind === 'interval') {
    const period = timing.every * INTERVAL_UNITS[timing.unit]
    return new Date(anchor + Math.max(1, Math.floor((after - anchor) / period) + 1) * period).toISOString()
  }
  const [hour, minute] = timing.time.split(':').map(Number)
  const next = new Date(after)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= after) { next.setDate(next.getDate() + 1); next.setHours(hour, minute, 0, 0) }
  return next.toISOString()
}

export function describeSchedule(timing: ScheduleTiming): string {
  if (timing.kind === 'daily') return `매일 ${timing.time}`
  if (timing.kind === 'interval') return `${timing.every}${{ minutes: '분', hours: '시간', days: '일' }[timing.unit]}마다`
  return `${new Date(timing.at).toLocaleString()} · 한 번`
}

/** datetime-local은 UTC가 아니다. 입력·표시 모두 같은 현지 시각으로 왕복한다. */
export function localDateTime(value: string | number = Date.now()): string {
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function parseLocalDateTime(value: string): string {
  const date = new Date(value)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) || !Number.isFinite(date.getTime()) || localDateTime(date.getTime()) !== value) throw new Error('실행할 날짜와 시각이 올바르지 않습니다')
  return date.toISOString()
}
