import { promises as fs } from 'fs'
import path from 'path'
import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'node-pty'
import { expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { PipelineRunner, expandPipeline, type Pipeline, type PipeNode } from '../src/core/pipeline'
import { tempDir } from './helpers'

/**
 * 실제 Claude Code·Codex를 Orbit과 같은 방식으로 띄워 작업 그래프를 끝까지 돌린다.
 * 모델 요청은 로컬 고정 서버가 받는다. 실제 계정·모델은 쓰지 않는다.
 * ORBIT_AUTOMATION_SMOKE=1 일 때만 실행한다.
 */
const LONG = [
  '# 긴 작업 지시', '', '아래 조건을 모두 지켜 구현하세요. "따옴표", \'작은따옴표\', `백틱`, <태그>, & 기호, 100% 확인.', '',
  '| 열 1 | 열 2 | 열 3 |', '|---|---|---|', ...Array.from({ length: 40 }, (_, i) => `| 항목 ${i} | 값 — ${i * 7} | 비고 · 확인 ✅ |`), '',
  '```ts', 'function 예시(x: number) {', '\treturn x * 2 // 탭 들여쓰기', '}', '```', '',
  ...Array.from({ length: 60 }, (_, i) => `${i + 1}. 한글 문장 ${i}: 서버 권위 이동과 패킷 검증을 확인하고, 실패하면 이유를 적는다…`),
  '', '<!-- 사용자 주석 -->', '끝.'
].join('\r\n')

type Kind = 'claude' | 'codex'
const texts = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts) : value && typeof value === 'object' ? Object.values(value).flatMap(texts) : []

function fakeModel(log: { kind: Kind; tag: string; step: string }[], delays: { slow: number }) {
  return createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      if (!request.url?.includes('responses') && !request.url?.includes('messages')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return }
      const kind: Kind = request.url.includes('responses') ? 'codex' : 'claude'
      let parsed: { tools?: unknown[]; messages?: { role: string; content: unknown }[]; input?: unknown[] } = {}
      try { parsed = JSON.parse(body) } catch { /* */ }
      // 제목 생성 같은 부수 요청은 도구 없이 온다
      if (!parsed.tools?.length) return reply(kind, response, { text: 'title' })
      const all = texts(kind === 'claude' ? parsed.messages : parsed.input).join('\n')
      const tag = /NODE=(\w+)/.exec([...all.matchAll(/NODE=(\w+)/g)].at(-1)?.[0] ?? '')?.[1] ?? '?'
      const last = kind === 'claude' ? JSON.stringify(parsed.messages?.at(-1) ?? '') : JSON.stringify(parsed.input?.at(-1) ?? '')
      const afterTool = kind === 'claude' ? last.includes('tool_result') : last.includes('function_call_output')
      const structured = /\[출력 형식\]/.test(texts(kind === 'claude' ? parsed.messages?.at(-1) : parsed.input?.at(-1)).join('\n')) || (!afterTool && /\[출력 형식\]/.test(all) && !all.includes('제출했습니다'))
      const slow = all.includes('SLOW')
      if (structured && !afterTool) { log.push({ kind, tag, step: 'submit' }); return reply(kind, response, { tool: { name: 'submit_output', args: { result: { node: tag, count: 3 } } } }) }
      log.push({ kind, tag, step: afterTool ? 'final-after-tool' : 'final' })
      reply(kind, response, { text: afterTool ? '' : `완료 ${tag}`, delay: slow ? delays.slow : 300 })
    })
  })
}

