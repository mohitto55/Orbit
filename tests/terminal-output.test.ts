import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { beginOutputCapture, endOutputCapture, freezeTerminalIntegration, prepareTerminalIntegration, readAgentOutput, takeAgentSignals } from '../src/core/terminalIntegration'
import { tempDir } from './helpers'
import { AGENT_PORT, expandPipeline, PipelineRunner, type Pipeline } from '../src/core/pipeline'

it.each(['claude', 'codex'] as const)('%s의 실제 완료 스크립트는 최종 응답을 그대로 받고 요청한 실행에만 보관한다', async (kind) => {
  const dir = await tempDir('orbit-response-')
  const integration = prepareTerminalIntegration(dir, kind, dir)
  const output = JSON.stringify({ people: '한글 이름', quote: '"인용"\n두 줄', literal: '$(throw "실행되면 안 됨") & | < > %PATH% ` ;', detail: { empty: '', ok: false, count: 0, list: [1, null] } })
  const prompt = '클라이언트가 하는 일을 출력하세요\n응답은 JSON', sessionId = '11111111-2222-3333-4444-555555555555'
  const payload = JSON.stringify(kind === 'codex' ? { type: 'agent-turn-complete', 'thread-id': sessionId, 'turn-id': 'turn-1', 'input-messages': [prompt], 'last-assistant-message': output } : { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: output })
  const options = { env: { ...process.env, ...integration.env }, cwd: dir, encoding: 'utf8' as const, stdio: 'pipe' as const }
  const complete = async () => {
    if (kind === 'claude') execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, 'prompt'], { ...options, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt }) })
    if (kind === 'codex') {
      const [command, ...args] = JSON.parse(integration.codexNotify.slice('notify='.length)) as string[]
      execFileSync(command, [...args, payload], options)
    } else {
      const settings = JSON.parse(await fs.readFile(integration.claudeSettings, 'utf8')) as { hooks: { Stop: { hooks: { command: string }[] }[] } }
      const command = settings.hooks.Stop[0].hooks[0].command
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command.split('-EncodedCommand ')[1]], { ...options, input: payload })
      else execFileSync('/bin/sh', ['-c', command], { ...options, input: payload })
    }
  }
  await complete()
  expect(takeAgentSignals(dir)).toEqual(['done'])
  expect(readAgentOutput(dir)).toBeUndefined()
  expect(await fs.readdir(dir)).not.toContain('agent-output.json')
  beginOutputCapture(dir, prompt, sessionId)
  await complete()
  expect(readAgentOutput(dir)).toBe(output)
  expect(takeAgentSignals(dir)).toEqual(['done'])
  beginOutputCapture(dir, prompt, sessionId)
  expect(readAgentOutput(dir)).toBeUndefined()
  expect(takeAgentSignals(dir)).toEqual([])
  endOutputCapture(dir)
  await complete()
  expect(readAgentOutput(dir)).toBeUndefined()
  takeAgentSignals(dir)
  freezeTerminalIntegration(dir)
  await complete()
  expect(takeAgentSignals(dir)).toEqual([])
})

