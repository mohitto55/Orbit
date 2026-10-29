import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { PipelineRunner, type DataShape, type Env, type PipeNode, type Pipeline } from '../src/core/pipeline'
import { PipelineHistory, prepareExecutions } from '../src/core/pipelineExecution'
import type { TerminalInfo } from '../src/core/terminal'
import { tempDir } from './helpers'

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, kind, text: '', terminal: 'new', ...extra })
const graph = (type: DataShape = 'task', action: PipeNode['kind'] = 'codex'): Pipeline => ({ id: 'shared-graph', title: '입력 처리', file: '', nodes: [
  node('in', 'function-input', { params: [{ id: 'target', name: 'target', type }] }),
  node('work', action, { text: action === 'complete' ? '' : '처리' }), node('out', 'function-output', { params: [] })
], edges: [{ from: 'in', to: 'work' }, { from: 'work', to: 'out' }, { from: 'in', to: 'work', pin: 'data', fromPort: 'target' }] })
const tasks = [1, 2, 3].map((i) => ({ id: `task-${i}`, title: `할 일 ${i}`, body: `원본 내용 ${i}`, status: '대기' }))
const env: Env = { tasks, sources: tasks.map((t) => ({ kind: 'task', id: t.id, title: t.title, text: t.body, version: '1' })) }
const selection = { port: 'target', sources: tasks.map((t) => ({ kind: 'task' as const, id: t.id })) }

function harness() {
  const tabs = new Map<string, TerminalInfo>(['a', 'b'].map((id) => [id, { id, title: id, kind: 'codex', pid: 1, activity: 'idle' }]))
  const submit = vi.fn(), createTerminal = vi.fn(async () => { throw new Error('새 탭을 만들면 안 됩니다') })
  let output: string | undefined
  const runner = new PipelineRunner({ createTerminal, getTerminal: (id) => tabs.get(id), hasTerminal: (id) => tabs.has(id), whenReady: async () => {}, submit, runCommand: vi.fn(), completeTasks: async () => {}, emit: () => {}, readAgentOutput: () => output })
  return { runner, tabs, submit, createTerminal, output: (value: string | undefined) => { output = value } }
}

