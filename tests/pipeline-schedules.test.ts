import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { nextScheduledTime, parseLocalDateTime, type ScheduleInput } from '../src/core/automationSchedule'
import { PipelineScheduler } from '../src/core/pipelineScheduler'
import { tempDir } from './helpers'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

async function fixture() {
  const dir = await tempDir('orbit-schedules-'); dirs.push(dir)
  let now = Date.parse('2026-11-18T00:00:00Z'), running = false
  const run = vi.fn(async () => [{ runId: 'run-scheduled' }]), changed = vi.fn(), onError = vi.fn()
  const deps = { file: path.join(dir, 'schedules.json'), now: () => now, run, changed, onError, isRunning: () => running }
  const store = new PipelineScheduler(deps); await store.load()
  const input: ScheduleInput = { title: '매시간 검사', enabled: true, timing: { kind: 'interval', every: 1, unit: 'hours' }, request: { pipelineId: 'graph-a', values: { input: '저장한 입력' }, allowNew: true } }
  return { store, deps, run, input, advance: (ms: number) => { now += ms }, running: (value: boolean) => { running = value } }
}

it('매일 예약은 오늘 남은 시각 또는 다음 날이며 월·연도 경계를 넘는다', () => {
  const today = new Date(2026, 11, 31, 8, 0).getTime()
  expect(new Date(nextScheduledTime({ kind: 'daily', time: '09:30' }, today)!)).toEqual(new Date(2026, 11, 31, 9, 30))
  expect(new Date(nextScheduledTime({ kind: 'daily', time: '09:30' }, new Date(2026, 11, 31, 9, 30).getTime())!)).toEqual(new Date(2027, 0, 1, 9, 30))
})

it('간격 예약은 지연 후에도 최초 기준 시각을 유지하고 밀린 회차를 건너뛴다', () => {
  const anchor = Date.parse('2026-11-18T00:00:00Z')
  expect(nextScheduledTime({ kind: 'interval', every: 3, unit: 'hours' }, anchor + 7 * 3600_000, anchor)).toBe('2026-11-18T09:00:00.000Z')
  expect(nextScheduledTime({ kind: 'interval', every: 2, unit: 'days' }, anchor, anchor)).toBe('2026-11-20T00:00:00.000Z')
})

it('현지 날짜를 UTC로 저장하고 존재하지 않는 날짜·시각·간격을 거부한다', () => {
  expect(new Date(parseLocalDateTime('2028-02-29T13:45'))).toEqual(new Date(2028, 1, 29, 13, 45))
  for (const value of ['2026-02-29T13:45', '2026-13-01T12:00', '2026-01-01T25:00', 'invalid']) expect(() => parseLocalDateTime(value)).toThrow()
  expect(() => nextScheduledTime({ kind: 'daily', time: '24:00' }, Date.now())).toThrow()
  expect(() => nextScheduledTime({ kind: 'once', at: '2026-02-29T12:00:00.000Z' }, Date.now())).toThrow()
  for (const every of [0, -1, 0.5, NaN, Infinity, 366]) expect(() => nextScheduledTime({ kind: 'interval', every, unit: 'days' }, Date.now())).toThrow()
})

it('한 번 예약은 정해진 때 한 번만 실행하며 동시 tick과 재시작에도 중복되지 않는다', async () => {
  const f = await fixture()
  const row = await f.store.save({ ...f.input, timing: { kind: 'once', at: '2026-11-18T01:00:00.000Z' } })
  await f.store.tick(); expect(f.run).not.toHaveBeenCalled()
  f.advance(3600_000)
  await Promise.all(Array.from({ length: 8 }, () => f.store.tick()))
  expect(f.run).toHaveBeenCalledTimes(1)
  expect(f.run).toHaveBeenCalledWith(f.input.request, { id: row.id, title: row.title, dueAt: '2026-11-18T01:00:00.000Z' })
  f.store.stop()
  const restored = new PipelineScheduler(f.deps); await restored.load(); await restored.tick()
  expect(f.run).toHaveBeenCalledTimes(1)
  expect((await restored.list())[0]).toMatchObject({ enabled: false, last: { status: 'started', runIds: ['run-scheduled'] } })
})

it('앱을 다시 열 때 놓친 반복 예약 여러 회차는 한 번 실행하고 다음 시각을 복원한다', async () => {
  const f = await fixture(); await f.store.save(f.input); f.store.stop()
  f.advance(9 * 3600_000 + 30 * 60_000)
  const restored = new PipelineScheduler(f.deps); await restored.load(); await restored.tick()
  expect(f.run).toHaveBeenCalledTimes(1)
  expect((await restored.list())[0].nextRunAt).toBe('2026-11-18T10:00:00.000Z')
})

