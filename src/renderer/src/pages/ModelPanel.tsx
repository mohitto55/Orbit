import { api } from '../api'
import type { PageProps } from '../App'
import type { Domain } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { MdContent } from '../Markdown'

/**
 * 도메인 모델 보기: 이 도메인이 소유한 개념의 상태·행위·불변식과 관계, 코드 위치 확인.
 * 업무 분류(도메인 트리)와 별개로, 모델끼리 어떻게 엮이는지를 본다. 표는 역할 탭의 문서에서 고친다.
 */
export default function ModelPanel({ domain, domains, refreshKey, go, onEdit, onSaved }: { domain: Domain; domains: Domain[]; refreshKey: number; go: PageProps['go']; onEdit: () => void; onSaved: () => void }) {
  const [anchors] = useLoad(() => api.checkAnchors(domain.id), [domain.id, domain.version, refreshKey])
  const hasSection = /^## 모델\s*$/m.test(domain.content)

  // 다른 도메인의 개념 중 이 도메인 개념을 가리키는 것 (들어오는 관계)
  const incoming = domains
    .filter((d) => d.id !== domain.id)
    .flatMap((d) =>
      d.model.flatMap((c) =>
        c.relations
          .filter((r) => {
            const [dn, cn] = r.to.includes('/') ? r.to.split('/').map((x) => x.trim()) : [null, r.to]
            return (dn === null || dn === domain.title || dn === domain.id) && domain.model.some((m) => m.name === cn) && (dn !== null || !d.model.some((m) => m.name === cn))
          })
          .map((r) => ({ from: d, concept: c.name, type: r.type, to: r.to.split('/').pop()!.trim() }))
      )
    )

  const addSection = async () => {
    try {
      const content = await api.withModelSection(domain.content)
      await api.saveDomain(domain.id, { content }, { size: 'minor', summary: '모델 표 추가' })
      toast('빈 모델 표를 넣었습니다. 역할 탭의 문서에서 개념을 적으세요')
      onSaved()
    } catch (e) {
      errorToast(e)
    }
  }

  const relTarget = (to: string) => {
    if (!to.includes('/')) return null
    const [dn] = to.split('/').map((x) => x.trim())
    return domains.find((d) => d.title === dn || d.id === dn) ?? null
  }

  return (
    <div className="model-panel">
      <div className="row between">
        <div className="muted small">개념이 가진 상태·행위·불변식과 관계. 응용 서비스의 호출 순서는 여기 적지 않고 설계에 적는다.</div>
        {hasSection ? (
          <button className="small ghost" onClick={onEdit}>
            표 고치기
          </button>
        ) : (
          <button className="small primary" onClick={addSection}>
            모델 표 추가
          </button>
        )}
      </div>
      {domain.model.length === 0 ? (
        <Empty>
          {hasSection ? '모델 표가 비어 있습니다.' : '이 도메인 문서에는 모델 표가 없습니다.'} 표 형식:{' '}
          <code>| 개념 | 종류 | 상태·행위 | 불변식 | 관계 | 코드 |</code> — 관계는 <code>사용 [[개념]]</code>, 다른 도메인이면 <code>[[도메인/개념]]</code>, 코드는 <code>`BaseRoom`</code>
        </Empty>
      ) : (
        <div className="concepts">
          {domain.model.map((c) => {
            const hits = (anchors ?? []).filter((a) => a.concept === c.name)
            return (
              <div key={c.name} className="concept">
                <div className="row between">
                  <b>{c.name}</b>
                  {c.kind && <Badge>{c.kind}</Badge>}
                </div>
                {c.behavior && (
                  <div className="concept-row">
                    <span className="muted small">상태·행위</span>
                    <MdContent source={c.behavior.replace(/<br\s*\/?>/gi, '\n\n')} />
                  </div>
                )}
                {c.invariants && (
                  <div className="concept-row">
                    <span className="muted small">불변식</span>
                    <MdContent source={c.invariants.replace(/<br\s*\/?>/gi, '\n\n')} />
                  </div>
                )}
                {c.relations.length > 0 && (
                  <div className="concept-row">
                    <span className="muted small">관계</span>
                    <div className="chips">
                      {c.relations.map((r, i) => {
                        const other = relTarget(r.to)
                        return other && other.id !== domain.id ? (
                          <button key={i} className="chip small cross" title="다른 도메인의 개념" onClick={() => go('domains', `${other.id}#model`)}>
                            {r.type} → {r.to}
                          </button>
                        ) : (
                          <span key={i} className="chip small">
                            {r.type} → {r.to}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
                {c.code.length > 0 && (
                  <div className="concept-row">
                    <span className="muted small">코드</span>
                    <div className="chips">
                      {c.code.map((code) => {
                        const h = hits.find((x) => x.anchor === code)
                        return (
                          <span key={code} className={`chip small mono ${h ? (h.found ? 'ok' : 'bad') : ''}`} title={h ? (h.found ? h.found : '코드에서 찾지 못했습니다') : '확인 중'}>
                            {h ? (h.found ? '✓' : '✗') : '…'} {code}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {incoming.length > 0 && (
        <div className="group">
          <h4>다른 도메인에서 들어오는 관계</h4>
          <ul className="small">
            {incoming.map((x, i) => (
              <li key={i}>
                <button className="link" onClick={() => go('domains', `${x.from.id}#model`)}>
                  {x.from.title} › {x.concept}
                </button>{' '}
                —{x.type}→ <b>{x.to}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  )
}
