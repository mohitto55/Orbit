import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { encodeClaudeProjectDir, finishCheck, isDriftDue, listClaudeSessions, listCodexSessions, listChecks, listRequests, pendingSessions } from '../src/core/drift'
import { buildGraph, resolveName } from '../src/core/graph'
import { createDomain, listDomains, saveDomain } from '../src/core/domain'
import { listInbox } from '../src/core/task'
import { listKnowledge, saveKnowledge } from '../src/core/knowledge'
import { readSettings } from '../src/core/workspace'
import { newProject, tempDir } from './helpers'

describe('Integration · Drift', () => {
  it('[IN-F05-AC1] 현재 프로젝트 폴더에서 진행된 세션만 찾는다', async () => {
    const ctx = await newProject()
    const home = await tempDir('home-')
    const claudeDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(ctx.projectDir))
    await fs.mkdir(claudeDir, { recursive: true })
    const lines = [
      { type: 'user', sessionId: 's1', timestamp: '2026-10-12T01:00:00Z', message: { role: 'user', content: '주문 취소 정책을 바꾸자' } },
      { type: 'assistant', sessionId: 's1', timestamp: '2026-10-12T01:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: '좋습니다' }] } }
    ]
    await fs.writeFile(path.join(claudeDir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))

    const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '12')
    await fs.mkdir(codexDir, { recursive: true })
    const codex = (cwd: string) =>
      [
        { type: 'session_meta', payload: { id: `c-${cwd.length}`, cwd } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '결제 재시도' }] } }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
    await fs.writeFile(path.join(codexDir, 'mine.jsonl'), codex(ctx.projectDir))
    await fs.writeFile(path.join(codexDir, 'other.jsonl'), codex(path.join(home, 'elsewhere')))

    const claude = await listClaudeSessions(ctx.projectDir, home)
    expect(claude).toMatchObject([{ id: 'claude:s1', firstPrompt: '주문 취소 정책을 바꾸자', messages: 2 }])
    const cx = await listCodexSessions(ctx.projectDir, home)
    expect(cx.map((s) => s.firstPrompt)).toEqual(['결제 재시도'])
    expect(await pendingSessions(ctx, home)).toHaveLength(2)
  })

  it('진행 중인 대화 파일에 줄이 붙으면 붙은 줄만 더 읽어 반영한다 (쓰는 중인 줄은 다 쓴 뒤에)', async () => {
    const ctx = await newProject()
    const home = await tempDir('home-')
    const claudeDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(ctx.projectDir))
    await fs.mkdir(claudeDir, { recursive: true })
    const file = path.join(claudeDir, 's2.jsonl')
    const line = (role: 'user' | 'assistant', text: string) =>
      JSON.stringify({ type: role, sessionId: 's2', timestamp: '2026-10-12T02:00:00Z', message: { role, content: text } }) + '\n'

    await fs.writeFile(file, line('user', '첫 질문'))
    expect(await listClaudeSessions(ctx.projectDir, home)).toMatchObject([{ firstPrompt: '첫 질문', messages: 1 }])

    // 답이 붙고, 다음 줄은 아직 쓰는 중
    const next = line('user', '두 번째 질문')
    await fs.appendFile(file, line('assistant', '답') + next.slice(0, 20))
    expect(await listClaudeSessions(ctx.projectDir, home)).toMatchObject([{ firstPrompt: '첫 질문', messages: 2 }])

    await fs.appendFile(file, next.slice(20))
    expect(await listClaudeSessions(ctx.projectDir, home)).toMatchObject([{ firstPrompt: '첫 질문', messages: 3 }])
  })

  it('[DR-F01-AC2] 지난 검토 이후 새 세션이 없으면 알리지 않는다', async () => {
    const ctx = await newProject()
    const settings = await readSettings(ctx)
    expect(isDriftDue([], settings, 0)).toBe(false)
    expect(isDriftDue([], settings, 3)).toBe(true)
  })

  it('[DR-F04-AC2] 표시가 도메인 변경 요청 / Inbox / 지식 초안으로 넘어간다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    await finishCheck(ctx, {
      sessionIds: ['claude:s1'],
      marks: [
        { kind: 'domain', excerpt: '취소는 배송 전까지만', sessionId: 'claude:s1', domainId: d.id },
        { kind: 'task', excerpt: '환불 API 정리', sessionId: 'claude:s1' },
        { kind: 'knowledge', excerpt: 'PG 콜백은 중복 올 수 있음', sessionId: 'claude:s1' }
      ]
    })
    expect((await listRequests(ctx))[0]).toMatchObject({ domain: d.id, status: 'pending' })
    expect((await listInbox(ctx))[0].title).toBe('환불 API 정리')
    expect((await listKnowledge(ctx))[0].status).toBe('초안')
  })

  it('[DR-F05-AC1] 마치면 회차 파일이 남고 본 세션이 검토됨으로 기록된다', async () => {
    const ctx = await newProject()
    await finishCheck(ctx, { sessionIds: ['claude:a', 'codex:b'], marks: [] })
    expect((await listChecks(ctx))[0].sessions).toEqual(['claude:a', 'codex:b'])
  })
})

describe('Knowledge', () => {
  it('[KN-F04-AC2] 새 결정으로 대체하면 이전 항목이 폐기되고 서로 연결된다', async () => {
    const ctx = await newProject()
    const old = await saveKnowledge(ctx, { type: '결정', title: 'REST 사용' })
    const neu = await saveKnowledge(ctx, { type: '결정', title: 'GraphQL로 전환', supersedes: old.id })
    const all = await listKnowledge(ctx)
    expect(all.find((k) => k.id === old.id)).toMatchObject({ status: '폐기됨', supersededBy: neu.id })
  })
})

describe('Knowledge Graph', () => {
  it('[KG-F03-AC1] 이름 링크는 같은 상위의 형제부터 찾는다', async () => {
    const ctx = await newProject()
    const order = await createDomain(ctx, { title: '주문', folder: 'order' })
    const settle = await createDomain(ctx, { title: '정산', folder: 'settle' })
    const oc = await createDomain(ctx, { title: '고객', folder: 'order-customer', parent: order.id })
    const sc = await createDomain(ctx, { title: '고객', folder: 'settle-customer', parent: settle.id })
    const cart = await createDomain(ctx, { title: '장바구니', folder: 'order-cart', parent: order.id })
    const domains = await listDomains(ctx)
    expect(resolveName('고객', domains, cart.id)).toBe(oc.id)
    expect(resolveName('고객', domains)).toBeNull()
  })

  it('[KG-F03-AC3] 상위/이름 경로 표기가 된다', async () => {
    const ctx = await newProject()
    const settle = await createDomain(ctx, { title: '정산', folder: 'settle' })
    const sc = await createDomain(ctx, { title: '고객', folder: 'settle-customer', parent: settle.id })
    expect(resolveName('정산/고객', await listDomains(ctx))).toBe(sc.id)
  })

  it('[KG-F04-AC1] 없는 노드를 가리키는 링크는 미정의 노드가 된다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    await saveDomain(ctx, d.id, { content: '# 주문\n\n## 역할\n\n[[배송]]과의 경계 미정\n' }, { size: 'minor', summary: '링크' })
    const g = await buildGraph(ctx)
    expect(g.nodes.find((n) => n.id === 'ghost:배송')?.kind).toBe('ghost')
    expect(g.edges).toContainEqual({ source: d.id, target: 'ghost:배송', type: '관련' })
  })
})
