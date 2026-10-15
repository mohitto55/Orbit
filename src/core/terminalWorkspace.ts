import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { TerminalManager, terminalCommand, validateSessionId, type TerminalEvents, type TerminalKind, type TerminalSnapshot } from './terminal'
import { encodeClaudeProjectDir } from './drift'
import { codexMetadataFiles, readCodexMetadata, sameProjectPath } from './sessionMetadata'
import { freezeTerminalIntegration, prepareTerminalIntegration, readCliLaunch, resumeOptions, shellQuote, type CliLaunch } from './terminalIntegration'
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
  launch?: CliLaunch
  codexPrefix?: string
}

export interface TerminalState {
  tabs: TerminalSnapshot[]
  active: string | null
}

/** CLI가 알려 준 ID와 일치하는 헤더만 찾는다. 구버전 저장 상태는 탭 고유 originator로 연결한다. */
export async function findCodexSession(projectDir: string, tabId: string, root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), since = 0, prefix?: string): Promise<string | undefined> {
  let latest: { id: string; created: number } | undefined
  for await (const file of codexMetadataFiles(path.join(root, 'sessions'), prefix ? 0 : since)) {
    if (prefix && !path.basename(file).includes(prefix)) continue
    const meta = await readCodexMetadata(file)
    if (!meta || !sameProjectPath(meta.cwd, projectDir)) continue
    if (prefix ? !meta.id.startsWith(prefix) : meta.originator !== `orbit-${tabId}`) continue
    if (meta.source && meta.source !== 'cli') continue
    validateSessionId(meta.id)
    // 일부 Codex 버전은 제목의 UUID 끝을 줄인다. 유일한 메타데이터일 때만 연결한다.
    if (prefix && latest && latest.id !== meta.id) return
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
  private monitor: NodeJS.Timeout
  private titleBuffers = new Map<string, string>()

  constructor(private file: string, private ctx: Ctx, spawn: typeof import('node-pty').spawn, private events: TerminalEvents) {
    this.manager = new TerminalManager(spawn, {
      onData: (id, data, sequence) => {
        const tab = this.tabs.get(id)
        if (!tab) return
        tab.output = (tab.output + data).slice(-200000)
        const titles = ((this.titleBuffers.get(id) ?? '') + data).slice(-8192)
        this.titleBuffers.set(id, titles.slice(-1024))
        const matches = [...titles.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)]
        try {
          if (matches.length) {
            this.syncLaunch(tab)
            if (tab.kind === 'codex') {
              const prefix = matches.at(-1)![1].match(/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{1,12})(?:\.\.\.|\s|$)/i)?.[1]
              if (prefix && prefix !== tab.codexPrefix) { tab.codexPrefix = prefix; this.nextBind = 0; this.save() }
            }
          }
        } catch (e) { this.events.onError?.(`세션 상태 저장 실패: ${String(e)}`) }
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
    this.monitor = setInterval(() => {
      try { for (const tab of this.tabs.values()) this.syncLaunch(tab) }
      catch (e) { this.events.onError?.(`세션 상태 저장 실패: ${String(e)}`) }
      void this.bindCodex().catch((e: unknown) => this.events.onError?.(`세션 ID 연결 실패: ${String(e)}`))
    }, 500)
    this.monitor.unref()
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
    for (const tab of this.tabs.values()) this.syncLaunch(tab)
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
    const cwd = tab.launch?.cwd ?? this.ctx.projectDir
    const integration = prepareTerminalIntegration(this.integrationDir(tab.id), tab.kind, cwd)
    let resume = restoring ? tab.sessionId : undefined
    if (tab.kind === 'claude' && resume) {
      const configDir = tab.launch?.home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
      if (!existsSync(path.join(configDir, 'projects', encodeClaudeProjectDir(cwd), `${resume}.jsonl`))) resume = undefined
    }
    let command = tab.kind === 'claude' && !resume
      ? `${terminalCommand('claude', settings)} --session-id ${tab.sessionId}`
      : terminalCommand(tab.kind, settings, resume)
    if (command && tab.launch) command += resumeOptions(tab.launch.args, command).map((arg) => ` ${shellQuote(arg)}`).join('')
    // 공유 데몬의 환경·저장 위치가 다른 탭에 섞이지 않도록 각 TUI를 독립 실행한다.
    if (tab.kind === 'codex' && command && !/(^|\s)--no-daemon(?:\s|$)/.test(command)) command += ' --no-daemon'
    if (tab.kind === 'codex' && command) command += ` -c ${shellQuote("tui.terminal_title=['session-id']")}`
    if (tab.kind === 'claude' && command) command += ` --settings ${shellQuote(integration.claudeSettings)}`
    // 새 셸의 준비 상태가 기존 launch 인자를 지우지 않도록 시작 이벤트 전에는 비교만 한다.
    const previousLaunch = tab.launch
    tab.launch = readCliLaunch(this.integrationDir(tab.id))
    if (tab.launch && previousLaunch) tab.launch = { ...tab.launch, args: previousLaunch.args, home: previousLaunch.home }
    this.manager.create(tab.kind, cwd, tab.cols, tab.rows, settings, tab.sessionId, tab.title, {
      id: tab.id, command: command ?? undefined, output: tab.output, init: integration.init,
      env: { ...integration.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `orbit-${tab.id}`, ...(tab.launch?.home ? { [tab.kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: tab.launch.home } : {}) }
    })
  }

  private integrationDir(id: string): string { return path.join(`${this.file}.sessions`, id) }

  private syncLaunch(tab: SavedTab): void {
    if (tab.exited !== undefined) return
    const launch = readCliLaunch(this.integrationDir(tab.id))
    if (!launch || JSON.stringify(tab.launch) === JSON.stringify(launch)) return
    if (launch.running && launch.runId !== tab.launch?.runId) {
      delete tab.sessionId
      delete tab.codexPrefix
      this.titleBuffers.delete(tab.id)
    }
    if (!launch.running) {
      tab.kind = 'shell'
      delete tab.sessionId
      delete tab.codexPrefix
    } else {
      tab.kind = launch.kind
      if (launch.sessionId) { validateSessionId(launch.sessionId); tab.sessionId = launch.sessionId }
    }
    tab.launch = launch
    this.save()
    this.events.onChange?.(this.snapshot(tab))
  }

  private async bindCodex(): Promise<void> {
    if (this.binding || this.stopped || Date.now() < this.nextBind) return
    const codexTabs = [...this.tabs.values()].filter((tab) => tab.kind === 'codex' && tab.exited === undefined)
    if (!codexTabs.length) return
    this.binding = true
    this.nextBind = Date.now() + 5000
    try {
      for (const tab of codexTabs) {
        const prefix = tab.codexPrefix
        if (tab.sessionId && (!prefix || tab.sessionId.startsWith(prefix))) continue
        const id = await findCodexSession(tab.launch?.cwd ?? this.ctx.projectDir, tab.id, tab.launch?.home, tab.createdAt, prefix)
        if (id && id !== tab.sessionId && prefix === tab.codexPrefix && !this.stopped && this.tabs.has(tab.id)) {
          tab.sessionId = id; this.save(); this.events.onChange?.(this.snapshot(tab))
        }
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
    this.titleBuffers.delete(id)
    this.manager.kill(id)
    if (this.active === id) this.active = [...this.tabs.keys()].at(-1) ?? null
    this.save()
  }
  suspend(persist = true): void {
    this.stopped = true
    clearInterval(this.monitor)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      if (persist) {
        for (const tab of this.tabs.values()) { this.syncLaunch(tab); freezeTerminalIntegration(this.integrationDir(tab.id)) }
        this.save()
      }
    } finally { this.manager.killAll() }
  }
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const pending = `${this.file}.tmp`
    writeFileSync(pending, JSON.stringify({ tabs: [...this.tabs.values()], active: this.active }))
    renameSync(pending, this.file)
  }
}
