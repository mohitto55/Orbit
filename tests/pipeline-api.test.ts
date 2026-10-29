import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/main/api'
import { recordChange } from '../src/core/changes'
import { tempDir } from './helpers'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Print 실행에는 터미널을 만들면 안 됩니다') }) }))

const definition = { title: '원본 검토', nodes: [
  { id: 'in', kind: 'function-input' as const, text: '', terminal: 'new' as const, params: [{ id: 'target', name: 'target', type: 'task' as const }] },
  { id: 'print', kind: 'print' as const, text: '', terminal: 'new' as const },
  { id: 'out', kind: 'function-output' as const, text: '', terminal: 'new' as const, params: [] }
], edges: [{ from: 'in', to: 'print' }, { from: 'print', to: 'out' }, { from: 'in', to: 'print', pin: 'data' as const, fromPort: 'target' }] }

describe('원본 → 실행 → 기록 API', () => {
  it('배치 실행·원본 필터·동일 입력 재실행·프로젝트별 재시작 복원을 잇는다', async () => {
    const dir = await tempDir('orbit-execution-api-')
    const deps = { send: vi.fn(), pickFolder: async () => null, recentFile: path.join(dir, 'state/recent.json'), onProjectOpened() {} }
    const api = createApi(deps), project = await api.createProject(path.join(dir, 'project'))
    const tasks = []
    for (const title of ['첫째', '둘째']) tasks.push(await api.createTask({ title, body: `원래 내용 ${title}`, type: 'research', horizon: '지금' }))
    const graph = await api.savePipeline(definition)
    const runs = await api.runPipelineBatch({ pipelineId: graph.id, selection: { port: 'target', sources: tasks.map((t) => ({ kind: 'task', id: t.id })) } })
    expect(runs.map((r) => r.status)).toEqual(['done', 'done'])
    expect(api.listPipelineRuns().total).toBe(2)
    expect(api.listPipelineRuns({ source: { kind: 'task', id: tasks[0].id } }).runs).toHaveLength(1)
    await api.updateTask(tasks[0].id, { body: '지금은 바뀐 내용' })
    const retry = await api.retryPipeline(runs[0].runId)
    expect(retry.nodes.print.output).toContain('원래 내용 첫째')
    expect(retry.nodes.print.output).not.toContain('지금은 바뀐 내용')
    expect(retry.retryOf).toBe(runs[0].runId)
    expect(api.listPipelineRuns().total).toBe(3)
    api.closeProject() // 종료 직전 생성된 기록도 저장을 마감한다.
    expect(api.pipelineRuns()).toEqual([])
    const restarted = createApi(deps)
    await restarted.openProject(project.projectDir)
    expect(restarted.listPipelineRuns().total).toBe(3)
    expect((await restarted.pipelineExecution(retry.runId)).state.nodes.print.output).toContain('원래 내용 첫째')
    await restarted.createProject(path.join(dir, 'other'))
    expect(restarted.listPipelineRuns().total).toBe(0)
    restarted.closeProject()
  })

  it('삭제된 입력이 섞인 배치는 하나도 실행하지 않고 변경 입력에는 변경 전후 원문을 담는다', async () => {
    const dir = await tempDir('orbit-change-execution-')
    const api = createApi({ send() {}, pickFolder: async () => null, recentFile: path.join(dir, 'recent.json'), onProjectOpened() {} })
    const project = await api.createProject(path.join(dir, 'project'))
    const graph = await api.savePipeline(definition)
    await expect(api.runPipelineBatch({ pipelineId: graph.id, selection: { port: 'target', sources: [{ kind: 'task', id: 'deleted' }] } })).rejects.toThrow('원본을 찾을 수 없습니다')
    expect(api.listPipelineRuns().total).toBe(0)
    const change = await recordChange(project, { target: 'spec-x', from: 1, to: 2, size: 'minor', summary: '기능 수정', changed: ['F1'] }, { file: path.join(project.dataRoot, 'domains/spec.md'), before: '이전 내용', after: '변경한 내용' })
    const changedGraph = await api.savePipeline({ ...definition, id: graph.id, nodes: definition.nodes.map((n) => n.id === 'in' ? { ...n, params: [{ id: 'target', name: 'target', type: 'change' }] } : n) })
    const [run] = await api.runPipelineBatch({ pipelineId: changedGraph.id, selection: { port: 'target', sources: [{ kind: 'change', id: change.id }] } })
    expect(run.nodes.print.output).toContain('Before:\n이전 내용')
    expect(run.nodes.print.output).toContain('After:\n변경한 내용')
    expect((await api.pipelineExecution(run.runId)).options.snapshot?.env.sources?.[0].version).toBe(change.created)
    api.closeProject()
  })
})
