import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { newProject, tempDir } from './helpers'
import { listPipelines, savePipeline, reorderPipeline, deletePipeline } from '../src/core/pipelineStore'
import { listSkills, saveSkill, skillId } from '../src/core/skills'
import { readMd, writeMd } from '../src/core/md'
import { createApi } from '../src/main/api'

describe('자동화 라이브러리 저장', () => {
  it('작업 그래프와 함수의 순서를 독립적으로 저장하고 본문 저장·추가·삭제 뒤에도 유지한다', async () => {
    const ctx = await newProject()
    const saved = []
    for (const id of ['g1', 'g2', 'g3', 'f1', 'f2']) saved.push(await savePipeline(ctx, { id, title: id, template: id.startsWith('f'), nodes: [], edges: [] }))
    const original = await fs.readFile(saved[0].file, 'utf8')
    await reorderPipeline(ctx, 'g3', 'g1', 'before')
    await reorderPipeline(ctx, 'f2', 'f1', 'before')
    const groups = (await listPipelines(ctx))
    expect(groups.filter((p) => !p.template).map((p) => p.id)).toEqual(['g3', 'g1', 'g2'])
    expect(groups.filter((p) => p.template).map((p) => p.id)).toEqual(['f2', 'f1'])
    expect(await fs.readFile(saved[0].file, 'utf8')).toBe(original)
    await savePipeline(ctx, { ...saved[0], title: '편집한 그래프' })
    await savePipeline(ctx, { id: 'g4', title: '새 그래프', nodes: [], edges: [] })
    await deletePipeline(ctx, 'g2')
    await reorderPipeline(ctx, 'g3', 'g1', 'after')
    expect((await listPipelines(ctx)).filter((p) => !p.template).map((p) => p.title)).toEqual(['편집한 그래프', 'g3', '새 그래프'])
    await expect(reorderPipeline(ctx, 'g1', 'f1', 'before')).rejects.toThrow('각 목록')
    await expect(reorderPipeline(ctx, 'missing', 'g1', 'before')).rejects.toThrow('찾을 수 없습니다')
    expect(await listPipelines(await newProject())).toEqual([])
  })

  it('프로젝트·내 스킬을 만들고 수정해도 노드 ID와 기존 frontmatter를 보존한다', async () => {
    const project = await tempDir('orbit-skill-project-'), home = await tempDir('orbit-skill-home-')
    const input = { name: 'review-spec', description: '기능 검증', body: '# 검증\n\n- [ ] 명세 확인\n\n```txt\n원문\n```', scope: 'project' as const }
    const skill = await saveSkill(project, input, home)
    const userSkill = await saveSkill(project, { ...input, scope: 'user' }, home)
    expect(skillId(skill)).toBe('project:review-spec')
    expect(skillId(userSkill)).toBe('user:review-spec')
    expect((await listSkills(project, home)).map((s) => s.body)).toEqual([input.body, input.body])
    const raw = await readMd(skill.file)
    await writeMd(skill.file, { ...raw.data, 'allowed-tools': ['Read'], custom: { keep: true } }, raw.content)
    const edited = await saveSkill(project, { ...input, id: skillId(skill), description: '수정한 설명', body: '# 새 본문\n\n두 줄\n줄바꿈' }, home)
    expect(edited.file).toBe(skill.file)
    expect((await readMd(skill.file)).data).toMatchObject({ name: input.name, description: '수정한 설명', 'allowed-tools': ['Read'], custom: { keep: true } })
    expect((await listSkills(project, home)).find((s) => s.scope === 'project')?.body).toBe(edited.body)
    await expect(saveSkill(project, input, home)).rejects.toThrow('이미 있습니다')
    await expect(saveSkill(project, { ...input, name: '../outside' }, home)).rejects.toThrow('스킬 이름')
    await expect(saveSkill(project, { ...input, name: 'nul' }, home)).rejects.toThrow('스킬 이름')
    await expect(saveSkill(project, { ...input, id: skillId(skill), name: 'renamed' }, home)).rejects.toThrow('이름과 위치')
    await expect(saveSkill(project, { ...input, name: 'empty', body: '  ' }, home)).rejects.toThrow('본문')
  })

  it('작성한 스킬을 노드로 불러 String 값으로 Print에 전달하고 수정·재열기 후 최신 본문을 사용한다', async () => {
    const dir = await tempDir('orbit-skill-graph-')
    const deps = { send() {}, pickFolder: async () => null, recentFile: path.join(dir, 'recent.json'), onProjectOpened() {} }
    const api = createApi(deps), project = await api.createProject(path.join(dir, 'project'))
    const skill = await api.saveSkill({ scope: 'project', name: 'inspect-feature', description: '기능 검사', body: '# 기준\n\n- [ ] 입력 확인' })
    const graph = await api.savePipeline({ title: '스킬 본문 출력', nodes: [
      { id: 'start', kind: 'start', terminal: 'new', text: '' },
      { id: 'skill', kind: 'skill', ref: skill.id, terminal: 'new', text: '' },
      { id: 'print', kind: 'print', terminal: 'new', text: '' }
    ], edges: [{ from: 'start', to: 'print' }, { from: 'skill', to: 'print' }] })
    try {
      expect((await api.listSkills()).find((s) => s.id === skill.id)?.body).toBe(skill.body)
      const first = await api.runPipeline(graph.id)
      expect(first.status).toBe('done'); expect(first.nodes.print.output).toBe(skill.body)
      const edited = await api.saveSkill({ ...skill, body: '# 수정한 기준\n\n엔터\n줄바꿈' })
      api.closeProject()
      await api.openProject(project.projectDir)
      const next = await api.runPipeline(graph.id)
      expect(next.status).toBe('done'); expect(next.nodes.print.output).toBe(edited.body)
      expect((await api.pipelineExecution(first.runId)).options.snapshot?.env.skills?.[0].body).toBe(skill.body)
    } finally { api.closeProject() }
  })
})
