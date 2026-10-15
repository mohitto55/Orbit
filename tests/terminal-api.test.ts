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
  it('[TE-F01-AC3] [TE-F01-AC4] [TE-F01-AC5] [TE-F01-AC6] [WS-F02-AC5] [WS-F02-AC6] 재시작 후 프로젝트를 선택하면 탭·이름·활성 탭·각 대화 ID를 복원한다', async () => {
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
    expect(claudePty.write).toHaveBeenCalledWith(expect.stringContaining(`claude --session-id ${claude.sessionId} --settings `))
    expect(ptys.find((pty) => pty.pid === codex.pid)!.write).toHaveBeenCalledWith(expect.stringContaining('my-codex --profile work --no-daemon -c '))
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
    const server = (await api.termCreateGroup('서버 작업')).groups[0]
    await api.termMoveToGroup(codex.id, server.id)
    const planning = (await api.termCreateGroup('기획')).groups[1]
    await api.termMoveToGroup(claude.id, planning.id)
    await api.termSelectGroup(server.id)
    await api.termActivate(codex.id)
    ptys.find((pty) => pty.pid === codex.pid)!.emit('이전 터미널 화면')
    await api.termKill(closed.id)
    api.killAllTerminals()

    const restarted = createApi(deps)
    expect(await restarted.currentProject()).toBeNull()
    await expect(restarted.termState()).rejects.toThrow('프로젝트가 열려 있지 않습니다')
    expect(ptys).toHaveLength(3)
    await restarted.openProject(projectDir)
    const state = await restarted.termState()
    expect(state.active).toBe(codex.id)
    expect(state.groups).toEqual([server, planning])
    expect(state.activeGroup).toBe(server.id)
    expect(state.tabs.map((tab) => tab.title).sort()).toEqual(['결제 작업', '기획 검토'].sort())
    const resumedCodex = state.tabs.find((tab) => tab.id === codex.id)!
    const resumedClaude = state.tabs.find((tab) => tab.id === claude.id)!
    expect(resumedCodex).toMatchObject({ sessionId: 'native-codex-id', output: '이전 터미널 화면', groupId: server.id })
    expect(resumedClaude.groupId).toBe(planning.id)
    expect(ptys.find((pty) => pty.pid === resumedCodex.pid)!.write).toHaveBeenCalledWith(expect.stringContaining('my-codex resume native-codex-id --profile work --no-daemon -c '))
    expect(ptys.find((pty) => pty.pid === resumedClaude.pid)!.write).toHaveBeenCalledWith(expect.stringContaining(`claude --resume ${claude.sessionId} --settings `))
    expect((await restarted.termState()).tabs).toHaveLength(2)
    expect(ptys).toHaveLength(5)
    restarted.closeProject()
    expect(await createApi(deps).currentProject()).toBeNull()
    await restarted.createProject(await tempDir('other-project-'))
    expect((await restarted.termState()).tabs).toEqual([])
    expect((await restarted.termState()).groups).toEqual([])
    expect((await restarted.termState()).activeGroup).toBe('all')
    restarted.killAllTerminals()
  })

  it.each(['{"tabs": [', '{"tabs": [], "groups": [{"id": "broken", "title": "서버"}]}'])('저장 파일이 손상되면 오류를 알리고 원본 파일을 덮어쓰지 않는다: %s', async (corrupted) => {
    const root = await tempDir('terminal-corrupt-')
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(root, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const projectDir = await tempDir('terminal-project-')
    await api.createProject(projectDir)
    await api.termCreate('shell')
    api.killAllTerminals()
    const files = await fs.readdir(path.join(root, 'terminals'))
    const file = path.join(root, 'terminals', files[0])
    await fs.writeFile(file, corrupted)
    const restarted = createApi(deps)
    await restarted.openProject(projectDir)
    await expect(restarted.termState()).rejects.toThrow('터미널')
    restarted.killAllTerminals()
    expect(await fs.readFile(file, 'utf8')).toBe(corrupted)
    expect(ptys).toHaveLength(1)
  })

  it('[TE-F02-AC1] [TE-F02-AC2] [TE-F02-AC3] [TE-F02-AC5] 그룹 정리는 프로세스와 출력을 유지하고 활성 탭을 선택한 그룹 안에서 고른다', async () => {
    const home = await tempDir('terminal-groups-')
    const api = createApi({ send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'recent.json'), onProjectOpened() {} })
    await api.createProject(await tempDir('group-project-'))
    try {
      const first = await api.termCreate('shell')
      const second = await api.termCreate('shell')
      const third = await api.termCreate('shell')
      ptys[0].emit('그룹 이동 전 출력')
      const writesBefore = ptys.map((p) => vi.mocked(p.write).mock.calls.length)
      const server = (await api.termCreateGroup(' 서버 ')).groups[0]
      expect(server.title).toBe('서버')
      expect((await api.termState()).active).toBeNull()
      await api.termMoveToGroup(first.id, server.id)
      await api.termMoveToGroup(second.id, server.id)
      const client = (await api.termCreateGroup('클라이언트')).groups[1]
      await api.termMoveToGroup(third.id, client.id)
      const layout = await api.termSelectGroup(server.id)
      expect(layout.active).toBe(second.id)
      expect(layout.tabs.every((tab) => !('output' in tab))).toBe(true)
      await api.termRenameGroup(server.id, '백엔드')
      await expect(api.termCreateGroup('백엔드')).rejects.toThrow('이미 사용')
      await expect(api.termCreateGroup('  ')).rejects.toThrow('1~100')
      await expect(api.termMoveToGroup(first.id, '없는 그룹')).rejects.toThrow('그룹')
      await expect(api.termSelectGroup('없는 그룹')).rejects.toThrow('그룹')
      expect(ptys).toHaveLength(3)
      expect(ptys.every((p) => vi.mocked(p.kill).mock.calls.length === 0)).toBe(true)
      expect(ptys.map((p) => vi.mocked(p.write).mock.calls.length)).toEqual(writesBefore)
      expect((await api.termState()).tabs.find((t) => t.id === first.id)).toMatchObject({ pid: first.pid, output: '그룹 이동 전 출력' })

      const afterClose = await api.termKill(second.id)
      expect(afterClose.active).toBe(first.id)
      const moved = await api.termMoveToGroup(first.id, client.id)
      expect(moved.activeGroup).toBe(server.id)
      expect(moved.active).toBeNull()
      await api.termSelectGroup(client.id)
      const released = await api.termDeleteGroup(client.id)
      expect(released.activeGroup).toBe('ungrouped')
      expect(released.tabs.map((t) => t.groupId)).toEqual([undefined, undefined])
      expect(ptys[0].kill).not.toHaveBeenCalled()
      expect(ptys[2].kill).not.toHaveBeenCalled()
      await api.termSelectGroup(server.id)
      const added = await api.termCreate('shell')
      expect(added.groupId).toBe(server.id)
      expect((await api.termState()).active).toBe(added.id)
    } finally { api.killAllTerminals() }
  })

  it('[TE-F02-AC4] [TE-F02-AC6] 그룹이 없던 저장 파일과 없어진 그룹의 탭을 미분류로 복원한다', async () => {
    const home = await tempDir('terminal-legacy-groups-')
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const project = await tempDir('group-legacy-project-')
    await api.createProject(project)
    const first = await api.termCreate('shell')
    api.killAllTerminals()
    const files = await fs.readdir(path.join(home, 'terminals'))
    const file = path.join(home, 'terminals', files.find((f) => f.endsWith('.json'))!)
    const legacy = JSON.parse(await fs.readFile(file, 'utf8')) as { groups?: unknown; activeGroup?: string; tabs: { groupId?: string }[] }
    delete legacy.groups
    delete legacy.activeGroup
    legacy.tabs[0].groupId = 'group-missing'
    await fs.writeFile(file, JSON.stringify(legacy))
    const restarted = createApi(deps)
    await restarted.openProject(project)
    try {
      const state = await restarted.termState()
      expect(state).toMatchObject({ groups: [], activeGroup: 'all', active: first.id })
      expect(state.tabs[0].groupId).toBeUndefined()
      expect(state.tabs[0].id).toBe(first.id)
    } finally { restarted.killAllTerminals() }
  })
})
