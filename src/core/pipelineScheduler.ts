import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { nextScheduledTime, validateTiming, type PipelineSchedule, type ScheduleInput } from './automationSchedule'
import type { PipelineRunRequest } from './pipelineExecution'

export interface ScheduleTrigger { id: string; title: string; dueAt: string }
export interface ScheduleBlock { message: string; retryAt?: string }
interface SchedulerDeps {
  file: string
  now?: () => number
  changed: () => void
  onError: (error: unknown) => void
  isRunning: (pipelineId: string) => boolean
  check?: (request: PipelineRunRequest) => Promise<ScheduleBlock | undefined>
  run: (request: PipelineRunRequest, trigger: ScheduleTrigger) => Promise<{ runId: string }[]>
}

/** 실행 전 회차를 저장한다. 재시작·동시 tick으로 같은 회차를 두 번 시작하지 않는다. */
export class PipelineScheduler {
  private rows: PipelineSchedule[] = []
  private loaded = false
  private active = true
  private timer?: NodeJS.Timeout
  private queue: Promise<unknown> = Promise.resolve()
  private now: () => number
  constructor(private deps: SchedulerDeps) { this.now = deps.now ?? (() => Date.now()) }

  async load(): Promise<void> {
    try {
      const data: { version?: unknown; schedules?: PipelineSchedule[] } = JSON.parse(await fs.readFile(this.deps.file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.schedules)) throw new Error('예약 파일 형식을 확인하세요')
      const ids = new Set<string>()
      for (const row of data.schedules) {
        if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.title !== 'string' || typeof row.enabled !== 'boolean' || !row.request || typeof row.request.pipelineId !== 'string' || !Number.isFinite(Date.parse(row.anchor)) || (row.nextRunAt !== undefined && !Number.isFinite(Date.parse(row.nextRunAt))) || (row.retryAt !== undefined && !Number.isFinite(Date.parse(row.retryAt)))) throw new Error('예약 파일 형식을 확인하세요')
        ids.add(row.id)
        validateTiming(row.timing)
        if (row.last?.status === 'dispatching') row.last = { ...row.last, status: 'failed', message: '이전 실행을 전달하는 동안 앱이 종료되었습니다. 실행 기록을 확인하세요.' }
      }
      this.rows = data.schedules
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.loaded = true
  }

  start(): void {
    if (this.timer || !this.loaded || !this.active) return
    let ticking = false
    const tick = () => {
      if (ticking) return
      ticking = true
      void this.tick().catch((error) => { this.stop(); this.deps.onError(error) }).finally(() => { ticking = false })
    }
    this.timer = setInterval(tick, 1000)
    this.timer.unref()
    tick()
  }

