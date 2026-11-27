import { execFileSync } from 'child_process'
import path from 'path'
import { expect, it } from 'vitest'
import { ADD_PORT, AGENT_PORT, IF_PORT, PipelineRunner, expandPipeline, pipelineProblems, type PipeNode, type Pipeline } from '../src/core/pipeline'
import { beginOutputCapture, endOutputCapture, prepareTerminalIntegration, readAgentOutput, takeAgentSignals } from '../src/core/terminalIntegration'
import { tempDir } from './helpers'

const sessionId = '11111111-2222-3333-4444-555555555555'
const pasted = (text: string) => `\n\n<pasted_content id="595f">\n${text}\n</pasted_content id="595f">\n`

it.each([false, true])('탭이 공백 네 칸으로 변환된 Claude 요청도 본문·요청 ID·세션을 검증한다 (포장: %s)', async (wrapped) => {
  const dir = await tempDir('orbit-claude-tabs-'), integration = prepareTerminalIntegration(dir, 'claude', dir)
  const prompt = '- 상위\n\t- 하위\n\t\t- 손자\n\n첫 줄\n둘째 줄'
  const previous = beginOutputCapture(dir, prompt, sessionId), current = beginOutputCapture(dir, prompt, sessionId)
  expect(current.startsWith(prompt)).toBe(true)
  const pack = (text: string) => wrapped ? pasted(text) : text
  const send = (action: string, event: object) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
  const stop = { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: '완료' }
  for (const wrong of [previous.replace(/\t/g, '    '), current.replace(/\t/g, '  '), current.replace(/\t/g, '    ').replace('하위', '다른 본문')]) {
    send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: pack(wrong) })
    send('done', stop); expect(readAgentOutput(dir)).toBeUndefined()
  }
  send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: 'other', prompt: pack(current.replace(/\t/g, '    ')) })
  send('done', stop); expect(readAgentOutput(dir)).toBeUndefined()
  send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: pack(current.replace(/\t/g, '    ')) })
  send('done', stop); expect(readAgentOutput(dir)).toBe('완료')
})

it.each(['\n', '\r\n'])('Claude의 긴 붙여넣기 입력(%j)은 요청 본문·ID·세션이 일치할 때만 완료한다', async (newline) => {
  const dir = await tempDir('orbit-claude-paste-'), integration = prepareTerminalIntegration(dir, 'claude', dir)
  const prompt = '할 일 사전 검수·구현…\n' + '요구사항과 기존 검수 결과\n'.repeat(30000)
  const previous = beginOutputCapture(dir, prompt, sessionId)
  const current = beginOutputCapture(dir, prompt, sessionId)
  const send = (action: string, event: object) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
  const stop = { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: '{"ready":true}' }
  const submit = { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: pasted(current) }
  for (const wrong of [
    { ...submit, prompt: pasted(previous) },
    { ...submit, prompt: pasted(current.replace('사전 검수', '다른 작업')) },
    { ...submit, prompt: '다른 요청\n' + pasted(current) },
    { ...submit, prompt: pasted(current) + '다른 요청' },
    { ...submit, prompt: pasted(current).replace('</pasted_content id="595f">', '</pasted_content id="other">') },
    { ...submit, session_id: 'another-session' },
    { ...submit, agent_id: 'child' }
  ]) {
    send('prompt', wrong)
    send('done', stop)
    expect(takeAgentSignals(dir)).toEqual([])
    expect(readAgentOutput(dir)).toBeUndefined()
  }
  send('prompt', { ...submit, prompt: pasted(current).replace(/[·…]/g, '').replace(/\n/g, newline) })
  expect(readAgentOutput(dir)).toBeUndefined() // 입력 확인만으로는 완료하지 않는다.
  send('done', { ...stop, session_id: 'another-session' })
  expect(takeAgentSignals(dir)).toEqual([])
  send('done', stop)
  expect(takeAgentSignals(dir)).toEqual(['done'])
  expect(readAgentOutput(dir)).toBe(stop.last_assistant_message)
})

it('원문에 pasted_content 태그가 있는 요청도 본문을 바꾸지 않고 비교한다', async () => {
  const dir = await tempDir('orbit-literal-paste-'), integration = prepareTerminalIntegration(dir, 'claude', dir)
  const prompt = beginOutputCapture(dir, pasted('원문에 포함된 예시'), sessionId)
  const send = (action: string, event: object) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
  send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: pasted(prompt) })
  send('done', { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: '완료' })
  expect(takeAgentSignals(dir)).toEqual(['done'])
  expect(readAgentOutput(dir)).toBe('완료')
})