function reply(kind: Kind, response: ServerResponse, r: { text?: string; tool?: { name: string; args: object }; delay?: number }) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delay = r.delay ?? 300
  if (kind === 'claude') {
    const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    setTimeout(() => {
      if (r.tool) {
        emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tool_${Date.now()}`, name: `mcp__orbit__${r.tool.name}`, input: {} } })
        emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(r.tool.args) } })
      } else {
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        if (r.text) emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: r.text } })
      }
      emit('content_block_stop', { index: 0 })
      emit('message_delta', { delta: { stop_reason: r.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      emit('message_stop', {}); response.end()
    }, delay)
    return
  }
  const id = `${Date.now()}`
  const item = r.tool
    ? { id: `call_${id}`, type: 'function_call', call_id: `call_${id}`, namespace: 'mcp__orbit', name: r.tool.name, arguments: JSON.stringify(r.tool.args), status: 'completed' }
    : { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: r.text ?? '', annotations: [] }] }
  response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress', output: [] } })}\n\n`)
  setTimeout(() => {
    response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
  }, delay)
}

const node = (id: string, kind: Kind, text: string, extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text, terminal: 'new', ...extra })

const SCENARIOS: { name: string; graph: (kind: Kind) => Pipeline; check: (kind: Kind, run: ReturnType<PipelineRunner['list']>[number]) => void }[] = [
  {
    name: 'new-tab',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '간단한 작업 NODE=a')], edges: [] }),
    check: (_k, run) => expect(run.nodes.a.output).toBe('완료 a')
  },
  {
    name: 'long-prompt',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, `${LONG}\r\nNODE=a`)], edges: [] }),
    check: (_k, run) => expect(run.nodes.a.output).toBe('완료 a')
  },
  {
    name: 'chain-same-tab',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '첫 작업 NODE=a'), node('b', kind, '앞 결과: {{a}} NODE=b', { terminal: 'continue' }), node('c', kind, '앞 결과: {{b}} NODE=c', { terminal: 'continue' })], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }),
    check: (_k, run) => expect(['a', 'b', 'c'].map((id) => run.nodes[id].output)).toEqual(['완료 a', '완료 b', '완료 c'])
  },
  {
    name: 'structured-mcp',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '구조화 작업 NODE=a', { outputSchema: JSON.stringify({ type: 'object', properties: { node: { type: 'string', description: '' }, count: { type: 'number', description: '' } }, required: ['node', 'count'], additionalProperties: false }) })], edges: [] }),
    check: (_k, run) => expect(run.nodes.a.structuredOutput).toEqual({ node: 'a', count: 3 })
  },
  {
    name: 'slow-response',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '느린 작업 SLOW NODE=a'), node('b', kind, '다음 NODE=b', { terminal: 'continue' })], edges: [{ from: 'a', to: 'b' }] }),
    check: (_k, run) => expect([run.nodes.a.output, run.nodes.b.output]).toEqual(['완료 a', '완료 b'])
  },
  {
    name: 'startup-dialog',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '첫 실행 NODE=a')], edges: [] }),
    check: (_k, run) => expect(run.nodes.a.output).toBe('완료 a')
  },
  {
    name: 'parallel-new-tabs',
    graph: (kind) => ({ id: 'g', title: 'g', file: '', nodes: [node('a', kind, '병렬 NODE=a'), node('b', kind, '병렬 NODE=b'), node('c', kind, '합치기 {{a}} {{b}} NODE=c')], edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }] }),
    check: (_k, run) => expect(['a', 'b', 'c'].map((id) => run.nodes[id].output)).toEqual(['완료 a', '완료 b', '완료 c'])
  }
]

const only = process.env.ORBIT_AUTOMATION_SCENARIO?.split(',')
const kinds = (process.env.ORBIT_AUTOMATION_KINDS?.split(',') ?? ['claude', 'codex']) as Kind[]
const cases = kinds.flatMap((kind) => SCENARIOS.filter((s) => !only || only.includes(s.name)).map((s) => ({ kind, scenario: s.name })))

