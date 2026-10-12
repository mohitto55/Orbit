import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/core/domain'
import { finishCheck, listRequests, resolveRequest } from '../src/core/drift'
import { newProject } from './helpers'

describe('변경 검토 · 변경 요청', () => {
  it('[IR-F08-AC2] 변경 요청을 반영 완료 또는 반려로 닫고, 메모와 함께 기록한다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    await finishCheck(ctx, {
      sessionIds: ['claude:s1'],
      marks: [
        { kind: 'domain', excerpt: '취소는 배송 전까지만', sessionId: 'claude:s1', domainId: d.id },
        { kind: 'domain', excerpt: '주문 번호 형식 변경', sessionId: 'claude:s1', domainId: d.id }
      ]
    })
    const [a, b] = await listRequests(ctx)
    await resolveRequest(ctx, a.id, 'done')
    await resolveRequest(ctx, b.id, 'rejected', '이미 다른 규칙으로 정해짐')
    const after = await listRequests(ctx)
    expect(after.find((r) => r.id === a.id)?.status).toBe('done')
    expect(after.find((r) => r.id === b.id)).toMatchObject({ status: 'rejected', resolution: '이미 다른 규칙으로 정해짐' })
    await expect(resolveRequest(ctx, a.id, 'rejected')).rejects.toThrow(/이미 처리/)
  })
})
