import { spawn, execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { beginOutputCapture, endOutputCapture, prepareTerminalIntegration, takeAgentSignals } from '../src/core/terminalIntegration'
import { readMessageLog, writeMessageScope, type MessageScope } from '../src/core/sessionMessages'
import { tempDir } from './helpers'

interface RpcResult { result: { isError?: boolean; content: { text: string }[] } }
function client(dir: string) {
  const child = spawn(process.execPath, [path.join(dir, 'mcp.cjs'), dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0, buffer = ''
  const pending = new Map<number, { resolve: (response: RpcResult) => void; reject: (error: Error) => void }>()
  child.stdout.on('data', (part: Buffer) => {
    buffer += part.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)) as RpcResult & { id: number }
      buffer = buffer.slice(end + 1)
      pending.get(response.id)?.resolve(response); pending.delete(response.id)
    }
  })
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('MCP 종료')) })
  return {
    call(name: string, args: object = {}): Promise<RpcResult> {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      })
    },
    close() { child.kill() }
  }
}
const content = (result: RpcResult): unknown => JSON.parse(result.result.content[0].text)

it('Codex·Claude MCP 프로세스가 연결한 상대에게만 실시간 왕복하고 실행·요청 종료 시 수신을 중단한다', async () => {
  const root = await tempDir('orbit-message-test-'), scopeRoot = path.join(root, 'run-one')
  const a = path.join(root, 'codex'), b = path.join(root, '한글 claude'), c = path.join(root, 'unlinked')
  const scope: MessageScope = { status: 'running', nodes: {
    a: { id: 'a', name: '구현', kind: 'codex', status: 'running', peers: ['b'] },
    b: { id: 'b', name: '검증', kind: 'claude', status: 'running', peers: ['a'] },
    c: { id: 'c', name: '별도 작업', kind: 'codex', status: 'running', peers: [] }
  } }
  writeMessageScope(scopeRoot, scope)
  for (const [dir, id, kind] of [[a, 'a', 'codex'], [b, 'b', 'claude'], [c, 'c', 'codex']] as const) {
    prepareTerminalIntegration(dir, kind, root)
    beginOutputCapture(dir, '작업', undefined, undefined, undefined, { root: scopeRoot, nodeId: id })
  }
  const ca = client(a), cb = client(b), cc = client(c)
  try {
    expect(content(await ca.call('list_peers'))).toEqual([{ id: 'b', name: '검증', kind: 'claude', status: 'running' }])
    expect(content(await cc.call('list_peers'))).toEqual([])
    expect((await ca.call('send_message', { to: 'c', text: '누출 금지' })).result.isError).toBe(true)
    expect((await ca.call('send_message', { to: '../b', text: '누출 금지' })).result.isError).toBe(true)
    expect((await ca.call('send_message', { to: 'b', text: 'x'.repeat(8001) })).result.isError).toBe(true)
    const waiting = cb.call('receive_messages', { wait_seconds: 30 })
    expect((await ca.call('send_message', { to: 'b', text: 'API 구현 완료 · 검증 부탁해요\n두 번째 줄' })).result.isError).toBeUndefined()
    expect(content(await waiting)).toMatchObject({ messages: [{ from: 'a', to: 'b', text: 'API 구현 완료 · 검증 부탁해요\n두 번째 줄' }] })
    expect(content(await cb.call('receive_messages'))).toMatchObject({ messages: [] })
    await cb.call('send_message', { to: 'a', text: '응답 확인' })
    expect(content(await ca.call('receive_messages'))).toMatchObject({ messages: [{ from: 'b', text: '응답 확인' }] })
    expect(readMessageLog(scopeRoot).map((m) => m.read)).toEqual([true, true])
    expect(takeAgentSignals(a)).toEqual([])
    expect(takeAgentSignals(b)).toEqual([])
    const oldWait = cb.call('receive_messages', { wait_seconds: 30 })
    await cb.call('list_peers')
    // 같은 터미널을 다른 실행에 재사용해도 이전 수신 요청이 새 실행의 메시지를 읽으면 안 된다.
    const otherRoot = path.join(root, 'run-two')
    writeMessageScope(otherRoot, scope)
    beginOutputCapture(b, '다음 실행', undefined, undefined, undefined, { root: otherRoot, nodeId: 'b' })
    expect((await oldWait).result.isError).toBe(true)
    await ca.call('send_message', { to: 'b', text: '이전 실행 메시지' })
    expect(content(await cb.call('receive_messages'))).toMatchObject({ messages: [] })
    scope.status = 'stopped'; writeMessageScope(scopeRoot, scope)
    expect((await ca.call('send_message', { to: 'b', text: '중지 후' })).result.isError).toBe(true)
    endOutputCapture(b)
    expect((await cb.call('list_peers')).result.isError).toBe(true)
    prepareTerminalIntegration(a, 'codex', root)
    scope.status = 'running'; writeMessageScope(scopeRoot, scope)
    beginOutputCapture(a, '재연결', undefined, undefined, undefined, { root: scopeRoot, nodeId: 'a' })
    expect((await ca.call('list_peers')).result.isError).toBe(true)
  } finally { ca.close(); cb.close(); cc.close() }
})

