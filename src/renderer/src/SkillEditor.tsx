import { useRef, useState } from 'react'
import { api } from './api'
import { RunDrawer } from './Automation'
import { MdEditor } from './Markdown'
import { toast } from './ui'

type Skill = Awaited<ReturnType<typeof api.listSkills>>[number]

export function SkillEditor({ skill, canAdd, onClose, onSaved }: { skill?: Skill; canAdd: boolean; onClose: () => void; onSaved: (skill: Skill, addNode: boolean) => void }) {
  const [name, setName] = useState(skill?.name ?? '')
  const [scope, setScope] = useState<Skill['scope']>(skill?.scope ?? 'project')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [body, setBody] = useState(skill?.body ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const saving = useRef(false)
  const dirty = name !== (skill?.name ?? '') || scope !== (skill?.scope ?? 'project') || description !== (skill?.description ?? '') || body !== (skill?.body ?? '')
  const close = () => { if (!saving.current && (!dirty || confirm('저장하지 않은 스킬 편집을 닫을까요?'))) onClose() }
  const save = async (addNode: boolean) => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await api.saveSkill({ id: skill?.id, scope, name, description, body })
      toast('스킬을 저장했습니다')
      onSaved(result, addNode)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { saving.current = false; setBusy(false) }
  }
  return <RunDrawer title={skill ? '스킬 편집' : '새 스킬'} onClose={close}>
    <p className="small muted">본문을 Markdown으로 작성하세요. 스킬 노드의 String 출력으로 본문을 전달할 수 있습니다.</p>
    <div className="field"><label htmlFor="skill-name">스킬 이름</label><input id="skill-name" value={name} disabled={busy || !!skill} placeholder="review-feature" onChange={(e) => setName(e.target.value)} />
      <span className="small muted">{skill ? '기존 노드와의 연결을 유지하기 위해 이름은 고정됩니다.' : '영문 소문자·숫자·하이픈, 최대 64자'}</span>
    </div>
    <div className="field"><label htmlFor="skill-scope">사용 범위</label><select id="skill-scope" value={scope} disabled={busy || !!skill} onChange={(e) => setScope(e.target.value as Skill['scope'])}><option value="project">이 프로젝트</option><option value="user">모든 프로젝트 · 내 스킬</option></select></div>
    <div className="field"><label htmlFor="skill-description">설명</label><input id="skill-description" value={description} disabled={busy} placeholder="언제 사용하는 스킬인지 적어 주세요" onChange={(e) => setDescription(e.target.value)} /></div>
    <fieldset className="skill-body" disabled={busy}><MdEditor value={body} onChange={setBody} label="스킬 본문" /></fieldset>
    {error && <p role="alert" className="pipe-value-error">{error}</p>}
    <footer className="row between"><button disabled={busy} onClick={close}>취소</button><div className="row">
      <button disabled={busy || !name.trim() || !body.trim()} className={canAdd ? '' : 'primary'} onClick={() => void save(false)}>{busy ? '저장 중…' : '저장'}</button>
      {canAdd && <button className="primary" disabled={busy || !name.trim() || !body.trim()} onClick={() => void save(true)}>저장하고 노드 추가</button>}
    </div></footer>
  </RunDrawer>
}
