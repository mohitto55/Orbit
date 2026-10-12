import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Design } from '../types'
import { Badge, Empty, askChange, errorToast, toast, useLoad } from '../ui'
import { History } from './Domains'

type DesignWithStale = Design & { stale: { id: string; summary: string; target: string }[] }

export default function DesignPanel({ folder, system, refreshKey, onChanged }: { folder?: string; system?: boolean; refreshKey: number; onChanged: () => void }) {
  const [designs, reload] = useLoad(() => api.listDesigns() as Promise<DesignWithStale[]>, [refreshKey])
  const list = (designs ?? []).filter((d) => (system ? d.system : d.folder === folder))
  const [selected, setSelected] = useState<string | null>(null)
  const design = list.find((d) => d.id === selected) ?? list[0]

  if (!designs) return null
  if (system && list.length === 0) {
    return (
      <Empty>
        시스템 공통 설계가 없습니다.{' '}
        <button
          className="primary"
          onClick={async () => {
            await api.createSystemDesign().catch(errorToast)
            reload()
          }}
        >
          만들기
        </button>
      </Empty>
    )
  }
  if (list.length === 0) return <Empty>설계가 없습니다. 기능 명세 표의 행에서 "+ 설계"로 만드세요 (필요한 기능만).</Empty>

  return (
    <div className="split inner">
      {!system && (
        <div className="pane-list narrow">
          {list.map((d) => (
            <button key={d.id} className={`tree-item ${design?.id === d.id ? 'on' : ''}`} onClick={() => setSelected(d.id)}>
              {d.title} {d.stale.length > 0 && <Badge kind="fail">낡음</Badge>}
            </button>
          ))}
        </div>
      )}
      {design && <DesignEditor key={design.id + design.version} design={design} onSaved={() => { reload(); onChanged() }} />}
    </div>
  )
}

function DesignEditor({ design, onSaved }: { design: DesignWithStale; onSaved: () => void }) {
  const [content, setContent] = useState(design.content)
  const [history, setHistory] = useState(false)
  useEffect(() => setContent(design.content), [design.content])
  const sections = [...design.content.matchAll(/\{#([a-z0-9-]+)\}/g)].map((m) => m[1])

  const save = async () => {
    const change = await askChange(`${design.title} 저장`)
    if (!change) return
    let changed: string[] = []
    if (design.system && change.size === 'major' && sections.length) {
      const s = prompt(`바뀐 섹션 id (쉼표 구분, 비우면 전체): ${sections.join(', ')}`, '')
      if (s === null) return
      changed = s.split(',').map((x) => x.trim()).filter(Boolean)
    }
    try {
      const r = await api.saveDesign(design.id, content, change, changed)
      toast(r.review ? `저장했습니다. 확인표시 ${r.review.items.length}개가 생겼습니다` : `저장했습니다 (v${r.design.version})`)
      onSaved()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="editor grow">
      <div className="row between">
        <div className="muted small">
          {design.id} · v{design.version}
          {design.basedOn.length > 0 && ` · 기준: ${design.basedOn.map((b) => `${b.feature} (${b.ref} v${b.version})`).join(', ')}`}
          {design.refs.length > 0 && ` · 참조: ${design.refs.map((r) => r.section).join(', ')}`}
        </div>
        <button className="small ghost" onClick={() => setHistory((h) => !h)}>
          {history ? '편집' : '변경 이력'}
        </button>
      </div>
      {design.stale.length > 0 && (
        <div className="banner warn">
          <div>
            <b>낡음</b>: 기준 기능 또는 참조한 공통 설계에 큰 변경이 있었습니다. 확인 필요 화면에서 처리하세요.
            <ul>
              {design.stale.map((c) => (
                <li key={c.id}>
                  {c.target}: {c.summary}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {history ? (
        <History target={design.id} />
      ) : (
        <>
          <textarea className="mono grow" value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row end">
            <button className="primary" disabled={content === design.content} onClick={save}>
              저장
            </button>
          </div>
        </>
      )}
    </div>
  )
}
