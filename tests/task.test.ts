import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { addInbox, classifyInbox, createTask, deleteTask, reorderTasks, discardInbox, dueTasks, listInbox, listTasks, updateTask } from '../src/core/task'
import type { ChangeSet } from '../src/core/changes'
import { restoreFiles, snapshotFiles } from '../src/core/undo'
import { newProject } from './helpers'

describe('Task', () => {
  it('[TK-F01-AC2] 유형·시기 입력 없이 Inbox에 저장된다', async () => {
    const ctx = await newProject()
    await addInbox(ctx, '캐시 만료 정책 다시 보기')
    expect((await listInbox(ctx)).map((i) => i.title)).toEqual(['캐시 만료 정책 다시 보기'])
  })

  it('[TK-F02-AC1] inbox/에 에이전트가 만든 md 파일이 Inbox 항목으로 표시된다', async () => {
    const ctx = await newProject()
    await fs.writeFile(path.join(ctx.dataRoot, 'inbox', 'agent-note.md'), '# 결제 재시도 로직 정리\n\n세션 중 발견\n', 'utf8')
    const items = await listInbox(ctx)
    expect(items[0].title).toBe('결제 재시도 로직 정리')
    expect(items[0].body).toContain('세션 중 발견')
  })

  it('[TK-F03-AC1] 유형과 시기를 고르면 Inbox 항목이 Task가 된다', async () => {
    const ctx = await newProject()
    const item = await addInbox(ctx, 'x')
    const task = await classifyInbox(ctx, item.id, { type: 'refactor', horizon: '나중' })
    expect(task).toMatchObject({ title: 'x', type: 'refactor', horizon: '나중', status: '대기' })
    expect(await listInbox(ctx)).toHaveLength(0)
  })

  it('[TK-F03-AC2] 유형이나 시기가 없으면 Task로 저장되지 않는다', async () => {
    const ctx = await newProject()
    const item = await addInbox(ctx, 'x')
    await expect(classifyInbox(ctx, item.id, { type: '', horizon: '나중' })).rejects.toThrow(/유형/)
    await expect(classifyInbox(ctx, item.id, { type: 'bug', horizon: '' })).rejects.toThrow(/시기/)
    expect(await listTasks(ctx)).toHaveLength(0)
  })

  it('[TK-F03-AC4] 필요 없으면 버림으로 닫을 수 있다', async () => {
    const ctx = await newProject()
    const item = await addInbox(ctx, 'x')
    await discardInbox(ctx, item.id)
    expect(await listInbox(ctx)).toHaveLength(0)
  })

  it('[TK-F05-AC1] 기한이 지난 Task가 시기 도래로 표시된다', async () => {
    const ctx = await newProject()
    await createTask(ctx, { title: 'a', type: 'bug', horizon: '다음', due: '2026-01-01' })
    await createTask(ctx, { title: 'b', type: 'bug', horizon: '다음', due: '2099-01-01' })
    const due = dueTasks(await listTasks(ctx), [], new Date('2026-10-12'))
    expect(due.map((t) => t.title)).toEqual(['a'])
  })

  it('[TK-F05-AC2] 트리거 조건이 충족되면 시기 도래로 표시된다', async () => {
    const ctx = await newProject()
    const first = await createTask(ctx, { title: 'first', type: 'feature', horizon: '지금' })
    await createTask(ctx, { title: 'after-task', type: 'feature', horizon: '나중', trigger: { kind: 'task-done', ref: first.id } })
    await createTask(ctx, { title: 'after-domain', type: 'docs', horizon: '나중', trigger: { kind: 'domain-changed', ref: 'dom-a', after: 2 } })
    expect(dueTasks(await listTasks(ctx), [])).toHaveLength(0)
    await updateTask(ctx, first.id, { status: '완료' })
    const changes = [{ target: 'dom-a', to: 3 } as ChangeSet]
    expect(dueTasks(await listTasks(ctx), changes).map((t) => t.title).sort()).toEqual(['after-domain', 'after-task'])
  })

  it('[TK-F07-AC1] 상태는 대기 → 진행 → 완료 / 취소다', async () => {
    const ctx = await newProject()
    const t = await createTask(ctx, { title: 'a', type: 'bug', horizon: '지금' })
    expect((await updateTask(ctx, t.id, { status: '진행' })).status).toBe('진행')
    await expect(updateTask(ctx, t.id, { status: '보류' as any })).rejects.toThrow()
  })

  it('Task에 시작일·종료일을 저장하고 고치고 지울 수 있다', async () => {
    const ctx = await newProject()
    const t = await createTask(ctx, { title: 'x', type: 'feature', horizon: '지금', start: '2026-10-12', end: '2026-10-20' })
    expect(t).toMatchObject({ start: '2026-10-12', end: '2026-10-20' })
    expect((await updateTask(ctx, t.id, { end: '2026-10-25' })).end).toBe('2026-10-25')
    const cleared = await updateTask(ctx, t.id, { start: '' })
    expect(cleared.start).toBeUndefined()
    expect(cleared.end).toBe('2026-10-25')
  })

  it('종료일이 시작일보다 빠르면 저장되지 않는다', async () => {
    const ctx = await newProject()
    await expect(createTask(ctx, { title: 'x', type: 'bug', horizon: '지금', start: '2026-10-20', end: '2026-10-12' })).rejects.toThrow(/종료일/)
    const t = await createTask(ctx, { title: 'y', type: 'bug', horizon: '지금', start: '2026-10-12' })
    await expect(updateTask(ctx, t.id, { end: '2026-10-01' })).rejects.toThrow(/종료일/)
  })

  it('따옴표 없이 쓴 YAML 날짜도 YYYY-MM-DD로 읽는다', async () => {
    const ctx = await newProject()
    await fs.mkdir(path.join(ctx.dataRoot, 'tasks'), { recursive: true })
    await fs.writeFile(
      path.join(ctx.dataRoot, 'tasks', 'task-0009.md'),
      '---\nid: task-0009\ntitle: z\ntype: docs\nhorizon: 다음\nstart: 2026-11-01\nend: 2026-11-03\n---\n',
      'utf8'
    )
    expect((await listTasks(ctx))[0]).toMatchObject({ start: '2026-11-01', end: '2026-11-03' })
  })

  it('Task의 제목·유형·내용을 고치고 삭제할 수 있다', async () => {
    const ctx = await newProject()
    const t = await createTask(ctx, { title: 'a', type: 'bug', horizon: '지금' })
    const u = await updateTask(ctx, t.id, { title: ' b ', type: 'docs', horizon: '나중', body: '메모', links: ['dom-a'] })
    expect(u).toMatchObject({ title: 'b', type: 'docs', horizon: '나중', body: '메모', links: ['dom-a'] })
    await expect(updateTask(ctx, t.id, { title: '  ' })).rejects.toThrow(/제목/)
    await deleteTask(ctx, t.id)
    expect(await listTasks(ctx)).toHaveLength(0)
  })

  it('중요도는 기본 보통이고 바꿀 수 있으며, 모르는 값은 막는다', async () => {
    const ctx = await newProject()
    const t = await createTask(ctx, { title: 'a', type: 'bug', horizon: '지금' })
    expect(t.priority).toBe('보통')
    expect((await updateTask(ctx, t.id, { priority: '높음' })).priority).toBe('높음')
    await expect(updateTask(ctx, t.id, { priority: '급함' as any })).rejects.toThrow(/중요도/)
    const h = await createTask(ctx, { title: 'b', type: 'bug', horizon: '지금', priority: '낮음' })
    expect(h.priority).toBe('낮음')
  })

  it('끌어서 바꾼 순서가 order로 저장된다', async () => {
    const ctx = await newProject()
    const a = await createTask(ctx, { title: 'a', type: 'bug', horizon: '지금' })
    const b = await createTask(ctx, { title: 'b', type: 'bug', horizon: '지금' })
    await reorderTasks(ctx, [b.id, a.id])
    const byId = Object.fromEntries((await listTasks(ctx)).map((t) => [t.id, t.order]))
    expect(byId).toEqual({ [b.id]: 1, [a.id]: 2 })
  })

  it('스냅샷으로 수정·삭제·생성을 되돌린다', async () => {
    const ctx = await newProject()
    const t = await createTask(ctx, { title: 'a', type: 'bug', horizon: '지금' })
    const snap = await snapshotFiles(ctx, [t.file])
    await updateTask(ctx, t.id, { title: 'b' })
    await restoreFiles(ctx, snap)
    expect((await listTasks(ctx))[0].title).toBe('a')
    await deleteTask(ctx, t.id)
    await restoreFiles(ctx, snap)
    expect(await listTasks(ctx)).toHaveLength(1)
    await restoreFiles(ctx, [{ file: t.file, raw: null }])
    expect(await listTasks(ctx)).toHaveLength(0)
    await expect(snapshotFiles(ctx, [path.join(ctx.projectDir, '..', 'x.md')])).rejects.toThrow(/밖/)
  })
})
