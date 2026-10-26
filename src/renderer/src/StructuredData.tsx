import { FIELD_TYPE_NAME, FIELD_TYPES, jsonType, type FieldType, type JsonValue, type OutputField } from '../../core/structuredData'

export const defaultOutputFields = (): OutputField[] => [{ name: 'people', type: 'string', description: '' }]

export function OutputFields({ fields, disabled, onChange }: { fields: OutputField[]; disabled: boolean; onChange: (fields: OutputField[]) => void }) {
  const patch = (index: number, value: Partial<OutputField>) => onChange(fields.map((field, i) => i === index ? { ...field, ...value } : field))
  return <div className="pipe-output-fields">
    <div className="small muted">필드 이름·타입·작성 규칙을 정하세요. 모든 필드는 필수입니다.</div>
    {fields.map((field, index) => <div className="pipe-output-field" key={index}>
      <div className="row">
        <input aria-label="출력 필드 이름" placeholder="예: people" value={field.name} disabled={disabled} onChange={(e) => patch(index, { name: e.target.value })} />
        <select aria-label={`${field.name || '출력 필드'} 타입`} value={field.type} disabled={disabled} onChange={(e) => patch(index, { type: e.target.value as FieldType })}>
          {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_NAME[type]}</option>)}
        </select>
        <button className="ghost" title={`${field.name || '출력 필드'} 삭제`} disabled={disabled} onClick={() => onChange(fields.filter((_, i) => i !== index))}>×</button>
      </div>
      <textarea aria-label={`${field.name || '출력 필드'} 작성 규칙`} rows={2} placeholder="예: 사람 이름을 쉼표로 구분하세요. 없으면 빈 문자열을 쓰세요." value={field.description} disabled={disabled} onChange={(e) => patch(index, { description: e.target.value })} />
    </div>)}
    <button disabled={disabled} onClick={() => onChange([...fields, { name: '', type: 'string', description: '' }])}>+ 출력 필드</button>
  </div>
}

/** 중첩 Dictionary·배열을 펼치고 각 경로를 연결된 데이터 노드로 꺼낸다. */
export function JsonTree({ value, disabled, onExtract, path = [] }: { value: JsonValue; disabled: boolean; onExtract: (path: string[]) => void; path?: string[] }) {
  if (value === null || typeof value !== 'object') return <code className="pipe-json-scalar">{JSON.stringify(value)}</code>
  const entries = Object.entries(value)
  if (!entries.length) return <code>{Array.isArray(value) ? '[]' : '{}'}</code>
  return <div className="pipe-json-tree">
    {entries.map(([key, child]) => {
      const childPath = [...path, key]
      const composite = child !== null && typeof child === 'object'
      const heading = <><b>{key}</b><span className="small muted">{FIELD_TYPE_NAME[jsonType(child)]}</span></>
      return <div className="pipe-json-entry" key={key}>
        <div className="row">
          {heading}
          <button className="ghost" title={`${childPath.join(' / ')}을 데이터 노드로 꺼내기`} disabled={disabled} onClick={() => onExtract(childPath)}>꺼내기</button>
        </div>
        {composite ? <details open={path.length < 1}>
          <summary className="small muted">{Array.isArray(child) ? `${child.length}개 항목` : `${Object.keys(child).length}개 필드`}</summary>
          <JsonTree value={child} disabled={disabled} onExtract={onExtract} path={childPath} />
        </details> : <JsonTree value={child} disabled={disabled} onExtract={onExtract} path={childPath} />}
      </div>
    })}
  </div>
}
