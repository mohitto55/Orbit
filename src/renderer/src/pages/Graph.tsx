import { useEffect, useRef, useState } from 'react'
import cytoscape, { type Core } from 'cytoscape'
import { api } from '../api'
import type { PageProps } from '../App'
import { useLoad } from '../ui'

const KINDS = [
  ['domain', '도메인'],
  ['spec', '기능 명세'],
  ['design', '설계'],
  ['task', 'Task'],
  ['knowledge', '지식'],
  ['ghost', '미정의']
] as const

const COLORS: Record<string, string> = {
  Core: '#e8590c',
  Supporting: '#1c7ed6',
  Generic: '#868e96',
  spec: '#2f9e44',
  design: '#7048e8',
  task: '#f08c00',
  knowledge: '#0c8599',
  ghost: '#ced4da'
}

export default function GraphPage({ refreshKey, go }: PageProps) {
  const [graph] = useLoad(() => api.graph(), [refreshKey])
  const ref = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const [kinds, setKinds] = useState<Set<string>>(new Set(['domain', 'spec', 'design', 'ghost']))
  const [mode, setMode] = useState<'all' | 'local' | 'tree'>('all')
  const [center, setCenter] = useState<string | null>(null)
  const [depth, setDepth] = useState(1)

  useEffect(() => {
    if (!graph || !ref.current) return
    let nodes = graph.nodes.filter((n) => kinds.has(n.kind))
    let edges = graph.edges
    if (mode === 'tree') edges = edges.filter((e) => e.type === '상위')
    if (mode === 'local' && center) {
      const keep = new Set([center])
      for (let i = 0; i < depth; i++) {
        for (const e of edges) {
          if (keep.has(e.source)) keep.add(e.target)
          if (keep.has(e.target)) keep.add(e.source)
        }
      }
      nodes = nodes.filter((n) => keep.has(n.id))
    }
    const ids = new Set(nodes.map((n) => n.id))
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))

    cy.current?.destroy()
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    cy.current = cytoscape({
      container: ref.current,
      elements: [
        ...nodes.map((n) => ({ data: { id: n.id, label: n.label, kind: n.kind, color: COLORS[n.kind === 'domain' ? n.subdomainType ?? 'Supporting' : n.kind] } })),
        ...edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, label: e.type } }))
      ],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: dark ? '#e9ecef' : '#212529',
            'font-size': 11,
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 18,
            height: 18
          }
        },
        { selector: 'node[kind = "domain"]', style: { width: 28, height: 28 } },
        { selector: 'node[kind = "ghost"]', style: { 'border-width': 1, 'border-style': 'dashed', 'border-color': '#868e96', opacity: 0.7 } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#fab005' } },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': dark ? '#495057' : '#ced4da',
            'target-arrow-color': dark ? '#495057' : '#ced4da',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.7,
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': 8,
            color: '#868e96'
          }
        }
      ],
      layout: mode === 'tree' ? { name: 'breadthfirst', directed: true, padding: 20 } : { name: 'cose', animate: false, padding: 20 }
    })
    cy.current.on('tap', 'node', (e) => setCenter(e.target.id()))
    cy.current.on('dbltap', 'node', (e) => {
      const n = e.target.data()
      if (n.kind === 'domain') go('domains', n.id)
      if (n.kind === 'task') go('tasks', n.id)
    })
    return () => {
      cy.current?.destroy()
      cy.current = null
    }
  }, [graph, kinds, mode, center, depth, go])

  return (
    <div className="page graph-page">
      <div className="row between">
        <h2>그래프</h2>
        <div className="row">
          <div className="seg small">
            {(
              [
                ['all', '전체'],
                ['local', '로컬'],
                ['tree', '계층']
              ] as const
            ).map(([m, l]) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {l}
              </button>
            ))}
          </div>
          {mode === 'local' && (
            <label className="small">
              단계 <input type="number" min={1} max={5} value={depth} onChange={(e) => setDepth(Number(e.target.value))} style={{ width: 50 }} />
            </label>
          )}
        </div>
      </div>
      <div className="row">
        {KINDS.map(([k, l]) => (
          <label key={k} className="small chip">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={(e) => {
                const s = new Set(kinds)
                e.target.checked ? s.add(k) : s.delete(k)
                setKinds(s)
              }}
            />
            {l}
          </label>
        ))}
        <span className="muted small">노드 클릭: 로컬 중심 선택 · 더블클릭: 열기</span>
      </div>
      <div ref={ref} className="graph" />
    </div>
  )
}
