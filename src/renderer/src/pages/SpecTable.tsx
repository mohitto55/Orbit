import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Domain, Feature, FeatureStatus, Spec } from '../types'
import { AC_LABEL, Badge, Empty, Modal, askChange, errorToast, toast, useLoad } from '../ui'
import { History } from './Domains'

export default function SpecTable({ domain, refreshKey, onChanged }: { domain: Domain; refreshKey: number; onChanged: () => void }) {
  const [specs, reload] = useLoad(() => api.listSpecs(), [refreshKey])
  const spec = specs?.find((s) => s.domainId === domain.id)
  const [status, reloadStatus] = useLoad(() => (spec ? api.specStatus(spec.id) : Promise.resolve(null)), [spec?.id, spec?.version, refreshKey])
  const [designs] = useLoad(() => api.listDesigns(), [refreshKey])
  const [domains] = useLoad(() => api.listDomains(), [refreshKey])
  const [rows, setRows] = useState<Feature[]>([])
  const [picking, setPicking] = useState<number | null>(null)
  const [newName, setNewName] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    if (spec) setRows(spec.features.map((f) => ({ ...f, acs: f.acs.map((a) => ({ ...a })) })))
  }, [spec?.id, spec?.version, spec?.content])

  if (!specs) return null
  if (!spec) {
    return (
      <Empty>
        이 도메인에는 {domain.parent ? '규칙 명세' : '기능 명세'}가 없습니다.{' '}
        <button
          className="primary"
          onClick={async () => {
            await api.createSpec(domain.id).catch(errorToast)
            reload()
          }}
        >
          {domain.parent ? '규칙 명세' : '기능 명세'} 만들기
        </button>
      </Empty>
    )
  }

  const dirty = JSON.stringify(rows) !== JSON.stringify(spec.features)
  const update = (i: number, patch: Partial<Feature>) => setRows((r) => r.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  const save = async () => {
    try {
      let r = await api.saveFeatures(spec.id, rows, null).catch(async (e: Error) => {
        if (!/요약/.test(e.message)) throw e
        const change = await askChange('활성 기능이 바뀌었습니다. 변경을 기록하세요', 'major')
        if (!change) return null
        return api.saveFeatures(spec.id, rows, change)
      })
      if (!r) return
      toast(r.review ? `저장했습니다. 확인표시 ${r.review.items.length}개가 생겼습니다` : '저장했습니다')
      reload()
      reloadStatus()
      onChanged()
    } catch (e) {
      errorToast(e)
    }
  }

  const add = async () => {
    if (!newName.trim()) return
    if (dirty && !confirm('저장하지 않은 수정이 사라집니다. 계속할까요?')) return
    try {
      await api.addFeature(spec.id, { name: newName })
      setNewName('')
      reload()
    } catch (e) {
      errorToast(e)
    }
  }

  const ownDesigns = (designs ?? []).filter((d) => d.folder === spec.folder)
  // 루트의 기능 명세: 아래 하위 도메인들의 규칙 명세에서 쓰는 규칙을 고른다
  const under = new Set<string>()
  const walk = (id: string) => (domains ?? []).filter((d) => d.parent === id).forEach((d) => (under.add(d.id), walk(d.id)))
  walk(domain.id)
  const ruleSpecs = spec.role === 'feature' ? specs.filter((s) => under.has(s.domainId)) : []
  const ruleName = (id: string) => {
    for (const s of ruleSpecs) {
      for (const f of s.features) {
        const dn = (domains ?? []).find((d) => d.id === s.domainId)?.title ?? ''
        if (f.id === id) return `${dn} · ${f.name}`
        const a = f.acs.find((x) => x.id === id)
        if (a) return `${dn} · ${f.name} AC${a.num}`
      }
    }
    return null
  }
  const showUses = spec.role === 'feature' && ruleSpecs.length > 0
  const noun = spec.role === 'rule' ? '규칙' : '기능'

  return (
    <div>
      <div className="row between">
        <div className="muted small">
          {spec.id} · v{spec.version} · 기준: {spec.basedOn.map((b) => `${b.ref} v${b.version}`).join(', ')}
        </div>
        <button className="small ghost" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? '표 보기' : '변경 이력'}
        </button>
      </div>
      {status && status.stale.length > 0 && (
        <div className="banner warn">
          <div>
            <b>낡음</b>: 기준 버전 이후 도메인에 큰 변경이 있었습니다.
            <ul>
              {status.stale.flatMap((s) => s.changes.map((c) => <li key={c.id}>{`${c.target} v${c.from}→v${c.to}: ${c.summary}`}</li>))}
            </ul>
          </div>
          <button
            onClick={async () => {
              const note = prompt('재확인 사유 (내용은 그대로 두고 기준 버전만 올립니다)', '여전히 유효')
              if (note === null) return
              await api.reconfirmSpec(spec.id, note).catch(errorToast)
              reload()
              onChanged()
            }}
          >
            재확인
          </button>
        </div>
      )}
      {showHistory ? (
        <History target={spec.id} />
      ) : (
        <>
          <table className="table spec">
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th>
                <th style={{ width: 140 }}>{noun}</th>
                <th style={{ width: 150 }}>목적</th>
                <th>수용 기준</th>
                {showUses && <th style={{ width: 200 }}>쓰는 규칙</th>}
                <th style={{ width: 104 }}>상태</th>
                <th style={{ width: 104 }}>설계</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => {
                const design = ownDesigns.find((d) => d.basedOn.some((b) => b.feature === f.id))
                return (
                  <tr key={f.id} className={f.status === '폐기' ? 'dim' : ''}>
                    <td className="mono small">{f.id}</td>
                    <td>
                      {/* 긴 이름도 다 보이게 줄바꿈해서 보여준다. 이름은 한 줄이므로 Enter·줄바꿈은 넣지 않는다 */}
                      <textarea
                        rows={1}
                        className="autogrow"
                        value={f.name}
                        onChange={(e) => update(i, { name: e.target.value.replace(/\n/g, ' ') })}
                        onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                      />
                    </td>
                    <td>
                      <textarea rows={1} className="autogrow" value={f.purpose} onChange={(e) => update(i, { purpose: e.target.value })} />
                    </td>
                    <td>
                      {f.acs.map((a, k) => {
                        const st = a.num > 0 ? status?.acStatus[a.id] : undefined
                        return (
                          <div key={k} className="ac">
                            <span className="mono small">AC{a.num || '+'}</span>
                            <textarea
                              rows={1}
                              className="autogrow"
                              value={a.text}
                              onChange={(e) => update(i, { acs: f.acs.map((x, m) => (m === k ? { ...x, text: e.target.value } : x)) })}
                            />
                            {st && <Badge kind={st}>{AC_LABEL[st]}</Badge>}
                            <button className="icon" title="AC 삭제" onClick={() => update(i, { acs: f.acs.filter((_, m) => m !== k) })}>
                              ×
                            </button>
                          </div>
                        )
                      })}
                      <button className="small ghost" onClick={() => update(i, { acs: [...f.acs, { id: '', num: 0, text: '' }] })}>
                        + AC
                      </button>
                    </td>
                    {showUses && (
                      <td>
                        <div className="uses">
                          {(f.uses ?? []).map((u) => (
                            <span key={u} className={`chip small ${ruleName(u) ? '' : 'bad'}`} title={ruleName(u) ?? '없는 규칙'}>
                              <span className="mono">{u}</span>
                              <span className="uses-name">{ruleName(u) ?? '없는 규칙'}</span>
                              <button className="icon" title="빼기" onClick={() => update(i, { uses: (f.uses ?? []).filter((x) => x !== u) })}>
                                ×
                              </button>
                            </span>
                          ))}
                          <button className="small ghost" onClick={() => setPicking(i)}>
                            + 규칙
                          </button>
                        </div>
                      </td>
                    )}
                    <td>
                      <select value={f.status} onChange={(e) => update(i, { status: e.target.value as FeatureStatus })}>
                        <option>초안</option>
                        <option>활성</option>
                        <option>폐기</option>
                      </select>
                    </td>
                    <td>
                      {design ? (
                        <span className="small">
                          있음 {design.stale.length > 0 && <Badge kind="fail">낡음</Badge>}
                        </span>
                      ) : (
                        <button
                          className="small ghost"
                          onClick={async () => {
                            await api.createDesign(spec.id, f.id).then(() => toast('설계를 만들었습니다. 설계 탭에서 편집하세요')).catch(errorToast)
                            onChanged()
                          }}
                        >
                          + 설계
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="row between">
            <div className="row">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`새 ${noun} 이름`} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button onClick={add}>+ {noun}</button>
            </div>
            <button className="primary" disabled={!dirty} onClick={save}>
              표 저장
            </button>
          </div>
          <p className="muted small">
            {spec.role === 'rule'
              ? '규칙 명세: 이 도메인이 혼자 지키는 조건·상태 전이·계산·불변식. 사용자 기능은 루트 도메인의 기능 명세에 적고 여기 규칙을 참조합니다. '
              : showUses
                ? '기능 명세: 하위 도메인의 규칙을 조정해 이루는 사용자 기능. 쓰는 규칙이 크게 바뀌면 이 기능에 확인 항목이 생깁니다. '
                : ''}
            초안 행은 기록 없이 고칠 수 있습니다. 활성 행을 고치면 변경 크기와 요약을 남겨야 하고, 큰 변경이면 그 기능의 설계와 테스트에 확인표시가 뜹니다.</p>
        </>
      )}
      {picking !== null && rows[picking] && (
        <RulePicker
          ruleSpecs={ruleSpecs}
          domains={domains ?? []}
          value={rows[picking].uses ?? []}
          onClose={() => setPicking(null)}
          onPick={(uses) => {
            update(picking, { uses })
            setPicking(null)
          }}
        />
      )}
    </div>
  )
}

/** 루트 기능이 쓰는 하위 도메인 규칙 고르기 (기능 전체 또는 AC 하나) */
function RulePicker({ ruleSpecs, domains, value, onClose, onPick }: { ruleSpecs: Spec[]; domains: Domain[]; value: string[]; onClose: () => void; onPick: (uses: string[]) => void }) {
  const [sel, setSel] = useState<string[]>(value)
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  return (
    <Modal title="쓰는 규칙 고르기" onClose={onClose} wide>
      <div className="muted small">이 기능을 이루려고 지켜야 하는 하위 도메인의 규칙입니다. 규칙 전체나 AC 하나를 고를 수 있습니다.</div>
      <div className="rule-picker">
        {ruleSpecs.map((s) => (
          <div key={s.id} className="uc-rules">
            <b className="small">{domains.find((d) => d.id === s.domainId)?.title}</b>
            {s.features.filter((f) => f.status !== '폐기').length === 0 && <div className="muted small">규칙이 없습니다</div>}
            {s.features
              .filter((f) => f.status !== '폐기')
              .map((f) => (
                <div key={f.id} className="uc-rule">
                  <label className="small">
                    <input type="checkbox" checked={sel.includes(f.id)} onChange={() => toggle(f.id)} />
                    <span className="mono muted">{f.id}</span> {f.name}
                  </label>
                  <div className="uc-rule-acs">
                    {f.acs.map((a) => (
                      <label key={a.id} className="small muted">
                        <input type="checkbox" checked={sel.includes(a.id)} disabled={sel.includes(f.id)} onChange={() => toggle(a.id)} />
                        AC{a.num}: {a.text}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="row end">
        <button onClick={onClose}>취소</button>
        <button className="primary" onClick={() => onPick(sel)}>
          {sel.length}개 고르기
        </button>
      </div>
    </Modal>
  )
}
