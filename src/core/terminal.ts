import type { IPty } from 'node-pty'
import { randomUUID } from 'crypto'
import type { ProjectSettings } from './workspace'

/** 연동: 프로젝트 폴더에서 셸·Claude Code·Codex를 실행하는 터미널 세션 관리. */
export type TerminalKind = 'shell' | 'claude' | 'codex'

export interface TerminalInfo {
  id: string
  kind: TerminalKind
  title: string
  pid: number
  sessionId?: string
  exited?: number
  groupId?: string
}

export interface TerminalSnapshot extends TerminalInfo {
  output: string
  sequence: number
}

export interface TerminalEvents {
  onData: (id: string, data: string, sequence?: number) => void
  onExit: (id: string, code: number) => void
  onError?: (message: string) => void
  onChange?: (info: TerminalInfo) => void
  /** 에이전트(Claude Code·Codex)가 응답 하나를 끝냈을 때 */
  onAgentDone?: (id: string) => void
  /** runCommand로 보낸 셸 명령이 끝났을 때 (출력은 시작·끝 표시 사이의 글) */
  onCommandDone?: (id: string, code: number, output: string) => void
}

const TITLES: Record<TerminalKind, string> = { shell: '터미널', claude: 'Claude Code', codex: 'Codex' }

/** ID를 셸 명령에 넣기 전에 검사한다. 명령 자체는 사용자가 설정한 셸 코드다. */
export function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) throw new Error('올바르지 않은 대화 ID입니다')
}

export function terminalCommand(kind: TerminalKind, settings: Partial<ProjectSettings> = {}, sessionId?: string): string | null {
  if (kind === 'shell') return null
  const start = (kind === 'claude' ? settings.claudeCommand : settings.codexCommand)?.trim() || kind
  if (!sessionId) return start
  validateSessionId(sessionId)
  const template = (kind === 'claude' ? settings.claudeResumeCommand : settings.codexResumeCommand)?.trim()
    || `${start} ${kind === 'claude' ? '--resume' : 'resume'} {sessionId}`
  if (!template.includes('{sessionId}')) throw new Error('대화 재개 명령에는 {sessionId}가 필요합니다')
  return template.replaceAll('{sessionId}', sessionId)
}

/** 앱이 다른 에이전트 안에서 실행됐을 때 그 세션 표시가 새 에이전트로 새지 않게 지운다. */
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue
    out[k] = v
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

