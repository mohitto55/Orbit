import { useState } from 'react'
import { api } from '../api'
import { Empty, useLoad } from '../ui'

/** GitHub식 줄 단위 비교: 줄 번호, 추가(+)·삭제(-) 색, 바뀌지 않은 부분 접기. */
export default function DiffView({ changeId }: { changeId: string }) {
  const [full, setFull] = useState(false)
  const [data] = useLoad(() => api.changeDiff(changeId, full), [changeId, full])
  if (!data) return null
  if ('unavailable' in data) return <Empty>비교할 수 없습니다: {data.unavailable}</Empty>
  const { diff } = data
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="mono">{data.file}</span>
        <span className="diff-stat">
          <span className="plus">+{diff.added}</span> <span className="minus">−{diff.removed}</span>
        </span>
        <span className="muted small">{data.source === 'git' ? 'git 이력에서 가져옴' : '저장 시 스냅샷'}</span>
        <span className="grow" />
        <div className="seg small">
          <button className={!full ? 'on' : ''} onClick={() => setFull(false)}>
            바뀐 곳만
          </button>
          <button className={full ? 'on' : ''} onClick={() => setFull(true)}>
            전체
          </button>
        </div>
      </div>
      {diff.added + diff.removed === 0 ? (
        <Empty>내용 차이가 없습니다</Empty>
      ) : (
        <table className="diff-table">
          <tbody>
            {diff.hunks.map((h, i) => [
              h.skippedBefore > 0 && (
                <tr key={`s${i}`} className="diff-skip">
                  <td colSpan={4} onClick={() => setFull(true)} title="전체 보기">
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
                <td colSpan={4} onClick={() => setFull(true)} title="전체 보기">
                  ⋯ 같은 내용 {diff.skippedAfter}줄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
