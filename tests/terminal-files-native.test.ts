import { promises as fs } from 'fs'
import path from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'node-pty'
import { expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { terminalFilePastes } from '../src/core/terminalFiles'
import { tempDir } from './helpers'

// 설치된 CLI와 로컬 응답 서버만 사용하여 실제 이미지 첨부와 명시적 전송을 확인한다.
it.skipIf(!process.env.ORBIT_FILE_DROP_SMOKE).each(['codex', 'claude'] as const)('[TE-F01-AC12] 실제 %s에 사진 두 장과 문서를 붙여 넣고 Enter 이후에만 전송한다', async (kind) => {
  const root = await tempDir(`orbit-file-drop-${kind}-`)
  const cwd = await fs.realpath(root)
  const files = [path.join(root, '첫 사진.png'), path.join(root, "second's photo.png"), path.join(root, '설계 문서.txt')]
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVChTY/jPwPCfYRQAAAobAf8DJmCxAAAAAElFTkSuQmCC', 'base64')
  await fs.writeFile(files[0], png); await fs.writeFile(files[1], png); await fs.writeFile(files[2], 'Orbit file drop document')
  const requests: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (request.url?.includes('responses') || request.url?.includes('messages')) requests.push(body)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (request.url?.includes('messages')) {
        const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        emit('message_start', { message: { id: 'msg_orbit', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Files received.' } })
        emit('content_block_stop', { index: 0 })
        emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        emit('message_stop', {})
        response.end()
      } else {
        const message = { id: 'msg_orbit', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Files received.', annotations: [] }] }
        response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_orbit', status: 'in_progress', output: [] } })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: message })}\n\n`)
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_orbit', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const codexHome = path.join(root, 'codex')
  await fs.mkdir(codexHome)
  await fs.writeFile(path.join(codexHome, 'config.toml'), `check_for_update_on_startup = false\nmodel = "orbit-probe"\nmodel_provider = "orbit_probe"\n[model_providers.orbit_probe]\nname = "OrbitProbe"\nbase_url = "http://127.0.0.1:${port}"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nplugins = false\n[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level = "trusted"\n`)
  vi.stubEnv('CODEX_HOME', codexHome)
  const claudeHome = path.join(root, 'claude')
  await fs.mkdir(claudeHome)
  await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`)
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'orbit-probe')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  let output = ''
  const workspace = new TerminalWorkspace(path.join(root, 'workspace.json'), { projectDir: cwd, dataRoot: path.join(root, 'docs') }, spawn, {
    onData(id, data) {
      output = (output + data).slice(-200000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onExit() {}
  })
  try {
    const tab = workspace.create(kind, { name: 'file drop', driftIntervalDays: 7, reminderTime: '09:00' })
    await workspace.whenReady(tab.id)
    if (kind === 'codex') await vi.waitFor(() => expect(output).toContain('orbit-probe'), { timeout: 15000 })
    for (const text of terminalFilePastes(files, kind, process.platform === 'win32')) {
      workspace.write(tab.id, `\x1b[200~${text}\x1b[201~`)
      if (kind === 'codex' && process.platform === 'win32') workspace.write(tab.id, '\x05')
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(requests).toHaveLength(0)
    workspace.write(tab.id, 'OrbitFileDropProbe')
    await new Promise((resolve) => setTimeout(resolve, 500))
    workspace.write(tab.id, kind === 'codex' ? '\x05\r' : '\r')
    const images = (body: string) => (body.match(new RegExp(`"type"\\s*:\\s*"${kind === 'codex' ? 'input_image' : 'image'}"`, 'g')) ?? []).length
    await vi.waitFor(() => expect(requests.some((body) => body.includes('OrbitFileDropProbe') && images(body) === 2)).toBe(true), { timeout: 20000 })
    const request = requests.find((body) => body.includes('OrbitFileDropProbe') && images(body) === 2)!
    expect(request).toContain('설계 문서.txt')
  } finally {
    await fs.writeFile(path.join(root, 'terminal-output.txt'), output)
    await fs.writeFile(path.join(root, 'requests.json'), JSON.stringify(requests))
    console.info('File drop diagnostics:', root)
    workspace.suspend()
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 60000)
