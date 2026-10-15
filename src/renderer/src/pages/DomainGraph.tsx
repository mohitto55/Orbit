import { useEffect, useMemo, useRef } from 'react'
import cytoscape, { type Core, type NodeSingular } from 'cytoscape'
import type { DomainScope } from '../types'
import { useDark } from '../ui'
import { useWheelZoom } from '../cyZoom'
import { relationKind } from '../domainGraphView'

const POS_KEY = (root: string) => `orbit.domainGraph.v3.${root}`

type Positions = Record<string, { x: number; y: number }>

function loadPositions(root: string): Positions {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY(root)) ?? '{}')
  } catch {
    return {}
  }
}

function savePositions(root: string, c: Core) {
  try {
    const all: Positions = {}
    c.nodes()
      .filter((n) => n.isChildless())
      .forEach((n) => {
        all[n.id()] = { ...n.position() }
      })
    localStorage.setItem(POS_KEY(root), JSON.stringify(all))
  } catch {
    // 저장소를 못 쓰면 다음에 다시 배치한다
  }
}

/** 한글 라벨 너비 대략값 */
const labelWidth = (s: string, size = 13) => Math.max(56, [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? size + 0.5 : size * 0.58), 0) + 26)

const BOX_PAD = 22
const BOX_GAP = 60
const CELL_GAP = 28
const EMPTY_BOX = { w: 150, h: 64 }

/**
 * 그림 3.3처럼 배치: 하위 도메인 상자를 격자로 놓고, 상자 안에는 개념을 격자로 채운다.
 * 결과는 잎 노드(개념, 개념 없는 도메인)의 중심 좌표.
 */
