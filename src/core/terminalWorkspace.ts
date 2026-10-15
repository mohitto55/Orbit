import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { TerminalManager, terminalCommand, validateSessionId, type TerminalEvents, type TerminalKind, type TerminalSnapshot } from './terminal'
import { encodeClaudeProjectDir } from './drift'
import { codexMetadataFiles, readCodexMetadata, sameProjectPath } from './sessionMetadata'
import type { Ctx, ProjectSettings } from './workspace'

interface SavedTab {
  id: string
  kind: TerminalKind
  title: string
  sessionId?: string
  cols: number
  rows: number
  output: string
  createdAt: number
  exited?: number
}

export interface TerminalState {
  tabs: TerminalSnapshot[]
  active: string | null
}

/** Codex에는 새 대화 ID 지정 옵션이 없다. 탭 고유 originator와 일치하는 메타데이터만 찾는다. */
export async function findCodexSession(projectDir: string, tabId: string, root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), since = 0): Promise<string | undefined> {
  let latest: { id: string; created: number } | undefined
  for await (const file of codexMetadataFiles(path.join(root, 'sessions'), since)) {
    const meta = await readCodexMetadata(file)
    if (meta?.originator !== `orbit-${tabId}` || !sameProjectPath(meta.cwd, projectDir)) continue
    if (meta.source && meta.source !== 'cli') continue
    validateSessionId(meta.id)
    const created = Date.parse(meta.timestamp ?? '') || statSync(file).birthtimeMs
    if (!latest || created > latest.created) latest = { id: meta.id, created }
  }
  return latest?.id
}
/** 탭 배치·이름·세션 ID·최근 터미널 출력을 저장한다. CLI 대화 본문은 가져오지 않는다. */
export class TerminalWorkspace {
  private tabs = new Map<string, SavedTab>()
  private active: string | null = null
  private manager: TerminalManager
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private binding = false
  private nextBind = 0

