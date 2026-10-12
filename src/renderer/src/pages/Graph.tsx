import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core, type Layouts, type NodeSingular } from 'cytoscape'
import { api } from '../api'
import type { PageProps } from '../App'
import type { GNode } from '../types'
import { useLoad } from '../ui'

const KINDS = [
  ['domain', '도메인'],
  ['spec', '기능 명세'],
  ['design', '설계'],
  ['task', 'Task'],
  ['knowledge', '지식'],
  ['ghost', '미정의']
] as const

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS)

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

type Mode = 'all' | 'local' | 'tree'

const ANIM = { duration: 450, easing: 'ease-in-out-cubic' as const }

export default function GraphPage({ refreshKey, go }: PageProps) {
  const [graph] = useLoad(() => api.graph(), [refreshKey])
  const ref = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const running = useRef<Layouts | null>(null)
  const [kinds, setKinds] = useState<Set<string>>(new Set(['domain', 'spec', 'design', 'ghost']))
  const [mode, setMode] = useState<Mode>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [depth, setDepth] = useState(1)
  const goRef = useRef(go)
  goRef.current = go

  // 파일 감시로 같은 데이터가 다시 와도 그래프를 새로 만들지 않도록, 내용이 바뀐 경우에만 다시 만든다
  const signature = useMemo(() => (graph ? JSON.stringify(graph) : ''), [graph])

  /* 1) 그래프 생성: 데이터 내용이 바뀔 때만 */
  useEffect(() => {
    if (!graph || !ref.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const prev = cy.current
    running.current?.stop()
    running.current = null
    const positions = new Map<string, { x: number; y: number }>()
    prev?.nodes().forEach((n) => {
      positions.set(n.id(), { ...n.position() })
    })
    prev?.destroy()

    const instance = cytoscape({
      container: ref.current,
      elements: [
        ...graph.nodes.map((n) => ({
          data: { id: n.id, label: n.label, kind: n.kind, color: COLORS[n.kind === 'domain' ? n.subdomainType ?? 'Supporting' : n.kind] },
          position: positions.get(n.id)
        })),
        ...graph.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, label: e.type } }))
      ],
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.25,
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
            height: 18,
            'transition-property': 'opacity, border-width, width, height',
            'transition-duration': 250
          }
        },
        { selector: 'node[kind = "domain"]', style: { width: 28, height: 28 } },
        { selector: 'node[kind = "ghost"]', style: { 'border-width': 1, 'border-style': 'dashed', 'border-color': '#868e96' } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#fab005', width: 32, height: 32 } },
        { selector: '.faded', style: { opacity: 0.12 } },
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
            color: '#868e96',
            'text-opacity': 0,
            'transition-property': 'opacity, line-color',
            'transition-duration': 250
          }
        },
        { selector: 'edge.near', style: { 'line-color': '#fab005', 'target-arrow-color': '#fab005', width: 2, 'text-opacity': 1 } }
      ]
    })
    instance.on('tap', 'node', (e) => setSelected((e.target as NodeSingular).id()))
    instance.on('tap', (e) => {
      if (e.target === instance) setSelected(null)
    })
    instance.on('dbltap', 'node', (e) => openNode(e.target.data()))
    instance.on('mouseover', 'node', () => ref.current && (ref.current.style.cursor = 'pointer'))
    instance.on('mouseout', 'node', () => ref.current && (ref.current.style.cursor = 'default'))
    cy.current = instance
    // 확인용: 개발 도구나 스모크 확인에서 그래프 상태를 볼 수 있게 노출
    ;(window as unknown as { __girsktopGraph?: Core }).__girsktopGraph = instance

    // 처음에는 애니메이션 없이 배치, 이후 데이터 갱신은 기존 위치를 유지한 채 새 노드만 자리 잡는다
    if (positions.size > 0) applyView(instance, 'none')
    else applyView(instance, 'instant')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  useEffect(
    () => () => {
      running.current?.stop()
      cy.current?.destroy()
    },
    []
  )

  /* 2) 보기 바꾸기: 필터·모드·단계 — 그래프는 그대로 두고 보이는 요소만 바꾼 뒤 부드럽게 재배치 */
  useEffect(() => {
    if (cy.current) applyView(cy.current, 'animate')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, mode, depth, mode === 'local' ? selected : null])

  /* 3) 선택 강조: 배치는 건드리지 않고 이웃만 밝게 */
  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.batch(() => {
      c.elements().removeClass('faded near').unselect()
      if (!selected) return
      const node = c.getElementById(selected)
      if (node.empty()) return
      node.select()
      const near = node.closedNeighborhood()
      if (mode !== 'local') c.elements().not(near).addClass('faded')
      near.edges().addClass('near')
    })
  }, [selected, mode, signature])

  function visibleSet(c: Core) {
    let nodes = c.nodes().filter((n) => kinds.has(n.data('kind')))
    let edges = c.edges()
    if (mode === 'tree') edges = edges.filter((e) => e.data('label') === '상위')
    if (mode === 'local' && selected) {
      let keep = c.getElementById(selected).union(c.collection())
      for (let i = 0; i < depth; i++) keep = keep.union(keep.neighborhood())
      nodes = nodes.intersection(keep.nodes())
    }
    edges = edges.filter((e) => nodes.contains(e.source()) && nodes.contains(e.target()))
    return { nodes, edges }
  }

  /** layout: none = 보이는 요소만 바꿈, instant = 애니메이션 없이 배치(처음 열 때), animate = 부드럽게 재배치 */
  function applyView(c: Core, layout: 'none' | 'instant' | 'animate') {
    const { nodes, edges } = visibleSet(c)
    const shown = nodes.union(edges)
    // 바뀌는 요소만 숨기거나 보인다 (전부 껐다 켜면 매번 전체를 다시 그린다)
    const hidden = c.elements(':hidden')
    const appearing = shown.intersection(hidden)
    c.batch(() => {
      c.elements(':visible').difference(shown).style('display', 'none')
      appearing.style('display', 'element')
    })
    // 새로 나타난 노드는 이미 보이는 이웃 곁에서 출발하게 해, 원점에서 날아오지 않게 한다
    appearing.nodes().forEach((n) => {
      const anchor = n.neighborhood('node:visible').difference(appearing).nodes().first()
      if (anchor.nonempty()) n.position({ x: anchor.position('x') + Math.random() * 40 - 20, y: anchor.position('y') + Math.random() * 40 - 20 })
    })
    if (shown.empty() || layout === 'none') return
    // 앞 배치가 아직 돌고 있으면 멈추고 새로 시작한다 (빠르게 여러 번 눌러도 겹치지 않게)
    running.current?.stop()
    const animate = layout === 'animate'
    // cose의 animate:true는 계산하는 내내 화면을 다시 그려 끊겨 보인다. 'end'는 다 계산한 뒤 한 번에 부드럽게 옮긴다.
    const motion = { animate: animate ? 'end' : false, animationDuration: ANIM.duration, animationEasing: ANIM.easing, padding: 30 }
    const opts = mode === 'tree' ? { name: 'breadthfirst', directed: true, ...motion } : { name: 'cose', randomize: !animate, nodeDimensionsIncludeLabels: true, ...motion }
    const l = shown.layout(opts as cytoscape.LayoutOptions)
    running.current = l
    l.one('layoutstop', () => {
      if (running.current === l) running.current = null
    })
    l.run()
  }

  function openNode(n: { id: string; kind: string }) {
    if (n.kind === 'domain') goRef.current('domains', n.id)
    if (n.kind === 'task') goRef.current('tasks', n.id)
  }

  const fit = () => {
    const c = cy.current
    if (c) c.animate({ fit: { eles: c.elements(':visible'), padding: 30 } }, ANIM)
  }

  const info: GNode | undefined = graph?.nodes.find((n) => n.id === selected)
  const links = graph ? graph.edges.filter((e) => e.source === selected || e.target === selected) : []

  return (
    <div className="page graph-page">
      <div className="row between">
        <h2>관계도</h2>
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
          <button className="small" onClick={fit}>
            화면에 맞추기
          </button>
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
                if (e.target.checked) s.add(k)
                else s.delete(k)
                setKinds(s)
              }}
            />
            {l}
          </label>
        ))}
        <span className="muted small">
          {mode === 'local' ? '노드를 누르면 그 주변만 보여줍니다' : '노드를 누르면 연결된 곳이 강조됩니다'} · 더블클릭: 열기 · 빈 곳 클릭: 선택 해제
        </span>
      </div>
      <div className="graph-wrap">
        <div ref={ref} className="graph" />
        {info && (
          <div className="graph-info">
            <div className="small muted">{KIND_LABEL[info.kind] ?? info.kind}</div>
            <b>{info.label}</b>
            <div className="small muted mono">{info.id}</div>
            <div className="small">연결 {links.length}개</div>
            <div className="row">
              {(info.kind === 'domain' || info.kind === 'task') && (
                <button className="small primary" onClick={() => openNode(info)}>
                  열기
                </button>
              )}
              <button className="small ghost" onClick={() => setSelected(null)}>
                닫기
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
