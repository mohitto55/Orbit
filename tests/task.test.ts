import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { addInbox, classifyInbox, createTask, discardInbox, dueTasks, listInbox, listTasks, updateTask } from '../src/core/task'
import type { ChangeSet } from '../src/core/changes'
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
})