export function defaultShell(platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

/** 셸 명령 뒤에 끝 표시를 붙인다. 입력 줄을 화면에 되돌려 보여줄 때는 표시가 이어져 보이지 않도록 둘로 나눠 적는다. */
export function markedCommand(command: string, platform = process.platform): string {
  // 시작 표시도 따로 찍어 그 사이를 명령 출력으로 잘라 낸다 (화면에 되비친 명령 줄은 표시를 쪼개 적어 걸리지 않는다)
  if (platform === 'win32')
    return `Write-Host ('__ORBIT' + '_BEGIN__'); ${command}; $__orbit = if ($?) { 0 } else { [Math]::Max(1, [int]$LASTEXITCODE) }; Write-Host ('__ORBIT' + '_DONE__:' + $__orbit)`
  return `echo "__ORBIT""_BEGIN__"; ${command}; echo "__ORBIT""_DONE__:$?"`
}

/** 시작·끝 표시 사이의 출력 (색·커서 제어를 뺀 글, 줄바꿈은 \n) */
export function commandOutput(raw: string): string {
  const m = raw.search(MARK)
  const end = m < 0 ? raw.length : m
  const b = raw.lastIndexOf(BEGIN, end)
  return raw
    .slice(b < 0 ? 0 : b + BEGIN.length, end)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .trim()
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const MARK = /__ORBIT_DONE__:(-?\d+)/
const BEGIN = '__ORBIT_BEGIN__'
/** 명령 출력은 이만큼만 (끝쪽을) 남긴다 */
const OUTPUT_MAX = 100_000

type Spawn = typeof import('node-pty').spawn

interface Term {
  pty: IPty
  info: TerminalInfo
  output: string
  sequence: number
  lastData: number
  sawData: boolean
  /** Claude Code가 SessionStart 훅으로 입력 준비를 알렸는지 */
  ready: boolean
  /** 준비 신호를 기다려야 하는지 (훅을 붙여 실행한 Claude Code) */
  signals: boolean
  /** runCommand 후 끝 표시를 찾는 중인 출력 꼬리 */
  scan?: string
  /** runCommand 후의 출력 (색·커서 제어를 뺀 글) */
  out?: string
}

export class TerminalManager {
  private terms = new Map<string, Term>()

  constructor(
    private spawn: Spawn,
    private events: TerminalEvents,
    private now: () => number = Date.now
  ) {}

  /**
   * 셸을 열고, Claude Code·Codex면 그 셸 안에서 실행한다 (에이전트가 끝나도 셸은 남는다).
   * signals: 실행 명령에 응답 끝·준비 신호 훅이 붙어 있다 (IN-F10).
   */
  create(kind: TerminalKind, cwd: string, cols = 100, rows = 30, settings: Partial<ProjectSettings> = {}, sessionId?: string, title = TITLES[kind], options: { id?: string; env?: Record<string, string>; command?: string; output?: string; init?: string; signals?: boolean } = {}): TerminalInfo {
    if (!Object.hasOwn(TITLES, kind)) throw new Error('지원하지 않는 터미널 종류입니다')
    const start = options.command ?? terminalCommand(kind, settings, sessionId)
    const { file, args } = defaultShell()
    if (options.init && process.platform === 'win32') args.push('-NoExit', '-Command', options.init)
    const id = options.id ?? `term-${randomUUID()}`
    const pty = this.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...cleanEnv(process.env), ...options.env } })
    const info: TerminalInfo = { id, kind, title, pid: pty.pid, ...(sessionId ? { sessionId } : {}) }
    const entry: Term = { pty, info, output: options.output ?? '', sequence: 0, lastData: this.now(), sawData: false, ready: false, signals: !!options.signals }
    this.terms.set(id, entry)
    pty.onData((d) => {
      if (this.terms.get(id) !== entry) return
      entry.output = (entry.output + d).slice(-200000)
      entry.lastData = this.now()
      entry.sawData = true
      this.events.onData(id, d, ++entry.sequence)
      if (entry.scan !== undefined) this.scanOutput(id, entry, d)
    })
    pty.onExit(({ exitCode }) => {
      if (this.terms.get(id) !== entry) return
      this.terms.delete(id)
      this.events.onExit(id, exitCode)
    })
    if (options.init && process.platform !== 'win32') pty.write(`${options.init}\r`)
    if (start) pty.write(`${start}\r`)
    return info
  }

  private scanOutput(id: string, term: Term, data: string) {
    const plain = data.replace(ANSI, '')
    term.scan = (term.scan + plain).slice(-400)
    term.out = ((term.out ?? '') + plain).slice(-OUTPUT_MAX)
    const m = term.scan.match(MARK)
    if (!m) return
    const output = commandOutput(term.out)
    term.scan = undefined
    term.out = undefined
    this.events.onCommandDone?.(id, Number(m[1]), output)
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.pty.write(data)
  }

  /** 에이전트 입력창에 글을 붙여 넣고 보낸다. 여러 줄이 한 번에 들어가도록 bracketed paste로 감싼다. */
  submit(id: string, text: string, kind?: TerminalKind): void {
    const t = this.terms.get(id)
    if (!t) throw new Error(`터미널을 찾을 수 없습니다: ${id}`)
    t.pty.write(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`)
    // Windows Codex는 긴 paste를 개별 키로 받아 마지막 Enter도 줄바꿈으로 삼는다.
    // Ctrl+E는 내용을 바꾸지 않고 paste 버퍼를 확정하고, 뒤의 Enter를 전송으로 구분한다.
    const submit = (kind ?? t.info.kind) === 'codex' ? '\x05\r' : '\r'
    setTimeout(() => {
      if (this.terms.get(id) === t) t.pty.write(submit)
    }, 400)
  }

  /** 셸 명령을 실행하고, 끝나면 onCommandDone(종료 코드)으로 알린다. 여러 줄이면 한 줄로 잇는다. */
  runCommand(id: string, command: string): void {
    const t = this.terms.get(id)
    if (!t) throw new Error(`터미널을 찾을 수 없습니다: ${id}`)
    const line = command
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('; ')
    t.scan = ''
    t.out = ''
    t.pty.write(`${markedCommand(line)}\r`)
  }

  /** Claude Code의 SessionStart 훅이 입력 준비를 알렸다 */
  markReady(id: string): void {
    const t = this.terms.get(id)
    if (t) t.ready = true
  }

  /**
   * 입력을 받을 준비가 될 때까지 기다린다: 출력이 잠시 멈추면 준비된 것으로 본다.
   * 훅을 붙인 Claude Code는 SessionStart 신호를 받은 뒤에 출력이 멈춰야 한다. 너무 오래 걸리면 그냥 넘어간다.
   */
  async whenReady(id: string, quietMs = 1500, maxMs = 30000): Promise<void> {
    const start = this.now()
    for (;;) {
      const t = this.terms.get(id)
      if (!t) throw new Error(`터미널이 닫혔습니다: ${id}`)
      const quiet = this.now() - t.lastData
      const needsSignal = t.info.kind === 'claude' && t.signals
      if (needsSignal ? t.ready && quiet >= 700 : t.sawData && quiet >= quietMs) return
      if (this.now() - start > maxMs) return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  has(id: string): boolean {
    return this.terms.has(id)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terms.get(id)?.pty.resize(cols, rows)
  }

  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    t.pty.kill()
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info)
  }

  snapshot(id: string): TerminalSnapshot | undefined {
    const t = this.terms.get(id)
    return t ? { ...t.info, output: t.output, sequence: t.sequence } : undefined
  }

  rename(id: string, title: string): TerminalInfo {
    const t = this.terms.get(id)
    if (!t) throw new Error('실행 중인 터미널을 찾을 수 없습니다')
    if (!title.trim() || title.trim().length > 100) throw new Error('세션 이름은 1~100자로 입력해 주세요')
    t.info = { ...t.info, title: title.trim() }
    return t.info
  }
}
