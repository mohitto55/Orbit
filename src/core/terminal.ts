import type { IPty } from 'node-pty'

/** 연동: 프로젝트 폴더에서 셸·Claude Code·Codex를 실행하는 터미널 세션 관리. */
export type TerminalKind = 'shell' | 'claude' | 'codex'

export interface TerminalInfo {
  id: string
  kind: TerminalKind
  title: string
  pid: number
}

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string, code: number) => void
}

const TITLES: Record<TerminalKind, string> = { shell: '터미널', claude: 'Claude Code', codex: 'Codex' }
const START: Record<TerminalKind, string | null> = { shell: null, claude: 'claude', codex: 'codex' }

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
  private terms = new Map<string, { pty: IPty; info: TerminalInfo }>()
  private seq = 0

  constructor(
    private spawn: Spawn,
    private events: TerminalEvents
  ) {}

  /** 셸을 열고, Claude Code·Codex면 그 셸 안에서 실행한다 (에이전트가 끝나도 셸은 남는다). */
  create(kind: TerminalKind, cwd: string, cols = 100, rows = 30): TerminalInfo {
    const { file, args } = defaultShell()
    const pty = this.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: cleanEnv(process.env) })
    const id = `term-${++this.seq}`
    const info: TerminalInfo = { id, kind, title: TITLES[kind], pid: pty.pid }
    this.terms.set(id, { pty, info })
    pty.onData((d) => this.events.onData(id, d))
    pty.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.events.onExit(id, exitCode)
    })
    const start = START[kind]
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
}
