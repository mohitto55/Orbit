import type { SpecDifference, TextDifference } from '../../core/diff'
import { Markdown } from './Markdown'
import { Empty } from './ui'

const LABEL = { added: '추가', removed: '삭제', modified: '수정', same: '유지' }

function TextChange({ item }: { item: TextDifference }) {
  return <section className={`spec-diff-item ${item.kind}`} data-change-id={item.id}>
    <div className="row"><b>{item.label}</b><span className={`spec-diff-tag ${item.kind}`}>{LABEL[item.kind]}</span></div>
    {item.kind === 'modified' ? <div className="spec-diff-pair">
      <div className="spec-diff-before"><span className="small muted">이전</span><Markdown source={item.before ?? ''} /></div>
      <div className="spec-diff-after"><span className="small muted">이후</span><Markdown source={item.after ?? ''} /></div>
    </div> : <Markdown source={item.after ?? item.before ?? ''} />}
  </section>
}

export function SpecDiff({ diff, full }: { diff: SpecDifference; full: boolean }) {
  const changed = diff.features.filter((f) => f.kind !== 'same')
  const acs = diff.features.flatMap((f) => f.acs)
  const counts = (['added', 'modified', 'removed'] as const).map((kind) => ({ kind, count: acs.filter((a) => a.kind === kind).length })).filter((c) => c.count)
  const shown = full ? diff.features : changed
  return <div className="spec-diff">
    <div className="spec-diff-summary" role="status">
      <b>기능 {changed.length}개 변경</b>
      {counts.map(({ kind, count }) => <span key={kind} className={`spec-diff-tag ${kind}`}>수용 기준 {LABEL[kind]} {count}개</span>)}
    </div>
    {diff.order && <div className="spec-diff-order"><b>기능 순서 변경</b><div>이전: {diff.order.before.join(' → ')}</div><div>이후: {diff.order.after.join(' → ')}</div></div>}
    {!shown.length && <Empty>기능·수용 기준 내용 변경이 없습니다</Empty>}
    {shown.map((feature) => {
      const changedAcs = feature.acs.filter((ac) => ac.kind !== 'same'), sameAcs = feature.acs.filter((ac) => ac.kind === 'same')
      return <article key={feature.id} className="spec-diff-feature" data-feature-change={feature.id}>
        <header><span className="mono small">{feature.id}</span><h4>{feature.icon} {feature.name}</h4><span className={`spec-diff-tag ${feature.kind}`}>{LABEL[feature.kind]}</span></header>
        {feature.fields.map((field) => <TextChange key={field.id} item={field} />)}
        {feature.acOrder && <div className="spec-diff-order"><b>수용 기준 순서 변경</b><div>이전: {feature.acOrder.before.map((id) => id.split('-').at(-1)).join(' → ')}</div><div>이후: {feature.acOrder.after.map((id) => id.split('-').at(-1)).join(' → ')}</div></div>}
        {changedAcs.map((ac) => <TextChange key={ac.id} item={ac} />)}
        {!!sameAcs.length && (full ? sameAcs.map((ac) => <TextChange key={ac.id} item={ac} />) : <details className="spec-diff-unchanged"><summary>변경 없는 수용 기준 {sameAcs.length}개</summary>{sameAcs.map((ac) => <TextChange key={ac.id} item={ac} />)}</details>)}
      </article>
    })}
    {!full && diff.features.length > changed.length && <p className="small muted">변경 없는 기능 {diff.features.length - changed.length}개는 전체 보기에서 확인할 수 있습니다.</p>}
  </div>
}
