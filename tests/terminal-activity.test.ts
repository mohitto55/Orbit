import { promises as fs } from 'fs'
import path from 'path'
import type { IPty } from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { tempDir } from './helpers'

const workspaces: TerminalWorkspace[] = []
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.suspend()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  vi.useFakeTimers()
  const dir = await tempDir('terminal-activity-')
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'))
  const file = path.join(dir, 'workspace.json')
  const ptys: (IPty & { emit: (data: string) => void; exit: () => void })[] = []
  const spawn = vi.fn(() => {
    let onData: (data: string) => void = () => {}
    let onExit: (event: { exitCode: number }) => void = () => {}
    const pty = {
      pid: ptys.length + 1, cols: 100, rows: 30, process: 'shell', handleFlowControl: false,
      onData: (fn: typeof onData) => { onData = fn; return { dispose() {} } },
      onExit: (fn: typeof onExit) => { onExit = fn; return { dispose() {} } },
      emit: (data: string) => onData(data), exit: () => onExit({ exitCode: 0 }),
      write: vi.fn(), resize() {}, clear() {}, kill() {}, pause() {}, resume() {}
    }
    ptys.push(pty)
    return pty
  })
  const events = { onData() {}, onExit() {}, onChange: vi.fn(), onAgentDone: vi.fn(), onCommandDone: vi.fn() }
  const create = () => {
    const workspace = new TerminalWorkspace(file, { projectDir: dir, dataRoot: path.join(dir, 'docs') }, spawn, events)
    workspaces.push(workspace)
    return workspace
  }
  const workspace = create()
  const settings = { name: 'activity', driftIntervalDays: 7, reminderTime: '09:00' }
  const state = (id: string) => workspace.state().tabs.find((tab) => tab.id === id)!
  const signal = async (id: string, name: string) => fs.writeFile(path.join(`${file}.sessions`, id, `agent.${name}`), 'signal\n')
  return { workspace, create, file, settings, ptys, state, signal, events }
}

it('[TE-F03-AC1] [TE-F03-AC2] Codex의 상태 제목을 조각별로 받아 작업 중·완료를 알리고 일반 출력이나 중복 알림은 무시한다', async () => {
  const { workspace, settings, ptys, state, signal } = await setup()
  const tab = workspace.create('codex', settings, undefined, undefined, { title: '고정된 방 이름' })
  const emit = ptys[0].emit
  const title = (value: string) => `\x1b]0;11111111-2222-3333-4444-555555555555 | ${value}\x1b\\`
  emit(title('Ready'))
  expect(state(tab.id).activity).toBe('idle')
  const working = title('Working')
  for (const character of working) emit(character)
  expect(state(tab.id).activity).toBe('working')
  workspace.acknowledge(tab.id, state(tab.id).activityRevision!)
  expect(state(tab.id).activity).toBe('working')
  emit('일반 출력: Ready\r\n')
  expect(state(tab.id).activity).toBe('working')
  emit(title('Ready'))
  const completed = state(tab.id)
  expect(completed).toMatchObject({ activity: 'completed', title: '고정된 방 이름' })
  workspace.activate(tab.id)
  expect(state(tab.id).activity).toBe('completed') // 선택 상태 자체는 읽음 표시가 아니다.
  workspace.acknowledge(tab.id, completed.activityRevision!)
  emit('화면 다시 그리기')
  emit(title('Ready'))
  await signal(tab.id, 'done')
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('idle')
  emit(title('Thinking'))
  await signal(tab.id, 'done') // 앞 응답의 늦은 notify가 새 작업을 지우지 않는다.
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('working')
  emit(title('Ready'))
  workspace.acknowledge(tab.id, completed.activityRevision!)
  expect(state(tab.id).activity).toBe('completed')
  workspace.acknowledge(tab.id, state(tab.id).activityRevision!)
  expect(state(tab.id).activity).toBe('idle')
})

it('[TE-F03-AC1] Claude의 직접 입력과 작업 그래프 요청은 시작·완료·실패 신호에 따라 바뀐다', async () => {
  const { workspace, settings, state, signal, events } = await setup()
  const tab = workspace.create('claude', settings)
  await signal(tab.id, 'ready')
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('idle')
  await signal(tab.id, 'working')
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('working')
  await signal(tab.id, 'done')
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('completed')
  expect(events.onAgentDone).toHaveBeenCalledWith(tab.id)
  workspace.submit(tab.id, '다음 작업')
  expect(state(tab.id).activity).toBe('working')
  await signal(tab.id, 'idle')
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id).activity).toBe('idle')
  expect(events.onAgentDone).toHaveBeenCalledTimes(1)
})

