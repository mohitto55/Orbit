import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import { bindPipelineInputs, expandPipeline, isAgent, isListShape, newNodeId, pipelineProblems, sourceKind, type Env, type Pipeline, type PipelineExecution, type RunOptions, type PipelineRunSummary, type RunFilter, summarizeRun, type SourceRef } from './pipeline'

export interface PipelineRunRequest {
  pipelineId: string
  values?: Record<string, string>
  selection?: { port: string; sources: Pick<SourceRef, 'kind' | 'id'>[] }
  terminalIds?: string[]
  allowNew?: boolean
  maxConcurrent?: number
}

/** 모든 입력을 검증한 뒤 실행 목록을 만든다. 하나라도 잘못됐으면 일부만 실행하지 않는다. */
export function prepareExecutions(graph: Pipeline, env: Env, request: PipelineRunRequest): { pipe: Pipeline; options: RunOptions }[] {
  if (request.maxConcurrent !== undefined && (!Number.isInteger(request.maxConcurrent) || request.maxConcurrent < 1 || request.maxConcurrent > 64)) throw new Error('동시 실행 수는 1~64 사이의 정수여야 합니다')
  const entry = graph.nodes.find((n) => n.kind === 'function-input')
  const params = entry?.params ?? []
  const values = { ...entry?.values, ...request.values }
  for (const id of Object.keys(request.values ?? {})) if (!params.some((p) => p.id === id)) throw new Error('존재하지 않는 입력 변수입니다')
  const selection = request.selection
  const target = selection && params.find((p) => p.id === selection.port)
  if (selection && (!target || !selection.sources.length || selection.sources.some((s) => s.kind !== sourceKind(target.type)))) throw new Error('선택한 원본과 그래프 입력 타입이 맞지 않습니다')
  const selected = selection ? [...new Map(selection.sources.map((s) => [`${s.kind}:${s.id}`, s])).values()] : []
  const bindings = target ? isListShape(target.type) ? [{ ...values, [target.id]: selected.map((s) => s.id).join('\n') }] : selected.map((s) => ({ ...values, [target.id]: s.id })) : [values]
  const groupId = `group-${newNodeId()}`
  return bindings.map((bound) => {
    const refs: SourceRef[] = []
    for (const param of params) {
      const value = bound[param.id]
      if (value === undefined || ((sourceKind(param.type) || param.type === 'terminal') && !value.trim())) throw new Error(`${param.name}: 입력값을 지정하세요`)
      const kind = sourceKind(param.type)
      if (kind) {
        const ids = isListShape(param.type) ? value.split('\n').filter(Boolean) : [value]
        for (const id of ids) {
          const source = env.sources?.find((s) => s.kind === kind && s.id === id)
          if (!source) throw new Error(`${param.name}: 원본을 찾을 수 없습니다 (${id})`)
          const { text: _t, version: _v, ...ref } = source
          refs.push(ref)
        }
      }
    }
    const boundGraph = bindPipelineInputs(graph, bound)
    const problems = pipelineProblems(boundGraph, env, { requireStart: true })
    if (problems.length) throw new Error(problems.join('\n'))
    const pipe = { ...graph, ...expandPipeline(boundGraph, env) }
    if (request.terminalIds && !request.allowNew && env.terminals) for (const node of pipe.nodes) {
      if ((!isAgent(node) && node.kind !== 'shell') || node.session || node.terminalInput || node.terminal === 'continue') continue
      if (!env.terminals.some((t) => request.terminalIds!.includes(t.id) && t.kind === node.kind && t.exited === undefined)) throw new Error(`${node.name ?? node.kind}: 사용할 ${node.kind} 터미널을 선택하거나 새 터미널을 허용하세요`)
    }
    // 실행에 쓰인 정의·입력만 보관한다. 다른 프로젝트 자료나 전체 터미널 출력은 복사하지 않는다.
    const definitions: Pipeline[] = [graph]
    for (let i = 0; i < definitions.length; i++) for (const node of definitions[i].nodes) {
      const fn = env.library?.find((p) => p.id === node.ref)
      if (node.kind === 'template' && fn && !definitions.some((p) => p.id === fn.id)) definitions.push({ ...fn, file: '' })
    }
    const ids = new Set([...refs.map((s) => s.id), ...definitions.flatMap((p) => p.nodes.flatMap((n) => [n.ref ?? '', ...Object.values(n.values ?? {}).flatMap((v) => v.split('\n'))]))])
    const specIds = new Set([...ids].map((id) => id.split('#')[0]))
    const snapshotEnv: Env = {
      library: definitions.slice(1), tasks: env.tasks?.filter((t) => ids.has(t.id)),
      specs: env.specs?.filter((s) => specIds.has(s.id)), skills: env.skills?.filter((s) => ids.has(s.id)),
      sources: env.sources?.filter((s) => ids.has(s.id)),
      terminals: env.terminals?.map(({ id, title, kind, exited, activity }) => ({ id, title, kind, exited, activity }))
    }
    return { pipe, options: { groupId, sources: [...new Map(refs.map((s) => [`${s.kind}:${s.id}`, s])).values()], terminalIds: request.terminalIds, allowNew: request.allowNew, maxConcurrent: request.maxConcurrent, snapshot: { graph: boundGraph, env: snapshotEnv, values: bound } } }
  })
}

