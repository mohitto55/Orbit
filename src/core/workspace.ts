import { promises as fs } from 'fs'
import path from 'path'
import { exists, readMd, writeMd, nowIso } from './md'

export const DATA_DIR = '.girsktop'
export const SUBDIRS = [
  'domains',
  'changes',
  'reviews',
  'requests',
  'inbox',
  'tasks',
  'drift',
  'knowledge',
  'verification',
  '.cache'
]

export interface Ctx {
  projectDir: string
  dataRoot: string
}

export interface ProjectSettings {
  name: string
  created?: string
  driftIntervalDays: number
  reminderTime: string
  githubRepo?: string
  testCommand?: string
  junitPath?: string
}

const DEFAULTS: Omit<ProjectSettings, 'name'> = {
  driftIntervalDays: 7,
  reminderTime: '09:00'
}

/** 데이터 폴더 찾기: `.girsktop/project.md`가 우선, 없으면 `docs/domains`가 있는 `docs/`. */
export async function resolveDataRoot(projectDir: string): Promise<string | null> {
  const g = path.join(projectDir, DATA_DIR)
  if (await exists(path.join(g, 'project.md'))) return g
  const d = path.join(projectDir, 'docs')
  if (await exists(path.join(d, 'domains'))) return d
  return null
}

async function ensureGitignore(ctx: Ctx): Promise<void> {
  const rel = path.relative(ctx.projectDir, path.join(ctx.dataRoot, '.cache')).replace(/\\/g, '/') + '/'
  const file = path.join(ctx.projectDir, '.gitignore')
  const current = (await exists(file)) ? await fs.readFile(file, 'utf8') : ''
  if (current.split(/\r?\n/).includes(rel)) return
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  await fs.writeFile(file, current + sep + rel + '\n', 'utf8')
}

export async function createProject(projectDir: string, name?: string): Promise<Ctx> {
  const dataRoot = path.join(projectDir, DATA_DIR)
  if (await exists(path.join(dataRoot, 'project.md'))) {
    throw new Error('이미 Girsktop 프로젝트입니다')
  }
  for (const d of SUBDIRS) await fs.mkdir(path.join(dataRoot, d), { recursive: true })
  const settings: ProjectSettings = {
    name: name || path.basename(projectDir),
    created: nowIso(),
    ...DEFAULTS
  }
  await writeMd(path.join(dataRoot, 'project.md'), settings, `# ${settings.name}\n`)
  const ctx = { projectDir, dataRoot }
  await ensureGitignore(ctx)
  return ctx
}

export async function openProject(projectDir: string): Promise<Ctx> {
  const dataRoot = await resolveDataRoot(projectDir)
  if (!dataRoot) throw new Error('Girsktop 데이터 폴더를 찾을 수 없습니다 (.girsktop/ 또는 docs/domains/)')
  for (const d of SUBDIRS) await fs.mkdir(path.join(dataRoot, d), { recursive: true })
  const ctx = { projectDir, dataRoot }
  await ensureGitignore(ctx)
  return ctx
}

export async function isGitRepo(projectDir: string): Promise<boolean> {
  return exists(path.join(projectDir, '.git'))
}

export async function readSettings(ctx: Ctx): Promise<ProjectSettings> {
  const file = path.join(ctx.dataRoot, 'project.md')
  if (!(await exists(file))) return { name: path.basename(ctx.projectDir), ...DEFAULTS }
  const { data } = await readMd<Partial<ProjectSettings>>(file)
  return { name: path.basename(ctx.projectDir), ...DEFAULTS, ...data }
}

export async function saveSettings(ctx: Ctx, settings: ProjectSettings): Promise<void> {
  const file = path.join(ctx.dataRoot, 'project.md')
  const content = (await exists(file)) ? (await readMd(file)).content : `# ${settings.name}\n`
  await writeMd(file, settings, content)
}
