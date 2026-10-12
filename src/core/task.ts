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

export const PRIORITIES = ['높음', '보통', '낮음'] as const
export type Priority = (typeof PRIORITIES)[number]

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
  priority: Priority
  /** 사용자가 끌어서 정한 순서 (작을수록 위) */
  order?: number
  due?: string
  /** 시작일 YYYY-MM-DD */
  start?: string
  /** 종료일 YYYY-MM-DD */
  end?: string
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
  priority?: string
  due?: string
  start?: string
  end?: string
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

/** YAML이 날짜를 Date로 읽은 경우까지 YYYY-MM-DD 문자열로 맞춘다. */
function dateStr(v: unknown): string | undefined {
  if (v == null || v === '') return undefined
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

function validateDates(start?: string, end?: string): void {
  if (start && end && start > end) throw new Error('종료일이 시작일보다 빠를 수 없습니다')
}

function validateClassify(input: ClassifyInput): void {
  if (!TASK_TYPES.includes(input.type as TaskType)) throw new Error('작업 유형을 골라야 Task로 저장할 수 있습니다')
  if (!HORIZONS.includes(input.horizon as Horizon)) throw new Error('시기를 골라야 Task로 저장할 수 있습니다')
  if (input.priority && !PRIORITIES.includes(input.priority as Priority)) throw new Error('알 수 없는 중요도입니다')
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
      priority: PRIORITIES.includes(data.priority) ? data.priority : '보통',
      order: typeof data.order === 'number' ? data.order : undefined,
      due: dateStr(data.due),
      start: dateStr(data.start),
      end: dateStr(data.end),
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
  validateDates(input.start, input.end)
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
    priority: input.priority || '보통',
    ...(input.due ? { due: input.due } : {}),
    ...(input.start ? { start: input.start } : {}),
    ...(input.end ? { end: input.end } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    status: '대기',
    links: input.links ?? [],
    ...(input.source ? { source: input.source } : {}),
    created: nowIso()
  }
  await writeMd(file, data, input.body ?? '')
  return (await listTasks(ctx)).find((t) => t.id === id)!
}

/** 제목·세부 내용을 넘기면 Inbox에 적힌 것 대신 그것으로 만든다. */
export async function classifyInbox(ctx: Ctx, inboxId: string, input: ClassifyInput & { title?: string; body?: string }): Promise<Task> {
  validateClassify(input)
  const item = (await listInbox(ctx)).find((i) => i.id === inboxId)
  if (!item) throw new Error(`Inbox 항목을 찾을 수 없습니다: ${inboxId}`)
  const task = await createTask(ctx, { ...input, title: input.title?.trim() || item.title, body: input.body ?? item.body, source: item.source })
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
  if (patch.type || patch.horizon || patch.priority)
    validateClassify({ type: patch.type ?? task.type, horizon: patch.horizon ?? task.horizon, priority: patch.priority })
  if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error('알 수 없는 상태입니다')
  if ('title' in patch && !patch.title?.trim()) throw new Error('할 일 제목을 입력하세요')
  if (patch.title) patch = { ...patch, title: patch.title.trim() }
  validateDates('start' in patch ? patch.start : task.start, 'end' in patch ? patch.end : task.end)
  const { data, content } = await readMd(task.file)
  const { body, ...rest } = patch
  const next: Record<string, unknown> = { ...data, ...rest }
  // 빈 값으로 보낸 날짜는 지운다
  for (const k of ['due', 'start', 'end'] as const) if (k in patch && !patch[k]) delete next[k]
  await writeMd(task.file, next, body ?? content)
  return (await listTasks(ctx)).find((t) => t.id === id)!
}

/** ids 순서대로 order를 1부터 매긴다. */
export async function reorderTasks(ctx: Ctx, ids: string[]): Promise<void> {
  const tasks = await listTasks(ctx)
  for (const [i, id] of ids.entries()) {
    const task = tasks.find((t) => t.id === id)
    if (!task) throw new Error(`Task를 찾을 수 없습니다: ${id}`)
    if (task.order === i + 1) continue
    const { data, content } = await readMd(task.file)
    await writeMd(task.file, { ...data, order: i + 1 }, content)
  }
}

export async function deleteTask(ctx: Ctx, id: string): Promise<void> {
  const task = (await listTasks(ctx)).find((t) => t.id === id)
  if (!task) throw new Error(`Task를 찾을 수 없습니다: ${id}`)
  await fs.rm(task.file, { force: true })
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
    if (t.due && t.due <= today) return true
    if (t.trigger?.kind === 'task-done') return tasks.some((o) => o.id === t.trigger!.ref && o.status === '완료')
    if (t.trigger?.kind === 'domain-changed') {
      return changes.some((c) => c.target === t.trigger!.ref && (t.trigger!.after == null || c.to > t.trigger!.after))
    }
    return false
  })
}