it.each(['codex', 'claude'] as const)('[TE-F03-AC1] 셸에서 %s를 직접 켠 것만으로 작업 중·완료로 표시하지 않는다', async (kind) => {
  const { workspace, file, settings, state } = await setup()
  const tab = workspace.create('shell', settings)
  workspace.write(tab.id, `${kind}\r`)
  const launchFile = path.join(`${file}.sessions`, tab.id, 'state.json')
  const launch = JSON.parse(await fs.readFile(launchFile, 'utf8')) as Record<string, unknown>
  await fs.writeFile(launchFile, JSON.stringify({ ...launch, kind, runId: 'manual-agent', running: true }))
  await vi.advanceTimersByTimeAsync(500)
  expect(state(tab.id)).toMatchObject({ kind, activity: 'idle' })
})

it('[TE-F03-AC1] 셸은 입력 전송부터 프롬프트 복귀까지 작업 중이고 붙여넣기·일반 출력만으로 바뀌지 않는다', async () => {
  const { workspace, settings, state, ptys, events } = await setup()
  const tab = workspace.create('shell', settings)
  const emit = ptys[0].emit
  emit('\x1b]0;orbit:shell:ready\x07')
  workspace.write(tab.id, '\x1b[200~echo one\r')
  workspace.write(tab.id, 'echo two\r\x1b[201~')
  expect(state(tab.id).activity).toBe('idle')
  workspace.write(tab.id, '\r')
  expect(state(tab.id).activity).toBe('working')
  emit('일반 출력')
  expect(state(tab.id).activity).toBe('working')
  emit('\x1b]0;orbit:shell:ready\x07')
  expect(state(tab.id).activity).toBe('completed')
  workspace.runCommand(tab.id, 'echo graph')
  expect(state(tab.id).activity).toBe('working')
  emit('__ORBIT_BEGIN__\r\ngraph\r\n__ORBIT_DONE__:0\r\n')
  expect(state(tab.id).activity).toBe('completed')
  expect(events.onCommandDone).toHaveBeenCalledWith(tab.id, 0, 'graph')
  workspace.runCommand(tab.id, 'echo next')
  events.onCommandDone.mockImplementationOnce(() => workspace.runCommand(tab.id, 'echo last'))
  emit('__ORBIT_BEGIN__\r\nnext\r\n__ORBIT_DONE__:0\r\n')
  emit('\x1b]0;orbit:shell:ready:2\x07') // 앞 명령의 프롬프트가 다음 명령을 완료 처리하지 않는다.
  expect(state(tab.id).activity).toBe('working')
  emit('__ORBIT_BEGIN__\r\nlast\r\n__ORBIT_DONE__:0\r\n')
  expect(state(tab.id).activity).toBe('completed')
  workspace.write(tab.id, 'sleep 10\r')
  workspace.write(tab.id, '\x03')
  expect(state(tab.id).activity).toBe('idle')
  workspace.runCommand(tab.id, 'sleep 10')
  ptys[0].exit()
  expect(state(tab.id)).toMatchObject({ activity: 'idle', exited: 0 })
})

it('[TE-F03-AC3] 재시작하면 미확인 완료를 유지하고 중단된 작업 중 표시는 기본 상태로 복원한다', async () => {
  const { workspace, create, settings, ptys } = await setup()
  const completed = workspace.create('shell', settings)
  workspace.runCommand(completed.id, 'echo done')
  ptys[0].emit('__ORBIT_BEGIN__\r\ndone\r\n__ORBIT_DONE__:0\r\n')
  const working = workspace.create('shell', settings)
  workspace.runCommand(working.id, 'sleep 10')
  workspace.suspend()
  const restored = create()
  await restored.restore(settings)
  expect(restored.state().tabs.find((tab) => tab.id === completed.id)?.activity).toBe('completed')
  expect(restored.state().tabs.find((tab) => tab.id === working.id)?.activity).toBe('idle')
})
