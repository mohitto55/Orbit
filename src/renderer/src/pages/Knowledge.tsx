import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PageProps } from '../App'
import type { Knowledge, KnowledgeType } from '../types'
import { KN_TYPES } from '../types'
import { Badge, Empty, errorToast, toast, useLoad } from '../ui'
import { MdEditor } from '../Markdown'

type Draft = { id?: string; type: KnowledgeType; title: string; content: string; status: Knowledge['status']; harness: boolean; supersedes?: string }

export default function KnowledgePage({ refreshKey }: PageProps) {
  const [items, reload] = useLoad(() => api.listKnowledge(), [refreshKey])
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)

  const list = (items ?? []).filter((k) => (!type || k.type === type) && (!q || (k.title + k.content).includes(q)))
  const save = async () => {
    if (!draft) return
    try {
      const k = await api.saveKnowledge(draft)
      toast('저장했습니다')
      setDraft({ ...draft, id: k.id, supersedes: undefined })
      reload()
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="split">
      <div className="pane-list">
        <div className="row between">
          <h3>지식</h3>
          <button className="small" onClick={() => setDraft({ type: '결정', title: '', content: '', status: '유효', harness: false })}>
            + 새 항목
          </button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색" />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">모든 종류</option>
          {KN_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {list.length === 0 && <Empty>항목이 없습니다</Empty>}
        {list.map((k) => (
          <button
            key={k.id}
            className={`tree-item ${draft?.id === k.id ? 'on' : ''} ${k.status === '폐기됨' ? 'dim' : ''}`}
            onClick={() => setDraft({ id: k.id, type: k.type, title: k.title, content: k.content, status: k.status, harness: k.harness })}
          >
            <Badge>{k.type}</Badge> {k.title} {k.status === '초안' && <Badge kind="review">초안</Badge>}
          </button>
        ))}
      </div>
      <div className="pane-main">
        {draft ? (
          <Editor key={draft.id ?? 'new'} draft={draft} setDraft={setDraft} onSave={save} items={items ?? []} />
        ) : (
          <Empty>항목을 고르거나 새로 만드세요. 한 도메인 안에서만 쓰는 용어는 그 도메인의 domain.md 용어 섹션에 둡니다.</Empty>
        )}
      </div>
    </div>
  )
}

function Editor({ draft, setDraft, onSave, items }: { draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; items: Knowledge[] }) {
  const [local, setLocal] = useState(draft)
  useEffect(() => setLocal(draft), [draft])
  const set = (p: Partial<Draft>) => {
    const next = { ...local, ...p }
    setLocal(next)
    setDraft(next)
  }
  const current = items.find((k) => k.id === draft.id)
  return (
    <div className="editor">
      <div className="grid4">
        <div className="field">
          <label>종류</label>
          <select value={local.type} onChange={(e) => set({ type: e.target.value as KnowledgeType })}>
            {KN_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>상태</label>
          <select value={local.status} onChange={(e) => set({ status: e.target.value as Draft['status'] })}>
            <option>초안</option>
            <option>유효</option>
            <option>폐기됨</option>
          </select>
        </div>
        <div className="field">
          <label>하네스 포함</label>
          <input type="checkbox" checked={local.harness} onChange={(e) => set({ harness: e.target.checked })} />
        </div>
        {local.type === '결정' && !local.id && (
          <div className="field">
            <label>대체할 이전 결정</label>
            <select value={local.supersedes ?? ''} onChange={(e) => set({ supersedes: e.target.value || undefined })}>
              <option value="">(없음)</option>
              {items
                .filter((k) => k.type === '결정' && k.status !== '폐기됨')
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.title}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label>제목</label>
        <input value={local.title} onChange={(e) => set({ title: e.target.value })} />
      </div>
      {current?.supersededBy && <div className="banner">이 결정은 {current.supersededBy}로 대체되었습니다</div>}
      {current?.sources.length ? <div className="small muted">근거: {current.sources.join(', ')}</div> : null}
      <MdEditor label="본문" value={local.content} onChange={(v) => set({ content: v })} />
      <div className="row end">
        <button className="primary" disabled={!local.title.trim()} onClick={onSave}>
          저장
        </button>
      </div>
    </div>
  )
}
