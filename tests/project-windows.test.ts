import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectWindows } from '../src/main/projectWindows'
import { AgentAccountStore } from '../src/main/agentAccountStore'
import type { Pipeline } from '../src/core/pipeline'
import type { TerminalSnapshot } from '../src/core/terminal'
import { tempDir } from './helpers'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1, write() {}, kill() {}, resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) })) }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs() })
async function fixture() {
  const dir = await tempDir('orbit-windows-'), send = vi.fn(), unwatch = vi.fn(), watch = vi.fn(() => unwatch)
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'))
  const accounts = new AgentAccountStore(path.join(dir, 'accounts'), () => {}, async () => ({ checkedAt: new Date().toISOString(), loggedIn: true, windows: [] }))
  let now = Date.now()
  const windows = new ProjectWindows({ recentFile: path.join(dir, 'recent.json'), pickFolder: async () => null, send, watch, accounts, scheduleNow: () => now })
  cleanups.push(async () => { await windows.closeWindow(1); await windows.closeWindow(2); await windows.closeWindow(3); windows.shutdown(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
  for (const id of [1, 2, 3]) windows.register(id)
  return { dir, windows, accounts, send, watch, unwatch, advance: (ms: number) => { now += ms } }
}

it('같은 프로젝트를 여러 창에서 열어도 예약을 한 번만 실행하고 한 창을 닫아도 유지한다', async () => {
  const f = await fixture(), parent = path.join(f.dir, 'actual'), alias = path.join(f.dir, 'alias')
  await fs.mkdir(parent)
  await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const folder = path.join(alias, 'project')
  await f.windows.invoke(1, 'createProject', [folder])
  await Promise.all([f.windows.invoke(2, 'openProject', [path.join(parent, 'project')]), f.windows.invoke(3, 'openProject', [folder])])
  expect(f.windows.all()).toHaveLength(1); expect(f.watch).toHaveBeenCalledTimes(1)
  const graph = await f.windows.invoke(1, 'savePipeline', [{ title: '공유 예약', nodes: [{ id: 'start', kind: 'start', terminal: 'new', text: '' }, { id: 'print', kind: 'print', terminal: 'new', text: '공유 출력' }], edges: [{ from: 'start', to: 'print' }] }]) as Pipeline
  await f.windows.invoke(1, 'savePipelineSchedule', [{ title: '한 번', enabled: true, timing: { kind: 'once', at: new Date(Date.now() + 1000).toISOString() }, request: { pipelineId: graph.id } }])
  await f.windows.closeWindow(1); expect(f.unwatch).not.toHaveBeenCalled()
  f.advance(2000)
  await vi.waitFor(() => expect(f.windows.all()[0].listPipelineRuns().total).toBe(1), { timeout: 3500 })
  expect(await f.windows.invoke(2, 'listPipelineRuns', [])).toEqual(await f.windows.invoke(3, 'listPipelineRuns', []))
  const tab = await f.windows.invoke(2, 'termCreate', ['shell']) as TerminalSnapshot
  f.send.mockClear()
  await f.windows.invoke(2, 'termRestart', [tab.id])
  expect(f.send).toHaveBeenCalledWith(3, 'term-restarted', expect.objectContaining({ id: tab.id }))
  expect(f.send.mock.calls.filter((call) => call[1] === 'term-restarted').map((call) => call[0])).toEqual([3])
  await f.windows.closeWindow(2); await f.windows.closeWindow(3)
  expect(f.unwatch).toHaveBeenCalledTimes(1); expect(f.windows.all()).toHaveLength(0)
})

it('프로젝트와 이미지 기준 경로는 창별로 격리하고 열기 실패는 원래 프로젝트를 보존한다', async () => {
  const f = await fixture()
  await f.windows.invoke(1, 'createProject', [path.join(f.dir, 'one')]); await f.windows.invoke(2, 'createProject', [path.join(f.dir, 'two')])
  expect((await f.windows.current(1))?.projectDir).not.toBe((await f.windows.current(2))?.projectDir)
  await f.windows.invoke(1, 'createTask', [{ title: '첫 창 문서', type: 'research', horizon: '지금' }])
  expect(await f.windows.invoke(2, 'listTasks', [])).toEqual([])
  const before = await f.windows.current(1)
  await expect(f.windows.invoke(1, 'openProject', [path.join(f.dir, 'missing')])).rejects.toThrow()
  expect(await f.windows.current(1)).toEqual(before)
  await f.windows.invoke(1, 'closeProject', []); expect(await f.windows.current(1)).toBeNull(); expect(await f.windows.current(2)).not.toBeNull()
})

it('현재 계정 전환은 모든 창의 새 터미널에 적용하고 기존 터미널 계정은 유지한다', async () => {
  const f = await fixture()
  await f.windows.invoke(1, 'createProject', [path.join(f.dir, 'one')]); await f.windows.invoke(2, 'createProject', [path.join(f.dir, 'two')])
  const old = await f.windows.invoke(1, 'termCreate', ['codex']) as TerminalSnapshot
  const work = await f.accounts.save({ provider: 'codex', label: '업무 계정', enabled: true, minimumRemainingPercent: 0, blockWhenUnknown: false })
  await f.windows.invoke(2, 'selectAgentAccount', ['codex', work.id])
  const next = await f.windows.invoke(1, 'termCreate', ['codex']) as TerminalSnapshot
  expect(old.accountId).toBe('default-codex'); expect(next.accountId).toBe(work.id)
  expect((await f.windows.all()[0].termState()).tabs.find((row) => row.id === old.id)?.accountId).toBe('default-codex')
  const reopened = new AgentAccountStore(path.join(f.dir, 'accounts'), () => {})
  expect((await reopened.resolve('codex')).id).toBe(work.id)
})
