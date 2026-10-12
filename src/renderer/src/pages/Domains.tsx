import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { Domain, SubdomainType } from '../types'
import { Badge, Empty, Modal, askChange, errorToast, toast, useLoad } from '../ui'
import SpecTable from './SpecTable'
import { MdEditor } from '../Markdown'
import DesignPanel from './DesignPanel'
import ModelPanel from './ModelPanel'
import DomainGraph from './DomainGraph'
import SpecSummary from './FeatureRollup'
import { MdContent } from '../Markdown'
import type { DomainMap as MapData } from '../types'

type Tab = 'role' | 'features' | 'model' | 'spec' | 'design' | 'history'

export function domainLabel(domains: Domain[], id: string): string {
  const byId = new Map(domains.map((d) => [d.id, d]))
  const names: string[] = []
  let cur = byId.get(id)
  while (cur && names.length < 20) {
    names.unshift(cur.title)
    cur = cur.parent ? byId.get(cur.parent) : undefined
  }
  return names.join(' › ')
}

export default function Domains({ refreshKey, focus, reloadBadges, go }: PageProps) {
  const [domains, reload] = useLoad(() => api.listDomains(), [refreshKey])
  const [requests] = useLoad(() => api.listRequests(), [refreshKey])
  // focus는 '도메인 id' 또는 '도메인 id#model|spec|design' (다른 화면에서 특정 탭으로 바로 열 때)
  const [focusId, focusTab] = (focus ?? '').split('#')
  const [selected, setSelected] = useState<string | null>(focusId || null)
  const [tab, setTab] = useState<Tab>(focusTab === 'spec' || focusTab === 'design' || focusTab === 'model' ? focusTab : 'role')
  const [creating, setCreating] = useState(false)
  // 지도(그래프) 보기가 기본. 다른 화면에서 특정 도메인·탭으로 오면 문서 보기
  const [view, setView] = useState<'map' | 'doc'>(focus ? 'doc' : 'map')
  const [mapSel, setMapSel] = useState<string | null>(null)
  const [relayout, setRelayout] = useState(0)
  const [map, reloadMap] = useLoad(() => api.domainMap(), [refreshKey])
  // 그래프로 볼 최상위 도메인 (애그리거트 루트 단위)
  const [rootId, setRootId] = useState<string | null>(null)
  // 기능을 눌렀을 때 그 기능이 쓰는 규칙이 있는 하위 도메인들
  const [hl, setHl] = useState<{ feature: string | null; domains: string[] }>({ feature: null, domains: [] })
  const [scope, reloadScope] = useLoad(() => (rootId ? api.domainScope(rootId) : Promise.resolve(null)), [rootId, refreshKey])
  const [specs] = useLoad(() => api.listSpecs(), [refreshKey])
  const [statuses] = useLoad(() => api.allAcStatuses(), [refreshKey])
  const [systemDesign, setSystemDesign] = useState(false)

  // 다른 화면(관계도·유스케이스)에서 다른 도메인으로 옮겨 올 때
  useEffect(() => {
    if (!focusId) return
    setSelected(focusId)
    setSystemDesign(false)
    setView('doc')
    if (focusTab === 'spec' || focusTab === 'design' || focusTab === 'model') setTab(focusTab)
  }, [focus])

  useEffect(() => {
    if (!selected && domains?.length) {
      // 트리 맨 위(최상위 중 첫 번째)를 기본으로 연다
      const rank = { Core: 0, Supporting: 1, Generic: 2 } as Record<string, number>
      const roots = domains
        .filter((d) => !d.parent)
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || (rank[a.subdomainType] ?? 9) - (rank[b.subdomainType] ?? 9) || a.title.localeCompare(b.title, 'ko'))
      setSelected((roots[0] ?? domains[0]).id)
    }
  }, [domains, selected])

  if (!domains) return null
  const domain = domains.find((d) => d.id === selected)
  const openWiki = (target: string) => {
    const [a, b] = target.split('/').map((x) => x.trim())
    const hit = b
      ? domains.find((d) => d.title === b && domains.find((p) => p.id === d.parent)?.title === a)
      : domains.find((d) => d.id === target) ??
        domains.find((d) => d.title === target && (d.parent ?? '') === (domain?.parent ?? '')) ??
        (domains.filter((d) => d.title === target).length === 1 ? domains.find((d) => d.title === target) : undefined)
    if (hit) {
      setSelected(hit.id)
      setSystemDesign(false)
    } else toast(`아직 없는 도메인입니다: ${target}`, 'error')
  }
  const pendingReq = (requests ?? []).filter((r) => r.status === 'pending')
  const openDoc = (id: string, t?: Tab) => {
    setSelected(id)
    setSystemDesign(false)
    if (t) setTab(t)
    setView('doc')
  }

  if (view === 'map') {
    const roots = domains
      .filter((d) => !d.parent)
      .sort((x, y) => (x.order ?? 99) - (y.order ?? 99) || x.title.localeCompare(y.title, 'ko'))
    const under = (id: string) => domains.filter((d) => domainLabel(domains, d.id).startsWith(domainLabel(domains, id) + ' › '))
    const root = domains.find((d) => d.id === rootId)
    const pickedNode = scope?.nodes.find((n) => n.id === mapSel)
    const changed = () => {
      reload()
      reloadMap()
      reloadScope()
      reloadBadges()
    }
    return (
      <div className="split">
        <div className="pane-list">
          <div className="row between">
            <h3>도메인</h3>
            <div className="row">
              <button className="small ghost" onClick={() => setView('doc')}>
                문서로
              </button>
              <button className="small" onClick={() => setCreating(true)}>
                + 새 도메인
              </button>
            </div>
          </div>
          <div className="muted small">도메인을 고르면 그 도메인의 하위 도메인과 개념 관계만 그래프로 봅니다.</div>
          {roots.map((r) => {
            const subs = under(r.id)
            const feats = map?.nodes.filter((n) => n.id === r.id || subs.some((x) => x.id === n.id)).reduce((a, n) => a + n.features, 0) ?? 0
            const concepts = [r, ...subs].reduce((a, x) => a + x.model.length, 0)
            return (
              <button key={r.id} className={`tree-item root-card ${rootId === r.id ? 'on' : ''}`} onClick={() => { setRootId(r.id); setMapSel(null); setHl({ feature: null, domains: [] }) }}>
                <span className="row between">
                  <b>
                    <span className={`dot ${r.subdomainType.toLowerCase()}`} /> {r.title}
                  </b>
                </span>
                <span className="muted small">
                  하위 {subs.length} · 기능 {feats}
                  {concepts > 0 ? ` · 개념 ${concepts}` : ''}
                </span>
              </button>
            )
          })}
        </div>
        {root && scope ? (
          <div className="pane-main map-main">
            <div className="row between">
              <div>
                <div className="muted small">도메인 그래프</div>
                <h2>
                  {root.title} <Badge kind={root.subdomainType.toLowerCase()}>{root.subdomainType}</Badge>
                </h2>
              </div>
              <div className="row">
                <span className="muted small">회색 상자: 하위 도메인 · 흰 네모: 개념(객체) · 선: 개념 관계 (누르면 관계 이름) · 끌어서 옮길 수 있음</span>
                <button className="small ghost" title="노드 위치를 처음부터 다시 배치합니다" onClick={() => setRelayout((n) => n + 1)}>
                  다시 배치
                </button>
              </div>
            </div>
            <div className="map-body">
              <div className="graph-wrap">
                <DomainGraph
                  scope={scope}
                  selected={mapSel}
                  highlight={hl.domains}
                  onSelect={(id) => {
                    setMapSel(id)
                    setHl({ feature: null, domains: [] })
                  }}
                  onOpen={(id) => {
                    const n = scope.nodes.find((x) => x.id === id)
                    if (n) openDoc(n.domainId, n.kind === 'concept' ? 'model' : undefined)
                  }}
                  relayout={relayout}
                />
              </div>
              {pickedNode?.kind === 'concept' ? (
                <ConceptSide domains={domains} domainId={pickedNode.domainId} name={pickedNode.label} onOpen={() => openDoc(pickedNode.domainId, 'model')} onSelect={setMapSel} />
              ) : (
                <MapSide
                  id={pickedNode ? pickedNode.domainId : root.id}
                  map={map}
                  domains={domains}
                  specs={specs ?? []}
                  statuses={statuses ?? {}}
                  onSelect={setMapSel}
                  onOpen={openDoc}
                  onChanged={changed}
                  activeFeature={hl.feature}
                  onHighlight={(feature, ds) => setHl({ feature, domains: ds })}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="pane-main">
            <Empty>왼쪽에서 도메인을 고르면 그 도메인의 그래프가 나옵니다</Empty>
          </div>
        )}
        {creating && <CreateDomain domains={domains} onClose={() => setCreating(false)} onCreated={(d) => { changed(); if (!d.parent) setRootId(d.id); setCreating(false) }} />}
      </div>
    )
  }

  return (
    <div className="split">
      <div className="pane-list">
        <div className="row between">
          <h3>도메인</h3>
          <div className="row">
            <button
              className="small ghost"
              onClick={() => {
                // 지금 보던 도메인이 속한 최상위 도메인의 그래프로
                let cur = domains.find((d) => d.id === selected)
                while (cur?.parent) cur = domains.find((d) => d.id === cur!.parent)
                if (cur) setRootId(cur.id)
                setMapSel(selected)
                setView('map')
              }}
            >
              그래프로
            </button>
            <button className="small" onClick={() => setCreating(true)}>
              + 새 도메인
            </button>
          </div>
        </div>
        {domains.length === 0 && <Empty>도메인이 없습니다</Empty>}
        <Tree domains={domains} parent={undefined} depth={0} selected={systemDesign ? null : selected} onSelect={(id) => { setSelected(id); setSystemDesign(false) }} requests={pendingReq.map((r) => r.domain)} />
        <div className="tree-sep" />
        <button className={`tree-item ${systemDesign ? 'on' : ''}`} onClick={() => setSystemDesign(true)}>
          시스템 공통 설계
        </button>
      </div>
      <div className="pane-main">
        {systemDesign ? (
          <DesignPanel system refreshKey={refreshKey} onChanged={reloadBadges} />
        ) : domain ? (
          <>
            <div className="row between">
              <div>
                <div className="muted small">{domainLabel(domains, domain.id)}</div>
                <h2>
                  {domain.title} <Badge kind={domain.subdomainType.toLowerCase()}>{domain.subdomainType}</Badge> <span className="muted small">v{domain.version}</span>
                </h2>
              </div>
            </div>
            {/* 변경 요청은 변경 검토에서 처리한다. 여기서는 제목만 짧게 알린다. */}
            {pendingReq.some((r) => r.domain === domain.id) && (
              <div className="req-notice">
                <span className="req-notice-head">변경 요청 {pendingReq.filter((r) => r.domain === domain.id).length}개</span>
                {pendingReq
                  .filter((r) => r.domain === domain.id)
                  .map((r) => (
                    <button key={r.id} className="link req-notice-item" title="변경 검토에서 보기" onClick={() => go('reviews', `request:${r.id}`)}>
                      {(r.note ?? r.excerpt).split(/[:\n]/)[0]}
                    </button>
                  ))}
              </div>
            )}
            <div className="tabs">
              {(
                [
                  ['role', '역할 (1층)'],
                  ['model', `모델${domain.model.length ? ` ${domain.model.length}` : ''}`],
                  ['spec', domain.parent ? '규칙 명세 (2층)' : '기능 명세 (2층)'],
                  ['design', '설계 (3층)'],
                  ['history', '변경 이력']
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'role' && <RoleEditor key={domain.id + domain.version} domain={domain} domains={domains} onWiki={openWiki} onSaved={() => { reload(); reloadBadges() }} />}
            {tab === 'model' && <ModelPanel key={domain.id} domain={domain} domains={domains} refreshKey={refreshKey} go={go} onEdit={() => setTab('role')} onSaved={() => { reload(); reloadBadges() }} />}
            {tab === 'spec' && <SpecTable key={domain.id} domain={domain} refreshKey={refreshKey} onChanged={reloadBadges} />}
            {tab === 'design' && <DesignPanel key={domain.id} folder={domain.folder} refreshKey={refreshKey} onChanged={reloadBadges} />}
            {tab === 'history' && <History key={domain.id + domain.version} target={domain.id} />}
          </>
        ) : (
          <Empty>왼쪽에서 도메인을 고르세요</Empty>
        )}
      </div>
      {creating && <CreateDomain domains={domains} onClose={() => setCreating(false)} onCreated={(d) => { reload(); setSelected(d.id); setCreating(false) }} />}
    </div>
  )
}

function Tree(props: { domains: Domain[]; parent: string | undefined; depth: number; selected: string | null; onSelect: (id: string) => void; requests: string[] }) {
  const rank = { Core: 0, Supporting: 1, Generic: 2 } as Record<string, number>
  const kids = props.domains
    .filter((d) => (d.parent ?? undefined) === props.parent)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || (rank[a.subdomainType] ?? 9) - (rank[b.subdomainType] ?? 9) || a.title.localeCompare(b.title, 'ko'))
  return (
    <>
      {kids.map((d) => (
        <div key={d.id}>
          <button className={`tree-item ${props.selected === d.id ? 'on' : ''} ${d.status === '폐기됨' ? 'dim' : ''}`} style={{ paddingLeft: 10 + props.depth * 16 }} onClick={() => props.onSelect(d.id)}>
            <span className={`dot ${d.subdomainType.toLowerCase()}`} />
            {d.title}
            {props.requests.includes(d.id) && <span className="count">!</span>}
          </button>
          <Tree {...props} parent={d.id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  )
}

function CreateDomain({ domains, onClose, onCreated }: { domains: Domain[]; onClose: () => void; onCreated: (d: Domain) => void }) {
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [parent, setParent] = useState('')
  const [type, setType] = useState<SubdomainType>('Supporting')
  const [role, setRole] = useState('')
  const submit = async () => {
    try {
      onCreated(await api.createDomain({ title, folder: folder || undefined, parent: parent || undefined, subdomainType: type, role }))
      toast('도메인을 만들었습니다')
    } catch (e) {
      errorToast(e)
    }
  }
  return (
    <Modal title="새 도메인" onClose={onClose}>
      <div className="field">
        <label>이름</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>폴더 이름 (영문, 생성 후 바꾸지 않음)</label>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="예: order-customer" />
      </div>
      <div className="grid2">
        <div className="field">
          <label>상위 도메인 (하나만)</label>
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(최상위)</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {domainLabel(domains, d.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>도메인 유형</label>
          <select value={type} onChange={(e) => setType(e.target.value as SubdomainType)}>
            <option>Core</option>
            <option>Supporting</option>
            <option>Generic</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>역할</label>
        <textarea rows={3} value={role} onChange={(e) => setRole(e.target.value)} placeholder="이 도메인이 책임지는 일" />
      </div>
      <div className="row end">
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!title.trim()} onClick={submit}>
          만들기
        </button>
      </div>
    </Modal>
  )
}

function RoleEditor({ domain, domains, onSaved, onWiki }: { domain: Domain; domains: Domain[]; onSaved: () => void; onWiki: (t: string) => void }) {
  const [title, setTitle] = useState(domain.title)
  const [parent, setParent] = useState(domain.parent ?? '')
  const [type, setType] = useState<SubdomainType>(domain.subdomainType)
  const [status, setStatus] = useState(domain.status)
  const [content, setContent] = useState(domain.content)
  const dirty = title !== domain.title || parent !== (domain.parent ?? '') || type !== domain.subdomainType || status !== domain.status || content !== domain.content
  const moved = parent !== (domain.parent ?? '')
  const options = useMemo(() => domains.filter((d) => d.id !== domain.id), [domains, domain.id])

  const save = async () => {
    const change = await askChange(moved ? '도메인 저장 (이동은 큰 변경으로 기록됩니다)' : '도메인 저장', moved ? 'major' : 'minor')
    if (!change) return
    try {
      const r = await api.saveDomain(domain.id, { title, parent: parent || null, subdomainType: type, status, content }, change)
      toast(r.review ? `저장했습니다. 확인표시 ${r.review.items.length}개가 생겼습니다` : `저장했습니다 (v${r.domain.version})`)
      onSaved()
    } catch (e) {
      errorToast(e)
    }
  }
  const remove = async () => {
    if (!confirm(`${domain.title} 도메인을 삭제할까요? 폴더가 지워집니다.`)) return
    try {
      await api.deleteDomain(domain.id)
      toast('삭제했습니다')
      onSaved()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="editor">
      <div className="grid4">
        <div className="field">
          <label>이름</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>상위 도메인</label>
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(최상위)</option>
            {options.map((d) => (
              <option key={d.id} value={d.id}>
                {domainLabel(domains, d.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>유형</label>
          <select value={type} onChange={(e) => setType(e.target.value as SubdomainType)}>
            <option>Core</option>
            <option>Supporting</option>
            <option>Generic</option>
          </select>
        </div>
        <div className="field">
          <label>상태</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="폐기됨">폐기됨</option>
          </select>
        </div>
      </div>
      <MdEditor label="domain.md (역할 / 용어 / 모델 / 하지 않는 것)" value={content} onChange={setContent} onWiki={onWiki} />
      <div className="row between">
        <button className="danger ghost" onClick={remove}>
          삭제
        </button>
        <button className="primary" disabled={!dirty} onClick={save}>
          저장
        </button>
      </div>
    </div>
  )
}

export function History({ target }: { target: string }) {
  const [changes] = useLoad(() => api.history(target), [target])
  if (!changes) return null
  if (changes.length === 0) return <Empty>변경 기록이 없습니다</Empty>
  return (
    <table className="table">
      <thead>
        <tr>
          <th>버전</th>
          <th>크기</th>
          <th>요약</th>
          <th>바뀐 항목</th>
          <th>출처</th>
          <th>날짜</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.id}>
            <td>
              v{c.from} → v{c.to}
            </td>
            <td>
              <Badge kind={c.size}>{c.size === 'major' ? '큰 변경' : '작은 변경'}</Badge>
            </td>
            <td>{c.summary}</td>
            <td className="small">{c.changed.join(', ') || '전체'}</td>
            <td>{c.source}</td>
            <td className="small">{new Date(c.created).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const VIA_LABEL: Record<string, string> = { link: '직접', concept: '모델', mention: '언급' }

/** 지도 옆 패널: 고른 도메인의 역할, 관계, 하위까지 모은 기능 */
function MapSide(props: {
  id: string | null
  map: MapData | null
  domains: Domain[]
  specs: import('../types').Spec[]
  statuses: Record<string, Record<string, import('../types').AcStatus>>
  onSelect: (id: string | null) => void
  onOpen: (id: string, tab?: Tab) => void
  onChanged: () => void
  activeFeature: string | null
  onHighlight: (feature: string | null, domainIds: string[]) => void
}) {
  const { id, map, domains, specs, statuses, onSelect, onOpen, onChanged, activeFeature, onHighlight } = props
  const [type, setType] = useState('의존')
  const [to, setTo] = useState('')
  const d = domains.find((x) => x.id === id)
  const title = (x: string) => domains.find((y) => y.id === x)?.title ?? x

  if (!d || !map) {
    const roots = domains.filter((x) => !x.parent)
    return (
      <aside className="map-side">
        <h3>도메인 지도</h3>
        <p className="muted small">상위 도메인은 상자, 하위 도메인은 그 안에 묶여 보입니다. 선은 같은 상자 안의 하위 도메인 사이 관계입니다.</p>
        <ul className="small map-legend">
          <li><span className="lg solid" /> 직접 적은 관계</li>
          <li><span className="lg dashed" /> 모델 표의 개념 관계에서 온 것</li>
          <li><span className="lg dotted" /> 문서 본문의 [[도메인]] 언급</li>
        </ul>
        <p className="muted small">누르면 관계와 기능을, 두 번 누르면 문서를 엽니다. 노드를 끌어 옮긴 위치는 기억합니다.</p>
        <h4>최상위 도메인</h4>
        {roots.map((r) => {
          const all = [r.id, ...domains.filter((x) => domainLabel(domains, x.id).startsWith(domainLabel(domains, r.id) + ' › ')).map((x) => x.id)]
          const n = map?.nodes.filter((x) => all.includes(x.id)).reduce((a, x) => a + x.features, 0) ?? 0
          return (
            <button key={r.id} className="tree-item" onClick={() => onSelect(r.id)}>
              {r.title} <span className="muted small">기능 {n}</span>
            </button>
          )
        })}
      </aside>
    )
  }

  const out = map.edges.filter((e) => e.source === d.id)
  const inc = map.edges.filter((e) => e.target === d.id)
  const kids = domains.filter((x) => x.parent === d.id)

  const saveLinks = async (links: Domain['links'], summary: string) => {
    try {
      await api.saveDomain(d.id, { links }, { size: 'minor', summary })
      toast('관계를 저장했습니다')
      onChanged()
    } catch (e) {
      errorToast(e)
    }
  }

  const specPart = (
    <>
      <h4>{d.parent ? '규칙 명세' : '기능 명세'}</h4>
      {!d.parent && <div className="muted small">기능을 누르면 그 기능이 쓰는 규칙이 있는 하위 도메인이 그래프에서 강조됩니다.</div>}
      <SpecSummary domainId={d.id} domains={domains} specs={specs} statuses={statuses} active={activeFeature} onHighlight={onHighlight} onOpen={(x) => onOpen(x, 'spec')} />
    </>
  )
  return (
    <aside className="map-side">
      <div className="muted small">{domainLabel(domains, d.id)}</div>
      <h3>
        {d.title} <Badge kind={d.subdomainType.toLowerCase()}>{d.subdomainType}</Badge>
      </h3>
      <div className="row">
        <button className="small primary" onClick={() => onOpen(d.id)}>
          문서 열기
        </button>
        {d.parent && (
          <button className="small ghost" onClick={() => onSelect(d.parent!)}>
            ↑ {title(d.parent)}
          </button>
        )}
      </div>
      {/* 루트는 기능 명세가 먼저. 역할은 접어 둔다 */}
      {!d.parent && specPart}
      {d.role && (
        <details className="small map-role" open={!!d.parent}>
          <summary>역할</summary>
          <MdContent source={d.role} />
        </details>
      )}
      {kids.length > 0 && <h4>하위 도메인</h4>}
      {kids.length > 0 && (
        <div className="chips">
          {kids.map((k) => (
            <button key={k.id} className="chip small" onClick={() => onSelect(k.id)}>
              {k.title}
            </button>
          ))}
        </div>
      )}
      {d.parent && specPart}
      {/* 관계선은 같은 상위 안의 하위 도메인끼리만 있으므로 하위 도메인에서만 보인다 */}
      {d.parent && (
        <>
      <h4>관계</h4>
      {out.length + inc.length === 0 && <div className="muted small">{d.parent ? '같은 상위 안의 다른 하위 도메인과 이어진 선이 없습니다' : '최상위 도메인끼리는 선을 긋지 않습니다'}</div>}
      <ul className="small map-rels">
        {out.map((e) => (
          <li key={'o' + e.target}>
            → <button className="link" onClick={() => onSelect(e.target)}>{title(e.target)}</button> {e.types.join(', ')}{' '}
            <span className="muted">({e.via.map((v) => VIA_LABEL[v]).join('·')})</span>
            {e.details.length > 0 && <div className="muted">{e.details.join(' / ')}</div>}
            {e.via.includes('link') && (
              <button className="link danger-link" title="직접 적은 관계 지우기" onClick={() => saveLinks(d.links.filter((l) => l.to !== e.target), `관계 삭제: → ${title(e.target)}`)}>
                지우기
              </button>
            )}
          </li>
        ))}
        {inc.map((e) => (
          <li key={'i' + e.source}>
            ← <button className="link" onClick={() => onSelect(e.source)}>{title(e.source)}</button> {e.types.join(', ')}{' '}
            <span className="muted">({e.via.map((v) => VIA_LABEL[v]).join('·')})</span>
          </li>
        ))}
      </ul>
      {d.parent && (
      <div className="row map-add">
        <input value={type} onChange={(e) => setType(e.target.value)} list="rel-types" style={{ width: 80 }} />
        <datalist id="rel-types">
          <option value="의존" />
          <option value="사용" />
          <option value="요청" />
          <option value="구독" />
        </datalist>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">대상 도메인…</option>
          {domains
            .filter((x) => x.id !== d.id && !!d.parent && x.parent === d.parent)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {domainLabel(domains, x.id)}
              </option>
            ))}
        </select>
        <button
          className="small"
          disabled={!to || !type.trim()}
          onClick={() => {
            saveLinks([...d.links.filter((l) => l.to !== to), { type: type.trim(), to }], `관계 추가: ${type.trim()} → ${title(to)}`)
            setTo('')
          }}
        >
          + 선
        </button>
      </div>
      )}
        </>
      )}
    </aside>
  )
}

/** 그래프에서 개념을 골랐을 때: 상태·행위, 불변식, 관계, 코드 */
function ConceptSide({ domains, domainId, name, onOpen, onSelect }: { domains: Domain[]; domainId: string; name: string; onOpen: () => void; onSelect: (id: string | null) => void }) {
  const d = domains.find((x) => x.id === domainId)
  const c = d?.model.find((m) => m.name === name)
  if (!d || !c) return <aside className="map-side" />
  const row = (label: string, v: string) =>
    v ? (
      <div className="concept-row">
        <span className="muted small">{label}</span>
        <MdContent source={v.replace(/<br\s*\/?>/gi, '\n\n')} />
      </div>
    ) : null
  return (
    <aside className="map-side">
      <div className="muted small">{domainLabel(domains, d.id)} › 개념</div>
      <h3>
        {c.name} {c.kind && <Badge>{c.kind}</Badge>}
      </h3>
      {row('상태·행위', c.behavior)}
      {row('불변식', c.invariants)}
      {c.relations.length > 0 && (
        <div className="concept-row">
          <span className="muted small">관계</span>
          <div className="chips">
            {c.relations.map((r, i) => (
              <span key={i} className="chip small">
                {r.type} → {r.to}
              </span>
            ))}
          </div>
        </div>
      )}
      {c.code.length > 0 && (
        <div className="concept-row">
          <span className="muted small">코드</span>
          <div className="chips">
            {c.code.map((x) => (
              <span key={x} className="chip small mono">
                {x}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button className="small primary" onClick={onOpen}>
          모델 표 열기
        </button>
        <button className="small ghost" onClick={() => onSelect(d.id)}>
          ↑ {d.title}
        </button>
      </div>
    </aside>
  )
}
