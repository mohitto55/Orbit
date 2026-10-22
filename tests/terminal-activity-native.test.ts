import { promises as fs } from 'fs'
import path from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'node-pty'
import { expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import type { TerminalActivity } from '../src/core/terminal'
import { tempDir } from './helpers'

it.skipIf(!process.env.ORBIT_ACTIVITY_SMOKE).each(['codex', 'claude', 'shell'] as const)('[TE-F03-AC1] 실제 %s 터미널에서 직접 입력한 작업의 시작·종료·읽음 상태를 감지한다', async (kind) => {
  const root = await tempDir(`orbit-activity-${kind}-`)
  const codexHome = path.join(root, 'codex')
  await fs.mkdir(codexHome)
  const cwd = await fs.realpath(root)
  // 로컬 고정 응답만 사용한다. 실제 모델이나 사용자 계정으로 요청하지 않는다.
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (!request.url?.includes('responses') && !request.url?.includes('messages')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (request.url.includes('messages')) {
        const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        emit('message_start', { message: { id: 'msg_orbit', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        setTimeout(() => {
          emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Orbit activity complete.' } })
          emit('content_block_stop', { index: 0 })
          emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
          emit('message_stop', {})
          response.end()
        }, 800)
        return
      }
      const message = { id: 'msg_orbit', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Orbit activity complete.', annotations: [] }] }
      response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_orbit', status: 'in_progress', output: [] } })}\n\n`)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: message })}\n\n`)
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_orbit', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
      }, 300)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model = "orbit-probe"\nmodel_provider = "orbit_probe"\n[model_providers.orbit_probe]\nname = "OrbitProbe"\nbase_url = "http://127.0.0.1:${port}"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nplugins = false\n[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level = "trusted"\n`)
  vi.stubEnv('CODEX_HOME', codexHome)
  const claudeHome = path.join(root, 'claude')
  await fs.mkdir(claudeHome)
  await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`)
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'orbit-probe')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  const activity: TerminalActivity[] = []
  let output = ''
  const settings = { name: 'activity native', driftIntervalDays: 7, reminderTime: '09:00' }
  const workspace = new TerminalWorkspace(path.join(root, 'workspace.json'), { projectDir: cwd, dataRoot: path.join(root, 'docs') }, spawn, {
    onData(id, data) {
      output = (output + data).slice(-200000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onChange(info) { if (info.activity && activity.at(-1) !== info.activity) activity.push(info.activity) },
    onExit() {}
  })
  try {
    const tab = workspace.create(kind, settings)
    await workspace.whenReady(tab.id)
    expect(workspace.state().tabs[0].activity).toBe('idle')
    activity.length = 0
    if (kind !== 'shell') {
      if (kind === 'codex') await vi.waitFor(() => expect(output).toContain('orbit-probe'), { timeout: 15000 })
      workspace.write(tab.id, 'OrbitManualActivityProbe')
      await new Promise((resolve) => setTimeout(resolve, 500))
      workspace.write(tab.id, kind === 'codex' ? '\x05\r' : '\r')
    } else {
      workspace.write(tab.id, process.platform === 'win32' ? 'Start-Sleep -Milliseconds 250; echo OrbitManualActivityProbe\r' : 'sleep 0.25; echo OrbitManualActivityProbe\r')
    }
    await vi.waitFor(() => expect(activity).toContain('working'), { timeout: 15000 })
    await vi.waitFor(() => expect(workspace.state().tabs[0].activity).toBe('completed'), { timeout: 20000 })
    expect(activity).toEqual(['working', 'completed'])
    workspace.acknowledge(tab.id, workspace.state().tabs[0].activityRevision!)
    workspace.resize(tab.id, 101, 30)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(workspace.state().tabs[0].activity).toBe('idle')
  } finally {
    await fs.writeFile(path.join(root, 'terminal-output.txt'), output)
    await fs.writeFile(path.join(root, 'activity.json'), JSON.stringify(activity))
    workspace.suspend()
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 45000)
