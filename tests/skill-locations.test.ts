import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listSkills, saveSkill, skillId, type SkillInput } from '../src/core/skills'
import { SKILL_LOCATIONS } from '../src/core/skillLocations'
import { tempDir } from './helpers'
import { readMd, writeMd } from '../src/core/md'

const directories: string[] = []
async function fixture() {
  const directory = await tempDir('orbit-skill-locations-')
  directories.push(directory)
  return { project: path.join(directory, 'project'), home: path.join(directory, 'home') }
}
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

it('사용자 Codex 폴더의 backend 스킬 세 개를 빈 Claude 폴더와 관계없이 찾는다', async () => {
  const { project, home } = await fixture()
  const names = ['backend-caching-strategy', 'backend-cdn-cache-busting', 'backend-file-versioning']
  for (const name of names) await writeMd(path.join(home, '.codex/skills', name, 'SKILL.md'), { name, description: `설명: ${name}` }, `# ${name}\n\n본문`)
  const skills = await listSkills(project, home)
  expect(skills.map((s) => s.name)).toEqual(names)
  expect(skills.map(skillId)).toEqual(names.map((name) => `codex:user:${name}`))
  expect(skills.every((s) => s.location === 'codex' && s.scope === 'user' && s.body.endsWith('본문'))).toBe(true)
})

it('세 저장 위치와 두 범위의 동명 스킬을 구분하고 기존 Claude ID를 유지한다', async () => {
  const { project, home } = await fixture()
  for (const scope of ['project', 'user'] as const) for (const location of SKILL_LOCATIONS) {
    await saveSkill(project, { scope, location, name: 'same-name', description: '', body: `${scope}/${location}` }, home)
  }
  const skills = await listSkills(project, home)
  expect(skills.map(skillId)).toEqual(['project:same-name', 'codex:project:same-name', 'agents:project:same-name', 'user:same-name', 'codex:user:same-name', 'agents:user:same-name'])
  expect(new Set(skills.map((s) => s.file)).size).toBe(6)
  for (const skill of skills) {
    const original = await readMd(skill.file)
    await writeMd(skill.file, { ...original.data, custom: { preserve: true } }, original.content)
    // A caller with an existing ID may omit location. It must still save in place.
    const saved = await saveSkill(project, { id: skillId(skill), scope: skill.scope, name: skill.name, description: '수정', body: skill.body + '\n수정' }, home)
    expect(saved.file).toBe(skill.file)
    expect(skillId(saved)).toBe(skillId(skill))
    expect((await readMd(saved.file)).data.custom).toEqual({ preserve: true })
    await expect(saveSkill(project, { ...saved, id: skillId(saved), location: saved.location === 'claude' ? 'codex' : 'claude' }, home)).rejects.toThrow('이름과 위치')
    await expect(saveSkill(project, saved, home)).rejects.toThrow('이미 있습니다')
  }
  expect((await listSkills(project, home)).map((s) => s.body)).toEqual(skills.map((s) => s.body + '\n수정'))
})

it('루트 md 파일·frontmatter 없는 폴더·잘못된 스킬이 섞여도 정상 파일을 찾는다', async () => {
  const { project, home } = await fixture()
  for (const location of SKILL_LOCATIONS) {
    const root = path.join(project, `.${location}/skills`)
    await fs.mkdir(path.join(root, 'plain'), { recursive: true })
    await fs.writeFile(path.join(root, 'plain/SKILL.md'), '# 원문\n\n내용')
    await fs.writeFile(path.join(root, 'standalone.md'), '# 단일 파일')
    await fs.writeFile(path.join(root, 'broken.md'), '---\nname: [broken\n---\n본문')
  }
  const skills = await listSkills(project, home)
  expect(skills).toHaveLength(6)
  expect(skills.map((s) => s.name)).toEqual(['plain', 'standalone', 'plain', 'standalone', 'plain', 'standalone'])
})

it('연결한 스킬 폴더도 읽되 루트 밖으로 연결된 파일은 편집하지 않는다', async () => {
  const { project, home } = await fixture()
  const root = path.join(project, '.agents/skills'), shared = path.join(home, 'shared')
  await writeMd(path.join(shared, 'SKILL.md'), { name: 'linked' }, '연결 본문')
  await fs.mkdir(root, { recursive: true })
  await fs.symlink(shared, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const [skill] = await listSkills(project, home)
  expect(skillId(skill)).toBe('agents:project:linked')
  expect(skill.body).toBe('연결 본문')
  await expect(saveSkill(project, { ...skill, id: skillId(skill), body: '수정' }, home)).rejects.toThrow('폴더 밖')
  expect((await readMd(path.join(shared, 'SKILL.md'))).content.trim()).toBe('연결 본문')
})

it('IPC로 받은 임의 저장 위치와 경로 이동을 거부한다', async () => {
  const { project, home } = await fixture()
  const input: SkillInput = { scope: 'project', name: 'valid', description: '', body: '본문' }
  await expect(saveSkill(project, { ...input, location: '../outside' as SkillInput['location'] }, home)).rejects.toThrow('저장 위치')
  for (const location of SKILL_LOCATIONS) {
    await expect(saveSkill(project, { ...input, location, name: '../outside' }, home)).rejects.toThrow('스킬 이름')
  }
})
