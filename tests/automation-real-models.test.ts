import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'node-pty'
import { expect, it } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { AGENT_PORT, PipelineRunner, expandPipeline, type Pipeline } from '../src/core/pipeline'
import { tempDir } from './helpers'

/**
 * 사용자 계정으로 로그인된 실제 Claude Code·Codex와 실제 모델로 작업 그래프를 끝까지 돌린다.
 * 파일을 고치지 않는 짧은 요청만 보낸다. ORBIT_REAL_MODEL_SMOKE=<신뢰된 프로젝트 폴더> 일 때만 실행한다.
 */
const project = process.env.ORBIT_REAL_MODEL_SMOKE

it.skipIf(!project)('실제 모델로 Claude → Codex → Codex 이어서(구조화) → Claude 이어서(구조화) 그래프를 끝까지 완료한다', async () => {
  const root = await tempDir('orbit-real-models-')
  const events: string[] = []
  const output: Record<string, string> = {}
  const t0 = Date.now(), stamp = (e: string) => events.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${e}`)
  const settings = { name: 'real models', driftIntervalDays: 7, reminderTime: '09:00' }
  const workspace = new TerminalWorkspace(path.join(root, 'workspace.json'), { projectDir: project!, dataRoot: path.join(root, 'docs') }, spawn, {
    onData(id, data) {
      output[id] = ((output[id] ?? '') + data).slice(-400000)
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
    },
    onChange(info) { stamp(`${info.id.slice(5, 13)} ${info.kind} activity=${info.activity}`) },
    onAgentDone: (id) => { stamp(`${id.slice(5, 13)} agentDone`); runner.agentDone(id) },
    onAgentError: (id, error) => { stamp(`${id.slice(5, 13)} agentError ${error}`); runner.terminalFailed(id, error) },
    onAgentWaiting: (id, waiting) => { stamp(`${id.slice(5, 13)} waiting=${waiting}`); runner.agentWaiting(id, waiting) },
    onExit(id, code) { stamp(`${id.slice(5, 13)} exit ${code}`) }
  })
  const runner = new PipelineRunner({
    createTerminal: (k, label) => workspace.open(k, settings, { title: label }), hasTerminal: (id) => workspace.has(id), getTerminal: (id) => workspace.get(id),
    whenReady: (id, onChoice) => workspace.whenReady(id, onChoice), submit: (id, text) => { stamp(`${id.slice(5, 13)} submit`); workspace.submit(id, text) }, runCommand: (id, text) => workspace.runCommand(id, text),
    beginOutputCapture: (id, text, schema, messages) => workspace.beginOutputCapture(id, text, schema, messages), readAgentOutput: (id) => workspace.readAgentOutput(id), endOutputCapture: (id) => workspace.endOutputCapture(id),
    completeTasks: async () => {}, emit: (st) => stamp(`run ${st.status} ${Object.entries(st.nodes).map(([k, v]) => `${k}:${v.status}${v.message ? `(${v.message})` : ''}`).join(' ')}`)
  })
  const rule = '도구나 파일을 쓰지 말고 바로 답하세요.'
  const fields = [{ name: 'word', type: 'string' as const, description: '받은 단어를 그대로' }, { name: 'length', type: 'number' as const, description: '그 단어의 글자 수' }]
  const graph: Pipeline = { id: 'real', title: '실제 모델', file: '', nodes: [
    { id: 'a', name: 'Claude', kind: 'claude', terminal: 'new', text: `${rule} 영어 단어 "orbit"만 한 줄로 답하세요.` },
    { id: 'b', name: 'Codex', kind: 'codex', terminal: 'new', text: `${rule} 아래에 붙은 글을 대문자로 바꿔 그 결과만 한 줄로 답하세요.` },
    { id: 'c', name: 'Codex 이어서', kind: 'codex', terminal: 'continue', text: `${rule} 방금 답한 단어와 그 글자 수를 내세요.`, fields },
    { id: 'd', name: 'Claude 구조화', kind: 'claude', terminal: 'new', text: `${rule} 아래에 붙은 결과의 word와 length를 그대로 내세요.`, fields }
  ], edges: [
    // 실행 선과 데이터 선(앞 노드의 응답을 다음 프롬프트 뒤에 붙인다)
    { from: 'a', to: 'b' }, { from: 'a', to: 'b', pin: 'data', fromPort: AGENT_PORT.output },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' }, { from: 'c', to: 'd', pin: 'data', fromPort: AGENT_PORT.output }
  ] }
  try {
    runner.start({ ...graph, ...expandPipeline(graph, {}) })
    for (let i = 0; i < 600 && runner.list()[0].status === 'running'; i++) await new Promise((r) => setTimeout(r, 500))
    const run = runner.list()[0]
    expect(run.status, events.join('\n')).toBe('done')
    expect(run.nodes.a.output?.toLowerCase()).toContain('orbit')
    expect(run.nodes.b.output).toContain('ORBIT')
    expect(run.nodes.c.structuredOutput).toMatchObject({ word: expect.stringMatching(/orbit/i), length: 5 })
    expect(run.nodes.d.structuredOutput).toMatchObject({ word: expect.stringMatching(/orbit/i), length: 5 })
  } finally {
    await fs.writeFile(path.join(root, 'diagnostics.json'), JSON.stringify({ events, runs: runner.list() }, null, 2))
    await fs.writeFile(path.join(root, 'output.txt'), Object.entries(output).map(([k, v]) => `===== ${k}\n${v}`).join('\n'))
    console.info('real model diagnostics:', root)
    runner.reset(); workspace.suspend()
  }
}, 330_000)