/** 목록은 작은 인덱스만 읽고, 입력·노드 출력·그래프는 상세를 열 때 읽는다. */
export class PipelineHistory {
  private index = new Map<string, PipelineRunSummary>()
  private writes: Promise<void> = Promise.resolve()
  private active = new Set<string>()
  private pending = new Map<string, PipelineExecution>()
  private sealed = false
  constructor(private dir: string, private onError: (error: unknown) => void) {}

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8')) as PipelineRunSummary[]
      for (const row of list) {
        if (!/^run-[\w-]+$/.test(row.runId)) continue
        this.index.set(row.runId, row.status === 'running' ? { ...row, status: 'stopped', waiting: false, message: '앱 종료 또는 프로젝트 전환으로 중단됨' } : row)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error) }
  }

  save(execution: PipelineExecution): void {
    if (this.sealed) return
    const id = execution.state.runId
    this.active.add(id)
    this.index.set(id, summarizeRun(execution.state))
    this.pending.set(id, execution)
    const index = [...this.index.values()]
    this.writes = this.writes.then(() => {
      if (this.sealed) return
      mkdirSync(this.dir, { recursive: true })
      this.write(`${id}.json`, execution)
      this.write('index.json', index)
      if (this.pending.get(id) === execution) this.pending.delete(id)
    }).catch(this.onError)
  }

  private write(name: string, value: unknown): void {
    const file = path.join(this.dir, name), temp = `${file}.tmp`
    // 마감과 기록 교체가 중간에 끼어들지 않도록 파일 교체까지 한 번에 끝낸다.
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    renameSync(temp, file)
  }

  list(filter: RunFilter = {}): { runs: PipelineRunSummary[]; total: number; counts: Record<NonNullable<RunFilter['status']>, number> } {
    const matching = [...this.index.values()].filter((r) => (!filter.source || r.sources.some((s) => s.kind === filter.source!.kind && s.id === filter.source!.id)) && (!filter.groupId || r.groupId === filter.groupId))
    const counts = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 }
    for (const run of matching) counts[run.waiting && run.status === 'running' ? 'waiting' : run.status]++
    const rows = matching.filter((r) => !filter.status || (r.waiting && r.status === 'running' ? 'waiting' : r.status) === filter.status).sort((a, b) => b.started.localeCompare(a.started))
    const offset = Math.max(0, filter.offset ?? 0), limit = Math.max(1, Math.min(100, filter.limit ?? 30))
    return { runs: rows.slice(offset, offset + limit), total: rows.length, counts }
  }

  async get(id: string): Promise<PipelineExecution> {
    if (!this.index.has(id) || !/^run-[\w-]+$/.test(id)) throw new Error('실행 기록을 찾을 수 없습니다')
    await this.writes
    const record = JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8')) as PipelineExecution
    if (!this.active.has(id) && record.state.status === 'running') record.state = { ...record.state, status: 'stopped', message: '앱 종료 또는 프로젝트 전환으로 중단됨', nodes: Object.fromEntries(Object.entries(record.state.nodes).map(([nodeId, node]) => [nodeId, ['waiting', 'starting', 'running'].includes(node.status) ? { ...node, status: 'skipped', waitingFor: undefined, message: '실행이 중단되었습니다' } : node])) }
    return record
  }

  flush(): Promise<void> { return this.writes }

  /** 종료 이벤트는 비동기 쓰기를 기다리지 않는다. 아직 쓰지 못한 최신 기록만 동기로 마감한다. */
  finish(): void {
    this.sealed = true
    if (!this.pending.size) return
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const [id, record] of this.pending) this.write(`${id}.json`, record)
      this.write('index.json', [...this.index.values()])
      this.pending.clear()
    } catch (error) { this.onError(error) }
  }
}

export type { PipelineRunSummary, RunFilter } from './pipeline'