  stop(): void { this.active = false; clearInterval(this.timer); this.timer = undefined }
  async flush(): Promise<void> { await this.queue }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.queue.then(fn)
    this.queue = work.catch(() => {})
    return work
  }

  private ready(): void {
    if (!this.loaded) throw new Error('예약을 불러오지 못했습니다. 프로젝트를 다시 열어 주세요')
    if (!this.active) throw new Error('프로젝트가 닫혔습니다')
  }

  private async write(rows: PipelineSchedule[]): Promise<void> {
    const temp = `${this.deps.file}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(this.deps.file), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, schedules: rows }), 'utf8')
      await fs.rename(temp, this.deps.file)
    } finally { await fs.rm(temp, { force: true }) }
    this.rows = rows
    this.deps.changed()
  }

  async list(): Promise<PipelineSchedule[]> {
    await this.queue; this.ready()
    return structuredClone(this.rows)
  }

  save(input: ScheduleInput): Promise<PipelineSchedule> {
    return this.serial(async () => {
      this.ready(); validateTiming(input.timing)
      if (typeof input.enabled !== 'boolean' || typeof input.title !== 'string' || !input.title.trim() || !input.request || typeof input.request.pipelineId !== 'string') throw new Error('예약 이름과 작업 그래프를 입력하세요')
      const old = input.id ? this.rows.find((row) => row.id === input.id) : undefined
      if (input.id && !old) throw new Error('수정할 예약을 찾을 수 없습니다')
      const now = this.now(), iso = new Date(now).toISOString()
      const timingChanged = !old || JSON.stringify(old.timing) !== JSON.stringify(input.timing)
      if (timingChanged && input.timing.kind === 'once' && Date.parse(input.timing.at) <= now) throw new Error('한 번 실행할 예약은 미래의 날짜와 시각으로 지정하세요')
      if (old && !old.enabled && input.enabled && input.timing.kind === 'once' && Date.parse(input.timing.at) <= now) throw new Error('새 실행 날짜를 지정한 뒤 예약을 켜세요')
      const anchor = timingChanged ? iso : old.anchor
      const nextRunAt = timingChanged || (input.enabled && !old?.enabled) ? nextScheduledTime(input.timing, now, Date.parse(anchor)) : old?.nextRunAt
      const row: PipelineSchedule = { ...structuredClone(input), id: old?.id ?? `schedule-${randomUUID()}`, title: input.title.trim().slice(0, 150), created: old?.created ?? iso, updated: iso, anchor, nextRunAt, last: old?.last }
      await this.write([...this.rows.filter((item) => item.id !== row.id), row])
      return structuredClone(row)
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => { this.ready(); await this.write(this.rows.filter((row) => row.id !== id)) })
  }

  removePipeline(id: string): Promise<void> {
    return this.serial(async () => { this.ready(); await this.write(this.rows.filter((row) => row.request.pipelineId !== id)) })
  }

  /** 사용자가 계정·정책을 변경하면 초기화 예정일까지 기다리지 않고 다시 판단한다. */
  recheckBlocked(): Promise<void> {
    return this.serial(async () => {
      if (!this.active || !this.loaded) return
      const rows = this.rows.map((row) => row.enabled && row.retryAt && row.last?.status === 'blocked' ? { ...row, retryAt: undefined } : row)
      if (rows.some((row, i) => row !== this.rows[i])) await this.write(rows)
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      this.ready()
      const row = this.rows.find((item) => item.id === id)
      if (!row || typeof enabled !== 'boolean') throw new Error('예약을 찾을 수 없습니다')
      const now = this.now()
      if (enabled && row.timing.kind === 'once' && Date.parse(row.timing.at) <= now) throw new Error('예약을 편집해 새 실행 날짜를 지정하세요')
      await this.write(this.rows.map((item) => item.id === id ? { ...item, enabled, updated: new Date(now).toISOString(), retryAt: undefined, nextRunAt: enabled ? nextScheduledTime(item.timing, now, Date.parse(item.anchor)) : item.nextRunAt } : item))
    })
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (!this.active || !this.loaded) return
      for (const current of [...this.rows]) {
        const now = this.now()
        if (!this.active) return
        if (!current.enabled || !current.nextRunAt || Date.parse(current.nextRunAt) > now || (current.retryAt && Date.parse(current.retryAt) > now)) continue
        let block: ScheduleBlock | undefined
        try {
          block = this.deps.isRunning(current.request.pipelineId) ? { message: '같은 그래프의 이전 실행이 끝나기를 기다립니다', retryAt: new Date(now + 10_000).toISOString() } : await this.deps.check?.(current.request)
        } catch (error) { block = { message: error instanceof Error ? error.message : String(error) } }
        if (!this.active) return
        const dueAt = current.nextRunAt, at = new Date(now).toISOString()
        if (block) {
          const retry = block.retryAt && Date.parse(block.retryAt)
          await this.write(this.rows.map((row) => row.id === current.id ? { ...row, retryAt: new Date(retry && retry > now ? retry : now + 60_000).toISOString(), last: { at, dueAt, status: 'blocked', message: block.message } } : row))
          continue
        }
        // 밀린 반복 회차는 한 번으로 합친다. 먼저 다음 시각을 기록한 뒤 실행한다.
        const nextRunAt = nextScheduledTime(current.timing, this.now(), Date.parse(current.anchor))
        let claimed: PipelineSchedule = { ...current, enabled: !!nextRunAt, nextRunAt, retryAt: undefined, last: { at, dueAt, status: 'dispatching' } }
        await this.write(this.rows.map((row) => row.id === current.id ? claimed : row))
        try {
          if (!this.active) throw new Error('실행 준비 중 프로젝트가 닫혔습니다')
          const runs = await this.deps.run(current.request, { id: current.id, title: current.title, dueAt })
          claimed = { ...claimed, last: { at, dueAt, status: 'started', runIds: runs.map((run) => run.runId) } }
        } catch (error) {
          claimed = { ...claimed, last: { at, dueAt, status: 'failed', message: error instanceof Error ? error.message : String(error) } }
        }
        await this.write(this.rows.map((row) => row.id === current.id ? claimed : row))
      }
    })
  }
}
