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
}

export interface TerminalSnapshot extends TerminalInfo {
  output: string
  sequence: number
}

export interface TerminalEvents {
  onData: (id: string, data: string, sequence?: number) => void
  onExit: (id: string, code: number) => void
  onError?: (message: string) => void
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

type Spawn = typeof import('node-pty').spawn

export class TerminalManager {
  private terms = new Map<string, { pty: IPty; info: TerminalInfo; output: string; sequence: number }>()

  constructor(
    private spawn: Spawn,
    private events: TerminalEvents
  ) {}

  /** 셸을 열고, Claude Code·Codex면 그 셸 안에서 실행한다 (에이전트가 끝나도 셸은 남는다). */
  create(kind: TerminalKind, cwd: string, cols = 100, rows = 30, settings: Partial<ProjectSettings> = {}, sessionId?: string, title = TITLES[kind], options: { id?: string; env?: Record<string, string>; command?: string; output?: string } = {}): TerminalInfo {
    if (!Object.hasOwn(TITLES, kind)) throw new Error('지원하지 않는 터미널 종류입니다')
    const start = options.command ?? terminalCommand(kind, settings, sessionId)
    const { file, args } = defaultShell()
    const id = options.id ?? `term-${randomUUID()}`
    const pty = this.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...cleanEnv(process.env), ...options.env } })
    const info: TerminalInfo = { id, kind, title, pid: pty.pid, ...(sessionId ? { sessionId } : {}) }
    const entry = { pty, info, output: options.output ?? '', sequence: 0 }
    this.terms.set(id, entry)
    pty.onData((d) => {
      if (this.terms.get(id) !== entry) return
      entry.output = (entry.output + d).slice(-200000)
      this.events.onData(id, d, ++entry.sequence)
    })
    pty.onExit(({ exitCode }) => {
      if (this.terms.get(id) !== entry) return
      this.terms.delete(id)
      this.events.onExit(id, exitCode)
    })
    if (start) pty.write(`${start}\r`)
    return info
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.pty.write(data)
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
