import { useState } from 'react'
import { api } from '../api'
import { Empty, useLoad } from '../ui'
import type { LineDiff } from '../../../core/diff'
import { SpecDiff } from '../SpecDiff'

/** 명세는 기능·AC별로, 일반 문서는 줄 단위로 비교한다. */
export default function DiffView({ changeId }: { changeId: string }) {
  const [full, setFull] = useState(false)
  const [raw, setRaw] = useState(false)
  const [data] = useLoad(() => api.changeDiff(changeId, full), [changeId, full])
  if (!data) return null
  if ('unavailable' in data) return <Empty>비교할 수 없습니다: {data.unavailable}</Empty>
  const { diff } = data
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="mono">{data.file}</span>
        {(!data.spec || raw) && <span className="diff-stat">
          <span className="plus">+{diff.added}</span> <span className="minus">−{diff.removed}</span>
        </span>}
        <span className="grow" />
        {data.spec && <div className="seg small">
          <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>항목별 비교</button>
          <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>원문 비교</button>
        </div>}
        <div className="seg small">
          <button className={!full ? 'on' : ''} onClick={() => setFull(false)}>
            바뀐 곳만
          </button>
          <button className={full ? 'on' : ''} onClick={() => setFull(true)}>
            전체
          </button>
        </div>
      </div>
      {data.spec && !raw ? <>
        <SpecDiff diff={data.spec} full={full} />
        {!!(data.spec.outside.added + data.spec.outside.removed) && <details className="spec-diff-outside">
          <summary>표 밖의 변경 · 본문·문서 정보 (+{data.spec.outside.added} −{data.spec.outside.removed})</summary>
          <DiffTable diff={data.spec.outside} onExpand={() => { setRaw(true); setFull(true) }} />
        </details>}
      </> : <DiffTable diff={diff} onExpand={() => setFull(true)} />}
    </div>
  )
}

/** 줄 단위 비교 표. onExpand: 접힌 줄을 눌렀을 때 (전체 보기로 바꾸기) */
export function DiffTable({ diff, onExpand }: { diff: LineDiff; onExpand?: () => void }) {
  return (
    diff.added + diff.removed === 0 ? (
      <Empty>내용 차이가 없습니다</Empty>
    ) : (
      <table className="diff-table">
        <tbody>
          {diff.hunks.map((h, i) => [
            h.skippedBefore > 0 && (
              <tr key={`s${i}`} className="diff-skip">
                <td colSpan={4} onClick={onExpand} title="전체 보기">
                  ⋯ 같은 내용 {h.skippedBefore}줄
                </td>
              </tr>
            ),
            ...h.lines.map((l, j) => (
              <tr key={`${i}-${j}`} className={`diff-${l.type}`}>
                <td className="ln">{l.oldNo ?? ''}</td>
                <td className="ln">{l.newNo ?? ''}</td>
                <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                <td className="code">{l.text || ' '}</td>
              </tr>
            ))
          ])}
          {diff.skippedAfter > 0 && (
            <tr className="diff-skip">
              <td colSpan={4} onClick={onExpand} title="전체 보기">
                ⋯ 같은 내용 {diff.skippedAfter}줄
              </td>
            </tr>
          )}
        </tbody>
      </table>
    )
  )
}
