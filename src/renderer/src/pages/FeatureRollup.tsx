import type { AcStatus, Domain, Spec } from '../types'
import { AC_LABEL, Badge, Empty } from '../ui'

/**
 * 그래프 옆 패널의 명세 요약.
 * 루트 도메인이면 기능 명세(사용자 기능)와 기능마다 쓰는 하위 도메인 규칙을, 하위 도메인이면 규칙 명세를 보여준다.
 * 행을 누르면 펼쳐서 목적·수용 기준·쓰는 규칙을 자세히 보이고, 쓰는 규칙이 있는 하위 도메인을 그래프에서 강조한다.
 */
export default function SpecSummary({ domainId, domains, specs, statuses, active, onHighlight, onOpen }: {
  domainId: string
  domains: Domain[]
  specs: Spec[]
  statuses: Record<string, Record<string, AcStatus>>
  active: string | null
  onHighlight: (featureId: string | null, domainIds: string[]) => void
  onOpen: (domainId: string) => void
}) {
  const spec = specs.find((s) => s.domainId === domainId)
  const rows = spec?.features.filter((f) => f.status !== '폐기') ?? []
  if (!spec || rows.length === 0) return <Empty>{domains.find((d) => d.id === domainId)?.parent ? '규칙이 없습니다' : '기능이 없습니다'}</Empty>

  // 규칙 ID → 그 규칙이 있는 하위 도메인과 내용
  const owner = new Map<string, { domainId: string; specId: string; label: string; text?: string }>()
  for (const s of specs) {
    const dn = domains.find((d) => d.id === s.domainId)?.title ?? ''
    for (const f of s.features) {
      owner.set(f.id, { domainId: s.domainId, specId: s.id, label: `${dn} · ${f.name}`, text: f.purpose })
      for (const a of f.acs) owner.set(a.id, { domainId: s.domainId, specId: s.id, label: `${dn} · ${f.name} AC${a.num}`, text: a.text })
    }
  }
  const st = statuses[spec.id] ?? {}

  return (
    <div className="rollup compact">
      {rows.map((f) => {
        const pass = f.acs.filter((a) => st[a.id] === 'pass').length
        const fail = f.acs.some((a) => st[a.id] === 'fail')
        const uses = (f.uses ?? []).map((u) => ({ id: u, ...(owner.get(u) ?? { domainId: '', specId: '', label: `${u} (없는 규칙)` }) }))
        const on = active === f.id
        return (
          <div key={f.id} className={`rollup-item clickable ${on ? 'on' : ''}`}>
            <div
              className="rollup-row"
              title={on ? '접기' : '자세히 보기'}
              onClick={() => onHighlight(on ? null : f.id, on ? [] : [...new Set(uses.map((u) => u.domainId).filter(Boolean))])}
            >
              <span className="mono small muted">{f.id}</span>
              <span className="rollup-name">
                <span className="rollup-caret">{on ? '▾' : '▸'}</span> {f.name}
              </span>
              <span className="rollup-badges">{f.acs.length > 0 && <Badge kind={fail ? 'fail' : pass === f.acs.length ? 'pass' : ''}>{`${pass}/${f.acs.length}`}</Badge>}</span>
            </div>
            {!on && uses.length > 0 && (
              <div className="rollup-uses small muted">
                {uses.map((u) => (
                  <span key={u.id}>→ {u.label}</span>
                ))}
              </div>
            )}
            {on && (
              <div className="rollup-detail small">
                {f.purpose && <p className="rollup-purpose">{f.purpose}</p>}
                <div className="rollup-sec">수용 기준</div>
                {f.acs.length === 0 && <div className="muted">없음</div>}
                {f.acs.map((a) => {
                  const s = st[a.id] ?? 'none'
                  return (
                    <div key={a.id} className="rollup-ac">
                      <span className="mono muted">AC{a.num}</span>
                      <span>{a.text}</span>
                      <Badge kind={s}>{AC_LABEL[s]}</Badge>
                    </div>
                  )
                })}
                {uses.length > 0 && (
                  <>
                    <div className="rollup-sec">쓰는 규칙</div>
                    {uses.map((u) => (
                      <div key={u.id} className="rollup-rule">
                        <button className="link" onClick={() => u.domainId && onOpen(u.domainId)}>
                          {u.label}
                        </button>
                        {u.text && <div className="muted">{u.text}</div>}
                      </div>
                    ))}
                  </>
                )}
                <div className="muted rollup-meta">
                  {f.status} · <span className="mono">{f.id}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      <button className="link small" onClick={() => onOpen(domainId)}>
        {spec.role === 'rule' ? '규칙 명세' : '기능 명세'} 열기
      </button>
    </div>
  )
}