  constructor(private file: string, private ctx: Ctx, spawn: typeof import('node-pty').spawn, private events: TerminalEvents) {
    this.manager = new TerminalManager(spawn, {
      onData: (id, data, sequence) => {
        const tab = this.tabs.get(id)
        if (!tab) return
        tab.output = (tab.output + data).slice(-200000)
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null
            try { this.save() } catch (e) { this.events.onError?.(`터미널 저장 실패: ${String(e)}`) }
            void this.bindCodex().catch((e: unknown) => this.events.onError?.(`세션 ID 연결 실패: ${String(e)}`))
          }, 1000)
          this.timer.unref()
        }
        events.onData(id, data, sequence)
      },
      onExit: (id, code) => {
        const tab = this.tabs.get(id)
        if (tab) tab.exited = code
        this.save()
        events.onExit(id, code)
      }
    })
  }

  async restore(settings: ProjectSettings): Promise<void> {
    if (!existsSync(this.file)) return
    if (statSync(this.file).size > 32 * 1024 * 1024) throw new Error('터미널 저장 파일이 너무 큽니다')
    const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { tabs?: SavedTab[]; active?: string }
    if (!Array.isArray(saved.tabs)) throw new Error('터미널 저장 파일을 읽을 수 없습니다')
    for (const tab of saved.tabs) {
      if (!/^term-[a-f0-9-]{36}$/.test(tab.id) || !['shell', 'claude', 'codex'].includes(tab.kind) || typeof tab.title !== 'string') throw new Error('터미널 저장 정보가 올바르지 않습니다')
      if (tab.sessionId) validateSessionId(tab.sessionId)
      this.tabs.set(tab.id, { ...tab, output: typeof tab.output === 'string' ? tab.output.slice(-200000) : '' })
    }
    this.active = this.tabs.has(saved.active ?? '') ? saved.active! : [...this.tabs.keys()].at(-1) ?? null
    await this.bindCodex()
    for (const tab of this.tabs.values()) {
      if (this.stopped) return
      if (tab.exited !== undefined) continue
      try { this.launch(tab, settings, true) } catch (e) {
        tab.exited = -1
        tab.output += `\r\n[세션 복원 실패: ${e instanceof Error ? e.message : String(e)}]\r\n`
      }
    }
    this.save()
  }

  create(kind: TerminalKind, settings: ProjectSettings, cols = 100, rows = 30): TerminalSnapshot {
    if (!['shell', 'claude', 'codex'].includes(kind)) throw new Error('지원하지 않는 터미널 종류입니다')
    const tab: SavedTab = { id: `term-${randomUUID()}`, kind, title: { shell: '터미널', claude: 'Claude Code', codex: 'Codex' }[kind], cols, rows, output: '', createdAt: Date.now(), ...(kind === 'claude' ? { sessionId: randomUUID() } : {}) }
    this.tabs.set(tab.id, tab)
    try { this.launch(tab, settings, false) } catch (e) { this.tabs.delete(tab.id); throw e }
    this.active = tab.id
    this.save()
    return this.snapshot(tab)
  }

  private launch(tab: SavedTab, settings: ProjectSettings, restoring: boolean): void {
    let resume = restoring ? tab.sessionId : undefined
    if (tab.kind === 'claude' && resume) {
      const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
      if (!existsSync(path.join(configDir, 'projects', encodeClaudeProjectDir(this.ctx.projectDir), `${resume}.jsonl`))) resume = undefined
    }
    let command = tab.kind === 'claude' && !resume
      ? `${terminalCommand('claude', settings)} --session-id ${tab.sessionId}`
      : terminalCommand(tab.kind, settings, resume)
    // 공유 데몬의 환경·저장 위치가 다른 탭에 섞이지 않도록 각 TUI를 독립 실행한다.
    if (tab.kind === 'codex' && command && !/(^|\s)--no-daemon(?:\s|$)/.test(command)) command += ' --no-daemon'
    this.manager.create(tab.kind, this.ctx.projectDir, tab.cols, tab.rows, settings, tab.sessionId, tab.title, {
      id: tab.id, command: command ?? undefined, output: tab.output,
      env: tab.kind === 'codex' ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `orbit-${tab.id}` } : {}
    })
  }

  private async bindCodex(): Promise<void> {
    if (this.binding || this.stopped || Date.now() < this.nextBind) return
    const codexTabs = [...this.tabs.values()].filter((tab) => tab.kind === 'codex' && tab.exited === undefined)
    if (!codexTabs.length) return
    this.binding = true
    this.nextBind = Date.now() + 5000
    try {
      for (const tab of codexTabs) {
        const id = await findCodexSession(this.ctx.projectDir, tab.id, undefined, tab.createdAt)
        if (id && id !== tab.sessionId && !this.stopped && this.tabs.has(tab.id)) { tab.sessionId = id; this.save() }
      }
    } finally { this.binding = false }
  }

  private snapshot(tab: SavedTab): TerminalSnapshot {
    const live = this.manager.snapshot(tab.id)
    return { id: tab.id, kind: tab.kind, title: tab.title, pid: live?.pid ?? 0, sessionId: tab.sessionId, output: live?.output ?? tab.output, sequence: live?.sequence ?? 0, ...(tab.exited === undefined ? {} : { exited: tab.exited }) }
  }

  state(): TerminalState { return { tabs: [...this.tabs.values()].map((tab) => this.snapshot(tab)), active: this.active } }

  async restart(id: string, settings: ProjectSettings): Promise<TerminalSnapshot> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('터미널을 찾을 수 없습니다')
    await this.bindCodex()
    this.manager.kill(id)
    delete tab.exited
    this.launch(tab, settings, true)
    this.active = id
    this.save()
    return this.snapshot(tab)
  }

  write(id: string, data: string): void { this.manager.write(id, data) }
  resize(id: string, cols: number, rows: number): void {
    this.manager.resize(id, cols, rows)
    const tab = this.tabs.get(id)
    if (tab && cols > 0 && rows > 0) { tab.cols = cols; tab.rows = rows }
  }
  activate(id: string): void {
    if (!this.tabs.has(id)) return
    this.active = id
    this.save()
  }
  rename(id: string, title: string): TerminalSnapshot {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('터미널을 찾을 수 없습니다')
    if (!title.trim() || title.trim().length > 100) throw new Error('세션 이름은 1~100자로 입력해 주세요')
    tab.title = title.trim()
    this.save()
    return this.snapshot(tab)
  }
  kill(id: string): void {
    this.tabs.delete(id)
    this.manager.kill(id)
    if (this.active === id) this.active = [...this.tabs.keys()].at(-1) ?? null
    this.save()
  }
  suspend(persist = true): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try { if (persist) this.save() } finally { this.manager.killAll() }
  }
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const pending = `${this.file}.tmp`
    writeFileSync(pending, JSON.stringify({ tabs: [...this.tabs.values()], active: this.active }))
    renameSync(pending, this.file)
  }
}