it('이전 실행이 끝날 때까지 대기하며 일회성 예약도 잃지 않는다', async () => {
  const f = await fixture(); await f.store.save({ ...f.input, timing: { kind: 'once', at: '2026-11-18T01:00:00.000Z' } })
  f.running(true); f.advance(3600_000); await f.store.tick()
  expect(f.run).not.toHaveBeenCalled()
  expect((await f.store.list())[0]).toMatchObject({ enabled: true, last: { status: 'blocked' } })
  f.running(false); f.advance(10_000); await f.store.tick()
  expect(f.run).toHaveBeenCalledTimes(1)
})

it('쿼터 때문에 대기한 예약은 알려 준 재시도 시각까지 실행하지 않는다', async () => {
  const f = await fixture()
  const check = vi.fn().mockResolvedValueOnce({ message: '한도 소진', retryAt: '2026-11-18T02:00:00.000Z' }).mockResolvedValue(undefined)
  const store = new PipelineScheduler({ ...f.deps, check }); await store.load(); await store.save(f.input)
  f.advance(3600_000); await store.tick(); expect(f.run).not.toHaveBeenCalled()
  f.advance(30 * 60_000); await store.tick(); expect(check).toHaveBeenCalledTimes(1)
  f.advance(30 * 60_000); await store.tick(); expect(f.run).toHaveBeenCalledTimes(1)
})

it('일시정지·재개·수정·삭제가 저장되고, 재개는 밀린 간격을 몰아 실행하지 않는다', async () => {
  const f = await fixture(), row = await f.store.save(f.input)
  await f.store.setEnabled(row.id, false); f.advance(4 * 3600_000); await f.store.tick(); expect(f.run).not.toHaveBeenCalled()
  await f.store.setEnabled(row.id, true); expect((await f.store.list())[0].nextRunAt).toBe('2026-11-18T05:00:00.000Z')
  await f.store.save({ ...f.input, id: row.id, title: '수정한 예약', timing: { kind: 'daily', time: '15:00' } })
  const copy = new PipelineScheduler(f.deps); await copy.load(); expect((await copy.list())[0].title).toBe('수정한 예약')
  await f.store.remove(row.id); expect(await f.store.list()).toEqual([])
})

it('프로젝트를 닫거나 실행 준비가 실패해도 다른 프로젝트에서 실행하거나 계속 재시도하지 않는다', async () => {
  const f = await fixture(); await f.store.save(f.input); f.run.mockRejectedValueOnce(new Error('그래프가 변경되었습니다'))
  f.advance(3600_000); await f.store.tick(); expect((await f.store.list())[0].last).toMatchObject({ status: 'failed', message: '그래프가 변경되었습니다' })
  await f.store.tick(); expect(f.run).toHaveBeenCalledTimes(1)
  f.store.stop(); f.advance(3600_000); await f.store.tick(); expect(f.run).toHaveBeenCalledTimes(1)
})

it('실행 중간에 중단된 기록과 손상된 저장 파일을 성공으로 취급하거나 덮어쓰지 않는다', async () => {
  const f = await fixture(), row = await f.store.save(f.input)
  await fs.writeFile(f.deps.file, JSON.stringify({ version: 1, schedules: [{ ...row, nextRunAt: '2026-11-18T02:00:00.000Z', last: { status: 'dispatching', at: row.created, dueAt: row.created } }] }))
  const restored = new PipelineScheduler(f.deps); await restored.load(); expect((await restored.list())[0].last?.status).toBe('failed')
  await fs.writeFile(f.deps.file, '{broken')
  const broken = new PipelineScheduler(f.deps); await expect(broken.load()).rejects.toThrow(); await expect(broken.save(f.input)).rejects.toThrow()
  expect(await fs.readFile(f.deps.file, 'utf8')).toBe('{broken')
})

it('회차를 디스크에 기록하지 못하면 실행하지 않고 저장된 예약을 보존한다', async () => {
  const f = await fixture(), row = await f.store.save(f.input)
  f.advance(3600_000)
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'))
  try { await expect(f.store.tick()).rejects.toThrow('disk unavailable') } finally { rename.mockRestore() }
  expect(f.run).not.toHaveBeenCalled()
  expect(JSON.parse(await fs.readFile(f.deps.file, 'utf8')).schedules[0]).toEqual(row)
  await f.store.tick(); expect(f.run).toHaveBeenCalledTimes(1)
})
