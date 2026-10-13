import { useId, useMemo } from 'react'
import { readChecklist, type ChecklistItem } from './checklistMarkdown'

export function TaskChecklist({
  body,
  onToggle,
  disabled = false,
  collapsible = false
}: {
  body: string
  onToggle: (item: ChecklistItem, checked: boolean) => void
  disabled?: boolean
  collapsible?: boolean
}) {
  const id = useId()
  const items = useMemo(() => readChecklist(body), [body])
  if (!items.length) return null
  const done = items.filter((item) => item.checked).length
  const heading = <span>완료 조건 <span className={`checklist-count ${done === items.length ? 'complete' : ''}`}>{done}/{items.length}</span></span>
  const list = (
    <ul className="task-checklist-items" aria-label="완료 조건" aria-busy={disabled}>
      {items.map((item, index) => (
        <li key={item.offset} className={item.checked ? 'checked' : ''}>
          <input
            id={`${id}-${item.offset}`}
            type="checkbox"
            checked={item.checked}
            disabled={disabled}
            onChange={(event) => onToggle(item, event.target.checked)}
          />
          <label htmlFor={`${id}-${item.offset}`}>{item.text || `완료 조건 ${index + 1}`}</label>
        </li>
      ))}
    </ul>
  )
  return collapsible ? (
    <details className="task-checklist compact" onPointerDown={(event) => event.stopPropagation()}>
      <summary>{heading}</summary>
      {list}
    </details>
  ) : (
    <section className="task-checklist">
      <div className="checklist-heading">{heading}</div>
      {list}
    </section>
  )
}
