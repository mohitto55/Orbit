import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { Domain, SubdomainType } from '../types'
import { Badge, Empty, Modal, askChange, errorToast, toast, useLoad } from '../ui'
import SpecTable from './SpecTable'
import { MdEditor } from '../Markdown'
import DesignPanel from './DesignPanel'

type Tab = 'role' | 'spec' | 'design' | 'history'

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

export default function Domains({ refreshKey, focus, reloadBadges }: PageProps) {
  const [domains, reload] = useLoad(() => api.listDomains(), [refreshKey])
  const [requests, reloadReq] = useLoad(() => api.listRequests(), [refreshKey])
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  const [tab, setTab] = useState<Tab>('role')
  const [creating, setCreating] = useState(false)
  const [systemDesign, setSystemDesign] = useState(false)

  useEffect(() => {
    if (!selected && domains?.length) setSelected(domains[0].id)
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

  return (
    <div className="split">
      <div className="pane-list">
        <div className="row between">
          <h3>도메인</h3>
          <button className="small" onClick={() => setCreating(true)}>
            + 새 도메인
          </button>
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
            {pendingReq
              .filter((r) => r.domain === domain.id)
              .map((r) => (
                <div key={r.id} className="banner">
                  <div>
                    <b>변경 요청</b> <span className="muted small">({r.source})</span>
                    <blockquote>{r.excerpt}</blockquote>
                    {r.note && <div>{r.note}</div>}
                  </div>
                  <button
                    onClick={async () => {
                      await api.resolveRequest(r.id).catch(errorToast)
                      reloadReq()
                      reloadBadges()
                    }}
                  >
                    반영 완료
                  </button>
                </div>
              ))}
            <div className="tabs">
              {(
                [
                  ['role', '역할 (1층)'],
                  ['spec', '기능 명세 표 (2층)'],
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
  const kids = props.domains.filter((d) => (d.parent ?? undefined) === props.parent)
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
      <MdEditor label="domain.md (역할 / 용어 / 하지 않는 것 / 관계)" value={content} onChange={setContent} onWiki={onWiki} />
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