it('Codex 제목 생성·하위 세션·중간 메시지는 무시하고 요청한 최종 응답만 검증·출력한다', async () => {
  const dir = await tempDir('orbit-final-response-'), sessionId = '11111111-2222-3333-4444-555555555555'
  const integration = prepareTerminalIntegration(dir, 'codex', dir)
  const notify = (event: Record<string, unknown>) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, 'notify'], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
  let prompt = ''
  const graph: Pipeline = { id: 'g', title: '클라이언트 작업 내용', file: '', nodes: [
    { id: 'ai', kind: 'codex', text: '클라이언트 작업 내용 출력', terminal: 'new', fields: [{ name: 'works', description: '', type: 'array', items: { type: 'object', description: '' } }] },
    { id: 'print', kind: 'print', text: '', terminal: 'new' }
  ], edges: [{ from: 'ai', to: 'print' }, { from: 'ai', to: 'print', pin: 'data', fromPort: AGENT_PORT.output }] }
  const runner = new PipelineRunner({ createTerminal: async () => ({ id: 'tab', kind: 'codex', title: '', pid: 1 }), hasTerminal: () => true, getTerminal: () => undefined, whenReady: async () => {},
    submit: (_id, text) => { prompt = text }, runCommand() {}, completeTasks: async () => {}, emit() {},
    beginOutputCapture: (_id, text) => beginOutputCapture(dir, text, sessionId), readAgentOutput: () => readAgentOutput(dir), endOutputCapture: () => endOutputCapture(dir)
  })
  runner.start({ ...graph, ...expandPipeline(graph) })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(prompt).toContain('works')
  const event = { type: 'agent-turn-complete', 'thread-id': sessionId, 'turn-id': 'actual-turn', 'input-messages': [prompt] }
  for (const wrong of [
    { ...event, 'input-messages': ['Generate a short title for: ' + prompt], 'last-assistant-message': '{"title":"클라이언트 작업 내용 출력"}' },
    { ...event, 'thread-id': 'another-session', 'last-assistant-message': '{"title":"클라이언트 작업 내용 출력"}' },
    { ...event, type: 'agent-message', 'last-assistant-message': '현재 작업을 확인하고 있습니다.' },
    { ...event, 'input-messages': ['이전 요청'], 'last-assistant-message': '{"works":[]}' }
  ]) {
    notify(wrong)
    expect(takeAgentSignals(dir)).toEqual([])
    expect(readAgentOutput(dir)).toBeUndefined()
    expect(runner.agentDone('tab')).toBeNull() // 구버전/지연 완료 신호가 와도 실패로 바꾸지 않는다.
    expect(runner.list()[0].nodes).toMatchObject({ ai: { status: 'running' }, print: { status: 'waiting' } })
    expect(runner.list()[0].nodes.ai.output).toBeUndefined()
  }
  const result = { works: [{ title: '실제로 완료한 작업', active: false, count: 0 }] }
  notify({ ...event, 'input-messages': [prompt.replace(/\n/g, '\r\n')], 'last-assistant-message': JSON.stringify(result) })
  expect(takeAgentSignals(dir)).toEqual(['done'])
  expect(runner.agentDone('tab')).toMatchObject({ status: 'done', nodes: { ai: { structuredOutput: result }, print: { status: 'done', output: JSON.stringify(result, null, 2) } } })
  expect(await fs.readdir(dir)).not.toContain('agent-output.json')
})

it('새 Codex 탭의 전체 ID를 아직 찾지 못했어도 화면에서 받은 세션 ID 접두어로 제목 세션을 제외한다', async () => {
  const dir = await tempDir('orbit-final-prefix-'), integration = prepareTerminalIntegration(dir, 'codex', dir)
  const prompt = '같은 입력', sessionId = '11111111-2222-3333-4444-555555555555'
  beginOutputCapture(dir, prompt, undefined, sessionId.slice(0, 29))
  const notify = (id: string, output: string) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, 'notify'], { env: { ...process.env, ...integration.env }, input: JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'input-messages': [prompt], 'last-assistant-message': output }) })
  notify('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '{"title":"잘못된 제목"}')
  expect(readAgentOutput(dir)).toBeUndefined()
  expect(takeAgentSignals(dir)).toEqual([])
  notify(sessionId, '{"works":[]}')
  expect(readAgentOutput(dir)).toBe('{"works":[]}')
})

it('Claude는 요청 프롬프트의 UserPromptSubmit 이후 같은 세션의 Stop만 수집한다', async () => {
  const dir = await tempDir('orbit-claude-final-'), sessionId = '11111111-2222-3333-4444-555555555555'
  const integration = prepareTerminalIntegration(dir, 'claude', dir), prompt = '이번 요청'
  const send = (action: string, event: Record<string, unknown>) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
  const stop = { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: '{"works":[]}' }
  beginOutputCapture(dir, prompt, sessionId)
  send('done', stop)
  expect(takeAgentSignals(dir)).toEqual([])
  send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: '이전 요청' })
  send('done', stop)
  expect(readAgentOutput(dir)).toBeUndefined()
  send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt })
  for (const wrong of [{ ...stop, hook_event_name: 'SubagentStop' }, { ...stop, agent_id: 'child' }, { ...stop, session_id: 'other' }]) send('done', wrong)
  expect(takeAgentSignals(dir)).toEqual([])
  send('done', stop)
  expect(readAgentOutput(dir)).toBe(stop.last_assistant_message)
  expect(takeAgentSignals(dir)).toEqual(['done'])
})
