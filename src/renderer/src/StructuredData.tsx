import { FIELD_TYPE_NAME, FIELD_TYPES, jsonType, type FieldType, type JsonValue, type OutputField, type OutputType } from '../../core/structuredData'

export const defaultOutputFields = (): OutputField[] => [{ name: 'result', type: 'string', description: '' }]
const changeType = (value: OutputType | undefined, type: FieldType): OutputType => ({ type, description: value?.description ?? '',
  ...(type === 'object' ? { fields: value?.fields ?? [] } : {}),
  ...(type === 'array' ? { items: value?.items ?? { type: 'string', description: '' } } : {}) })

function TypeSelect({ value, label, disabled, onChange }: { value?: FieldType; label: string; disabled: boolean; onChange: (value: FieldType) => void }) {
  return <select aria-label={`${label} Type`} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value as FieldType)}>
    {!value && <option value="">Any</option>}
    {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_NAME[type]}</option>)}
  </select>
}

function TypeDetails({ value, path, disabled, onChange }: { value: OutputType; path: string; disabled: boolean; onChange: (value: OutputType) => void }) {
  return <>
    <textarea aria-label={`${path} Description`} rows={2} placeholder="Description — expected value and formatting rules" value={value.description} disabled={disabled} onChange={(event) => onChange({ ...value, description: event.target.value })} />
    {value.type === 'object' && <fieldset className="pipe-output-nested">
      <legend>Properties</legend>
      {!value.fields?.length && <p className="small muted">Any properties are allowed until fields are added.</p>}
      <OutputFields fields={value.fields ?? []} path={path} disabled={disabled} onChange={(fields) => onChange({ ...value, fields })} />
    </fieldset>}
    {value.type === 'array' && <fieldset className="pipe-output-nested">
      <legend>Items</legend>
      <div className="row"><label className="small">Type</label><TypeSelect label={`${path}[]`} value={value.items?.type} disabled={disabled} onChange={(type) => onChange({ ...value, items: changeType(value.items, type) })} /></div>
      {value.items && <TypeDetails value={value.items} path={`${path}[]`} disabled={disabled} onChange={(items) => onChange({ ...value, items })} />}
    </fieldset>}
  </>
}

export function OutputFields({ fields, disabled, onChange, path = '' }: { fields: OutputField[]; disabled: boolean; onChange: (fields: OutputField[]) => void; path?: string }) {
  const patch = (index: number, value: Partial<OutputField>) => onChange(fields.map((field, i) => i === index ? { ...field, ...value } : field))
  return <div className="pipe-output-fields">
    {!path && <div className="small muted">Field name, Type, Description. All defined properties are required.</div>}
    {fields.map((field, index) => {
      const fieldPath = [path, field.name || 'Field'].filter(Boolean).join('.')
      return <div className="pipe-output-field" key={index}>
      <div className="row">
        <input aria-label={path ? `${path} Field name` : 'Field name'} placeholder="Field name" value={field.name} disabled={disabled} onChange={(e) => patch(index, { name: e.target.value })} />
        <TypeSelect label={fieldPath} value={field.type} disabled={disabled} onChange={(type) => onChange(fields.map((current, i) => i === index ? { name: current.name, ...changeType(current, type) } : current))} />
        <button className="ghost" title={`Delete ${fieldPath}`} disabled={disabled} onClick={() => onChange(fields.filter((_, i) => i !== index))}>×</button>
      </div>
      <TypeDetails value={field} path={fieldPath} disabled={disabled} onChange={(value) => onChange(fields.map((current, i) => i === index ? { name: current.name, ...value } : current))} />
    </div>})}
    <button aria-label={path ? `Add property to ${path}` : 'Add output field'} disabled={disabled} onClick={() => onChange([...fields, { name: '', type: 'string', description: '' }])}>+ Add field</button>
  </div>
}

/** 중첩 Dictionary·배열을 펼치고 각 경로를 연결된 데이터 노드로 꺼낸다. */
export function JsonTree({ value, disabled, onExtract, path = [] }: { value: JsonValue; disabled: boolean; onExtract?: (path: string[]) => void; path?: string[] }) {
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
          {onExtract && <button className="ghost" title={`${childPath.join(' / ')}을 데이터 노드로 꺼내기`} disabled={disabled} onClick={() => onExtract(childPath)}>꺼내기</button>}
        </div>
        {composite ? <details open={path.length < 1}>
          <summary className="small muted">{Array.isArray(child) ? `${child.length}개 항목` : `${Object.keys(child).length}개 필드`}</summary>
          <JsonTree value={child} disabled={disabled} onExtract={onExtract} path={childPath} />
        </details> : <JsonTree value={child} disabled={disabled} onExtract={onExtract} path={childPath} />}
      </div>
    })}
  </div>
}