function packLayout(scope: DomainScope, aspect = 1.4): Positions {
  const boxOf = (id: string) => scope.nodes.find((n) => n.id === id)?.parent ?? id
  // 이어진 상자끼리 가까이 오도록, 가장 많이 이어진 상자부터 너비 우선으로 순서를 정한다
  const links = new Map<string, Set<string>>()
  for (const e of scope.edges) {
    const a = boxOf(e.source)
    const b = boxOf(e.target)
    if (a === b) continue
    links.set(a, (links.get(a) ?? new Set()).add(b))
    links.set(b, (links.get(b) ?? new Set()).add(a))
  }
  const all = scope.nodes.filter((n) => n.kind !== 'concept')
  const order: string[] = []
  const rest = [...all].sort((x, y) => (links.get(y.id)?.size ?? 0) - (links.get(x.id)?.size ?? 0))
  while (order.length < all.length) {
    const start = rest.find((n) => !order.includes(n.id))!
    const queue = [start.id]
    while (queue.length) {
      const id = queue.shift()!
      if (order.includes(id)) continue
      order.push(id)
      const next = [...(links.get(id) ?? [])].filter((x) => !order.includes(x)).sort((x, y) => (links.get(y)?.size ?? 0) - (links.get(x)?.size ?? 0))
      queue.push(...next)
    }
  }
  const boxes = order.map((id) => all.find((n) => n.id === id)!)
  // 상자 안에서는 애그리거트(루트)를 맨 앞에
  const conceptsOf = (id: string) =>
    scope.nodes.filter((n) => n.parent === id).sort((x, y) => Number(/aggregate/i.test(y.conceptKind ?? '')) - Number(/aggregate/i.test(x.conceptKind ?? '')))
  const size = new Map<string, { w: number; h: number }>()
  // 상자 안 칸 자리들 (어느 칸에 어떤 개념을 둘지는 상자 위치가 정해진 뒤에 고른다)
  const slots = new Map<string, { x: number; y: number }[]>()
  for (const b of boxes) {
    const cs = conceptsOf(b.id)
    if (cs.length === 0) {
      size.set(b.id, EMPTY_BOX)
      continue
    }
    const cols = Math.ceil(Math.sqrt(cs.length))
    const cw = Math.max(...cs.map((c) => labelWidth(c.label, 13)))
    const ch = 46
    slots.set(
      b.id,
      cs.map((_, i) => ({ x: BOX_PAD + (i % cols) * (cw + CELL_GAP) + cw / 2, y: BOX_PAD + Math.floor(i / cols) * (ch + CELL_GAP) + ch / 2 }))
    )
    const rows = Math.ceil(cs.length / cols)
    size.set(b.id, { w: BOX_PAD * 2 + cols * cw + (cols - 1) * CELL_GAP, h: BOX_PAD * 2 + rows * ch + (rows - 1) * CELL_GAP })
  }
  // 격자 배치: 가장 많이 이어진 상자를 가운데에 두고, 다음 상자는 이미 놓인 이웃과 가장 가까운 빈 칸에 놓는다
  // (책의 그림처럼 이어진 애그리거트끼리 맞닿게). aspect로 가로·세로 퍼짐을 조절한다.
  const cell = new Map<string, { c: number; r: number }>()
  const taken = new Set<string>()
  for (const b of boxes) {
    const placed = [...(links.get(b.id) ?? [])].map((x) => cell.get(x)).filter((x): x is { c: number; r: number } => !!x)
    let best = { c: 0, r: 0 }
    let bestScore = Infinity
    const R = Math.ceil(Math.sqrt(boxes.length)) + 2
    for (let r = -R; r <= R; r++) {
      for (let c = -R; c <= R; c++) {
        if (taken.has(`${c},${r}`)) continue
        const near = placed.reduce((sum, p) => sum + Math.abs(p.c - c) + Math.abs(p.r - r), 0)
        // 이어질 상자와 같은 줄·같은 칸에 있는데 사이에 다른 상자가 있으면 선이 그 상자를 지나가므로 피한다
        const blocked = placed.filter((p) => {
          if (p.c === c) for (let k = Math.min(p.r, r) + 1; k < Math.max(p.r, r); k++) if (taken.has(`${c},${k}`)) return true
          if (p.r === r) for (let k = Math.min(p.c, c) + 1; k < Math.max(p.c, c); k++) if (taken.has(`${k},${r}`)) return true
          return false
        }).length
        // 이웃이 없으면 가운데 가까이, 세로보다 가로로 조금 더 퍼지게
        const spread = Math.abs(c) / aspect + Math.abs(r) * aspect * 0.8
        const score = near * 10 + blocked * 25 + spread
        if (score < bestScore) {
          bestScore = score
          best = { c, r }
        }
      }
    }
    cell.set(b.id, best)
    taken.add(`${best.c},${best.r}`)
  }
  const cols = [...new Set([...cell.values()].map((x) => x.c))].sort((x, y) => x - y)
  const rows = [...new Set([...cell.values()].map((x) => x.r))].sort((x, y) => x - y)
  const colW = new Map(cols.map((c) => [c, Math.max(...boxes.filter((b) => cell.get(b.id)!.c === c).map((b) => size.get(b.id)!.w))]))
  const rowH = new Map(rows.map((r) => [r, Math.max(...boxes.filter((b) => cell.get(b.id)!.r === r).map((b) => size.get(b.id)!.h))]))
  const colX = new Map<number, number>()
  cols.reduce((x, c) => (colX.set(c, x), x + colW.get(c)! + BOX_GAP), 0)
  const rowY = new Map<number, number>()
  rows.reduce((y, r) => (rowY.set(r, y), y + rowH.get(r)! + BOX_GAP), 0)
  const out: Positions = {}
  for (const b of boxes) {
    const { c, r } = cell.get(b.id)!
    const sz = size.get(b.id)!
    // 칸 안에서 가운데 정렬
    const x = colX.get(c)! + (colW.get(c)! - sz.w) / 2
    const y = rowY.get(r)! + (rowH.get(r)! - sz.h) / 2
    const free = [...(slots.get(b.id) ?? [])]
    if (free.length === 0) {
      out[b.id] = { x: x + sz.w / 2, y: y + sz.h / 2 }
      continue
    }
    // 대표 개념(애그리거트 루트)은 이어진 상자들 쪽 칸에 둔다. 상자 밖으로 나가는 선이 다른 개념을 지나지 않게
    const [root, ...others] = conceptsOf(b.id)
    const nb = [...(links.get(b.id) ?? [])].map((id) => cell.get(id)).filter((v): v is { c: number; r: number } => !!v)
    if (nb.length) {
      const dx = nb.reduce((a, v) => a + v.c, 0) / nb.length - c
      const dy = nb.reduce((a, v) => a + v.r, 0) / nb.length - r
      free.sort((p, q) => q.x * dx + q.y * dy - (p.x * dx + p.y * dy))
    }
    out[root.id] = { x: x + free[0].x, y: y + free[0].y }
    others.forEach((o, i) => (out[o.id] = { x: x + free[i + 1].x, y: y + free[i + 1].y }))
  }
  return out
}

/**
 * 도메인 하나의 그래프 (그림 3.3처럼): 하위 도메인은 회색 상자, 그 안에 개념(객체)이 흰 네모로,
 * 개념끼리는 상자 안팎으로 선. 소유·참조의 의미는 선 모양으로 구분한다.
 */
