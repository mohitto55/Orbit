import { describe, expect, it } from 'vitest'
import { spawn } from 'node-pty'
import { TerminalManager, cleanEnv } from '../src/core/terminal'
import { tempDir } from './helpers'

function setup() {
  const out = new Map<string, string>()
  const exits = new Map<string, number>()
  const mgr = new TerminalManager(spawn, {
    onData: (id, d) => out.set(id, (out.get(id) ?? '') + d),
    onExit: (id, code) => exits.set(id, code)
  })
  return { mgr, out, exits }
}

const waitFor = async (cond: () => boolean, ms = 15000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('시간 초과')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('연동 · 터미널', () => {
  it('[IN-F09-AC1] 프로젝트 폴더에서 셸을 열고 입력을 실행한다', async () => {
    const { mgr, out } = setup()
    const cwd = await tempDir('term-')
    const t = mgr.create('shell', cwd, 120, 30)
    mgr.write(t.id, 'echo girsktop-term-ok\r')
    await waitFor(() => (out.get(t.id) ?? '').includes('girsktop-term-ok'))
    expect(mgr.list().map((x) => x.id)).toContain(t.id)
    mgr.killAll()
  }, 30000)

  it('[IN-F09-AC4] 탭을 닫으면 프로세스가 종료되고 목록에서 빠진다', async () => {
    const { mgr } = setup()
    const t = mgr.create('shell', await tempDir('term-'))
    mgr.kill(t.id)
    expect(mgr.list()).toHaveLength(0)
  }, 30000)

  it('[IN-F09-AC5] 다른 에이전트 세션 표시는 새 터미널 환경으로 넘기지 않는다', () => {
    const env = cleanEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', HOME: 'h' })
    expect(env).toMatchObject({ PATH: 'x', HOME: 'h', TERM: 'xterm-256color' })
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
  })
})
