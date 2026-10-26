import { useEffect, useRef, useState } from 'react'
import type { PipeNode, RunState } from './types'
import { KIND_NAME } from './types'
import { errorToast, toast } from './ui'
import { PaneDivider } from './PipelineLayout'

/** 실제 실행 결과만 표시한다. 편집 중 미리 보기 값과 섞지 않는다. */
export function PipelineOutput({ run, nodes, onSelect, height, onResize }: { run?: RunState; nodes: PipeNode[]; onSelect: (id: string) => void; height: number; onResize: (height: number) => void }) {
  const [open, setOpen] = useState(true)
  const [onlyPrint, setOnlyPrint] = useState(false)
  const [limit, setLimit] = useState(100)
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true)
  const entries = Object.entries(run?.nodes ?? {}).filter(([, state]) => state.output !== undefined && (!onlyPrint || state.kind === 'print'))
    .sort(([, a], [, b]) => (a.outputOrder ?? 0) - (b.outputOrder ?? 0))
  useEffect(() => { setLimit(100); follow.current = true }, [run?.runId])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [run?.runId, entries.length, open, onlyPrint])
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast('출력을 복사했습니다') } catch (error) { errorToast(error) }
  }
  return <>
    {open && <PaneDivider axis="y" side="after" value={height} min={100} max={600} initial={220} label="출력 로그 높이" onChange={onResize} />}
    <section className="pipe-console" aria-label="작업 그래프 출력 로그" style={{ height: open ? height : undefined }}>
    <div className="row between pipe-console-toolbar">
      <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} 출력 로그 <span className="muted">{entries.length}</span></button>
      <label className="small"><input type="checkbox" checked={onlyPrint} onChange={(event) => setOnlyPrint(event.target.checked)} /> Print만</label>
    </div>
    {open && <div ref={scroll} className="pipe-console-entries" onScroll={(event) => {
      const el = event.currentTarget
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }}>
      {!entries.length && <p className="small muted">{run?.status === 'running' ? '출력을 기다리고 있습니다…' : 'Print에 값을 연결하고 실행하면 중간값을 볼 수 있습니다. Claude·Codex 응답과 셸 출력도 여기에 표시됩니다.'}</p>}
      {entries.length > limit && <button className="ghost" onClick={() => { follow.current = false; setLimit(limit + 100) }}>이전 출력 더 보기 ({entries.length - limit})</button>}
      {entries.slice(-limit).map(([id, state]) => {
        const source = [id, ...(state.sourceIds ?? [])].find((key) => nodes.some((node) => node.id === key))
        const kind = state.kind ? KIND_NAME[state.kind] : '출력'
        return <article key={id} className="pipe-console-entry">
          <div className="row">
            <span className="small muted">{state.outputAt ? new Date(state.outputAt).toLocaleTimeString() : ''} · {kind}</span>
            <button className="ghost pipe-console-source" disabled={!source} title="출력한 노드 선택" onClick={() => source && onSelect(source)}>{state.name ?? kind}</button>
            {state.status === 'failed' && <span className="small" style={{ color: 'var(--bad)' }}>실패</span>}
            <button className="ghost" aria-label={`${state.name ?? kind} 출력 복사`} onClick={() => void copy(state.output!)}>복사</button>
          </div>
          <pre>{state.output === '' ? <span className="muted">(빈 문자열)</span> : state.output}</pre>
        </article>
      })}
    </div>}
  </section></>
}
