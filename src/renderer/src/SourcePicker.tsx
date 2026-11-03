import { useState } from 'react'

export function matchesSearch(query: string, ...values: string[]): boolean {
  const text = values.join(' ').normalize('NFKC').toLocaleLowerCase()
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).every((word) => text.includes(word))
}

export interface SourceOption { id: string; title: string; detail?: string; search?: string }

/** 검색 결과가 바뀌어도 선택을 유지한다. 값은 그래프 입력과 같은 줄바꿈으로 구분한 ID. */
export function SourcePicker({ id, label, options, value, multiple = false, disabled = false, onChange }: {
  id?: string; label: string; options: SourceOption[]; value: string; multiple?: boolean; disabled?: boolean; onChange: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const selected = value.split('\n').filter(Boolean)
  const shown = options.filter((o) => matchesSearch(query, o.id, o.title, o.detail ?? '', o.search ?? ''))
  const labelOf = (o: SourceOption) => `${o.title} · ${o.detail ?? o.id}`
  return <div className="source-picker" role="group" aria-label={`${label} 선택 영역`}>
    <input id={multiple ? id : undefined} type="search" aria-label={`${label} 검색`} placeholder="이름·ID로 검색" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
    {multiple ? <>
      {selected.length > 0 && <div className="source-selected" aria-label="선택한 항목">{selected.map((key) => <button type="button" className="small" key={key} disabled={disabled} onClick={() => onChange(selected.filter((s) => s !== key).join('\n'))} aria-label={`${options.find((o) => o.id === key)?.title ?? key} 선택 해제`}>{options.find((o) => o.id === key)?.title ?? `${key} (선택 불가)`} ×</button>)}</div>}
      <div className="source-options">{shown.map((o) => <label key={o.id}><input type="checkbox" disabled={disabled} checked={selected.includes(o.id)} onChange={(e) => onChange((e.target.checked ? [...selected, o.id] : selected.filter((s) => s !== o.id)).join('\n'))} /><span>{o.title}<small>{o.detail ?? o.id}</small></span></label>)}</div>
    </> : <select id={id} aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} size={query.trim() ? Math.min(6, Math.max(2, shown.length + 1)) : undefined}>
      <option value="">원본을 고르세요</option>
      {value && !options.some((o) => o.id === value) && <option value={value} disabled>{value} · 선택할 수 없는 항목, 다시 선택하세요</option>}
      {value && options.some((o) => o.id === value) && !shown.some((o) => o.id === value) && <optgroup label="현재 선택"><option value={value}>{labelOf(options.find((o) => o.id === value)!)}</option></optgroup>}
      {shown.map((o) => <option key={o.id} value={o.id}>{labelOf(o)}</option>)}
    </select>}
    <span className="small muted" role="status">{shown.length ? `검색 결과 ${shown.length}개` : '검색 결과가 없습니다'}{multiple ? ` · 선택 ${selected.length}개` : ''}</span>
  </div>
}
