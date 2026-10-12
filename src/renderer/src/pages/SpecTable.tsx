import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Domain, Feature, FeatureStatus } from '../types'
import { AC_LABEL, Badge, Empty, askChange, errorToast, toast, useLoad } from '../ui'
import { History } from './Domains'

export default function SpecTable({ domain, refreshKey, onChanged }: { domain: Domain; refreshKey: number; onChanged: () => void }) {
  const [specs, reload] = useLoad(() => api.listSpecs(), [refreshKey])
  const spec = specs?.find((s) => s.domainId === domain.id)
  const [status, reloadStatus] = useLoad(() => (spec ? api.specStatus(spec.id) : Promise.resolve(null)), [spec?.id, spec?.version, refreshKey])
  const [designs] = useLoad(() => api.listDesigns(), [refreshKey])
  const [rows, setRows] = useState<Feature[]>([])
  const [newName, setNewName] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    if (spec) setRows(spec.features.map((f) => ({ ...f, acs: f.acs.map((a) => ({ ...a })) })))
  }, [spec?.id, spec?.version, spec?.content])

  if (!specs) return null
  if (!spec) {
    return (
      <Empty>
        이 도메인에는 기능 명세 표가 없습니다.{' '}
        <button
          className="primary"
          onClick={async () => {
            await api.createSpec(domain.id).catch(errorToast)
            reload()
          }}
        >
          기능 명세 표 만들기
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

  const ownDesigns = (designs ?? []).filter((d) => d.folder === domain.folder)

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
                <th style={{ width: 140 }}>기능</th>
                <th style={{ width: 150 }}>목적</th>
                <th>수용 기준</th>
                <th style={{ width: 80 }}>상태</th>
                <th style={{ width: 80 }}>설계</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => {
                const design = ownDesigns.find((d) => d.basedOn.some((b) => b.feature === f.id))
                return (
                  <tr key={f.id} className={f.status === '폐기' ? 'dim' : ''}>
                    <td className="mono small">{f.id}</td>
                    <td>
                      <input value={f.name} onChange={(e) => update(i, { name: e.target.value })} />
                    </td>
                    <td>
                      <textarea rows={2} value={f.purpose} onChange={(e) => update(i, { purpose: e.target.value })} />
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
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 기능 이름" onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button onClick={add}>+ 기능</button>
            </div>
            <button className="primary" disabled={!dirty} onClick={save}>
              표 저장
            </button>
          </div>
          <p className="muted small">초안 행은 기록 없이 고칠 수 있습니다. 활성 행을 고치면 변경 크기와 요약을 남겨야 하고, 큰 변경이면 그 기능의 설계와 테스트에 확인표시가 뜹니다.</p>
        </>
      )}
    </div>
  )
}
