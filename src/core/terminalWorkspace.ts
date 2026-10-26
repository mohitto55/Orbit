import { existsSync, mkdirSync, promises as fs, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { TerminalManager, terminalCommand, validateSessionId, type TerminalActivity, type TerminalEvents, type TerminalInfo, type TerminalKind, type TerminalSnapshot } from './terminal'
import { encodeClaudeProjectDir } from './drift'
import { codexMetadataFiles, readCodexMetadata, sameProjectPath } from './sessionMetadata'
import { beginOutputCapture, endOutputCapture, readAgentOutput, freezeTerminalIntegration, prepareTerminalIntegration, readCliLaunch, resumeOptions, shellQuote, takeAgentSignals, type CliLaunch } from './terminalIntegration'
import type { Ctx, ProjectSettings } from './workspace'

interface SavedTab {
  id: string
  kind: TerminalKind
  /** Orbit의 고정 표시 이름. CLI 세션 제목과 동기화하지 않는다. */
  title: string
  sessionId?: string
  cols: number
  rows: number
  output: string
  createdAt: number
  exited?: number
  launch?: CliLaunch
  codexPrefix?: string
  groupId?: string
  activity?: TerminalActivity
  activityRevision?: number
}

export interface TerminalGroup {
  id: string
  title: string
}

export interface TerminalLayout {
  tabs: TerminalInfo[]
  groups: TerminalGroup[]
  active: string | null
  /** all: 전체, ungrouped: 미분류, 그 외에는 그룹 ID */
  activeGroup: string
}

export interface TerminalState extends TerminalLayout {
  tabs: TerminalSnapshot[]
}

export type TerminalOrderPosition = 'before' | 'after'

function reorder<T extends { id: string }>(items: T[], id: string, targetId: string, position: TerminalOrderPosition): T[] {
  if (position !== 'before' && position !== 'after') throw new Error('이동 위치가 올바르지 않습니다')
  const item = items.find((entry) => entry.id === id)
  if (!item || !items.some((entry) => entry.id === targetId)) throw new Error('순서를 바꿀 항목을 찾을 수 없습니다')
  if (id === targetId) return items
  const ordered = items.filter((entry) => entry.id !== id)
  const index = ordered.findIndex((entry) => entry.id === targetId) + (position === 'after' ? 1 : 0)
  ordered.splice(index, 0, item)
  return ordered
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
  private groups: TerminalGroup[] = []
  private activeGroup = 'all'
  private manager: TerminalManager
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private restoring = false
  private restoreLaunches = new Map<string, CliLaunch | undefined>()
  private binding: Promise<void> | null = null
  private nextBind = 0
  private monitor: NodeJS.Timeout
  private titleBuffers = new Map<string, string>()
  private codexStatusTabs = new Set<string>()
  private shellPastes = new Set<string>()
  private commands = new Set<string>()

  constructor(private file: string, private ctx: Ctx, spawn: typeof import('node-pty').spawn, private events: TerminalEvents) {
    this.manager = new TerminalManager(spawn, {
      onData: (id, data, sequence) => {
        const tab = this.tabs.get(id)
        if (!tab) return
        tab.output = (tab.output + data).slice(-200000)
        const titles = (this.titleBuffers.get(id) ?? '') + data
        const matches = [...titles.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)]
        // 완성된 제목은 한 번만 처리한다. 다음 출력에서 이전 작업 상태가 재생되면 안 된다.
        const last = matches.at(-1)
        const tail = titles.slice(last ? last.index! + last[0].length : 0)
        const pending = tail.lastIndexOf('\x1b]')
        this.titleBuffers.set(id, pending >= 0 && tail.length - pending <= 8192 ? tail.slice(pending) : tail.endsWith('\x1b') ? '\x1b' : '')
        try {
          if (matches.length) {
            this.syncLaunch(tab)
            for (const match of matches) {
              const title = match[1]
              if (tab.kind === 'shell' && !this.commands.has(id) && /^orbit:shell:ready(?::\d+)?$/.test(title)) this.finishActivity(tab)
              if (tab.kind === 'codex') {
                const prefix = title.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{1,12})(?:\.\.\.|\s|$)/i)?.[1]
                if (prefix && prefix !== tab.codexPrefix) { tab.codexPrefix = prefix; this.nextBind = 0; this.save() }
                // Windows ConPTY도 전달하는 OSC 제목의 상태만 읽는다. 방 이름은 바꾸지 않는다.
                const status = title.match(/(?:^|[|·]\s*)(Working|Thinking|Waiting|Ready)$/)?.[1]
                if (status) {
                  this.codexStatusTabs.add(id)
                  if (status === 'Ready') this.finishActivity(tab)
                  else this.setActivity(tab, 'working')
                }
              }
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
        this.commands.delete(id)
        const tab = this.tabs.get(id)
        if (tab) {
          tab.exited = code
          if (tab.activity === 'working') this.setActivity(tab, 'idle')
        }
        this.save()
        events.onExit(id, code)
      },
      onCommandDone: (id, code, output) => {
        this.commands.delete(id)
        const tab = this.tabs.get(id)
        if (tab) this.finishActivity(tab)
        events.onCommandDone?.(id, code, output)
      }
    })
    this.monitor = setInterval(() => {
      if (this.restoring) return
      try {
        for (const tab of this.tabs.values()) this.syncLaunch(tab)
        // IN-F10: 훅이 남긴 작업·준비 신호
        for (const tab of this.tabs.values()) {
          if (tab.exited !== undefined) continue
          const dir = this.integrationDir(tab.id)
          for (const signal of takeAgentSignals(dir)) {
            if (signal === 'ready') this.manager.markReady(tab.id)
            if (signal === 'working') this.setActivity(tab, 'working')
            if (signal === 'idle') this.setActivity(tab, 'idle')
            if (signal === 'done') {
              // Codex 상태 제목과 notify가 같은 완료를 두 번 알리지 않게 한다.
              if (tab.kind !== 'codex' || !this.codexStatusTabs.has(tab.id)) this.finishActivity(tab)
              this.events.onAgentDone?.(tab.id)
            }
          }
        }
      } catch (e) { this.events.onError?.(`세션 상태 저장 실패: ${String(e)}`) }
      void this.bindCodex().catch((e: unknown) => this.events.onError?.(`세션 ID 연결 실패: ${String(e)}`))
    }, 500)
    this.monitor.unref()
  }

  async restore(settings: ProjectSettings): Promise<void> {
    this.restoring = true
    try {
      let raw: string
      try { raw = await fs.readFile(this.file, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (this.stopped) return
      const saved = JSON.parse(raw) as { tabs?: SavedTab[]; active?: string; groups?: TerminalGroup[]; activeGroup?: string }
      if (!Array.isArray(saved.tabs)) throw new Error('터미널 저장 파일을 읽을 수 없습니다')
      // 그룹이 없는 구버전 저장 파일은 모든 탭을 미분류로 복원한다.
      if (saved.groups !== undefined) {
        if (!Array.isArray(saved.groups) || saved.groups.some((g) => !g || !/^group-[a-f0-9-]{36}$/.test(g.id) || typeof g.title !== 'string' || !g.title.trim() || g.title.length > 100) || new Set(saved.groups.map((g) => g.id)).size !== saved.groups.length) throw new Error('터미널 그룹 저장 정보가 올바르지 않습니다')
        this.groups = saved.groups.map((g) => ({ id: g.id, title: g.title.trim() }))
      }
      for (const tab of saved.tabs) {
        if (!/^term-[a-f0-9-]{36}$/.test(tab.id) || !['shell', 'claude', 'codex'].includes(tab.kind) || typeof tab.title !== 'string') throw new Error('터미널 저장 정보가 올바르지 않습니다')
        if (tab.sessionId) validateSessionId(tab.sessionId)
        this.tabs.set(tab.id, { ...tab, activity: tab.activity === 'completed' ? 'completed' : 'idle', activityRevision: Number.isSafeInteger(tab.activityRevision) && tab.activityRevision! >= 0 ? tab.activityRevision : 0, groupId: this.groups.some((g) => g.id === tab.groupId) ? tab.groupId : undefined, output: typeof tab.output === 'string' ? tab.output.slice(-200000) : '' })
      }
      this.activeGroup = saved.activeGroup === 'ungrouped' || this.groups.some((g) => g.id === saved.activeGroup) ? saved.activeGroup! : 'all'
      this.active = this.tabs.has(saved.active ?? '') ? saved.active! : [...this.tabs.keys()].at(-1) ?? null
      this.reconcileActive()
      for (const tab of this.tabs.values()) this.syncLaunch(tab)
      await this.bindCodex()
      // 하나씩 복원하며 이벤트 루프를 돌려 프로젝트 화면과 닫기 요청이 응답하게 한다.
      const ordered = [...this.tabs.values()].sort((a, b) => Number(b.id === this.active) - Number(a.id === this.active))
      for (const tab of ordered) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (this.stopped) return
        if (tab.exited !== undefined) continue
        this.restoreLaunches.set(tab.id, readCliLaunch(this.integrationDir(tab.id)))
        try { this.launch(tab, settings, true) } catch (e) {
          tab.exited = -1
          tab.output += `\r\n[세션 복원 실패: ${e instanceof Error ? e.message : String(e)}]\r\n`
        }
      }
    } finally { this.restoring = false; this.restoreLaunches.clear() }
    this.save()
  }

  /** 작업 그래프에서 지정한 세션이 이미 실행 중이면 그 탭을 그대로 쓴다. */
  async open(kind: TerminalKind, settings: ProjectSettings, options: { title?: string; resume?: string } = {}): Promise<TerminalSnapshot & { reused: boolean }> {
    if (options.resume && kind !== 'shell') {
      validateSessionId(options.resume)
      for (const tab of this.tabs.values()) this.syncLaunch(tab)
      if (kind === 'codex') await this.bindCodex(true)
    }
    if (this.stopped) throw new Error('터미널 작업 공간이 닫혔습니다')
    // 조회와 생성 사이에 기다리지 않아 동시에 같은 세션을 열어도 탭은 하나만 생긴다.
    const existing = options.resume && kind !== 'shell'
      ? [...this.tabs.values()].find((tab) => tab.kind === kind && tab.sessionId === options.resume && (!tab.codexPrefix || tab.sessionId?.startsWith(tab.codexPrefix)) && this.manager.has(tab.id))
      : undefined
    return existing
      ? { ...this.snapshot(existing), reused: true }
      : { ...this.create(kind, settings, undefined, undefined, options), reused: false }
  }

  /** 새 탭을 연다. resume을 주면 로컬에 저장된 그 대화를 이어서 연다. */
  create(kind: TerminalKind, settings: ProjectSettings, cols = 100, rows = 30, options: { title?: string; resume?: string } = {}): TerminalSnapshot {
    if (!['shell', 'claude', 'codex'].includes(kind)) throw new Error('지원하지 않는 터미널 종류입니다')
    if (options.resume) validateSessionId(options.resume)
    const resume = kind === 'shell' ? undefined : options.resume
    const tab: SavedTab = { id: `term-${randomUUID()}`, kind, title: options.title ?? { shell: '터미널', claude: 'Claude Code', codex: 'Codex' }[kind], cols, rows, output: '', createdAt: Date.now(), ...(resume ? { sessionId: resume } : kind === 'claude' ? { sessionId: randomUUID() } : {}), ...(this.groups.some((g) => g.id === this.activeGroup) ? { groupId: this.activeGroup } : {}) }
    this.tabs.set(tab.id, tab)
    try { this.launch(tab, settings, !!resume) } catch (e) { this.tabs.delete(tab.id); throw e }
    this.active = tab.id
    this.save()
    return this.snapshot(tab)
  }

  private launch(tab: SavedTab, settings: ProjectSettings, restoring: boolean): void {
    this.codexStatusTabs.delete(tab.id)
    this.shellPastes.delete(tab.id)
    this.commands.delete(tab.id)
    this.titleBuffers.delete(tab.id)
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
    if (tab.kind === 'codex' && command) command += ` -c ${shellQuote("tui.terminal_title=['session-id','status']")} -c ${shellQuote(integration.codexNotify)}`
    if (tab.kind === 'claude' && command) command += ` --settings ${shellQuote(integration.claudeSettings)}`
    // 새 셸의 준비 상태가 기존 launch 인자를 지우지 않도록 시작 이벤트 전에는 비교만 한다.
    const previousLaunch = tab.launch
    tab.launch = readCliLaunch(this.integrationDir(tab.id))
    if (tab.launch && previousLaunch) tab.launch = { ...tab.launch, args: previousLaunch.args, home: previousLaunch.home }
    this.manager.create(tab.kind, cwd, tab.cols, tab.rows, settings, tab.sessionId, tab.title, {
      id: tab.id, command: command ?? undefined, output: tab.output, init: integration.init, signals: tab.kind === 'claude' && !!command,
      env: { ...integration.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `orbit-${tab.id}`, ...(tab.launch?.home ? { [tab.kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: tab.launch.home } : {}) }
    })
  }

  private integrationDir(id: string): string { return path.join(`${this.file}.sessions`, id) }

  beginOutputCapture(id: string): void {
    if (!this.manager.has(id)) throw new Error('터미널이 닫혔습니다')
    beginOutputCapture(this.integrationDir(id))
  }
  readAgentOutput(id: string): string | undefined { return readAgentOutput(this.integrationDir(id)) }
  endOutputCapture(id: string): void { endOutputCapture(this.integrationDir(id)) }

  private syncLaunch(tab: SavedTab): void {
    if (tab.exited !== undefined) return
    const launch = readCliLaunch(this.integrationDir(tab.id))
    if (!launch || JSON.stringify(tab.launch) === JSON.stringify(launch)) return
    if (launch.running && launch.runId !== tab.launch?.runId) {
      // 셸에서 CLI를 켠 명령과, CLI에 실제 작업을 요청한 상태를 구분한다.
      if (tab.activity === 'working') this.setActivity(tab, 'idle')
      delete tab.sessionId
      delete tab.codexPrefix
      this.titleBuffers.delete(tab.id)
      this.codexStatusTabs.delete(tab.id)
    }
    if (!launch.running) {
      if (tab.activity === 'working') this.setActivity(tab, 'idle')
      tab.kind = 'shell'
      delete tab.sessionId
      delete tab.codexPrefix
    } else {
      tab.kind = launch.kind
      if (launch.sessionId) { validateSessionId(launch.sessionId); tab.sessionId = launch.sessionId }
    }
    tab.launch = launch
    this.save()
    this.events.onChange?.(this.info(tab))
  }

  private bindCodex(force = false): Promise<void> {
    if (this.binding) return this.binding.then(() => force ? this.bindCodex(true) : undefined)
    if (this.stopped || (!force && Date.now() < this.nextBind)) return Promise.resolve()
    const codexTabs = [...this.tabs.values()].filter((tab) => tab.kind === 'codex' && tab.exited === undefined)
    if (!codexTabs.length) return Promise.resolve()
    this.nextBind = Date.now() + 5000
    this.binding = (async () => {
      for (const tab of codexTabs) {
        const prefix = tab.codexPrefix
        if (tab.sessionId && (!prefix || tab.sessionId.startsWith(prefix))) continue
        const id = await findCodexSession(tab.launch?.cwd ?? this.ctx.projectDir, tab.id, tab.launch?.home, tab.createdAt, prefix)
        if (id && id !== tab.sessionId && prefix === tab.codexPrefix && !this.stopped && this.tabs.has(tab.id)) {
          tab.sessionId = id; this.save(); this.events.onChange?.(this.info(tab))
        }
      }
    })().finally(() => { this.binding = null })
    return this.binding
  }

  private snapshot(tab: SavedTab): TerminalSnapshot {
    const live = this.manager.snapshot(tab.id)
    return { id: tab.id, kind: tab.kind, title: tab.title, activity: tab.activity ?? 'idle', activityRevision: tab.activityRevision ?? 0, pid: live?.pid ?? 0, sessionId: tab.sessionId, groupId: tab.groupId, output: live?.output ?? tab.output, sequence: live?.sequence ?? 0, ...(tab.exited === undefined ? {} : { exited: tab.exited }) }
  }

  private info(tab: SavedTab): TerminalInfo {
    const { output, sequence, ...info } = this.snapshot(tab)
    return info
  }

  private setActivity(tab: SavedTab, activity: TerminalActivity): void {
    if (this.stopped || (tab.activity ?? 'idle') === activity) return
    tab.activity = activity
    tab.activityRevision = (tab.activityRevision ?? 0) + 1
    this.save()
    this.events.onChange?.(this.info(tab))
  }

  private finishActivity(tab: SavedTab): void {
    if (tab.activity === 'working') this.setActivity(tab, 'completed')
  }

  markDone(id: string): void {
    const tab = this.tabs.get(id)
    if (tab) this.finishActivity(tab)
  }

  /** 화면이 실제로 표시한 완료만 확인한다. 늦은 확인 요청이 다음 작업을 지우지 않는다. */
  acknowledge(id: string, revision: number): void {
    const tab = this.tabs.get(id)
    if (tab?.activity === 'completed' && tab.activityRevision === revision) this.setActivity(tab, 'idle')
  }

  /** 그룹 전환에는 탭 정보만 보낸다. 터미널 출력은 다시 전송하거나 재생하지 않는다. */
  layout(): TerminalLayout {
    return {
      tabs: [...this.tabs.values()].map((tab) => this.info(tab)),
      groups: this.groups.map((g) => ({ ...g })), active: this.active, activeGroup: this.activeGroup
    }
  }

  state(): TerminalState { return { ...this.layout(), tabs: [...this.tabs.values()].map((tab) => this.snapshot(tab)) } }

  private inActiveGroup(tab: SavedTab): boolean {
    return this.activeGroup === 'all' || (this.activeGroup === 'ungrouped' ? !tab.groupId : tab.groupId === this.activeGroup)
  }

  private reconcileActive(): void {
    const visible = [...this.tabs.values()].filter((tab) => this.inActiveGroup(tab))
    if (!visible.some((tab) => tab.id === this.active)) this.active = visible.at(-1)?.id ?? null
  }

  selectGroup(id: string): TerminalLayout {
    if (id !== 'all' && id !== 'ungrouped' && !this.groups.some((g) => g.id === id)) throw new Error('터미널 그룹을 찾을 수 없습니다')
    this.activeGroup = id
    this.reconcileActive()
    this.save()
    return this.layout()
  }

  private groupTitle(title: string, except?: string): string {
    const trimmed = title.trim()
    if (!trimmed || trimmed.length > 100) throw new Error('그룹 이름은 1~100자로 입력해 주세요')
    if (['전체', '미분류'].includes(trimmed) || this.groups.some((g) => g.id !== except && g.title.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new Error('이미 사용 중인 그룹 이름입니다')
    return trimmed
  }

  createGroup(title: string): TerminalLayout {
    const group = { id: `group-${randomUUID()}`, title: this.groupTitle(title) }
    this.groups.push(group)
    return this.selectGroup(group.id)
  }

  renameGroup(id: string, title: string): TerminalLayout {
    const group = this.groups.find((g) => g.id === id)
    if (!group) throw new Error('터미널 그룹을 찾을 수 없습니다')
    group.title = this.groupTitle(title, id)
    this.save()
    return this.layout()
  }

  deleteGroup(id: string): TerminalLayout {
    if (!this.groups.some((g) => g.id === id)) throw new Error('터미널 그룹을 찾을 수 없습니다')
    this.groups = this.groups.filter((g) => g.id !== id)
    for (const tab of this.tabs.values()) if (tab.groupId === id) delete tab.groupId
    if (this.activeGroup === id) this.activeGroup = 'ungrouped'
    this.reconcileActive()
    this.save()
    return this.layout()
  }

  moveToGroup(id: string, groupId: string | null): TerminalLayout {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('터미널을 찾을 수 없습니다')
    if (groupId !== null && !this.groups.some((g) => g.id === groupId)) throw new Error('터미널 그룹을 찾을 수 없습니다')
    tab.groupId = groupId ?? undefined
    this.reconcileActive()
    this.save()
    return this.layout()
  }

  /** 표시 순서만 바꾼다. 탭의 그룹·활성 상태와 실행 중인 프로세스는 유지한다. */
  reorderTab(id: string, targetId: string, position: TerminalOrderPosition): TerminalLayout {
    const ordered = reorder([...this.tabs.values()], id, targetId, position)
    this.tabs = new Map(ordered.map((tab) => [tab.id, tab]))
    this.save()
    return this.layout()
  }

  reorderGroup(id: string, targetId: string, position: TerminalOrderPosition): TerminalLayout {
    this.groups = reorder(this.groups, id, targetId, position)
    this.save()
    return this.layout()
  }

  async restart(id: string, settings: ProjectSettings): Promise<TerminalSnapshot> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('터미널을 찾을 수 없습니다')
    await this.bindCodex()
    this.manager.kill(id)
    if (tab.activity === 'working') this.setActivity(tab, 'idle')
    delete tab.exited
    this.launch(tab, settings, true)
    this.activate(id)
    return this.snapshot(tab)
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id)
    if (tab && this.manager.has(id)) {
      if (data.includes('\x1b[200~')) this.shellPastes.add(id)
      if (tab.kind === 'shell' && !this.shellPastes.has(id) && data.endsWith('\r') && !data.endsWith('\x1b\r')) this.setActivity(tab, 'working')
      if (data.includes('\x1b[201~')) this.shellPastes.delete(id)
      if (data === '\x03' && tab.activity === 'working') {
        this.commands.delete(id)
        this.setActivity(tab, 'idle')
      }
    }
    this.manager.write(id, data)
  }
  /** IN-F11: 작업 그래프가 터미널에 프롬프트·명령을 보낸다 */
  has(id: string): boolean { return this.manager.has(id) }
  get(id: string): TerminalInfo | undefined {
    const tab = this.tabs.get(id)
    if (!tab || !this.manager.has(id)) return undefined
    this.syncLaunch(tab)
    return this.info(tab)
  }
  whenReady(id: string): Promise<void> { return this.manager.whenReady(id) }
  submit(id: string, text: string): void {
    const tab = this.tabs.get(id)
    this.manager.submit(id, text, tab?.kind)
    if (tab) this.setActivity(tab, 'working')
  }
  runCommand(id: string, command: string): void {
    this.commands.add(id)
    try { this.manager.runCommand(id, command) }
    catch (error) { this.commands.delete(id); throw error }
    const tab = this.tabs.get(id)
    if (tab) this.setActivity(tab, 'working')
  }
  resize(id: string, cols: number, rows: number): void {
    this.manager.resize(id, cols, rows)
    const tab = this.tabs.get(id)
    if (tab && cols > 0 && rows > 0) { tab.cols = cols; tab.rows = rows }
  }
  activate(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (!this.inActiveGroup(tab)) this.activeGroup = tab.groupId ?? 'ungrouped'
    this.active = id
    this.save()
  }
  rename(id: string, title: string): TerminalSnapshot {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('터미널을 찾을 수 없습니다')
    if (!title.trim() || title.trim().length > 100) throw new Error('터미널 이름은 1~100자로 입력해 주세요')
    tab.title = title.trim()
    this.save()
    return this.snapshot(tab)
  }
  kill(id: string): void {
    this.tabs.delete(id)
    this.titleBuffers.delete(id)
    this.codexStatusTabs.delete(id)
    this.shellPastes.delete(id)
    this.commands.delete(id)
    this.manager.kill(id)
    this.reconcileActive()
    this.save()
  }
  suspend(persist = true): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.monitor)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      if (persist) {
        if (this.restoring) {
          // 중단된 재접속의 새 generation/종료 훅이 원래 CLI 세션을 셸로 바꾸지 않게 한다.
          for (const [id, launch] of this.restoreLaunches) {
            const state = path.join(this.integrationDir(id), 'state.json')
            if (launch) writeFileSync(state, JSON.stringify({ ...launch, frozen: true }))
            else rmSync(state, { force: true })
          }
        } else {
          for (const tab of this.tabs.values()) { this.syncLaunch(tab); freezeTerminalIntegration(this.integrationDir(tab.id)) }
          this.save()
        }
      }
    } finally { this.manager.killAll() }
  }
  private save(): void {
    // 복원 중 탭마다 전체 출력 파일을 다시 쓰지 않는다. 중단돼도 원본은 보존한다.
    if (this.restoring) return
    mkdirSync(path.dirname(this.file), { recursive: true })
    const pending = `${this.file}.tmp`
    writeFileSync(pending, JSON.stringify({ tabs: [...this.tabs.values()], groups: this.groups, active: this.active, activeGroup: this.activeGroup }))
    renameSync(pending, this.file)
  }
}