it('Claude는 도구 실행 뒤와 Stop에서 새 메시지를 한 번만 읽고 처리 전에는 완료 신호를 보내지 않는다', async () => {
  const root = await tempDir('orbit-message-hook-'), a = path.join(root, 'a'), b = path.join(root, 'b'), scopeRoot = path.join(root, 'run')
  const session = '11111111-2222-3333-4444-555555555555'
  const scope: MessageScope = { status: 'running', nodes: {
    a: { id: 'a', name: 'Codex', kind: 'codex', status: 'running', peers: ['b'] },
    b: { id: 'b', name: 'Claude', kind: 'claude', status: 'running', peers: ['a'] }
  } }
  writeMessageScope(scopeRoot, scope)
  prepareTerminalIntegration(a, 'codex', root)
  const integration = prepareTerminalIntegration(b, 'claude', root)
  beginOutputCapture(a, '작업', undefined, undefined, undefined, { root: scopeRoot, nodeId: 'a' })
  const tagged = beginOutputCapture(b, '작업', session, undefined, undefined, { root: scopeRoot, nodeId: 'b' })
  const bridge = (action: string, event: object) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, action], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event), encoding: 'utf8' })
  bridge('prompt', { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: tagged })
  const ca = client(a)
  try {
    await ca.call('send_message', { to: 'b', text: '도구 중 도착' })
    const hook = (event: object) => execFileSync(process.execPath, [path.join(b, 'messages.cjs'), b], { env: { ...process.env, ...integration.env }, input: JSON.stringify(event), encoding: 'utf8' })
    expect(hook({ hook_event_name: 'PostToolUse', agent_id: 'subagent' })).toBe('')
    expect(hook({ hook_event_name: 'PostToolUse', session_id: 'different-session' })).toBe('')
    expect(JSON.parse(hook({ hook_event_name: 'PostToolUse' }))).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('도구 중 도착') } })
    expect(hook({ hook_event_name: 'PostToolUse' })).toBe('')
    await ca.call('send_message', { to: 'b', text: '종료 직전 질문' })
    const event = { hook_event_name: 'Stop', session_id: session, last_assistant_message: '완료' }
    expect(JSON.parse(bridge('done', event))).toMatchObject({ decision: 'block', reason: expect.stringContaining('종료 직전 질문') })
    expect(takeAgentSignals(b)).toEqual([])
    bridge('done', event)
    expect(takeAgentSignals(b)).toEqual(['done'])
    scope.nodes.b.status = 'done'; writeMessageScope(scopeRoot, scope)
    expect((await ca.call('send_message', { to: 'b', text: '종료 후' })).result.isError).toBe(true)
  } finally { ca.close() }
})
