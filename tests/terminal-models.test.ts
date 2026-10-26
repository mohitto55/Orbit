import { promises as fs } from 'fs'
import path from 'path'
import type { IPty } from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'
import { agentModels } from '../src/core/agentModels'
import { modelProblem } from '../src/core/agentModel'
import { TerminalWorkspace } from '../src/core/terminalWorkspace'
import { resumeOptions, shellQuote, withTerminalModel } from '../src/core/terminalIntegration'
import { encodeClaudeProjectDir } from '../src/core/drift'
import { tempDir } from './helpers'

const workspaces: TerminalWorkspace[] = []
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.suspend(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('모델 제안은 로컬 CLI 목록을 사용하고 숨긴 항목·잘못된 값은 제외하며 직접 입력을 지원한다', async () => {
  const dir = await tempDir('orbit-models-')
  vi.stubEnv('CODEX_HOME', dir)
  expect(await agentModels('codex')).toEqual([])
  await fs.writeFile(path.join(dir, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'model-a', display_name: 'Model A', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'bad\ninput' }, null
  ] }))
  expect(await agentModels('codex')).toEqual([{ id: 'model-a', name: 'Model A' }])
  expect(await agentModels('claude')).toContainEqual({ id: 'sonnet', name: 'sonnet' })
  for (const id of ['custom/model:v2', 'opus[1m]', 'arn:aws:bedrock:region:123:inference-profile/example']) expect(modelProblem(id)).toBeUndefined()
  for (const id of ['a\n/model other', 'x; echo unsafe', '$(command)', '--model', 'x y']) expect(modelProblem(id)).toBeTruthy()
  await fs.writeFile(path.join(dir, 'models_cache.json'), '{broken')
  expect(await agentModels('codex')).toEqual([])
})

it('노드 모델은 실행 명령의 모델 옵션과 복원 인자보다 우선하며 다른 옵션은 유지한다', () => {
  for (const option of ['--model old', '--model=old', '-m old', '--model "old"', "--model 'old'"]) {
    const command = withTerminalModel(`codex ${option} --profile work resume id`, 'custom/model:v2')
    expect(command).not.toContain('old')
    expect(command).toContain('--profile work resume id')
    expect(command).toContain(`--model ${shellQuote('custom/model:v2')}`)
    expect(resumeOptions(['-m', 'old', '--model=old', '--yolo'], command)).toEqual(['--yolo'])
  }
})

async function setup() {
  const dir = await tempDir('orbit-terminal-model-'), file = path.join(dir, 'workspace.json')
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'))
  const ptys: (IPty & { emit: (data: string) => void })[] = []
  const spawn = vi.fn((): IPty => {
    let onData: (data: string) => void = () => {}
    const pty = { pid: ptys.length + 1, cols: 100, rows: 30, process: 'shell', handleFlowControl: false,
      onData: (cb: typeof onData) => { onData = cb; return { dispose() {} } }, onExit: () => ({ dispose() {} }),
      emit: (data: string) => onData(data), write: vi.fn(), kill: vi.fn(), resize() {}, clear() {}, pause() {}, resume() {} }
    ptys.push(pty); return pty
  })
  const events = { onData() {}, onExit() {}, onChange: vi.fn() }
  const create = () => { const workspace = new TerminalWorkspace(file, { projectDir: dir, dataRoot: path.join(dir, 'docs') }, spawn, events); workspaces.push(workspace); return workspace }
  const workspace = create(), settings = { name: 'models', driftIntervalDays: 7, reminderTime: '09:00' }
  vi.spyOn(TerminalWorkspace.prototype, 'whenReady').mockResolvedValue()
  return { dir, file, ptys, create, workspace, settings, events }
}