it.skipIf(!process.env.ORBIT_AUTOMATION_SMOKE).each(cases)('실제 $kind에서 $scenario 그래프를 끝까지 완료한다', async ({ kind, scenario }) => {
  const s = SCENARIOS.find((x) => x.name === scenario)!
  const root = await tempDir(`orbit-auto-${kind}-${scenario}-`)
  const codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude')
  await fs.mkdir(codexHome); await fs.mkdir(claudeHome)
  const cwd = await fs.realpath(root)
  const log: { kind: Kind; tag: string; step: string }[] = []
  const server = fakeModel(log, { slow: 9000 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  // startup-dialog: 폴더 신뢰 질문이 뜨는 첫 실행. 사람이 몇 초 뒤 답할 때까지 Orbit은 아무 키도 보내면 안 된다.
  const dialog = scenario === 'startup-dialog'
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model="orbit-probe"\nmodel_provider="orbit_probe"\n[model_providers.orbit_probe]\nname="OrbitProbe"\nbase_url="http://127.0.0.1:${port}"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nplugins=false\n` + (dialog ? '' : `[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level="trusted"\n`))
  await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: !dialog, hasCompletedProjectOnboarding: true } } }))
  const answered = new Set<string>()
  vi.stubEnv('CODEX_HOME', codexHome); vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'orbit-probe'); vi.stubEnv('ANTHROPIC_API_KEY', '')
  const output: Record<string, string> = {}
  const events: string[] = []
  const t0 = Date.now(), stamp = (e: string) => events.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${e}`)
  const settings = { name: 'automation stress', driftIntervalDays: 7, reminderTime: '09:00' }
  const workspace = new TerminalWorkspace(path.join(root, 'workspace.json'), { projectDir: cwd, dataRoot: path.join(root, 'docs') }, spawn, {
    onData(id, data) {
      output[id] = ((output[id] ?? '') + data).slice(-400000)
      // xterm.js가 대신 답하는 터미널 질의
      if (data.includes('\x1b[6n')) workspace.write(id, '\x1b[1;1R')
      if (data.includes('\x1b]10;?')) workspace.write(id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      if (data.includes('\x1b]11;?')) workspace.write(id, '\x1b]11;rgb:0000/0000/0000\x1b\\')
      // Claude: 폴더 신뢰(기본값 "No, exit"), Codex(Windows): 샌드박스 설정(기본값 관리자 설정). 사람은 두 번째 항목을 고른다.
      if (dialog && !answered.has(id) && /trust|sandbox/i.test(output[id].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, ''))) {
        answered.add(id)
        stamp(`${id.slice(5, 13)} dialog shown`)
        setTimeout(() => { stamp(`${id.slice(5, 13)} user answers dialog`); workspace.write(id, '\x1b[B'); setTimeout(() => workspace.write(id, '\r'), 300) }, 5000)
      }
    },
    onChange(info) { stamp(`${info.id.slice(5, 13)} activity=${info.activity}`) },
    onAgentDone: (id) => { stamp(`${id.slice(5, 13)} agentDone`); runner.agentDone(id) },
    onAgentError: (id, error) => { stamp(`${id.slice(5, 13)} agentError ${error}`); runner.terminalFailed(id, error) },
    onExit(id, code) { stamp(`${id.slice(5, 13)} exit ${code}`) }
  })
  const runner = new PipelineRunner({
    createTerminal: (k, label) => workspace.open(k, settings, { title: label }), hasTerminal: (id) => workspace.has(id), getTerminal: (id) => workspace.get(id),
    whenReady: (id) => workspace.whenReady(id), submit: (id, text) => { stamp(`${id.slice(5, 13)} submit ${text.length}자`); workspace.submit(id, text) }, runCommand: (id, text) => workspace.runCommand(id, text),
    beginOutputCapture: (id, text, schema, messages) => workspace.beginOutputCapture(id, text, schema, messages), readAgentOutput: (id) => workspace.readAgentOutput(id), endOutputCapture: (id) => workspace.endOutputCapture(id),
    syncMessageRun: (id, scope) => workspace.syncMessageRun(id, scope), completeTasks: async () => {}, emit: (st) => stamp(`run ${st.status} ${Object.entries(st.nodes).map(([k, v]) => `${k}:${v.status}${v.message ? `(${v.message})` : ''}`).join(' ')}`)
  })
  try {
    const g = s.graph(kind)
    runner.start({ ...g, ...expandPipeline(g, {}) })
    await vi.waitFor(() => expect(runner.list()[0].status).not.toBe('running'), { timeout: 90000, interval: 250 })
    const run = runner.list()[0]
    expect(run.status, JSON.stringify(run.nodes)).toBe('done')
    s.check(kind, run)
    if (dialog) {
      const at = (word: string) => events.findIndex((e) => e.includes(word))
      expect(at('dialog shown'), events.join('\n')).toBeGreaterThanOrEqual(0)
      // 프롬프트는 사람이 안내 창에 답한 뒤에만 보낸다
      expect(at('submit'), events.join('\n')).toBeGreaterThan(at('user answers dialog'))
      expect(events.some((e) => e.includes('입력 준비'))).toBe(true)
    }
  } finally {
    await fs.writeFile(path.join(root, 'diagnostics.json'), JSON.stringify({ events, log, runs: runner.list() }, null, 2))
    runner.reset(); workspace.suspend(); server.closeAllConnections(); server.close(); vi.unstubAllEnvs()
    await fs.writeFile(path.join(root, 'output.txt'), Object.entries(output).map(([k, v]) => `===== ${k}\n${v}`).join('\n'))
    console.info(`[${kind}/${scenario}] diagnostics:`, root)
  }
}, 120000)
