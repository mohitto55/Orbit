import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { createApi } from '../src/main/api'
import { newProject, tempDir } from './helpers'

const ptys = vi.hoisted(() => [] as IPty[])
vi.mock('node-pty', () => ({
  spawn: vi.fn((): IPty => {
    const pty: IPty = {
      pid: ptys.length + 1, cols: 100, rows: 30, process: 'shell', handleFlowControl: false,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write: vi.fn(), resize: vi.fn(), clear() {}, kill: vi.fn(), pause() {}, resume() {}
    }
    ptys.push(pty)
    return pty
  })
}))

afterEach(() => { vi.restoreAllMocks(); ptys.length = 0 })

describe('터미널 API', () => {
  it('[TE-F01-AC1] 프로젝트에서 사용자 명령을 실행하고 저장된 대화를 정확한 ID로 재개한다 [TE-F01-AC2] [TE-F01-AC3] [TE-F01-AC4]', async () => {
    const ctx = await newProject()
    const home = await tempDir('terminal-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dir = path.join(home, '.codex', 'sessions')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session.jsonl'), [
      { type: 'session_meta', payload: { id: 'saved-session', cwd: ctx.projectDir } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: '이전 대화' } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(ctx.projectDir, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    await api.openProject(ctx.projectDir)
    await api.saveSettings({ ...await api.getSettings(), codexCommand: 'custom-codex --profile work', codexResumeCommand: 'wrapper resume {sessionId} --profile work' })
    const [fresh, shell] = await Promise.all([api.termCreate('codex', 120, 40), api.termCreate('shell')])
    const { spawn } = await import('node-pty')
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: ctx.projectDir, cols: 120, rows: 40 }))
    expect(ptys[0].write).toHaveBeenCalledWith('custom-codex --profile work\r')
    expect(fresh.id).not.toBe(shell.id)
    const resumed = await api.termResume('codex:saved-session')
    expect(ptys[2].write).toHaveBeenCalledWith('wrapper resume saved-session --profile work\r')
    expect(await api.termResume('codex:saved-session')).toEqual(resumed)
    expect(ptys).toHaveLength(3)
    await api.termRename(resumed.id, '결제 작업')
    expect((await api.termSessions()).sessions[0].title).toBe('결제 작업')
    await api.termRenameSession('codex:saved-session', '최종 이름')
    expect((await api.termResume('codex:saved-session')).title).toBe('최종 이름')
    api.killAllTerminals()
    for (const pty of ptys) expect(pty.kill).toHaveBeenCalledOnce()

    const restarted = createApi(deps)
    await restarted.openProject(ctx.projectDir)
    expect((await restarted.termSessions()).sessions[0].title).toBe('최종 이름')
    await restarted.termResume('codex:saved-session')
    expect(ptys[3].write).toHaveBeenCalledWith('wrapper resume saved-session --profile work\r')
    await restarted.createProject(await tempDir())
    expect(ptys[3].kill).toHaveBeenCalledOnce()
    await expect(restarted.termResume('codex:saved-session')).rejects.toThrow('찾을 수 없습니다')
    await expect(restarted.termResume('codex:id;echo bad')).rejects.toThrow('찾을 수 없습니다')
  })
})
