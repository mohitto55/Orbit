import { useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { HarnessTarget } from '../types'
import { Empty, errorToast, toast, useLoad } from '../ui'
import { MdViewer } from '../Markdown'

export default function Harness({ refreshKey }: PageProps) {
  const [target, setTarget] = useState<HarnessTarget>('claude')
  const [status, reloadStatus] = useLoad(() => api.harnessStatus(target), [target, refreshKey])
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewHarness>> | null>(null)

  const load = async () => {
    try {
      setPreview(await api.previewHarness(target))
    } catch (e) {
      errorToast(e)
    }
  }
  const write = async () => {
    try {
      const p = await api.writeHarness(target)
      toast(`${p.file}에 썼습니다`)
      setPreview(null)
      reloadStatus()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="page">
      <h2>에이전트 지침</h2>
      <div className="row">
        <div className="seg">
          <button className={target === 'claude' ? 'on' : ''} onClick={() => { setTarget('claude'); setPreview(null) }}>
            Claude Code (CLAUDE.md)
          </button>
          <button className={target === 'codex' ? 'on' : ''} onClick={() => { setTarget('codex'); setPreview(null) }}>
            Codex (AGENTS.md)
          </button>
        </div>
        <button className="primary" onClick={load}>
          생성 미리보기
        </button>
      </div>
      {status && (
        <div className={`banner ${status.changed.length ? 'warn' : ''}`}>
          {status.generatedAt ? (
            status.changed.length ? (
              <div>
                <b>낡음</b>: {new Date(status.generatedAt).toLocaleString()} 생성 이후 바뀐 원본 {status.changed.length}개 — {status.changed.join(', ')}
              </div>
            ) : (
              <div>최신 상태입니다 ({new Date(status.generatedAt).toLocaleString()} 생성)</div>
            )
          ) : (
            <div>아직 생성하지 않았습니다</div>
          )}
        </div>
      )}
      {preview ? (
        <>
          <p className="muted small">
            {preview.file} — 앱은 <code>girsktop:start</code> ~ <code>girsktop:end</code> 표식 사이만 바꿉니다. 표식 밖 내용은 그대로입니다.
          </p>
          <div className="compare">
            <div>
              <h4>현재</h4>
              <MdViewer source={preview.before || '(파일 없음)'} />
            </div>
            <div>
              <h4>생성 후</h4>
              <MdViewer source={preview.after} />
            </div>
          </div>
          <div className="row end">
            <button onClick={() => setPreview(null)}>취소</button>
            <button className="primary" disabled={preview.before === preview.after} onClick={write}>
              확인하고 쓰기
            </button>
          </div>
        </>
      ) : (
        <Empty>미리보기로 생성될 내용을 확인한 뒤에만 파일을 씁니다.</Empty>
      )}
    </div>
  )
}
