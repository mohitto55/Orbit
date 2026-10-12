import type { AcStatus, Domain, Spec } from '../types'
import { Badge, Empty } from '../ui'
import { domainLabel } from './Domains'

/**
 * 기능 모아보기: 상위 도메인을 고르면 그 도메인과 모든 하위 도메인의 기능을 한곳에 모아 보여준다.
 * 요구사항(사용자 기능)은 위에서 한눈에 보고, 각 기능의 규칙·AC는 그 기능이 있는 도메인에서 관리한다.
 */
export default function FeatureRollup({ rootId, domains, specs, statuses, compact, onOpen }: { rootId: string; domains: Domain[]; specs: Spec[]; statuses: Record<string, Record<string, AcStatus>>; compact?: boolean; onOpen: (domainId: string) => void }) {
  const order: string[] = []
  const walk = (id: string) => {
    order.push(id)
    domains
      .filter((d) => d.parent === id)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title, 'ko'))
      .forEach((d) => walk(d.id))
  }
  walk(rootId)
  const groups = order
    .map((id) => ({ d: domains.find((x) => x.id === id)!, spec: specs.find((s) => s.domainId === id) }))
    .filter((g) => g.d && g.spec && g.spec.features.some((f) => f.status !== '폐기'))
  const total = groups.reduce((n, g) => n + g.spec!.features.filter((f) => f.status !== '폐기').length, 0)
  if (total === 0) return <Empty>이 도메인과 하위 도메인에 기능이 없습니다</Empty>
  const root = domains.find((d) => d.id === rootId)

  return (
    <div className={`rollup ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="muted small">
          {root?.title}
          {order.length > 1 ? `과 하위 도메인 ${order.length - 1}개` : ''}의 기능 {total}개
        </div>
      )}
      {groups.map(({ d, spec }) => (
        <div key={d.id} className="rollup-group">
          <button className="link rollup-head" onClick={() => onOpen(d.id)}>
            {d.id === rootId ? d.title : domainLabel(domains, d.id).split(' › ').slice(domainLabel(domains, rootId).split(' › ').length).join(' › ')}
            <span className="muted small"> · {spec!.features.filter((f) => f.status !== '폐기').length}</span>
          </button>
          {spec!.features
            .filter((f) => f.status !== '폐기')
            .map((f) => {
              const st = statuses[spec!.id] ?? {}
              const pass = f.acs.filter((a) => st[a.id] === 'pass').length
              const fail = f.acs.some((a) => st[a.id] === 'fail')
              return (
                <div key={f.id} className="rollup-row" title={f.purpose}>
                  <span className="mono small muted">{f.id}</span>
                  <span className="rollup-name">{f.name}</span>
                  {!compact && <span className="muted small rollup-purpose">{f.purpose}</span>}
                  <span className="rollup-badges">
                    {f.acs.length > 0 && <Badge kind={fail ? 'fail' : pass === f.acs.length ? 'pass' : ''}>{`${pass}/${f.acs.length}`}</Badge>}
                    {f.status === '초안' && !compact && <Badge>초안</Badge>}
                  </span>
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}
