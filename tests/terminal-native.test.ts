import { promises as fs } from 'fs'
import path from 'path'
import { expect, it, vi } from 'vitest'
import { spawn } from 'node-pty'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { tempDir } from './helpers'

// 설치된 Codex의 실제 TUI 연결 확인. 모델 요청은 닫힌 로컬 포트로만 보낸다.
it.skipIf(!process.env.ORBIT_NATIVE_SMOKE)('실제 Codex를 종료한 뒤 같은 세션 ID와 탭으로 자동 재접속한다', async () => {
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
    workspace.write(tab.id, '\r')
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
  } finally {
    workspace.suspend()
    vi.unstubAllEnvs()
  }
}, 60000)
