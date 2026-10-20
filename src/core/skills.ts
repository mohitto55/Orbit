import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { exists, readMd } from './md'

/** 연동: Claude Code 스킬(.claude/skills)을 읽는다. 작업 그래프의 스킬 노드가 이 내용을 글로 내보낸다. */
export interface Skill {
  /** project: 프로젝트의 .claude/skills, user: 내 홈의 ~/.claude/skills */
  scope: 'project' | 'user'
  name: string
  description: string
  /** frontmatter를 뺀 본문 */
  body: string
  file: string
}

/** 스킬 노드가 가리키는 id: "project:이름" / "user:이름" (같은 이름이 양쪽에 있어도 구분된다) */
export const skillId = (s: Pick<Skill, 'scope' | 'name'>) => `${s.scope}:${s.name}`

async function readDir(dir: string, scope: Skill['scope']): Promise<Skill[]> {
  if (!(await exists(dir))) return []
  const out: Skill[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    // <이름>/SKILL.md, 또는 바로 놓인 <이름>.md
    const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null
    if (!file || !(await exists(file))) continue
    try {
      const { data, content } = await readMd(file)
      const fallback = e.isDirectory() ? e.name : e.name.replace(/\.md$/, '')
      out.push({ scope, name: String(data.name ?? fallback), description: String(data.description ?? ''), body: content.trim(), file })
    } catch {
      // 형식이 깨진 스킬 하나 때문에 나머지를 못 쓰게 하지 않는다
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function listSkills(projectDir: string, home = os.homedir()): Promise<Skill[]> {
  const [project, user] = await Promise.all([readDir(path.join(projectDir, '.claude', 'skills'), 'project'), readDir(path.join(home, '.claude', 'skills'), 'user')])
  return [...project, ...user]
}
