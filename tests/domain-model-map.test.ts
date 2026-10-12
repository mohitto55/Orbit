import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createDomain, listDomains, saveDomain } from '../src/core/domain'
import { buildGraph } from '../src/core/graph'
import { ensureModelSection, parseModel, withoutModel } from '../src/core/model'
import { checkAnchors } from '../src/core/codecheck'
import { buildDomainMap, buildDomainScope } from '../src/core/domainmap'
import { buildCheckPrompt } from '../src/core/aicheck'
import { addFeature, createSpec } from '../src/core/spec'
import { newProject } from './helpers'

const MODEL = `# 채팅방

## 역할

대화를 진행한다.

## 모델

| 개념 | 종류 | 상태·행위 | 불변식 | 관계 | 코드 |
|---|---|---|---|---|---|
| 방 진행 | Aggregate | 턴 수 / 턴 진행 | 턴은 1씩만 오른다 | 사용 [[트리거]]<br>소유 [[턴]] | \`BaseRoom\` |
| 턴 | Value Object | 번호 |  |  | \`src/room/turn.ts\` |
| 트리거 | Entity | 조건, 액션 | 같은 발생은 한 번만 실행 | 요청 [[아이템/지급 의도]] |  |

## 하지 않는 것

- 결제
`

const ITEM = '# 아이템\n\n## 모델\n\n| 개념 | 종류 | 상태·행위 | 불변식 | 관계 | 코드 |\n|---|---|---|---|---|---|\n| 지급 의도 | Event | 대상, 수량 |  |  |  |\n'

async function setup() {
  const ctx = await newProject()
  const chat = await createDomain(ctx, { title: '채팅', folder: 'chat' })
  const room = await createDomain(ctx, { title: '채팅방', folder: 'room', parent: chat.id })
  const item = await createDomain(ctx, { title: '아이템', folder: 'item' })
  await saveDomain(ctx, room.id, { content: MODEL }, { size: 'minor', summary: '모델' })
  await saveDomain(ctx, item.id, { content: ITEM }, { size: 'minor', summary: '모델' })
  return { ctx, chat, room, item }
}

describe('도메인 모델 표', () => {
  it('모델 표에서 개념·종류·불변식·관계·코드 위치를 읽는다', () => {
    const m = parseModel(MODEL)
    expect(m.map((c) => c.name)).toEqual(['방 진행', '턴', '트리거'])
    expect(m[0]).toMatchObject({ kind: 'Aggregate', invariants: '턴은 1씩만 오른다', code: ['BaseRoom'] })
    expect(m[0].relations).toEqual([
      { type: '사용', to: '트리거' },
      { type: '소유', to: '턴' }
    ])
    expect(m[2].relations).toEqual([{ type: '요청', to: '아이템/지급 의도' }])
  })

  it('모델 섹션이 없으면 하지 않는 것 앞에 빈 표를 넣고, 있으면 그대로 둔다', () => {
    const plain = '# A\n\n## 역할\n\nx\n\n## 하지 않는 것\n\n- y\n'
    const added = ensureModelSection(plain)
    expect(added.indexOf('## 모델')).toBeLessThan(added.indexOf('## 하지 않는 것'))
    expect(parseModel(added)).toEqual([])
    expect(ensureModelSection(added)).toBe(added)
    expect(withoutModel(MODEL)).not.toContain('[[트리거]]')
  })

  it('새 도메인 문서에는 빈 모델 표가 들어간다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    expect(d.content).toContain('## 모델')
    expect(d.model).toEqual([])
  })

  it('관계도에 개념 노드와 개념 사이 관계가 생기고, 도메인을 넘는 관계는 표시된다', async () => {
    const { ctx, room, item } = await setup()
    const g = await buildGraph(ctx)
    expect(g.nodes.filter((n) => n.kind === 'concept').map((n) => n.label).sort()).toEqual(['방 진행', '지급 의도', '턴', '트리거'])
    const rel = (from: string, to: string) => g.edges.find((e) => e.source === `concept:${from}` && e.target === `concept:${to}`)
    expect(rel(`${room.id}/방 진행`, `${room.id}/트리거`)).toMatchObject({ type: '사용', cross: false })
    expect(rel(`${room.id}/트리거`, `${item.id}/지급 의도`)).toMatchObject({ type: '요청', cross: true })
    // 모델 표의 [[개념]]은 도메인 링크(미정의 노드)로 잡히지 않는다
    expect(g.nodes.some((n) => n.kind === 'ghost' && n.label === '트리거')).toBe(false)
  })

  it('코드 위치: 경로는 파일을, 이름은 정의를 찾는다', async () => {
    const { ctx } = await setup()
    let hits = await checkAnchors(ctx, await listDomains(ctx))
    expect(hits.find((h) => h.anchor === 'BaseRoom')?.found).toBeNull()
    await fs.mkdir(path.join(ctx.projectDir, 'src', 'room'), { recursive: true })
    await fs.writeFile(path.join(ctx.projectDir, 'src', 'room', 'turn.ts'), 'export {}\n')
    await fs.writeFile(path.join(ctx.projectDir, 'src', 'room', 'base.ts'), 'import x from "y"\n\nexport class BaseRoom {}\n')
    hits = await checkAnchors(ctx, await listDomains(ctx))
    expect(hits.find((h) => h.anchor === 'src/room/turn.ts')?.found).toBe('src/room/turn.ts')
    expect(hits.find((h) => h.anchor === 'BaseRoom')?.found).toBe('src/room/base.ts:3')
  })

  it('AI 점검 요청문에 코드 위치 확인 결과와 모델 점검 지시가 들어간다', async () => {
    const { ctx } = await setup()
    const prompt = await buildCheckPrompt(ctx, [], null, '')
    expect(prompt).toMatch(/방 진행: `BaseRoom` → 찾지 못함/)
    expect(prompt).toContain('응용 서비스')
  })
})

