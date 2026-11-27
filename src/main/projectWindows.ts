import { promises as fs } from 'fs'
import path from 'path'
import { createApi, type ApiDeps } from './api'
import { createAiCheckApi } from './aiCheckApi'
import type { Ctx } from '../core/workspace'

interface WindowDeps extends Omit<ApiDeps, 'send' | 'onProjectOpened'> {
  send: (windowId: number, channel: string, payload: unknown) => void
  watch: (ctx: Ctx, changed: () => void) => () => void
}

/** 같은 프로젝트의 창들은 한 실행기를 공유한다. 마지막 창이 닫힐 때만 종료한다. */
export class ProjectWindows {
  private windows = new Map<number, ReturnType<ProjectWindows['runtime']> | null>()
  private projects = new Map<string, ReturnType<ProjectWindows['runtime']>>()
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private empty: ReturnType<ProjectWindows['runtime']>
  constructor(private deps: WindowDeps) { this.empty = this.runtime() }

  private runtime() {
    let unwatch: (() => void) | undefined
    const members = new Set<number>()
    const send = (channel: string, payload: unknown) => { for (const id of members) this.deps.send(id, channel, payload) }
    const api = createApi({ ...this.deps, send, onProjectOpened: (ctx) => { unwatch?.(); unwatch = this.deps.watch(ctx, () => send('files-changed', null)) } })
    const ai = createAiCheckApi({ send, getCtx: async () => api.currentProject(), accounts: this.deps.accounts })
    return { api, methods: { ...api, ...ai }, members, send, close: () => { unwatch?.(); return api.killAllTerminals() } }
  }

  get methods(): string[] { return Object.keys(this.empty.methods) }
  register(id: number): void { this.windows.set(id, null) }
  current(id: number) { return (this.windows.get(id) ?? this.empty).api.currentProject() }
  all() { return [...this.projects.values()].map((runtime) => runtime.api) }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn)
    this.queue = result.catch(() => {})
    return result
  }

  private async detach(id: number): Promise<void> {
    const old = this.windows.get(id)
    this.windows.set(id, null)
    if (!old) return
    old.members.delete(id)
    if (!old.members.size) {
      for (const [key, runtime] of this.projects) if (runtime === old) this.projects.delete(key)
      await old.close()
    }
  }

  closeWindow(id: number): Promise<void> {
    return this.serial(async () => { await this.detach(id); this.windows.delete(id) })
  }

  invoke(id: number, name: string, args: unknown[]): Promise<unknown> {
    if (this.stopped || !this.windows.has(id)) return Promise.reject(new Error('창이 닫혔습니다'))
    if (name === 'closeProject') return this.serial(() => this.detach(id))
    if (name === 'openProject' || name === 'createProject') return this.serial(async () => {
      if (this.stopped || !this.windows.has(id)) throw new Error('창이 닫혔습니다')
      const [dir, title] = args
      if (typeof dir !== 'string' || !dir.trim() || (title !== undefined && typeof title !== 'string')) throw new Error('프로젝트 경로를 확인하세요')
      const canonical = await fs.realpath(path.resolve(dir)).catch(() => path.resolve(dir))
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
      let next = this.projects.get(key)
      if (!next) {
        next = this.runtime()
        try {
          if (name === 'createProject') await next.api.createProject(canonical, title)
          else await next.api.openProject(canonical)
          if (this.stopped) throw new Error('앱을 종료하는 중입니다')
          // 새 폴더는 생성 후 실경로가 생긴다. /var 별칭·Windows 짧은 경로도 같은 실행기를 사용한다.
          const createdPath = await fs.realpath(canonical)
          this.projects.set(process.platform === 'win32' ? createdPath.toLowerCase() : createdPath, next)
        } catch (error) { await next.close(); throw error }
      }
      if (this.windows.get(id) !== next) { await this.detach(id); this.windows.set(id, next); next.members.add(id) }
      return next.api.currentProject()
    })
    const runtime = this.windows.get(id) ?? this.empty
    if (!Object.hasOwn(runtime.methods, name)) return Promise.reject(new Error('지원하지 않는 동작입니다'))
    const fn = runtime.methods[name as keyof typeof runtime.methods] as (...args: unknown[]) => unknown
    return Promise.resolve().then(async () => {
      const result = await fn(...args)
      if (name === 'termRestart') for (const other of runtime.members) if (other !== id) this.deps.send(other, 'term-restarted', result)
      if (/^term(Create|Kill|Rename|Reorder|Move|Delete|SelectGroup|Restart|SetAgentOptions)/.test(name)) runtime.send('term-layout', await runtime.api.termLayout())
      return result
    })
  }

  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    for (const runtime of [this.empty, ...this.projects.values()]) {
      try { void runtime.close()?.catch((error: unknown) => console.error('Orbit 종료 정리 실패:', error)) }
      catch (error) { console.error('Orbit 종료 정리 실패:', error) }
    }
    this.projects.clear()
  }
}
