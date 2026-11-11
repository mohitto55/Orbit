import { promises as fs } from 'fs'
import path from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'node-pty'
import { expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { PipelineRunner } from '../src/core/pipeline'
import { tempDir } from './helpers'

// 실제 CLI와 MCP를 실행하되 모델 요청은 로컬 고정 응답으로 끝낸다.
it.skipIf(!process.env.ORBIT_MESSAGE_SMOKE)('실제 Codex와 Claude가 MCP 메시지를 왕복하고 각각의 자동화를 완료한다', async () => {
  const root = await tempDir('orbit-message-native-'), codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude')
  await fs.mkdir(codexHome); await fs.mkdir(claudeHome)
  const cwd = await fs.realpath(root)
  const requests: { kind: string; body: string }[] = []
  const steps = { codex: 0, claude: 0 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (part: Buffer) => { body += part.toString() })
    request.on('end', () => {
      if (!request.url?.includes('responses') && !request.url?.includes('messages')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return }
      const kind = request.url.includes('responses') ? 'codex' : 'claude'
      const parsed = JSON.parse(body) as { tools?: unknown[] }
      const step = parsed.tools?.length ? steps[kind]++ : 100
      requests.push({ kind, body })
      const tool = step === 0 ? kind === 'codex' ? 'send_message' : 'receive_messages' : step === 1 ? kind === 'codex' ? 'receive_messages' : 'send_message' : undefined
      const args = tool === 'send_message' ? { to: kind === 'codex' ? 'b' : 'a', text: kind === 'codex' ? 'Codex에서 보낸 질문' : 'Claude에서 보낸 답변' } : { wait_seconds: 30 }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (kind === 'claude') {
        const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        emit('message_start', { message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        if (tool) {
          emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tool_${step}`, name: `mcp__orbit__${tool}`, input: {} } })
          emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })
        } else {
          emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Claude 대화 완료' } })
        }
        emit('content_block_stop', { index: 0 })
        emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        emit('message_stop', {}); response.end()
      } else {
        const item = tool ? { id: `call_${step}`, type: 'function_call', call_id: `call_${step}`, namespace: 'mcp__orbit', name: tool, arguments: JSON.stringify(args), status: 'completed' }
          : { id: `msg_${step}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Codex 대화 완료', annotations: [] }] }
        response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `resp_${step}`, status: 'in_progress', output: [] } })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${step}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model="orbit-probe"\nmodel_provider="orbit_probe"\n[model_providers.orbit_probe]\nname="OrbitProbe"\nbase_url="http://127.0.0.1:${port}"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nplugins=false\n[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level="trusted"\n`)
  await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  vi.stubEnv('CODEX_HOME', codexHome); vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'orbit-probe'); vi.stubEnv('ANTHROPIC_API_KEY', '')
  const output: Record<string, string> = {}
  const settings = { name: 'message probe', driftIntervalDays: 7, reminderTime: '09:00' }
  const workspace = new TerminalWorkspace(path.join(root, 'workspace.json'), { projectDir: cwd, dataRoot: path.join(root, 'docs') }, spawn, {
    onData(id, data) {
      output[id] = ((output[id] ?? '') + data).slice(-200000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onAgentDone: (id) => { runner.agentDone(id) }, onAgentError: (id, error) => { runner.terminalFailed(id, error) }, onExit() {}
  })
  const runner = new PipelineRunner({
    createTerminal: (kind) => workspace.open(kind, settings), hasTerminal: (id) => workspace.has(id), getTerminal: (id) => workspace.get(id), whenReady: (id) => workspace.whenReady(id),
    submit: (id, text) => workspace.submit(id, text), runCommand: (id, text) => workspace.runCommand(id, text),
    beginOutputCapture: (id, text, schema, messages) => workspace.beginOutputCapture(id, text, schema, messages), readAgentOutput: (id) => workspace.readAgentOutput(id), endOutputCapture: (id) => workspace.endOutputCapture(id),
    syncMessageRun: (id, scope) => workspace.syncMessageRun(id, scope), completeTasks: async () => {}, emit() {}
  })
  try {
    const a = workspace.create('codex', settings), b = workspace.create('claude', settings)
    await Promise.all([workspace.whenReady(a.id), workspace.whenReady(b.id)])
    await vi.waitFor(() => expect(output[a.id]).toContain('orbit-probe'), { timeout: 15000 })
    const run = runner.start({ id: 'chat', title: '대화', file: '', nodes: [
      { id: 'a', name: 'Codex', kind: 'codex', terminal: 'new', terminalInput: { tabId: a.id }, text: '메시지 교환', peers: ['b'] },
      { id: 'b', name: 'Claude', kind: 'claude', terminal: 'new', terminalInput: { tabId: b.id }, text: '메시지 교환' }
    ], edges: [] })
    await vi.waitFor(() => expect(runner.list()[0].status).toBe('done'), { timeout: 45000 })
    expect(workspace.messageLog(run.runId).map((m) => [m.from, m.to, m.text, m.read])).toEqual([
      ['a', 'b', 'Codex에서 보낸 질문', true], ['b', 'a', 'Claude에서 보낸 답변', true]
    ])
    expect(requests.filter((r) => r.kind === 'codex').some((r) => r.body.includes('Claude에서 보낸 답변'))).toBe(true)
    expect(requests.filter((r) => r.kind === 'claude').some((r) => r.body.includes('Codex에서 보낸 질문'))).toBe(true)
  } finally {
    runner.reset(); workspace.suspend(); server.closeAllConnections(); server.close(); vi.unstubAllEnvs()
    await fs.writeFile(path.join(root, 'diagnostics.json'), JSON.stringify({ requests, output }))
    console.info('Session messaging diagnostics:', root)
  }
}, 75000)
