import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, stamp, nowIso } from './md'
import type { ChangeSet } from './changes'

export const TASK_TYPES = [
  'feature',
  'bug',
  'refactor',
  'tech-debt',
  'research',
  'docs',
  'test',
  'spec-sync',
  'design-sync',
  'domain-sync'
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const HORIZONS = ['지금', '다음', '나중', '언젠가'] as const
export type Horizon = (typeof HORIZONS)[number]

export const TASK_STATUSES = ['대기', '진행', '완료', '취소'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface TaskTrigger {
  kind: 'task-done' | 'domain-changed'
  ref: string
  /** domain-changed: 이 버전 이후의 변경만 */
  after?: number
}

export interface InboxItem {
  id: string
  title: string
  body: string
  source?: string
  created?: string
  file: string
}

export interface Task {
  id: string
  title: string
  body: string
  type: TaskType
  horizon: Horizon
  due?: string
  trigger?: TaskTrigger
  status: TaskStatus
  links: string[]
  source?: string
  issue?: number
  created: string
  file: string
}

export interface ClassifyInput {
  type: string
  horizon: string
  due?: string
  trigger?: TaskTrigger
  links?: string[]
}

function inboxDir(ctx: Ctx) {
  return path.join(ctx.dataRoot, 'inbox')
}
function taskDir(ctx: Ctx) {
  return path.join(ctx.dataRoot, 'tasks')
}

export async function addInbox(ctx: Ctx, title: string, source?: string): Promise<InboxItem> {
  const t = title.trim()
  if (!t) throw new Error('내용을 입력하세요')
  const id = `inbox-${stamp()}`
  const file = path.join(inboxDir(ctx), `${id}.md`)
  await writeMd(file, { kind: 'inbox', title: t, ...(source ? { source } : {}), created: nowIso() }, '')
  return { id, title: t, body: '', source, created: nowIso(), file }
}

/** 에이전트가 frontmatter 없이 만든 파일도 첫 줄을 제목으로 읽는다. */
export async function listInbox(ctx: Ctx): Promise<InboxItem[]> {
  const out: InboxItem[] = []
  for (const file of await listMd(inboxDir(ctx))) {
    const { data, content } = await readMd(file)
    const firstLine = content
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l)
    out.push({
      id: path.basename(file, '.md'),
      title: data.title ?? firstLine ?? path.basename(file, '.md'),
      body: data.title ? content.trim() : content.split('\n').slice(1).join('\n').trim(),
      source: data.source,
      created: data.created,
      file
    })
  }
  return out
}

function validateClassify(input: ClassifyInput): void {
  if (!TASK_TYPES.includes(input.type as TaskType)) throw new Error('작업 유형을 골라야 Task로 저장할 수 있습니다')
  if (!HORIZONS.includes(input.horizon as Horizon)) throw new Error('시기를 골라야 Task로 저장할 수 있습니다')
}

export async function listTasks(ctx: Ctx): Promise<Task[]> {
  const out: Task[] = []
  for (const file of await listMd(taskDir(ctx))) {
    const { data, content } = await readMd(file)
    out.push({
      id: data.id ?? path.basename(file, '.md'),
      title: data.title ?? '',
      body: content.trim(),
      type: data.type,
      horizon: data.horizon,
      due: data.due,
      trigger: data.trigger,
      status: data.status ?? '대기',
      links: data.links ?? [],
      source: data.source,
      issue: data.issue,
      created: data.created ?? '',
      file
    })
  }
  return out
}

export async function createTask(
  ctx: Ctx,
  input: ClassifyInput & { title: string; body?: string; source?: string }
): Promise<Task> {
  validateClassify(input)
  if (!input.title?.trim()) throw new Error('할 일 제목을 입력하세요')
  const tasks = await listTasks(ctx)
  const max = tasks.reduce((m, t) => Math.max(m, Number(t.id.match(/(\d+)$/)?.[1] ?? 0)), 0)
  const id = `task-${String(max + 1).padStart(4, '0')}`
  const file = path.join(taskDir(ctx), `${id}.md`)
  const data = {
    id,
    kind: 'task',
    title: input.title.trim(),
    type: input.type,
    horizon: input.horizon,
    ...(input.due ? { due: input.due } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    status: '대기',
    links: input.links ?? [],
    ...(input.source ? { source: input.source } : {}),
    created: nowIso()
  }
  await writeMd(file, data, input.body ?? '')
  return (await listTasks(ctx)).find((t) => t.id === id)!
}

export async function classifyInbox(ctx: Ctx, inboxId: string, input: ClassifyInput): Promise<Task> {
  validateClassify(input)
  const item = (await listInbox(ctx)).find((i) => i.id === inboxId)
  if (!item) throw new Error(`Inbox 항목을 찾을 수 없습니다: ${inboxId}`)
  const task = await createTask(ctx, { ...input, title: item.title, body: item.body, source: item.source })
  await fs.rm(item.file, { force: true })
  return task
}

export async function discardInbox(ctx: Ctx, inboxId: string): Promise<void> {
  const item = (await listInbox(ctx)).find((i) => i.id === inboxId)
  if (item) await fs.rm(item.file, { force: true })
}

export async function updateTask(ctx: Ctx, id: string, patch: Partial<Omit<Task, 'id' | 'file'>>): Promise<Task> {
  const task = (await listTasks(ctx)).find((t) => t.id === id)
  if (!task) throw new Error(`Task를 찾을 수 없습니다: ${id}`)
  if (patch.type || patch.horizon) validateClassify({ type: patch.type ?? task.type, horizon: patch.horizon ?? task.horizon })
  if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error('알 수 없는 상태입니다')
  const { data, content } = await readMd(task.file)
  const { body, ...rest } = patch
  await writeMd(task.file, { ...data, ...rest }, body ?? content)
  return (await listTasks(ctx)).find((t) => t.id === id)!
}

function todayStr(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 기한이 지났거나 트리거 조건이 충족된 미완료 Task. */
export function dueTasks(tasks: Task[], changes: ChangeSet[], now = new Date()): Task[] {
  const today = todayStr(now)
  return tasks.filter((t) => {
    if (t.status !== '대기' && t.status !== '진행') return false
    if (t.due && String(t.due).slice(0, 10) <= today) return true
    if (t.trigger?.kind === 'task-done') return tasks.some((o) => o.id === t.trigger!.ref && o.status === '완료')
    if (t.trigger?.kind === 'domain-changed') {
      return changes.some((c) => c.target === t.trigger!.ref && (t.trigger!.after == null || c.to > t.trigger!.after))
    }
    return false
  })
}
