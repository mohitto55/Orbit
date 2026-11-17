import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import matter from 'gray-matter'
import { exists, readMd } from './md'
import { SKILL_LOCATIONS, type SkillLocation } from './skillLocations'

/** 작업 그래프의 스킬 노드가 Claude Code·Codex·공용 스킬의 본문을 글로 내보낸다. */
export interface Skill {
  /** project: 프로젝트 폴더, user: 사용자 홈 */
  scope: 'project' | 'user'
  location: SkillLocation
  name: string
  description: string
  /** frontmatter를 뺀 본문 */
  body: string
  file: string
}

/** 기존 Claude ID는 유지한다. 새 위치는 접두어로 구분해 다른 본문으로 바뀌지 않는다. */
export const skillId = (s: Pick<Skill, 'scope' | 'name' | 'location'>) => `${s.location === 'claude' ? '' : `${s.location}:`}${s.scope}:${s.name}`

async function readDir(dir: string, scope: Skill['scope'], location: SkillLocation): Promise<Skill[]> {
  if (!(await exists(dir))) return []
  const out: Skill[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    // <이름>/SKILL.md, 또는 바로 놓인 <이름>.md
    const entry = path.join(dir, e.name)
    const directory = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(entry).catch(() => null))?.isDirectory())
    const file = directory ? path.join(entry, 'SKILL.md') : e.name.endsWith('.md') ? entry : null
    if (!file || !(await exists(file))) continue
    try {
      const { data, content } = await readMd(file)
      const fallback = directory ? e.name : e.name.replace(/\.md$/, '')
      out.push({ scope, location, name: String(data.name ?? fallback), description: String(data.description ?? ''), body: content.trim(), file })
    } catch {
      // 형식이 깨진 스킬 하나 때문에 나머지를 못 쓰게 하지 않는다
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function listSkills(projectDir: string, home = os.homedir()): Promise<Skill[]> {
  const groups = await Promise.all((['project', 'user'] as const).flatMap((scope) =>
    SKILL_LOCATIONS.map((location) => readDir(path.join(scope === 'project' ? projectDir : home, `.${location}`, 'skills'), scope, location))))
  return groups.flat()
}

export interface SkillInput {
  id?: string
  scope: Skill['scope']
  location?: SkillLocation
  name: string
  description: string
  body: string
}

export async function saveSkill(projectDir: string, input: SkillInput, home = os.homedir()): Promise<Skill> {
  if (input.scope !== 'project' && input.scope !== 'user') throw new Error('스킬 저장 위치가 올바르지 않습니다')
  const name = input.name.trim()
  if (!name || !input.body.trim()) throw new Error('스킬 이름과 본문을 입력하세요')
  const skills = await listSkills(projectDir, home)
  const matches = input.id ? skills.filter((s) => skillId(s) === input.id) : []
  if (input.id && matches.length !== 1) throw new Error('수정할 스킬을 찾을 수 없거나 이름이 중복됩니다')
  const current = matches[0]
  const location = input.location ?? current?.location ?? 'claude'
  if (!SKILL_LOCATIONS.includes(location)) throw new Error('스킬 저장 위치가 올바르지 않습니다')
  if (current && (current.name !== name || current.scope !== input.scope || current.location !== location)) throw new Error('연결된 노드를 유지하려면 기존 스킬의 이름과 위치는 변경할 수 없습니다')
  if (!current && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))) throw new Error('새 스킬 이름은 64자 이내의 영문 소문자·숫자·하이픈으로 입력하세요')
  if (!current && skills.some((s) => s.scope === input.scope && s.location === location && s.name.toLowerCase() === name.toLowerCase())) throw new Error('같은 이름의 스킬이 이미 있습니다')
  const root = path.join(input.scope === 'project' ? projectDir : home, `.${location}`, 'skills')
  await fs.mkdir(root, { recursive: true })
  const file = current?.file ?? path.join(root, name, 'SKILL.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const realRoot = await fs.realpath(root), realParent = await fs.realpath(path.dirname(file))
  const relative = path.relative(realRoot, realParent)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('스킬 폴더 밖에는 저장할 수 없습니다')
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (stat?.isSymbolicLink()) throw new Error('심볼릭 링크로 연결된 스킬은 여기서 수정할 수 없습니다')
  const metadata = current ? (await readMd<Record<string, unknown>>(file)).data : {}
  const raw = matter.stringify('\n' + input.body.replace(/\r\n/g, '\n'), { ...metadata, name, description: input.description.trim() })
  if (current) {
    const temp = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, raw, 'utf8'); await fs.rename(temp, file) }
    finally { await fs.rm(temp, { force: true }) }
  } else {
    try { await fs.writeFile(file, raw, { encoding: 'utf8', flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('같은 이름의 스킬 파일이 이미 있습니다'); throw error }
  }
  return { scope: input.scope, location, name, description: input.description.trim(), body: input.body.replace(/\r\n/g, '\n').trim(), file }
}