describe('도메인 지도', () => {
  async function mapSetup() {
    const ctx = await newProject()
    const chat = await createDomain(ctx, { title: '채팅', folder: 'chat' })
    const room = await createDomain(ctx, { title: '채팅방', folder: 'room', parent: chat.id })
    const item = await createDomain(ctx, { title: '아이템', folder: 'item', parent: chat.id })
    const shop = await createDomain(ctx, { title: '상점', folder: 'shop' })
    await saveDomain(ctx, room.id, { content: MODEL }, { size: 'minor', summary: '모델' })
    await saveDomain(ctx, item.id, { content: ITEM }, { size: 'minor', summary: '모델' })
    return { ctx, chat, room, item, shop }
  }

  it('하위 도메인은 상위 안에 묶이고, 같은 상위 안에서 다른 도메인 개념을 가리키면 선이 생긴다', async () => {
    const { ctx, chat, room, item } = await mapSetup()
    const map = await buildDomainMap(ctx)
    expect(map.nodes.find((n) => n.id === room.id)).toMatchObject({ parent: chat.id, concepts: 3 })
    expect(map.nodes.find((n) => n.id === chat.id)?.parent).toBeUndefined()
    expect(map.edges).toEqual([{ source: room.id, target: item.id, types: ['요청'], via: ['concept'], details: ['트리거 → 지급 의도'] }])
  })

  it('같은 상위 안에서는 직접 적은 관계와 본문의 [[도메인]] 언급도 선이 되고, 같은 방향은 하나로 합친다', async () => {
    const { ctx, room, item } = await mapSetup()
    await saveDomain(ctx, item.id, { links: [{ type: '의존', to: room.id }], content: '# 아이템\n\n## 역할\n\n[[채팅방]]에서 쓴다.\n' }, { size: 'minor', summary: '관계' })
    const map = await buildDomainMap(ctx)
    expect(map.edges.find((e) => e.source === item.id && e.target === room.id)).toMatchObject({ types: ['의존'], via: ['link', 'mention'] })
  })

  it('상자를 넘는 관계, 상위·하위 사이, 최상위끼리는 선을 긋지 않는다', async () => {
    const { ctx, chat, room, shop } = await mapSetup()
    await saveDomain(ctx, room.id, { links: [{ type: '의존', to: chat.id }, { type: '사용', to: shop.id }] }, { size: 'minor', summary: '관계' })
    await saveDomain(ctx, chat.id, { links: [{ type: '의존', to: shop.id }] }, { size: 'minor', summary: '관계' })
    const map = await buildDomainMap(ctx)
    expect(map.edges.some((e) => [e.source, e.target].includes(chat.id) || [e.source, e.target].includes(shop.id))).toBe(false)
  })

  it('도메인마다 폐기되지 않은 기능 수를 센다', async () => {
    const { ctx, room } = await mapSetup()
    let spec = await createSpec(ctx, room.id)
    spec = await addFeature(ctx, spec.id, { name: '대화 시작' })
    await addFeature(ctx, spec.id, { name: '답장 다시 생성' })
    const map = await buildDomainMap(ctx)
    expect(map.nodes.find((n) => n.id === room.id)?.features).toBe(2)
  })

  it('도메인 하나를 고르면 그 도메인과 하위 도메인, 개념, 그 안의 관계만 나온다', async () => {
    const { ctx, chat, room, item, shop } = await mapSetup()
    const scope = await buildDomainScope(ctx, chat.id)
    const ids = scope.nodes.map((n) => n.id)
    expect(ids).toContain(room.id)
    expect(ids).not.toContain(shop.id)
    // 고른 도메인은 개념이 없으면 상자로 그리지 않는다 (하위 도메인 상자만)
    expect(ids).not.toContain(chat.id)
    expect(scope.nodes.filter((n) => n.kind === 'concept').map((n) => n.label).sort()).toEqual(['방 진행', '지급 의도', '턴', '트리거'])
    expect(scope.nodes.find((n) => n.label === '턴')?.parent).toBe(room.id)
    // 상자 안 관계는 개념끼리 그대로
    expect(scope.edges).toContainEqual({ source: `concept:${room.id}/방 진행`, target: `concept:${room.id}/트리거`, label: '사용', kind: 'concept' })
    // 상자 사이는 각 상자의 애그리거트 루트끼리 한 줄. 어떤 개념이 무엇을 가리켰는지는 이름에 남는다
    expect(scope.edges).toContainEqual({ source: `concept:${room.id}/방 진행`, target: `concept:${item.id}/지급 의도`, label: '트리거 요청 지급 의도', kind: 'relation' })
    expect(scope.edges.filter((e) => e.kind === 'relation')).toHaveLength(1)
    // 범위 밖(상점)은 이 그래프에 없다
    expect((await buildDomainScope(ctx, shop.id)).nodes.map((n) => n.id)).toEqual([shop.id])
  })
})
