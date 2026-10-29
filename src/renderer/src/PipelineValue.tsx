import { useMemo, useState } from 'react'
import { dataPreviews, fillOutputs, isData, nodeName, outputRefs, type Env, type Graph, type NodeRun, type PipeNode, type RunState } from '../../core/pipeline'
import { FIELD_TYPE_NAME, jsonType, parseJson, type JsonValue } from '../../core/structuredData'
import { JsonTree } from './StructuredData'
import { errorToast, toast } from './ui'

interface ValueEntry {
  id: string; name: string; source: string; value?: JsonValue; raw?: string; message?: string; error?: boolean; type?: string
}
const statusText = (state?: NodeRun) => state?.status === 'failed' ? '실패' : state?.status === 'skipped' ? '건너뜀' : '응답 대기'

function values(node: PipeNode, graph: Graph, env: Env, run: RunState | undefined, states: [string, NodeRun][]): ValueEntry[] {
  if (node.kind === 'terminal') {
    const tab = env.terminals?.find((t) => t.id === node.ref)
    return [{ id: node.id, name: nodeName(node), source: '선택한 터미널', type: 'Terminal', ...(tab ? { value: tab.title, raw: tab.title } : { message: '사용할 터미널을 고르세요.' }) }]
  }
  if (isData(node)) {
    try {
      return dataPreviews(graph, node.id, env).map((entry) => {
        const refs = [...new Set(entry.items.flatMap(outputRefs))]
        const base = { id: entry.id, name: entry.name, ...(entry.shape === 'task' ? { type: 'Task' } : {}), source: entry.preview ? '설정 미리보기' : refs.length ? '현재 설정 + 최근 실행 응답' : '현재 값' }
        const missing = refs.filter((id) => run?.nodes[id]?.status !== 'done' || run.nodes[id].output === undefined)
        if (missing.length) return { ...base, message: missing.map((id) => {
          const state = run?.nodes[id]
          const source = graph.nodes.find((n) => n.id === id || id.endsWith(`/${n.id}`))
          return `${state?.name ?? (source ? nodeName(source) : '연결된 작업')}: ${statusText(state)}`
        }).join('\n') }
        try {
          const items = entry.items.map((item) => fillOutputs(item, (id) => run!.nodes[id].output!))
          const text = items[0] ?? ''
          const value = entry.shape === 'list' ? items : ['json', 'schema', 'boolean', 'number'].includes(entry.shape) ? parseJson(text) : text
          return { ...base, value, raw: entry.shape === 'list' ? JSON.stringify(items, null, 2) : text }
        } catch (error) { return { ...base, error: true, message: error instanceof Error ? error.message : String(error) } }
      })
    } catch (error) { return [{ id: node.id, name: nodeName(node), source: '현재 값', error: true, message: error instanceof Error ? error.message : String(error) }] }
  }
  if (['start', 'complete', 'function-input', 'function-output'].includes(node.kind)) return []
  if (!states.length) return [{ id: node.id, name: nodeName(node), source: '실행 결과', message: '실행하면 결과가 여기에 표시됩니다.' }]
  return [...states].sort(([, a], [, b]) => (a.outputOrder ?? 0) - (b.outputOrder ?? 0)).map(([id, state]) => ({
    id, name: state.name ?? nodeName(node), source: `최근 실행 · ${state.status === 'done' ? '완료' : statusText(state)}`,
    ...(state.output !== undefined ? { value: state.structuredOutput ?? state.output, raw: state.output, error: state.status === 'failed', message: state.status === 'failed' ? state.message : undefined }
      : state.conditionResult !== undefined ? { value: state.conditionResult, raw: String(state.conditionResult) }
      : { message: state.message ?? (state.status === 'done' ? '이 실행에는 출력값이 없습니다.' : `${statusText(state)}: 결과가 아직 없습니다.`) })
  }))
}

/** 선택만으로 확인하는 값. Print를 실행하거나 터미널을 열 필요가 없다. */
export function PipelineValue({ node, graph, env, run, states }: { node: PipeNode; graph: Graph; env: Env; run?: RunState; states: [string, NodeRun][] }) {
  const [selected, setSelected] = useState(''), [raw, setRaw] = useState(false)
  const entries = useMemo(() => values(node, graph, env, run, states), [node, graph, env, run, states])
  const entry = entries.find((e) => e.id === selected) ?? [...entries].reverse().find((e) => e.value !== undefined) ?? entries[0]
  if (!entry) return null
  const composite = entry.value !== null && typeof entry.value === 'object'
  const copy = async () => {
    if (entry.raw === undefined) return
    try { await navigator.clipboard.writeText(entry.raw); toast('값을 복사했습니다') } catch (error) { errorToast(error) }
  }
  return <section className="pipe-value" aria-label="노드 값 보기">
    <div className="row between pipe-value-toolbar">
      <strong>Value</strong>
      <span className="small muted">{entry.type ?? (entry.value !== undefined ? FIELD_TYPE_NAME[jsonType(entry.value)] : '')}</span>
      <div className="row" style={{ margin: 0 }}>
        {composite && <button className="ghost" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? 'Tree' : 'Raw'}</button>}
        <button className="ghost" disabled={entry.raw === undefined} onClick={() => void copy()}>복사</button>
      </div>
    </div>
    <div className="small muted">{entry.source}{Array.isArray(entry.value) ? ` · ${entry.value.length} items` : ''}</div>
    {entries.length > 1 && <select aria-label="값을 볼 실행 항목" value={entry.id} onChange={(event) => setSelected(event.target.value)}>
      {entries.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>}
    {entry.message && <p className={`small ${entry.error ? 'pipe-value-error' : 'muted'}`}>{entry.message}</p>}
    {entry.value !== undefined && <div className="pipe-value-content">
      {composite && !raw ? <JsonTree value={entry.value} disabled={false} /> : <pre>{entry.raw === '' ? <span className="muted">(빈 문자열)</span> : entry.raw}</pre>}
    </div>}
  </section>
}