it.each(['claude', 'codex'] as const)('%s 새 세션은 노드 모델로 시작하고 다른 탭·기본 설정과 분리해 복원한다', async (kind) => {
  const h = await setup(), settings = { ...h.settings, claudeCommand: 'claude --model original', codexCommand: 'codex -m original' }
  const first = h.workspace.create(kind, settings, undefined, undefined, { model: 'model-a' })
  const second = h.workspace.create(kind, settings, undefined, undefined, { model: 'model-b' })
  const command = (i: number) => vi.mocked(h.ptys[i].write).mock.calls.map(([s]) => s).join('\n')
  expect(command(0)).toContain(`--model ${shellQuote('model-a')}`)
  expect(command(1)).toContain(`--model ${shellQuote('model-b')}`)
  expect(command(0)).not.toContain('original')
  expect(h.workspace.get(first.id)?.model).toBe('model-a')
  await h.workspace.setModel(first.id, 'model-a', settings)
  expect(h.ptys[0].kill).not.toHaveBeenCalled()
  expect(h.ptys).toHaveLength(2)
  h.workspace.suspend()
  const restored = h.create(); await restored.restore(settings)
  expect(restored.state().tabs.map((tab) => [tab.id, tab.model])).toEqual([[first.id, 'model-a'], [second.id, 'model-b']])
  expect(command(2)).toContain(`--model ${shellQuote('model-b')}`) // 선택한 탭부터 복원
  expect(command(3)).toContain(`--model ${shellQuote('model-a')}`)
  expect(settings.claudeCommand).toBe('claude --model original')
})

it.each(['claude', 'codex'] as const)('%s 기존 대화 모델은 같은 탭에서 바꾸고 이름·그룹·출력·다른 탭을 보존한다', async (kind) => {
  const h = await setup(), tab = h.workspace.create(kind, h.settings, undefined, undefined, { title: '내 작업' }), sessionId = tab.sessionId ?? '11111111-2222-3333-4444-555555555555'
  const dir = kind === 'claude' ? path.join(h.dir, 'claude', 'projects', encodeClaudeProjectDir(h.dir)) : path.join(h.dir, 'codex', 'sessions')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: h.dir, originator: `orbit-${tab.id}`, source: 'cli' } }))
  h.ptys[0].emit('유지할 출력')
  const group = h.workspace.createGroup('내 그룹').groups[0]; h.workspace.moveToGroup(tab.id, group.id)
  const other = h.workspace.create('shell', h.settings), before = h.workspace.state()
  await h.workspace.setModel(tab.id, 'model-new', h.settings)
  expect(h.ptys[0].kill).toHaveBeenCalledTimes(1)
  expect(h.ptys[1].kill).not.toHaveBeenCalled()
  expect(h.ptys[2].write).toHaveBeenCalledWith(expect.stringContaining(`${kind === 'claude' ? '--resume' : 'resume'} ${sessionId}`))
  expect(h.ptys[2].write).toHaveBeenCalledWith(expect.stringContaining(`--model ${shellQuote('model-new')}`))
  expect(h.workspace.state().tabs).toHaveLength(2)
  expect(h.workspace.get(tab.id)).toMatchObject({ id: tab.id, title: '내 작업', groupId: group.id, sessionId, model: 'model-new' })
  expect(h.workspace.state().tabs[0].output).toBe('유지할 출력')
  const sequence = before.tabs[0].sequence
  h.ptys[2].emit('새 모델 출력')
  expect(h.workspace.state().tabs[0]).toMatchObject({ output: '유지할 출력새 모델 출력', sequence: sequence + 1 })
  expect(h.workspace.state()).toMatchObject({ active: other.id, activeGroup: before.activeGroup })
  expect(TerminalWorkspace.prototype.whenReady).toHaveBeenCalledWith(tab.id)
})

it('작업 중이거나 대화 ID가 없는 세션은 중단하지 않고 모델 적용 실패를 알린다', async () => {
  const h = await setup(), tab = h.workspace.create('codex', h.settings)
  h.ptys[0].emit('\x1b]0;Working\x07')
  await expect(h.workspace.setModel(tab.id, 'model-a', h.settings)).rejects.toThrow('작업 중')
  h.ptys[0].emit('\x1b]0;Ready\x07')
  await expect(h.workspace.setModel(tab.id, 'model-a', h.settings)).rejects.toThrow('대화 ID')
  expect(h.ptys[0].kill).not.toHaveBeenCalled()
  expect(h.ptys).toHaveLength(1)
})
