import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node-pty'
import { createApi, type Api } from '../src/main/api'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import type { AccountObservation } from '../src/core/agentAccounts'
import { tempDir } from './helpers'

// 실제 CLI나 모델을 시작하지 않고 PTY에 전달된 계정별 환경을 확인한다.
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1, write: vi.fn(), kill: vi.fn(), resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) })) }))
const instances: Api[] = [], dirs: string[] = []
afterEach(async () => {
  for (const api of instances.splice(0)) await api.killAllTerminals()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

async function fixture() {
  const dir = await tempDir('orbit-account-execution-'); dirs.push(dir)
  vi.stubEnv('CODEX_HOME', path.join(dir, 'default-codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'default-claude'))
  vi.stubEnv('OPENAI_API_KEY', 'parent-key'); vi.stubEnv('ANTHROPIC_API_KEY', 'parent-key')
  vi.mocked(spawn).mockClear()
  vi.spyOn(TerminalWorkspace.prototype, 'whenReady').mockResolvedValue()
  let now = Date.now()
  const observation: AccountObservation = { checkedAt: new Date().toISOString(), quotaCheckedAt: new Date().toISOString(), loggedIn: true, windows: [{ id: 'week', label: '7일', usedPercent: 20 }], ordinaryUsageAllowed: true }
  const probe = vi.fn(async (): Promise<AccountObservation> => structuredClone(observation))
  const api = createApi({ send() {}, pickFolder: async () => null, recentFile: path.join(dir, 'state/recent.json'), onProjectOpened() {}, scheduleNow: () => now, accountProbe: probe }); instances.push(api)
  const project = await api.createProject(path.join(dir, 'project'))
  const graph = await api.savePipeline({ title: '계정 실행', nodes: [{ id: 'start', kind: 'start', text: '', terminal: 'new' }, { id: 'work', kind: 'codex', text: '검증', terminal: 'new' }], edges: [{ from: 'start', to: 'work' }] })
  const account = await api.saveAgentAccount({ provider: 'codex', label: '업무', enabled: true, minimumRemainingPercent: 10, blockWhenUnknown: true })
  const request = { pipelineId: graph.id, allowNew: true, accountIds: { codex: account.id } }
  return { dir, api, project, account, request, probe, observation, advance: (ms: number) => { now += ms } }
}

it('쿼터로 실행을 막고, 사용 가능 응답 후 선택 계정의 환경으로 시작하며 복원한다', async () => {
  const f = await fixture()
  f.observation.ordinaryUsageAllowed = false
  await expect(f.api.runPipelineBatch(f.request)).rejects.toThrow('한도 소진')
  expect(f.api.listPipelineRuns().total).toBe(0); expect(spawn).not.toHaveBeenCalled()
  f.observation.ordinaryUsageAllowed = true
  await f.api.refreshAgentAccount(f.account.id)
  const [run] = await f.api.runPipelineBatch(f.request)
  await vi.waitFor(() => expect(f.api.pipelineRuns().find((row) => row.runId === run.runId)?.nodes.work.status).toBe('running'))
  const environment = vi.mocked(spawn).mock.calls.at(-1)![2]!.env!
  expect(environment.CODEX_HOME).toBe(f.account.configDir)
  expect(environment.OPENAI_API_KEY).toBeUndefined(); expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
  expect((await f.api.pipelineExecution(run.runId)).options.accountIds?.codex).toBe(f.account.id)
  f.api.closeProject(); await f.api.openProject(f.project.projectDir)
  const workspace = await f.api.termLayout()
  expect(workspace.tabs[0].accountId).toBe(f.account.id)
  expect(vi.mocked(spawn).mock.calls.at(-1)![2]!.env?.CODEX_HOME).toBe(f.account.configDir)
})

it('소진으로 보류한 일회성 예약은 계정 회복 후 한 번 실행하고 완료 회차를 복원한다', async () => {
  const f = await fixture(), due = new Date(Date.now() + 1000).toISOString()
  f.observation.ordinaryUsageAllowed = false
  f.observation.windows[0].resetsAt = new Date(Date.now() + 3600_000).toISOString()
  await f.api.savePipelineSchedule({ title: '쿼터 대기', enabled: true, timing: { kind: 'once', at: due }, request: f.request })
  f.advance(2000)
  await vi.waitFor(async () => expect((await f.api.listPipelineSchedules())[0].last?.status).toBe('blocked'), { timeout: 3500 })
  expect(f.api.listPipelineRuns().total).toBe(0)
  f.observation.ordinaryUsageAllowed = true; await f.api.refreshAgentAccount(f.account.id)
  await vi.waitFor(async () => expect((await f.api.listPipelineSchedules())[0].last?.status).toBe('started'), { timeout: 3500 })
  expect(f.api.listPipelineRuns().total).toBe(1)
  f.api.closeProject(); await f.api.openProject(f.project.projectDir)
  expect((await f.api.listPipelineSchedules())[0]).toMatchObject({ enabled: false, last: { status: 'started' } })
  expect(f.api.listPipelineRuns().total).toBe(1)
}, 10_000)

it('새 탭을 금지하고 다른 계정의 탭만 고르면 대기 상태로 빠지기 전에 거절한다', async () => {
  const f = await fixture(), other = await f.api.openAgentAccount('default-codex')
  await expect(f.api.runPipelineBatch({ ...f.request, terminalIds: [other.id], allowNew: false })).rejects.toThrow('선택한 실행 계정과 같은 계정')
  expect(f.api.listPipelineRuns().total).toBe(0); expect(f.probe).not.toHaveBeenCalled()
})

it('계정 조회 도중 프로젝트를 바꾸면 이전 예약을 실행하지 않고 원래 프로젝트에서만 재개한다', async () => {
  const f = await fixture()
  let complete!: (value: AccountObservation) => void
  f.probe.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
  await f.api.savePipelineSchedule({ title: '프로젝트 전환', enabled: true, timing: { kind: 'once', at: new Date(Date.now() + 1000).toISOString() }, request: f.request })
  f.advance(2000)
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalled(), { timeout: 3500 })
  f.api.closeProject()
  const opening = f.api.createProject(path.join(f.dir, 'other'))
  complete(f.observation); await opening
  expect(f.api.listPipelineRuns().total).toBe(0); expect(spawn).not.toHaveBeenCalled()
  await f.api.openProject(f.project.projectDir)
  await vi.waitFor(() => expect(f.api.listPipelineRuns().total).toBe(1), { timeout: 3500 })
  expect(f.api.listPipelineRuns().runs[0].schedule?.title).toBe('프로젝트 전환')
}, 10_000)
