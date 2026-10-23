import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import type { IPty } from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { tempDir } from './helpers'

const workspaces: TerminalWorkspace[] = []
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.suspend(); vi.unstubAllEnvs() })
const settings = { name: 'restore', driftIntervalDays: 7, reminderTime: '09:00' }

async function setup(count: number, output = '이전 출력', exited?: number, kind: 'shell' | 'codex' = 'shell') {
  const root = await tempDir('terminal-restore-')
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'))
  const file = path.join(root, 'workspace.json')
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: `term-${randomUUID()}`, kind, sessionId: kind === 'codex' ? randomUUID() : undefined, title: `작업 ${index}`, cols: 100, rows: 30,
    output, createdAt: Date.now(), exited
  }))
  const original = JSON.stringify({ tabs, active: tabs.at(-1)?.id, activeGroup: 'all', groups: [] })
  await fs.writeFile(file, original)
  const spawn = vi.fn((): IPty => ({
    pid: 1, cols: 100, rows: 30, process: 'shell', handleFlowControl: false,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, clear() {}, kill() {}, pause() {}, resume() {}
  }))
  const workspace = new TerminalWorkspace(file, { projectDir: root, dataRoot: path.join(root, 'docs') }, spawn, { onData() {}, onExit() {} })
  workspaces.push(workspace)
  return { workspace, spawn, tabs, file, original }
}

it('[TE-F01-AC11] 복원 사이에 다른 이벤트를 처리하며 중간에 닫으면 나머지를 실행하거나 저장을 덮어쓰지 않는다', async () => {
  const { workspace, spawn, tabs, file, original } = await setup(40)
  const implementation = spawn.getMockImplementation()!
  spawn.mockImplementation(() => {
    setImmediate(() => workspace.suspend())
    return implementation()
  })
  await workspace.restore(settings)
  workspace.suspend()
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(workspace.state().tabs.map((tab) => tab.id)).toEqual(tabs.map((tab) => tab.id))
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

it('[TE-F01-AC11] 저장 파일을 읽는 중 닫아도 원본 탭과 출력을 보존한다', async () => {
  const { workspace, spawn, file, original } = await setup(40)
  const loading = workspace.restore(settings)
  workspace.suspend()
  await loading
  workspace.suspend()
  expect(spawn).not.toHaveBeenCalled()
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

it('[TE-F01-AC11] 복원 중 중단하면 CLI의 기존 세션 ID·실행 옵션도 보존한다', async () => {
  const { workspace, spawn, tabs, file, original } = await setup(2, '', undefined, 'codex')
  const active = tabs.at(-1)!
  const stateFile = path.join(`${file}.sessions`, active.id, 'state.json')
  const launch = { generation: randomUUID(), runId: 'original-run', kind: 'codex', cwd: path.dirname(file), args: ['--profile', 'work'], sessionId: active.sessionId, running: true }
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  await fs.writeFile(stateFile, JSON.stringify(launch))
  const implementation = spawn.getMockImplementation()!
  spawn.mockImplementation(() => { setImmediate(() => workspace.suspend()); return implementation() })
  await workspace.restore(settings)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual({ ...launch, frozen: true })
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

it('[TE-F01-AC11] Orbit이 저장한 32MB 이상의 정상 탭 파일도 열고 이름·최근 출력을 유지한다', async () => {
  const output = '대화'.repeat(100000)
  const { workspace, spawn, tabs, file } = await setup(60, output, 0)
  expect((await fs.stat(file)).size).toBeGreaterThan(32 * 1024 * 1024)
  await workspace.restore(settings)
  const state = workspace.state()
  expect(state.tabs).toHaveLength(60)
  expect(state.active).toBe(tabs.at(-1)!.id)
  expect(state.tabs.at(-1)).toMatchObject({ title: '작업 59', output, exited: 0 })
  expect(spawn).not.toHaveBeenCalled()
})