export default function DomainGraph({ scope, visibleScope = scope, showLabels = true, selected, highlight = [], onSelect, onOpen, relayout }: { scope: DomainScope; visibleScope?: DomainScope; showLabels?: boolean; selected: string | null; highlight?: string[]; onSelect: (id: string | null) => void; onOpen: (id: string) => void; relayout: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const dark = useDark()
  const handlers = useRef({ onSelect, onOpen })
  handlers.current = { onSelect, onOpen }
  const signature = useMemo(() => JSON.stringify(scope), [scope])
  const visibility = useMemo(() => {
    const edges = new Set(visibleScope.edges)
    return JSON.stringify([...visibleScope.nodes.map((n) => n.id), ...scope.edges.flatMap((e, i) => edges.has(e) ? [`s${i}`] : [])])
  }, [scope, visibleScope])
  const layoutVersion = useRef(relayout)

  useEffect(() => {
    if (!ref.current) return
    cy.current?.destroy()
    if (relayout !== layoutVersion.current) {
      layoutVersion.current = relayout
      try {
        localStorage.removeItem(POS_KEY(scope.rootId))
      } catch {
        // 무시
      }
    }
    const rect = ref.current.getBoundingClientRect()
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1.4
    const saved: Positions = { ...packLayout(scope, aspect), ...loadPositions(scope.rootId) }

    const text = dark ? '#c3c8d1' : '#2b303b'
    const panel = dark ? '#1c2026' : '#ffffff'
    const instance = cytoscape({
      container: ref.current,
      layout: { name: 'preset' },
      minZoom: 0.2,
      maxZoom: 2.5,
      elements: [
        ...scope.nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.label,
            parent: n.parent,
            kind: n.kind,
            w: labelWidth(n.label, 13)
          },
          position: saved[n.id]
        })),
        ...scope.edges.map((e, i) => ({ data: { id: `s${i}`, source: e.source, target: e.target, label: e.label || '관련', relation: relationKind(e) } }))
      ],
      style: [
        {
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            width: 'data(w)',
            height: 46,
            'background-color': dark ? '#2a2f37' : '#e3e5ea',
            'border-width': 1.5,
            'border-color': dark ? '#4a515c' : '#a3a9b4',
            label: 'data(label)',
            color: text,
            'font-family': 'Pretendard Variable, Pretendard, sans-serif',
            'font-size': 13,
            'font-weight': 600,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'transition-property': 'opacity',
            'transition-duration': 200
          }
        },
        { selector: 'node[kind != "concept"]', style: { width: 150, height: 64 } },
        {
          selector: 'node[kind = "concept"]',
          style: { shape: 'rectangle', 'background-color': panel, 'border-color': dark ? '#8b93a1' : '#5b6270', 'border-width': 1.2, 'font-weight': 500, 'font-family': 'JetBrains Mono, Consolas, Pretendard Variable, monospace' }
        },
        {
          selector: ':parent',
          style: {
            'background-color': dark ? '#2a2f37' : '#e3e5ea',
            'border-color': dark ? '#4a515c' : '#a3a9b4',
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -6,
            'font-size': 13,
            'font-weight': 700,
            padding: '22px'
          }
        },
        // 루트 도메인(고른 최상위 도메인) 상자는 하위 도메인과 다른 색
        {
          selector: 'node[kind = "root"]',
          style: {
            'background-color': dark ? '#16302d' : '#d7eeea',
            'border-color': dark ? '#3fbfae' : '#0b7a70',
            'border-width': 2,
            color: dark ? '#7fd8cb' : '#0b5f57'
          }
        },
        { selector: 'node:selected', style: { 'border-width': 2.5, 'border-color': dark ? '#3fbfae' : '#0b7a70' } },
        {
          selector: 'edge',
          style: {
            width: 1.3,
            'curve-style': 'bezier',
            'line-color': dark ? '#8b93a1' : '#6b7280',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': dark ? '#8b93a1' : '#6b7280',
            label: 'data(label)',
            'text-opacity': 0,
            'font-size': 11,
            color: dark ? '#aeb4bf' : '#4b5261',
            'text-background-color': panel,
            'text-background-opacity': 1,
            'text-background-padding': '2px',
            'text-wrap': 'wrap',
            'transition-property': 'opacity',
            'transition-duration': 200
          }
        },
        { selector: 'edge[relation = "ownership"]', style: { width: 2, 'line-color': dark ? '#3fbfae' : '#0b7a70', 'source-arrow-shape': 'diamond', 'source-arrow-color': dark ? '#3fbfae' : '#0b7a70', 'target-arrow-shape': 'none' } },
        { selector: 'edge[relation = "reference"]', style: { width: 1.8, 'line-style': 'dashed', 'line-color': dark ? '#7aa5ea' : '#3a6fc4', 'target-arrow-color': dark ? '#7aa5ea' : '#3a6fc4' } },
        { selector: 'edge[relation = "domain"]', style: { 'line-style': 'dotted', width: 1.8 } },
        { selector: '.filtered', style: { display: 'none' } },
        { selector: 'edge.labeled', style: { 'text-opacity': 1 } },
        { selector: '.faded', style: { opacity: 0.18 } },
        { selector: 'node.hl', style: { 'border-width': 2.5, 'border-color': dark ? '#3fbfae' : '#0b7a70' } },
        { selector: 'edge.near', style: { width: 2.8, 'text-opacity': 1 } }
      ]
    })
    instance.on('tap', 'node', (e) => handlers.current.onSelect((e.target as NodeSingular).id()))
    instance.on('tap', (e) => {
      if (e.target === instance) handlers.current.onSelect(null)
    })
    instance.on('dbltap', 'node', (e) => handlers.current.onOpen((e.target as NodeSingular).id()))
    instance.on('dragfree', 'node', () => savePositions(scope.rootId, instance))
    instance.on('mouseover', 'node', () => ref.current && (ref.current.style.cursor = 'pointer'))
    instance.on('mouseout', 'node', () => ref.current && (ref.current.style.cursor = 'default'))
    cy.current = instance
    ;(window as unknown as { __orbitDomainGraph?: Core }).__orbitDomainGraph = instance

    // 패널 크기가 정해진 뒤 화면에 맞춘다 (너무 크게 확대되지는 않게)
    const fit = () => {
      if (cy.current !== instance) return
      instance.resize()
      const visible = instance.elements().not('.filtered')
      if (visible.empty()) return
      instance.fit(visible, 50)
      if (instance.zoom() > 1.4) {
        instance.zoom(1.4)
        instance.center(visible)
      }
    }
    const frame = requestAnimationFrame(fit)
    // 옆 패널 내용이 늦게 차면서 폭이 바뀌는 경우까지 한 번 더
    const timer = setTimeout(() => !touched && fit(), 400)
    // 패널 크기가 바뀌면(처음 자리 잡을 때 포함) 다시 맞춘다. 사람이 줌·이동한 뒤에는 건드리지 않는다
    let touched = false
    instance.on('scrollzoom pinchzoom', () => (touched = true))
    instance.on('dragpan', () => (touched = true))
    const container = ref.current
    const onWheel = () => { touched = true }
    container.addEventListener('wheel', onWheel, { passive: true })
    const ro = new ResizeObserver(() => {
      if (!touched) fit()
      else instance.resize()
    })
    ro.observe(ref.current)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      container.removeEventListener('wheel', onWheel)
      ro.disconnect()
      instance.destroy()
      if (cy.current === instance) cy.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, dark, relayout])

  useWheelZoom(ref, cy)

  // 필터는 표시만 바꾼다. 숨긴 객체의 좌표도 유지하고 함께 저장한다.
  useEffect(() => {
    const c = cy.current
    if (!c) return
    const ids = new Set<string>(JSON.parse(visibility))
    c.batch(() => c.elements().forEach((e) => { e.toggleClass('filtered', !ids.has(e.id())) }))
    const visible = c.elements().not('.filtered')
    if (visible.empty()) return
    c.fit(visible, 50)
    if (c.zoom() > 1.4) { c.zoom(1.4); c.center(visible) }
  }, [visibility, signature, dark, relayout])

  useEffect(() => {
    cy.current?.edges().toggleClass('labeled', showLabels)
  }, [showLabels, signature, dark, relayout])

  /* 선택: 그 노드와 이어진 것만 밝게 */
  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.batch(() => {
      c.elements().removeClass('faded near hl').unselect()
      // 기능이 쓰는 규칙이 있는 하위 도메인 강조 (그 상자와 안의 개념만 밝게)
      if (highlight.length) {
        const boxes = c.nodes().not('.filtered').filter((n) => highlight.includes(n.id()))
        if (boxes.empty()) return
        const keep = boxes.union(boxes.descendants().not('.filtered'))
        boxes.addClass('hl')
        c.elements().not(keep.union(keep.edgesWith(keep))).addClass('faded')
        return
      }
      if (!selected) return
      const n = c.getElementById(selected)
      if (n.empty() || n.hasClass('filtered')) return
      n.select()
      const children = n.descendants().not('.filtered')
      const edges = n.connectedEdges().union(children.connectedEdges()).not('.filtered')
      const keep = n.union(children).union(edges).union(edges.connectedNodes())
      c.elements().not(keep.union(keep.nodes().ancestors())).addClass('faded')
      edges.addClass('near')
    })
  }, [selected, signature, visibility, dark, relayout, highlight.join(',')])

  return <div ref={ref} className="graph domain-map" />
}
