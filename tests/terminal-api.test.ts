import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { createApi } from '../src/main/api'
import { encodeClaudeProjectDir } from '../src/core/drift'
import { tempDir } from './helpers'

const ptys = vi.hoisted(() => [] as (IPty & { emit: (data: string) => void })[])
vi.mock('node-pty', () => ({ spawn: vi.fn((): IPty => {
  let data: (chunk: string) => void = () => {}
  const pty = {
    pid: ptys.length + 1, cols: 100, rows: 30, process: 'shell', handleFlowControl: false,
    onData: (fn: (chunk: string) => void) => { data = fn; return { dispose() {} } },
    onExit: () => ({ dispose() {} }), emit: (chunk: string) => data(chunk),
    write: vi.fn(), resize: vi.fn(), clear() {}, kill: vi.fn(), pause() {}, resume() {}
  }
  ptys.push(pty)
  return pty
}) }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); ptys.length = 0 })

describe('터미널 자동 복원', () => {
  it('[TE-F01-AC3] 재시작하면 프로젝트와 탭·이름·활성 탭·각 대화 ID를 자동 복원한다 [TE-F01-AC4]', async () => {
    const home = await tempDir('terminal-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'orbit', 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const projectDir = await tempDir('terminal-project-')
    await api.createProject(projectDir)
    await api.saveSettings({ ...await api.getSettings(), codexCommand: 'my-codex --profile work', codexResumeCommand: 'my-codex resume {sessionId} --profile work' })
    const [codex, claude, closed] = await Promise.all([api.termCreate('codex', 120, 40), api.termCreate('claude'), api.termCreate('shell')])
    const claudePty = ptys.find((pty) => pty.pid === claude.pid)!
    expect(claudePty.write).toHaveBeenCalledWith(`claude --session-id ${claude.sessionId}\r`)
    expect(ptys.find((pty) => pty.pid === codex.pid)!.write).toHaveBeenCalledWith('my-codex --profile work --no-daemon\r')
    const { spawn } = await import('node-pty')
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: projectDir, cols: 120, rows: 40, env: expect.objectContaining({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `orbit-${codex.id}` }) }))
    const codexRoot = path.join(home, '.codex', 'sessions')
    await fs.mkdir(codexRoot, { recursive: true })
    await fs.writeFile(path.join(codexRoot, 'mine.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'native-codex-id', cwd: projectDir, originator: `orbit-${codex.id}`, source: 'cli' } }) + '\n')
    // 본문은 복원에 필요 없다. Claude는 정확한 ID의 기록 유무만 확인한다.
    const claudeRoot = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectDir))
    await fs.mkdir(claudeRoot, { recursive: true })
    await fs.writeFile(path.join(claudeRoot, `${claude.sessionId}.jsonl`), '')
    await api.termRename(codex.id, '결제 작업')
    await api.termRename(claude.id, '기획 검토')
    await api.termActivate(codex.id)
    ptys.find((pty) => pty.pid === codex.pid)!.emit('이전 터미널 화면')
    await api.termKill(closed.id)
    api.killAllTerminals()

    const restarted = createApi(deps)
    expect((await restarted.restoreProject())?.projectDir).toBe(projectDir)
    const state = await restarted.termState()
    expect(state.active).toBe(codex.id)
    expect(state.tabs.map((tab) => tab.title).sort()).toEqual(['결제 작업', '기획 검토'].sort())
    const resumedCodex = state.tabs.find((tab) => tab.id === codex.id)!
    const resumedClaude = state.tabs.find((tab) => tab.id === claude.id)!
    expect(resumedCodex).toMatchObject({ sessionId: 'native-codex-id', output: '이전 터미널 화면' })
    expect(ptys.find((pty) => pty.pid === resumedCodex.pid)!.write).toHaveBeenCalledWith('my-codex resume native-codex-id --profile work --no-daemon\r')
    expect(ptys.find((pty) => pty.pid === resumedClaude.pid)!.write).toHaveBeenCalledWith(`claude --resume ${claude.sessionId}\r`)
    expect((await restarted.termState()).tabs).toHaveLength(2)
    expect(ptys).toHaveLength(5)
    restarted.closeProject()
    expect(await createApi(deps).restoreProject()).toBeNull()
    await restarted.createProject(await tempDir('other-project-'))
    expect((await restarted.termState()).tabs).toEqual([])
    restarted.killAllTerminals()
  })

  it('저장 파일이 손상되면 오류를 알리고 원본 파일을 덮어쓰지 않는다', async () => {
    const root = await tempDir('terminal-corrupt-')
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(root, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    await api.createProject(await tempDir('terminal-project-'))
    await api.termCreate('shell')
    api.killAllTerminals()
    const files = await fs.readdir(path.join(root, 'terminals'))
    const file = path.join(root, 'terminals', files[0])
    const corrupted = '{"tabs": ['
    await fs.writeFile(file, corrupted)
    const restarted = createApi(deps)
    await restarted.restoreProject()
    await expect(restarted.termState()).rejects.toThrow('터미널')
    restarted.killAllTerminals()
    expect(await fs.readFile(file, 'utf8')).toBe(corrupted)
    expect(ptys).toHaveLength(1)
  })
})