it.each([true, false])('붙여넣기된 Claude 사전 검수 ready=%s 결과로 구현·후속 검수를 분기한다', async (ready) => {
  const dir = await tempDir('orbit-paste-pipeline-')
  const integrations = new Map<string, ReturnType<typeof prepareTerminalIntegration>>()
  const prompts = new Map<string, string>()
  const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: `${id} 작업`, terminal: 'new', ...extra })
  const fields = [{ name: 'ready', type: 'boolean' as const, description: '구현 가능 여부' }]
  const graph: Pipeline = { id: 'review-flow', title: '사전 검수 → 구현 → 후속 검수', file: '', nodes: [
    node('pre-codex', 'codex', { fields }), node('pre-claude', 'claude', { fields }),
    node('codex-ready', 'property', { pointer: '/ready' }), node('claude-ready', 'property', { pointer: '/ready' }),
    node('codex-bool', 'boolean'), node('claude-bool', 'boolean'), node('both-ready', 'and'), node('gate', 'if'),
    node('implement', 'codex'), node('post-codex', 'codex'), node('post-claude', 'claude'), node('blocked', 'print')
  ], edges: [
    { from: 'pre-codex', to: 'pre-claude' }, { from: 'pre-claude', to: 'gate' },
    { from: 'pre-codex', to: 'codex-ready', pin: 'data', fromPort: AGENT_PORT.output },
    { from: 'pre-claude', to: 'claude-ready', pin: 'data', fromPort: AGENT_PORT.output },
    { from: 'codex-ready', to: 'codex-bool' }, { from: 'claude-ready', to: 'claude-bool' },
    { from: 'codex-bool', to: 'both-ready', toPort: ADD_PORT.a }, { from: 'claude-bool', to: 'both-ready', toPort: ADD_PORT.b },
    { from: 'both-ready', to: 'gate', toPort: IF_PORT.condition },
    { from: 'gate', to: 'implement', fromPort: IF_PORT.yes }, { from: 'gate', to: 'blocked', fromPort: IF_PORT.no },
    { from: 'implement', to: 'post-codex' }, { from: 'post-codex', to: 'post-claude' }
  ] }
  expect(pipelineProblems(graph)).toEqual([])
  const runner = new PipelineRunner({
    createTerminal: async (kind, title) => {
      integrations.set(title, prepareTerminalIntegration(path.join(dir, title), kind, dir))
      return { id: title, kind, title, pid: 1 }
    }, hasTerminal: () => true, getTerminal: () => undefined, whenReady: async () => {},
    submit: (id, text) => { prompts.set(id, text) }, runCommand() {}, completeTasks: async () => {}, emit() {},
    beginOutputCapture: (id, text) => beginOutputCapture(path.join(dir, id), text, sessionId),
    readAgentOutput: (id) => readAgentOutput(path.join(dir, id)), endOutputCapture: (id) => endOutputCapture(path.join(dir, id))
  })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  const complete = async (id: string, output: string) => {
    const integration = integrations.get(id)!, prompt = prompts.get(id)!
    expect(prompt).toContain('orbit-request:')
    const send = (action: string, event: object) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event) })
    if (graph.nodes.find((n) => n.id === id)?.kind === 'claude') {
      send('prompt', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: pasted(prompt) })
      send('done', { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: output })
    } else send('notify', { type: 'agent-turn-complete', 'thread-id': sessionId, 'input-messages': [prompt], 'last-assistant-message': output })
    expect(takeAgentSignals(path.join(dir, id))).toEqual(['done'])
    runner.agentDone(id)
    await flush()
  }
  runner.start({ ...graph, ...expandPipeline(graph) })
  await flush()
  await complete('pre-codex', '{"ready":true}')
  expect(runner.list()[0].nodes.implement.status).toBe('waiting')
  await complete('pre-claude', JSON.stringify({ ready }))
  expect(runner.list()[0].nodes.gate.conditionResult).toBe(ready)
  if (ready) {
    for (const id of ['implement', 'post-codex', 'post-claude']) {
      expect(runner.list()[0].nodes[id].status).toBe('running')
      await complete(id, `${id} 완료`)
    }
  } else expect(runner.list()[0].nodes.implement.status).toBe('skipped')
  expect(runner.list()[0].status).toBe('done')
  expect([...prompts.keys()]).toEqual(ready ? ['pre-codex', 'pre-claude', 'implement', 'post-codex', 'post-claude'] : ['pre-codex', 'pre-claude'])
})