describe('외부 입력과 병렬 실행', () => {
  it('Task는 항목별 실행으로 나누고 List<Task>는 한 실행에 모으며 원본 ID와 본문을 유지한다', () => {
    const p = graph(), original = JSON.stringify(p)
    const runs = prepareExecutions(p, env, { pipelineId: p.id, selection })
    expect(runs).toHaveLength(3)
    expect(new Set(runs.map((r) => r.options.groupId)).size).toBe(1)
    runs.forEach((run, i) => {
      expect(run.pipe.nodes[0].text).toContain(tasks[i].body)
      expect(run.pipe.nodes[0].text).not.toContain(tasks[(i + 1) % 3].body)
      expect(run.options.sources?.map((s) => s.id)).toEqual([tasks[i].id])
      expect(run.options.snapshot?.env.tasks).toHaveLength(1)
    })
    expect(JSON.stringify(p)).toBe(original)
    const terminal = { id: 'a', title: '기존 세션', kind: 'codex' as const, output: '관계없는 터미널의 긴 출력' }
    const snapshot = prepareExecutions(p, { ...env, terminals: [terminal] }, { pipelineId: p.id, selection, terminalIds: ['a'] })[0].options.snapshot
    expect(snapshot?.env.terminals?.[0]).not.toHaveProperty('output')
    const list = prepareExecutions(graph('task[]'), env, { pipelineId: p.id, selection })
    expect(list).toHaveLength(1)
    for (const t of tasks) expect(list[0].pipe.nodes[0].text).toContain(t.body)
    const complete = prepareExecutions(graph('task[]', 'complete'), env, { pipelineId: p.id, selection })
    expect(complete[0].pipe.nodes[0].text).toBe('task-1,task-2,task-3')
  })

  it.each(['change', 'spec', 'feature'] as const)('%s 입력·목록은 같은 함수 타입 체계를 사용한다', (kind) => {
    const sources = [1, 2].map((i) => ({ kind, id: `${kind}-${i}`, title: `${kind} ${i}`, text: `저장된 ${kind} 본문 ${i}`, version: '3' }))
    const request = { pipelineId: 'shared-graph', selection: { port: 'target', sources } }
    const single = prepareExecutions(graph(kind, 'print'), { sources }, request)
    expect(single).toHaveLength(2)
    expect(single[0].pipe.nodes[0].text).toBe(sources[0].text)
    const list = prepareExecutions(graph(`${kind}[]`, 'print'), { sources }, request)
    expect(list).toHaveLength(1)
    expect(list[0].pipe.nodes[0].text).toBe(sources.map((s) => s.text).join('\n\n'))
  })

  it('잘못된 타입·삭제된 원본·없는 입력을 실행 전 검사한다', () => {
    expect(() => prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection: { port: 'target', sources: [{ kind: 'change', id: 'task-1' }] } })).toThrow('타입')
    expect(() => prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection: { port: 'target', sources: [{ kind: 'task', id: 'deleted' }] } })).toThrow('원본을 찾을 수 없습니다')
    expect(() => prepareExecutions(graph(), env, { pipelineId: 'shared-graph' })).toThrow('입력값')
    expect(() => prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection, maxConcurrent: 0 })).toThrow('동시 실행 수')
  })

  it('같은 그래프의 독립 실행을 병렬 배정하고 바쁜 세션은 완료 후 자동 재사용한다', () => {
    const h = harness()
    const prepared = prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection, terminalIds: ['a', 'b'] })
    const runs = prepared.map((r) => h.runner.start(r.pipe, true, r.options))
    expect(new Set(runs.map((r) => r.runId)).size).toBe(3)
    expect(h.submit).toHaveBeenCalledTimes(2)
    expect(runs.map((r) => r.nodes.work.status)).toEqual(['running', 'running', 'waiting'])
    expect(runs[2].nodes.work.message).toContain('사용 중')
    h.output(undefined)
    expect(h.runner.agentDone('a')).toBeNull() // 중간 알림으로 다음 실행을 시작하지 않는다.
    h.output('첫 번째 최종 응답'); h.runner.agentDone('a')
    expect(h.submit).toHaveBeenCalledTimes(3)
    expect(h.runner.execution(runs[2].runId)?.state.nodes.work).toMatchObject({ status: 'running', termId: 'a' })
    h.output('세 번째 최종 응답'); h.runner.agentDone('a')
    h.output('두 번째 최종 응답'); h.runner.agentDone('b')
    expect(h.runner.list().map((r) => r.nodes.work.output)).toEqual(['첫 번째 최종 응답', '두 번째 최종 응답', '세 번째 최종 응답'])
    expect(h.createTerminal).not.toHaveBeenCalled()
  })

  it('수동 작업 종료·동시 실행 제한·개별 중지가 다른 실행의 입력을 침범하지 않는다', () => {
    const h = harness(); h.tabs.get('a')!.activity = 'working'
    const prepared = prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection, terminalIds: ['a'], maxConcurrent: 1 })
    const runs = prepared.map((r) => h.runner.start(r.pipe, true, r.options))
    expect(h.submit).not.toHaveBeenCalled()
    h.tabs.get('a')!.activity = 'idle'; h.runner.terminalChanged()
    expect(h.submit).toHaveBeenCalledTimes(1)
    h.runner.stop(runs[1].runId)
    h.output('완료'); h.runner.agentDone('a')
    expect(h.submit).toHaveBeenCalledTimes(2)
    expect(h.submit.mock.calls[1][1]).toContain('원본 내용 3')
    expect(h.runner.execution(runs[1].runId)?.state.status).toBe('stopped')
  })

  it('묶음 중지 도중에는 대기 항목을 새로 실행하지 않는다', () => {
    const h = harness()
    const runs = prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection, terminalIds: ['a'] }).map((r) => h.runner.start(r.pipe, true, r.options))
    expect(h.submit).toHaveBeenCalledTimes(1)
    h.runner.stopMany(runs.map((r) => r.runId))
    expect(h.runner.list().every((r) => r.status === 'stopped')).toBe(true)
    expect(h.submit).toHaveBeenCalledTimes(1)
  })
})

it('입력·그래프·출력을 보존하고 재시작 시 미완료 실행은 중단 상태로 읽으며 목록에 큰 출력은 싣지 않는다', async () => {
  const dir = await tempDir('orbit-run-history-'), errors = vi.fn(), store = new PipelineHistory(dir, errors)
  await store.load()
  const h = harness(), prepared = prepareExecutions(graph(), env, { pipelineId: 'shared-graph', selection, terminalIds: ['a', 'b'] })
  const runs = prepared.map((r) => h.runner.start(r.pipe, true, r.options))
  const records = runs.map((r) => h.runner.execution(r.runId)!)
  records.forEach((r) => store.save(r))
  h.output('최종 결과 '.repeat(10000)); h.runner.agentDone('a')
  store.save(h.runner.execution(runs[0].runId)!)
  await store.flush()
  const restored = new PipelineHistory(dir, errors); await restored.load()
  expect(restored.list({ source: { kind: 'task', id: 'task-1' } }).runs[0].status).toBe('done')
  expect(restored.list({ limit: 1 }).runs).toHaveLength(1)
  expect(restored.list({ limit: 1 }).total).toBe(3)
  const record = await restored.get(runs[0].runId)
  expect(record.options.snapshot?.env.tasks?.[0].body).toBe('원본 내용 1')
  expect(record.state.nodes.work.output).toContain('최종 결과')
  expect((await restored.get(runs[1].runId)).state.status).toBe('stopped')
  expect((await fs.readFile(path.join(dir, 'index.json'), 'utf8')).length).toBeLessThan(5000)
  await expect(restored.get('../outside')).rejects.toThrow('실행 기록')
  expect(errors).not.toHaveBeenCalled()
})
