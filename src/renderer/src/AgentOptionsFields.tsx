import { useEffect, useId, useState } from 'react'
import { api } from './api'
import { effortChoices, type AgentEffort, type AgentOptions } from '../../core/agentModel'

export function AgentOptionsFields({ kind, value, disabled, showEffort = true, onChange }: {
  kind: 'claude' | 'codex'; value: AgentOptions; disabled: boolean; showEffort?: boolean; onChange: (patch: AgentOptions) => void
}) {
  const id = useId(), [models, setModels] = useState<Awaited<ReturnType<typeof api.agentModels>>>([])
  useEffect(() => {
    let live = true
    setModels([])
    api.agentModels(kind).then((list) => { if (live) setModels(list) }).catch(() => {})
    return () => { live = false }
  }, [kind])
  const efforts = models.find((model) => model.id === value.model)?.efforts ?? effortChoices(kind)
  return <>
    <div className="field">
      <label htmlFor={`${id}-model`}>Model</label>
      <input id={`${id}-model`} aria-label="Model" list={`${id}-models`} value={value.model ?? ''} disabled={disabled} placeholder="기존 세션 / CLI 기본값" onChange={(e) => onChange({ model: e.target.value || undefined })} />
      <datalist id={`${id}-models`}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    </div>
    {showEffort && <div className="field">
      <label htmlFor={`${id}-effort`}>Effort</label>
      <select id={`${id}-effort`} aria-label="Effort" disabled={disabled} value={value.effort ?? ''} onChange={(e) => onChange({ effort: e.target.value as AgentEffort || undefined })}>
        <option value="">기존 세션 / CLI 기본값</option>
        {value.effort && !efforts.includes(value.effort) && <option value={value.effort} disabled>{value.effort} · 이 모델에서 지원하지 않음</option>}
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
    </div>}
    <div className="small muted">Model ID를 선택하거나 직접 입력할 수 있습니다. 비우면 세션·CLI 설정을 사용합니다. 변경하면 같은 탭에서 대화를 이어서 적용합니다.</div>
  </>
}
