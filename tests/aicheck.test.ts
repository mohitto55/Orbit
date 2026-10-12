import { describe, expect, it } from 'vitest'
import { buildCheckPrompt, decideFinding, lastCheckAt, listAiChecks, parseCheckResult, runAiCheck, type AgentRunner } from '../src/core/aicheck'
import { createDomain } from '../src/core/domain'
import { listRequests } from '../src/core/drift'
import { listInbox } from '../src/core/task'
import { listKnowledge } from '../src/core/knowledge'
import { newProject } from './helpers'

const reply = (findings: object[]) => `점검했습니다.\n\`\`\`json\n${JSON.stringify({ summary: '주문 취소 규칙이 문서에 없음', findings })}\n\`\`\``

describe('도메인 점검 · AI 점검', () => {
  it('[DR-F07-AC1] 점검 요청문에 현재 도메인 문서와 대화·커밋이 들어간다', async () => {
    const ctx = await newProject()
    await createDomain(ctx, { title: '주문', folder: 'order', role: '주문을 받는다' })
    const prompt = await buildCheckPrompt(ctx, [], '2026-10-01T00:00:00Z', 'abc1234 2026-10-02 취소 기능 추가')
    expect(prompt).toContain('주문을 받는다')
    expect(prompt).toContain('dom-order')
    expect(prompt).toContain('지난 점검(2026-10-01T00:00:00Z) 이후')
    expect(prompt).toContain('취소 기능 추가')
  })

  it('[DR-F07-AC2] AI 응답의 JSON을 코드 블록이나 앞뒤 말이 있어도 읽는다', () => {
    const r = parseCheckResult(reply([{ kind: 'domain', domainId: 'dom-order', title: '취소 규칙', detail: '배송 전까지만 취소', evidence: '사람: 배송 전에만 취소되게' }, { kind: 'nonsense', title: 'x' }]))
    expect(r.summary).toBe('주문 취소 규칙이 문서에 없음')
    expect(r.findings).toHaveLength(1)
    expect(() => parseCheckResult('결과 없음')).toThrow(/JSON/)
  })

  it('[DR-F07-AC3] 점검 결과가 기록되고, 다음 점검은 이번 점검 이후를 기준으로 한다', async () => {
    const ctx = await newProject()
    await createDomain(ctx, { title: '주문', folder: 'order' })
    const runner: AgentRunner = async () => reply([])
    const c = await runAiCheck(ctx, 'claude', runner)
    expect(c.error).toBeUndefined()
    expect((await listAiChecks(ctx)).map((x) => x.id)).toEqual([c.id])
    expect(await lastCheckAt(ctx)).toBe(c.finishedAt)
  })

  it('[DR-F07-AC4] AI 실행이 실패하면 실패 기록만 남고 점검 기준 시각은 바뀌지 않는다', async () => {
    const ctx = await newProject()
    const c = await runAiCheck(ctx, 'claude', async () => {
      throw new Error('claude를 찾을 수 없음')
    })
    expect(c.error).toContain('claude')
    expect(await lastCheckAt(ctx)).toBeNull()
  })

  it('[DR-F08-AC1] 받아들인 항목은 종류에 따라 변경 요청 / Inbox / 지식 초안이 된다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    const runner: AgentRunner = async () =>
      reply([
        { kind: 'domain', domainId: d.id, title: '취소 규칙', detail: '배송 전까지만 취소', evidence: '배송 전에만' },
        { kind: 'task', title: '환불 API 정리', detail: '' },
        { kind: 'knowledge', title: 'PG 콜백은 중복될 수 있음', detail: '멱등 처리 필요' },
        { kind: 'task', title: '무시할 항목', detail: '' }
      ])
    const c = await runAiCheck(ctx, 'claude', runner)
    await decideFinding(ctx, c.id, 'f1', true)
    await decideFinding(ctx, c.id, 'f2', true)
    await decideFinding(ctx, c.id, 'f3', true)
    await decideFinding(ctx, c.id, 'f4', false)
    expect((await listRequests(ctx))[0]).toMatchObject({ domain: d.id, status: 'pending' })
    expect((await listInbox(ctx)).map((i) => i.title)).toEqual(['환불 API 정리'])
    expect((await listKnowledge(ctx))[0]).toMatchObject({ title: 'PG 콜백은 중복될 수 있음', status: '초안' })
    expect((await listAiChecks(ctx))[0].findings.map((f) => f.status)).toEqual(['accepted', 'accepted', 'accepted', 'dismissed'])
  })
})
