import { promises as fs } from 'fs'
import path from 'path'
import { expect, it, vi } from 'vitest'
import { spawn } from 'node-pty'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { tempDir } from './helpers'

// 설치된 Codex의 실제 TUI 연결 확인. 모델 요청은 닫힌 로컬 포트로만 보낸다.
it.skipIf(!process.env.ORBIT_NATIVE_SMOKE)('[TE-F01-AC3] [TE-F01-AC8] [TE-F01-AC9] 실제 Codex의 줄바꿈과 일반 터미널에서 재개한 기존 세션을 앱 재시작 후 복원한다', async () => {
  const root = await tempDir('orbit-native-')
  const cwd = await fs.realpath(process.cwd())
  const codexHome = path.join(root, 'codex')
  await fs.mkdir(codexHome)
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model = "orbit-probe"\nmodel_provider = "orbit_probe"\n[model_providers.orbit_probe]\nname = "OrbitProbe"\nbase_url = "http://127.0.0.1:1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nplugins = false\n[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level = "trusted"\n`)
  vi.stubEnv('CODEX_HOME', codexHome)
  const settings = { name: 'native smoke', driftIntervalDays: 7, reminderTime: '09:00' }
  const file = path.join(root, 'workspace.json')
  const ctx = { projectDir: cwd, dataRoot: path.join(cwd, 'docs') }
  let workspace: TerminalWorkspace
  let output = ''
  const events = {
    onData(id: string, data: string) {
      output = (output + data).slice(-200000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onExit() {}
  }
  workspace = new TerminalWorkspace(file, ctx, spawn, events)
  try {
    const tab = workspace.create('codex', settings)
    await vi.waitFor(() => expect(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).toContain('orbit-probe'), { timeout: 20000 })
    workspace.write(tab.id, 'OrbitNativeRestoreProbe')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    // 화면의 Ctrl/Shift+Enter와 같은 신호. LF는 Windows에서 줄바꿈이 소실된다.
    workspace.write(tab.id, '\x1b\r')
    await new Promise((resolve) => setTimeout(resolve, 500))
    workspace.write(tab.id, 'OrbitSecondLine')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const historyFile = path.join(codexHome, 'history.jsonl')
    expect(await fs.readFile(historyFile, 'utf8').catch(() => '')).toBe('')
    workspace.write(tab.id, '\r')
    await vi.waitFor(async () => {
      const history = (await fs.readFile(historyFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { text: string })
      expect(history.map((entry) => entry.text)).toEqual(['OrbitNativeRestoreProbe\nOrbitSecondLine'])
    }, { timeout: 15000 })
    await vi.waitFor(() => expect(workspace.state().tabs[0].sessionId).toBeTruthy(), { timeout: 15000 })
    const sessionId = workspace.state().tabs[0].sessionId
    workspace.rename(tab.id, 'Native restore')
    workspace.suspend()
    output = ''
    workspace = new TerminalWorkspace(file, ctx, spawn, events)
    await workspace.restore(settings)
    expect(workspace.state()).toMatchObject({ active: tab.id, tabs: [{ id: tab.id, sessionId, title: 'Native restore' }] })
    await vi.waitFor(() => expect(output).toContain('OrbitNativeRestoreProbe'), { timeout: 20000 })
    expect(workspace.state().tabs[0].pid).toBeGreaterThan(0)
    // 다른 탭에서 만들어진 세션을 CLI 자체의 /resume 선택창에서 고른다.
    workspace.kill(tab.id)
    output = ''
    const shell = workspace.create('shell', settings)
    workspace.write(shell.id, 'codex --yolo\r')
    await vi.waitFor(() => expect(output).toContain('orbit-probe'), { timeout: 20000 })
    workspace.write(shell.id, '/resume')
    await new Promise((resolve) => setTimeout(resolve, 500))
    workspace.write(shell.id, '\r')
    await vi.waitFor(() => expect(output).toContain('Resume'), { timeout: 15000 })
    workspace.write(shell.id, '\r')
    await vi.waitFor(() => expect(workspace.state().tabs[0]).toMatchObject({ kind: 'codex', sessionId }), { timeout: 15000 })
    workspace.rename(shell.id, '직접 실행한 작업')
    workspace.suspend()
    output = ''
    workspace = new TerminalWorkspace(file, ctx, spawn, events)
    await workspace.restore(settings)
    expect(workspace.state()).toMatchObject({ active: shell.id, tabs: [{ id: shell.id, kind: 'codex', sessionId, title: '직접 실행한 작업' }] })
    await vi.waitFor(() => expect(output).toContain('OrbitNativeRestoreProbe'), { timeout: 20000 })
  } finally {
    await fs.writeFile(path.join(root, 'terminal-output.txt'), output)
    workspace.suspend()
    vi.unstubAllEnvs()
  }
}, 60000)

it.skipIf(!process.env.ORBIT_CLAUDE_SMOKE)('[TE-F01-AC8] [TE-F01-AC9] 직접 실행한 Claude의 줄바꿈과 SessionStart ID로 재시작 후 세션을 복원한다', async () => {
  const root = await tempDir('orbit-claude-native-')
  const config = path.join(root, 'claude')
  await fs.mkdir(config)
  await fs.writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [root.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'orbit-probe')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  let output = ''
  let workspace: TerminalWorkspace
  const file = path.join(root, 'workspace.json')
  const ctx = { projectDir: root, dataRoot: path.join(root, 'docs') }
  const settings = { name: 'native', driftIntervalDays: 7, reminderTime: '09:00' }
  const events = {
    onData(id: string, data: string) {
      output = (output + data).slice(-200000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onExit() {}
  }
  workspace = new TerminalWorkspace(file, ctx, spawn, events)
  try {
    const tab = workspace.create('shell', settings)
    workspace.write(tab.id, `claude --debug-file '${path.join(root, 'claude-debug.txt')}'\r`)
    await vi.waitFor(() => expect(workspace.state().tabs[0]).toMatchObject({ kind: 'claude', sessionId: expect.stringMatching(/^[a-f0-9-]{36}$/) }), { timeout: 25000 })
    const sessionId = workspace.state().tabs[0].sessionId
    await new Promise((resolve) => setTimeout(resolve, 800))
    workspace.write(tab.id, 'OrbitClaudeFirst')
    await new Promise((resolve) => setTimeout(resolve, 500))
    workspace.write(tab.id, '\x1b\r')
    await new Promise((resolve) => setTimeout(resolve, 500))
    workspace.write(tab.id, 'OrbitClaudeSecond')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const historyFile = path.join(config, 'history.jsonl')
    expect(await fs.readFile(historyFile, 'utf8').catch(() => '')).toBe('')
    workspace.write(tab.id, '\r')
    await vi.waitFor(async () => {
      const history = (await fs.readFile(historyFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { display: string })
      expect(history.map((entry) => entry.display)).toEqual(['OrbitClaudeFirst\nOrbitClaudeSecond'])
    }, { timeout: 10000 })
    workspace.suspend()
    output = ''
    workspace = new TerminalWorkspace(file, ctx, spawn, events)
    await workspace.restore(settings)
    expect(workspace.state().tabs[0]).toMatchObject({ id: tab.id, kind: 'claude', sessionId })
    await vi.waitFor(() => expect(output).toContain('OrbitClaudeFirst'), { timeout: 15000 })
  } finally {
    await fs.writeFile(path.join(root, 'terminal-output.txt'), output)
    workspace.suspend()
    vi.unstubAllEnvs()
  }
}, 35000)
