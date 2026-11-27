import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect, type Orbit } from './fixtures'
import { savePipeline } from '../../src/core/pipelineStore'

/**
 * 실제 앱(Electron) 안에서 실제 Claude Code·Codex를 띄워 작업 그래프를 끝까지 돌린다.
 * 모델 요청은 로컬 고정 서버가 받는다. ORBIT_AUTOMATION_SMOKE=1 일 때만 실행한다.
 */
test.skip(!process.env.ORBIT_AUTOMATION_SMOKE, '실제 Claude Code·Codex가 필요합니다')
test.setTimeout(240_000)

const texts = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts) : value && typeof value === 'object' ? Object.values(value).flatMap(texts) : []

function fakeModel(): Server {
  return createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      if (!request.url?.includes('responses') && !request.url?.includes('messages')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return }
      const claude = request.url.includes('messages')
      let parsed: { tools?: unknown[]; messages?: unknown; input?: unknown } = {}
      try { parsed = JSON.parse(body) } catch { /* */ }
      const all = texts(claude ? parsed.messages : parsed.input).join('\n')
      const tag = [...all.matchAll(/NODE=(\w+)/g)].at(-1)?.[1] ?? '?'
      const text = parsed.tools?.length ? `완료 ${tag}` : 'title'
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (claude) {
        const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        emit('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        setTimeout(() => {
          emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
          emit('content_block_stop', { index: 0 })
          emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
          emit('message_stop', {}); response.end()
        }, 500)
        return
      }
      const item = { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp', status: 'in_progress', output: [] } })}\n\n`)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
      }, 500)
    })
  })
}

async function prepareAgents(orbit: Orbit, port: number) {
  const cwd = await fs.realpath(orbit.ctx.projectDir)
  const claudeHome = path.join(orbit.isolatedHome, '.claude'), codexHome = path.join(orbit.isolatedHome, '.codex')
  await fs.mkdir(claudeHome, { recursive: true }); await fs.mkdir(codexHome, { recursive: true })
  // 앱은 사용자 키를 비운 채 띄운다. CLI 자체 설정으로만 로컬 서버를 가리킨다.
  // Claude 계정 확인(claude auth status)이 로그인으로 보도록 가짜 키를 준다. 요청은 로컬 서버로만 간다.
  // Codex는 OpenAI 로그인이 필요 없는 직접 지정 공급자(requires_openai_auth = false)라 로그인 정보를 두지 않는다.
  await fs.writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo orbit-probe', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }))
  await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model="orbit-probe"\nmodel_provider="orbit_probe"\n[model_providers.orbit_probe]\nname="OrbitProbe"\nbase_url="http://127.0.0.1:${port}"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nplugins=false\n[windows]\nsandbox="unelevated"\n[projects.${JSON.stringify(process.platform === 'win32' ? cwd.toLowerCase() : cwd)}]\ntrust_level="trusted"\n`)
}

test('앱에서 Claude Code → Codex → 같은 탭 이어서 그래프를 실행 버튼으로 돌려 끝까지 완료한다', async ({ orbit }) => {
  const server = fakeModel()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await prepareAgents(orbit, (server.address() as AddressInfo).port)
    const graph = await savePipeline(orbit.ctx, { title: '에이전트 연속 실행', nodes: [
      { id: 'start', kind: 'start', terminal: 'new', text: '' },
      { id: 'a', name: 'Claude 작업', kind: 'claude', terminal: 'new', text: '첫 작업 NODE=a' },
      { id: 'b', name: 'Codex 작업', kind: 'codex', terminal: 'new', text: '앞 결과 {{a}} NODE=b' },
      { id: 'c', name: 'Codex 이어서', kind: 'codex', terminal: 'continue', text: '앞 결과 {{b}} NODE=c' }
    ], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }] })
    await orbit.page.evaluate(async (dir) => { await window.orbit.invoke('closeProject'); await window.orbit.invoke('openProject', dir) }, orbit.ctx.projectDir)
    await orbit.page.reload()
    // 앱 시작 때 확인한 계정 상태를 방금 넣은 CLI 설정으로 다시 확인한다
    await orbit.page.getByRole('button', { name: '모든 계정 사용량 새로고침' }).click()
    await expect(orbit.page.getByRole('region', { name: '실행 계정과 사용량' })).not.toContainText('로그인', { timeout: 30_000 })
    await orbit.page.locator('nav').getByRole('button', { name: '자동화', exact: true }).click()
    await orbit.page.locator('.automation-page > .row .seg').getByRole('button', { name: '그래프', exact: true }).click()
    await orbit.page.locator(`[data-pipeline-id="${graph.id}"]`).click()
    await orbit.page.getByRole('button', { name: '▶ 실행' }).click()
    await orbit.page.getByRole('checkbox', { name: '사용할 세션이 없을 때 새 터미널 허용' }).check()
    await orbit.page.getByRole('button', { name: '1건 실행', exact: true }).click()
    await expect(orbit.page.getByText('실행을 시작했습니다')).toBeVisible()
    await expect.poll(async () => (await orbit.page.evaluate(() => window.orbit.invoke('pipelineRuns')) as { status: string }[])[0]?.status ?? 'none', { timeout: 180_000, intervals: [1000] }).toMatch(/^(done|failed|stopped)$/)
    const [run] = await orbit.page.evaluate(() => window.orbit.invoke('pipelineRuns')) as { status: string; nodes: Record<string, { status: string; output?: string; message?: string }> }[]
    expect(run.status, JSON.stringify(run.nodes)).toBe('done')
    expect(['a', 'b', 'c'].map((id) => run.nodes[id].output)).toEqual(['완료 a', '완료 b', '완료 c'])
  } finally {
    server.closeAllConnections(); server.close()
  }
})
