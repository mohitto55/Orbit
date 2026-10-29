import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { createApi } from '../src/main/api'
import { encodeClaudeProjectDir } from '../src/core/drift'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { AGENT_PORT } from '../src/core/pipeline'
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

describe('작업 그래프 세션 재사용', () => {
  async function setup() {
    const home = await tempDir('pipeline-terminal-home-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    // 실제 TUI의 입력 준비는 터미널 테스트에서 검증한다.
    vi.spyOn(TerminalWorkspace.prototype, 'whenReady').mockResolvedValue()
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'orbit', 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const projectDir = await tempDir('pipeline-terminal-project-')
    await api.createProject(projectDir)
    return { api, home, projectDir }
  }

  function saveGraph(api: ReturnType<typeof createApi>, kind: 'claude' | 'codex', session: string) {
    return api.savePipeline({
      title: '기존 대화 이어서 작업',
      nodes: [
        { id: 'start', kind: 'start', text: '', terminal: 'new' },
        { id: 'work', kind, name: '결제 검토', session, text: '기존 대화에 보내는 작업', terminal: 'new' }
      ],
      edges: [{ from: 'start', to: 'work' }]
    })
  }

  it.each(['claude', 'codex'] as const)('[DM-F02-AC15] %s 터미널 입력·출력은 이름을 바꿔도 선택한 실제 탭에만 연속 전송한다', async (kind) => {
    const { api } = await setup()
    try {
      const target = await api.termCreate(kind), other = await api.termCreate(kind)
      const targetPty = ptys.find((pty) => pty.pid === target.pid)!
      const otherPty = ptys.find((pty) => pty.pid === other.pid)!
      targetPty.emit('유지할 출력')
      const graph = await api.savePipeline({ title: '터미널 입력', nodes: [
        { id: 'start', kind: 'start', text: '', terminal: 'new' },
        { id: 'tab', kind: 'terminal', text: '', terminal: 'new', ref: target.id },
        { id: 'first', kind, text: '입력한 터미널에서 첫 작업', terminal: 'new' },
        { id: 'last', kind, text: '출력한 터미널에서 다음 작업', terminal: 'new' }
      ], edges: [
        { from: 'start', to: 'first' }, { from: 'first', to: 'last' },
        { from: 'tab', to: 'first', toPort: AGENT_PORT.terminal },
        { from: 'first', to: 'last', pin: 'data', fromPort: AGENT_PORT.terminal, toPort: AGENT_PORT.terminal }
      ] })
      await api.termRename(target.id, '변경한 탭 이름')
      const before = await api.termState()
      const run = await api.runPipeline(graph.id)
      await vi.waitFor(() => expect(targetPty.write).toHaveBeenCalledWith(expect.stringContaining('입력한 터미널에서 첫 작업')))
      api.markNodeDone(run.runId, 'first')
      await vi.waitFor(() => expect(targetPty.write).toHaveBeenCalledWith(expect.stringContaining('출력한 터미널에서 다음 작업')))
      expect(api.markNodeDone(run.runId, 'last')?.status).toBe('done')
      expect(api.pipelineRuns()[0].nodes).toMatchObject({ first: { termId: target.id }, last: { termId: target.id } })
      expect(otherPty.write).not.toHaveBeenCalledWith(expect.stringContaining('터미널에서'))
      expect(ptys).toHaveLength(2)
      expect(targetPty.kill).not.toHaveBeenCalled()
      expect(TerminalWorkspace.prototype.whenReady).not.toHaveBeenCalled()
      const after = await api.termState()
      expect(after).toMatchObject({ active: other.id, activeGroup: before.activeGroup })
      expect(after.tabs.find((t) => t.id === target.id)).toMatchObject({ title: '변경한 탭 이름', pid: target.pid, output: '유지할 출력' })
      await api.termKill(target.id)
      await expect(api.runPipeline(graph.id)).rejects.toThrow('닫혔습니다')
      expect(ptys).toHaveLength(2)
    } finally { api.killAllTerminals() }
  })

  it.each([
    { kind: 'claude', source: '전용 탭' }, { kind: 'codex', source: '전용 탭' },
    { kind: 'claude', source: '일반 셸' }, { kind: 'codex', source: '일반 셸' }
  ] as const)('[DM-F02-AC4] $kind $source 세션은 이미 열린 정확한 탭을 재사용하고 반복 실행에도 새 탭을 만들지 않는다', async ({ kind, source }) => {
    const { api, home, projectDir } = await setup()
    try {
      const target = await api.termCreate(source === '일반 셸' ? 'shell' : kind)
      const other = await api.termCreate(kind)
      const session = target.sessionId ?? '11111111-2222-3333-4444-555555555555'
      if (source === '일반 셸') {
        const dir = path.join(home, 'orbit', 'terminals')
        const files = await fs.readdir(dir)
        const launchFile = path.join(dir, `${files.find((file) => file.endsWith('.json'))!}.sessions`, target.id, 'state.json')
        const launch = JSON.parse(await fs.readFile(launchFile, 'utf8')) as Record<string, unknown>
        await fs.writeFile(launchFile, JSON.stringify({ ...launch, kind, cwd: projectDir, args: [], running: true, runId: 'manual-run', sessionId: kind === 'claude' ? session : undefined }))
      }
      if (kind === 'codex') {
        // 주기적 ID 연결 전에 실행해도 실제 세션을 찾아야 한다.
        const dir = path.join(home, '.codex', 'sessions')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `rollout-${session}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: projectDir, originator: `orbit-${target.id}`, source: 'cli' } }))
      }
      await api.termRename(target.id, '기존 작업 이름')
      const group = (await api.termCreateGroup('기존 그룹')).groups[0]
      await api.termMoveToGroup(target.id, group.id)
      await api.termSelectGroup('ungrouped')
      await api.termActivate(other.id)
      const targetPty = ptys.find((pty) => pty.pid === target.pid)!
      const otherPty = ptys.find((pty) => pty.pid === other.pid)!
      targetPty.emit('기존 출력')
      const graph = await saveGraph(api, kind, session)
      for (let i = 0; i < 2; i++) {
        const run = await api.runPipeline(graph.id)
        await vi.waitFor(() => expect(api.pipelineRuns().find((r) => r.runId === run.runId)?.nodes.work).toMatchObject({ status: 'running', termId: target.id }))
        expect((await api.termState()).tabs.find((tab) => tab.id === target.id)?.activity).toBe('working')
        expect(ptys).toHaveLength(2)
        expect(targetPty.write).toHaveBeenCalledWith('\x1b[200~기존 대화에 보내는 작업\x1b[201~')
        await vi.waitFor(() => expect(targetPty.write).toHaveBeenLastCalledWith(kind === 'codex' ? '\x05\r' : '\r'))
        expect(otherPty.write).not.toHaveBeenCalledWith(expect.stringContaining('기존 대화에 보내는 작업'))
        expect(api.markNodeDone(run.runId, 'work')?.status).toBe('done')
        const completed = (await api.termState()).tabs.find((tab) => tab.id === target.id)!
        expect(completed.activity).toBe('completed')
        await api.termAcknowledge(target.id, completed.activityRevision!)
        expect((await api.termState()).tabs.find((tab) => tab.id === target.id)?.activity).toBe('idle')
      }
      const state = await api.termState()
      expect(state.tabs).toHaveLength(2)
      expect(state.tabs.find((tab) => tab.id === target.id)).toMatchObject({ pid: target.pid, title: '기존 작업 이름', output: '기존 출력', groupId: group.id, sessionId: session })
      expect(state).toMatchObject({ active: other.id, activeGroup: 'ungrouped' })
      expect(targetPty.kill).not.toHaveBeenCalled()
      expect(TerminalWorkspace.prototype.whenReady).not.toHaveBeenCalled()
    } finally { api.killAllTerminals() }
  })

  it.each(['claude', 'codex'] as const)('[DM-F02-AC4] %s 세션을 동시에 불러와도 탭은 하나만 열고 실행 중인 작업을 덮어쓰지 않는다', async (kind) => {
    const { api, home, projectDir } = await setup()
    try {
      const session = '11111111-2222-3333-4444-555555555555'
      if (kind === 'claude') {
        const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectDir))
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `${session}.jsonl`), JSON.stringify({ type: 'ai-title', sessionId: session, aiTitle: 'AI가 정한 세션 이름' }))
      } else {
        const dir = path.join(home, '.codex')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'session_index.jsonl'), JSON.stringify({ id: session, thread_name: 'AI가 정한 세션 이름' }))
      }
      const first = await saveGraph(api, kind, session)
      const second = await saveGraph(api, kind, session)
      await Promise.all([api.runPipeline(first.id), api.runPipeline(second.id)])
      await vi.waitFor(() => expect(api.pipelineRuns().map((r) => r.nodes.work.status).sort()).toEqual(['running', 'waiting']))
      expect(ptys).toHaveLength(1)
      expect(TerminalWorkspace.prototype.whenReady).toHaveBeenCalledTimes(1)
      const state = await api.termState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].sessionId).toBe(session)
      expect(state.tabs[0].title).toBe(`${kind === 'claude' ? 'Claude Code' : 'Codex'} · 결제 검토`)
      expect(ptys[0].write).toHaveBeenCalledWith(expect.stringContaining(kind === 'claude' ? `claude --resume ${session}` : `codex resume ${session}`))
      expect(vi.mocked(ptys[0].write).mock.calls.filter(([input]) => input.includes('기존 대화에 보내는 작업'))).toHaveLength(1)
      const running = api.pipelineRuns().find((r) => r.nodes.work.status === 'running')!
      const waiting = api.pipelineRuns().find((r) => r.nodes.work.status === 'waiting')!
      expect(waiting.nodes.work.message).toContain('다른 작업 노드가 실행 중')
      expect(api.markNodeDone(running.runId, 'work')?.status).toBe('done')
      await vi.waitFor(() => expect(api.pipelineRuns().find((r) => r.runId === waiting.runId)?.nodes.work.status).toBe('running'))
      expect(ptys).toHaveLength(1)
      expect(vi.mocked(ptys[0].write).mock.calls.filter(([input]) => input.includes('기존 대화에 보내는 작업'))).toHaveLength(2)
    } finally { api.killAllTerminals() }
  })
})

describe('터미널 자동 복원', () => {
  it.each(['claude', 'codex'] as const)('[DM-F02-AC4] %s 세션 불러오기 목록에 첫 메시지와 구분되는 실제 name을 제공한다', async (kind) => {
    const home = await tempDir('agent-session-list-')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    const api = createApi({ send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'orbit', 'recent.json'), onProjectOpened() {} })
    const projectDir = await tempDir('agent-session-project-')
    await api.createProject(projectDir)
    const dir = kind === 'claude' ? path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectDir)) : path.join(home, '.codex', 'sessions')
    await fs.mkdir(dir, { recursive: true })
    for (const id of ['named', 'unnamed']) {
      const lines = kind === 'claude' ? [
        { type: 'user', sessionId: id, cwd: projectDir, message: { content: '첫 메시지 내용' } },
        ...(id === 'named' ? [{ type: 'custom-title', sessionId: id, customTitle: '실제 세션 이름' }] : [])
      ] : [
        { type: 'session_meta', payload: { id, cwd: projectDir } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 메시지 내용' }] } }
      ]
      await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'))
    }
    if (kind === 'codex') await fs.writeFile(path.join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: 'named', thread_name: '실제 세션 이름' }))
    const sessions = await api.agentSessions(kind)
    expect(sessions.find((s) => s.id === 'named')).toMatchObject({ name: '실제 세션 이름', firstPrompt: '첫 메시지 내용' })
    expect(sessions.find((s) => s.id === 'unnamed')).toMatchObject({ name: undefined, firstPrompt: '첫 메시지 내용' })
  })

  it('[TE-F01-AC4] [TE-F01-AC10] 복원·세션 전환·AI 이름 변경·재연결에도 저장한 터미널 이름을 유지한다', async () => {
    const home = await tempDir('terminal-session-names-')
    vi.stubEnv('CODEX_HOME', path.join(home, 'codex'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude'))
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'orbit', 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const projectDir = await tempDir('terminal-named-project-')
    await api.createProject(projectDir)
    const codex = await api.termCreate('codex')
    const claude = await api.termCreate('claude')
    const codexDir = path.join(home, 'codex', 'sessions')
    const claudeDir = path.join(home, 'claude', 'projects', encodeClaudeProjectDir(projectDir))
    await fs.mkdir(codexDir, { recursive: true })
    await fs.mkdir(claudeDir, { recursive: true })
    const codexId = '11111111-2222-3333-4444-555555555555'
    const nextId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const meta = (id: string, originator: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: projectDir, originator, source: 'cli' } }) + '\n'
    await fs.writeFile(path.join(codexDir, `rollout-${codexId}.jsonl`), meta(codexId, `orbit-${codex.id}`))
    await fs.writeFile(path.join(codexDir, `rollout-${nextId}.jsonl`), meta(nextId, 'codex-tui'))
    const index = [
      { id: codexId, thread_name: '결제 세션의 실제 name' },
      { id: nextId, thread_name: '다른 세션의 실제 name' }
    ].map((row) => JSON.stringify(row)).join('\n')
    await fs.writeFile(path.join(home, 'codex', 'session_index.jsonl'), index)
    const transcript = JSON.stringify({ type: 'custom-title', sessionId: claude.sessionId, customTitle: '클로드 세션 이름' }) + '\n'
    await fs.writeFile(path.join(claudeDir, `${claude.sessionId}.jsonl`), transcript)
    await api.termRename(codex.id, '결제 작업')
    await api.termRename(claude.id, '기획 검토')
    api.killAllTerminals()

    const restarted = createApi(deps)
    await restarted.openProject(projectDir)
    try {
      const state = await restarted.termState()
      expect(state.tabs.find((tab) => tab.id === codex.id)).toMatchObject({ sessionId: codexId, title: '결제 작업' })
      expect(state.tabs.find((tab) => tab.id === claude.id)).toMatchObject({ sessionId: claude.sessionId, title: '기획 검토' })
      const resumed = state.tabs.find((tab) => tab.id === codex.id)!
      ptys.find((pty) => pty.pid === resumed.pid)!.emit(`\x1b]0;${nextId}\x07`)
      await vi.waitFor(async () => {
        expect((await restarted.termState()).tabs.find((tab) => tab.id === codex.id)).toMatchObject({ sessionId: nextId, title: '결제 작업' })
      }, { timeout: 3000 })
      expect(deps.send).toHaveBeenCalledWith('term-info', expect.objectContaining({ id: codex.id, title: '결제 작업' }))
      const savedFiles = await fs.readdir(path.join(home, 'orbit', 'terminals'))
      const savedFile = path.join(home, 'orbit', 'terminals', savedFiles.find((file) => file.endsWith('.json'))!)
      const launchFile = path.join(`${savedFile}.sessions`, claude.id, 'state.json')
      const launch = JSON.parse(await fs.readFile(launchFile, 'utf8')) as Record<string, unknown>
      await fs.writeFile(path.join(claudeDir, `${nextId}.jsonl`), JSON.stringify({ type: 'ai-title', sessionId: nextId, aiTitle: '다른 클로드 세션 이름' }))
      await fs.writeFile(launchFile, JSON.stringify({ ...launch, sessionId: nextId }))
      ptys.find((pty) => pty.pid === state.tabs.find((tab) => tab.id === claude.id)!.pid)!.emit('\x1b]0;Claude\x07')
      await vi.waitFor(async () => {
        expect((await restarted.termState()).tabs.find((tab) => tab.id === claude.id)).toMatchObject({ sessionId: nextId, title: '기획 검토' })
      })
      const updatedIndex = index + '\n' + JSON.stringify({ id: nextId, thread_name: 'AI가 바꾼 코덱스 세션 이름' }) + '\n'
      const updatedTranscript = JSON.stringify({ type: 'ai-title', sessionId: nextId, aiTitle: 'AI가 바꾼 클로드 세션 이름' }) + '\n'
      await fs.writeFile(path.join(home, 'codex', 'session_index.jsonl'), updatedIndex)
      await fs.writeFile(path.join(claudeDir, `${nextId}.jsonl`), updatedTranscript)
      expect(await restarted.termRestart(codex.id)).toMatchObject({ sessionId: nextId, title: '결제 작업' })
      expect(await restarted.termRestart(claude.id)).toMatchObject({ sessionId: nextId, title: '기획 검토' })
      const saved = JSON.parse(await fs.readFile(savedFile, 'utf8')) as { tabs: { id: string; title: string }[] }
      expect(saved.tabs.find((tab) => tab.id === codex.id)?.title).toBe('결제 작업')
      expect(saved.tabs.find((tab) => tab.id === claude.id)?.title).toBe('기획 검토')
      expect(await fs.readFile(path.join(home, 'codex', 'session_index.jsonl'), 'utf8')).toBe(updatedIndex)
      expect(await fs.readFile(path.join(claudeDir, `${claude.sessionId}.jsonl`), 'utf8')).toBe(transcript)
      expect(await fs.readFile(path.join(claudeDir, `${nextId}.jsonl`), 'utf8')).toBe(updatedTranscript)
    } finally { restarted.killAllTerminals() }
  })

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

  it('[TE-F02-AC7] [TE-F02-AC8] 탭·그룹을 앞뒤로 정렬해도 세션·소속·선택·출력을 유지하고 다시 열 때 같은 순서로 복원한다', async () => {
    const home = await tempDir('terminal-order-')
    const project = await tempDir('terminal-order-project-')
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps)
    const restarted = createApi(deps)
    await api.createProject(project)
    try {
      const first = await api.termCreate('shell')
      const second = await api.termCreate('shell')
      const third = await api.termCreate('shell')
      const fourth = await api.termCreate('shell')
      await api.termRename(first.id, '고정된 작업 이름')
      ptys[0].emit('정렬 전 출력')
      const server = (await api.termCreateGroup('서버')).groups[0]
      const client = (await api.termCreateGroup('클라이언트')).groups[1]
      const misc = (await api.termCreateGroup('기타')).groups[2]
      await api.termMoveToGroup(first.id, server.id)
      await api.termMoveToGroup(third.id, server.id)
      await api.termMoveToGroup(second.id, client.id)
      await api.termSelectGroup(server.id)
      await api.termActivate(first.id)
      await api.termWrite(first.id, 'echo working\r')
      const before = await api.termState()
      const writesBefore = ptys.map((pty) => vi.mocked(pty.write).mock.calls.length)
      const moved = await api.termReorderTab(third.id, first.id, 'before')
      expect(moved.tabs.map((tab) => tab.id)).toEqual([third.id, first.id, second.id, fourth.id])
      expect(moved.tabs.filter((tab) => tab.groupId === server.id).map((tab) => tab.id)).toEqual([third.id, first.id])
      expect(moved).toMatchObject({ active: first.id, activeGroup: server.id })
      expect(moved.tabs.every((tab) => !('output' in tab))).toBe(true)
      await api.termReorderTab(third.id, first.id, 'after')
      await api.termSelectGroup('all')
      await api.termReorderTab(fourth.id, first.id, 'before')
      await api.termSelectGroup(server.id)
      await api.termActivate(first.id)
      expect((await api.termReorderGroup(misc.id, server.id, 'before')).groups.map((group) => group.id)).toEqual([misc.id, server.id, client.id])
      await api.termReorderGroup(misc.id, client.id, 'after')
      await api.termReorderGroup(client.id, server.id, 'before')
      await api.termRenameGroup(client.id, '프런트엔드')
      const final = await api.termState()
      expect(final.tabs.map((tab) => tab.id)).toEqual([fourth.id, first.id, third.id, second.id])
      expect(final.groups.map((group) => group.title)).toEqual(['프런트엔드', '서버', '기타'])
      expect(final).toMatchObject({ active: first.id, activeGroup: server.id })
      for (const tab of before.tabs) expect(final.tabs.find((item) => item.id === tab.id)).toEqual(tab)
      expect(ptys).toHaveLength(4)
      expect(ptys.every((pty) => vi.mocked(pty.kill).mock.calls.length === 0)).toBe(true)
      expect(ptys.map((pty) => vi.mocked(pty.write).mock.calls.length)).toEqual(writesBefore)
      api.closeProject()
      await restarted.openProject(project)
      const restored = await restarted.termState()
      expect(restored.tabs.map((tab) => tab.id)).toEqual(final.tabs.map((tab) => tab.id))
      expect(restored.groups).toEqual(final.groups)
      expect(restored).toMatchObject({ active: first.id, activeGroup: server.id })
      expect(restored.tabs.find((tab) => tab.id === first.id)).toMatchObject({ title: '고정된 작업 이름', output: '정렬 전 출력', groupId: server.id })
    } finally { api.closeProject(); restarted.closeProject() }
  })

  it('[TE-F02-AC7] [TE-F02-AC8] 정렬은 최신 목록을 사용하며 없는 대상·기본 그룹·잘못된 위치로 기존 목록을 훼손하지 않는다', async () => {
    const home = await tempDir('terminal-order-invalid-')
    const api = createApi({ send: vi.fn(), pickFolder: async () => null, recentFile: path.join(home, 'recent.json'), onProjectOpened() {} })
    await api.createProject(await tempDir('terminal-order-invalid-project-'))
    try {
      const first = await api.termCreate('shell')
      const second = await api.termCreate('shell')
      const group = (await api.termCreateGroup('서버')).groups[0]
      // 드래그 시작 후 새 탭이 생겨도 전체 목록을 덮어쓰지 않는다.
      const added = await api.termCreate('shell')
      expect((await api.termReorderTab(second.id, first.id, 'before')).tabs.map((tab) => tab.id)).toEqual([second.id, first.id, added.id])
      const before = await api.termState()
      await api.termReorderTab(first.id, first.id, 'after')
      await api.termReorderGroup(group.id, group.id, 'before')
      await expect(api.termReorderTab(first.id, 'missing', 'before')).rejects.toThrow('항목')
      await expect(api.termReorderTab('missing', first.id, 'after')).rejects.toThrow('항목')
      await expect(api.termReorderGroup('all', group.id, 'after')).rejects.toThrow('항목')
      await expect(api.termReorderGroup(group.id, 'ungrouped', 'before')).rejects.toThrow('항목')
      await expect(Reflect.apply(api.termReorderTab, null, [first.id, second.id, 'inside'])).rejects.toThrow('위치')
      expect(await api.termState()).toEqual(before)
    } finally { api.closeProject() }
  })
})
