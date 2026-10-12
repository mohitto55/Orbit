import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/core/domain'
import { addFeature, createSpec, getSpec, saveFeatures, specStaleness, type Feature } from '../src/core/spec'
import { decide, openReview } from '../src/core/impact'
import { listChanges } from '../src/core/changes'
import { newProject } from './helpers'

const active = (f: Feature, text: string): Feature => ({ ...f, status: '활성', acs: [{ id: '', num: 0, text }] })

/** 채팅(루트) 아래 채팅방·아이템(하위). 하위에는 규칙, 루트에는 그 규칙을 쓰는 기능 */
async function setup() {
  const ctx = await newProject()
  const chat = await createDomain(ctx, { title: '채팅', folder: 'chat' })
  const room = await createDomain(ctx, { title: '채팅방', folder: 'room', parent: chat.id })
  const shop = await createDomain(ctx, { title: '상점', folder: 'shop' })
  let rules = await createSpec(ctx, room.id)
  rules = await addFeature(ctx, rules.id, { name: '보상 자격' })
  rules = await addFeature(ctx, rules.id, { name: '중복 실행 금지' })
  rules = (await saveFeatures(ctx, rules.id, rules.features.map((f) => active(f, `${f.name} 규칙`)))).spec
  let features = await createSpec(ctx, chat.id)
  features = await addFeature(ctx, features.id, { name: 'N턴 후 아이템 받기' })
  let other = await createSpec(ctx, shop.id)
  other = await addFeature(ctx, other.id, { name: '구매' })
  return { ctx, chat, room, shop, rules, features, other }
}

describe('루트 기능 명세 / 하위 규칙 명세', () => {
  it('하위 도메인의 명세는 규칙 명세, 루트 도메인의 명세는 기능 명세다', async () => {
    const { rules, features } = await setup()
    expect(rules).toMatchObject({ role: 'rule', title: '채팅방 규칙 명세' })
    expect(features).toMatchObject({ role: 'feature', title: '채팅 기능 명세' })
  })

  it('루트의 기능은 쓰는 하위 규칙을 참조하고, 그 규칙 명세가 기준 버전으로 기록된다', async () => {
    const { ctx, rules, features } = await setup()
    const [f] = features.features
    const r = await saveFeatures(ctx, features.id, [{ ...f, uses: [rules.features[0].acs[0].id] }], null)
    expect(r.spec.features[0].uses).toEqual([rules.features[0].acs[0].id])
    expect(r.spec.basedOn).toContainEqual({ ref: rules.id, version: rules.version })
    // 다시 읽어도 남아 있다
    expect((await getSpec(ctx, features.id)).features[0].uses).toEqual([rules.features[0].acs[0].id])
  })

  it('자기 아래가 아닌 도메인의 규칙은 쓸 수 없다', async () => {
    const { ctx, features, other } = await setup()
    const [f] = features.features
    await expect(saveFeatures(ctx, features.id, [{ ...f, uses: [other.features[0].id] }], null)).rejects.toThrow(/아래 규칙이 아닙니다/)
  })

  it('쓰는 규칙이 크게 바뀌면 루트 기능 명세에 확인 항목이 생기고, 안 쓰는 규칙이 바뀌면 생기지 않는다', async () => {
    const { ctx, rules, features } = await setup()
    const [used, unused] = rules.features
    await saveFeatures(ctx, features.id, [{ ...features.features[0], uses: [used.id] }], null)

    const quiet = await saveFeatures(ctx, rules.id, rules.features.map((f) => (f.id === unused.id ? { ...f, acs: [{ ...f.acs[0], text: '바뀜' }] } : f)), { size: 'major', summary: '중복 규칙 변경' })
    expect((await openReview(ctx, quiet.change!))?.items.some((i) => i.target === features.id) ?? false).toBe(false)
    expect(specStaleness(await getSpec(ctx, features.id), await listChanges(ctx))).toEqual([])

    const now = await getSpec(ctx, rules.id)
    const loud = await saveFeatures(ctx, rules.id, now.features.map((f) => (f.id === used.id ? { ...f, acs: [{ ...f.acs[0], text: '자격 바뀜' }] } : f)), { size: 'major', summary: '보상 자격 변경' })
    const review = await openReview(ctx, loud.change!)
    expect(review?.items).toContainEqual(expect.objectContaining({ target: features.id, layer: 'spec' }))
    expect(specStaleness(await getSpec(ctx, features.id), await listChanges(ctx))).toHaveLength(1)

    // 확인하면 기준 버전이 지금 규칙 명세 버전으로 오르고 낡음이 풀린다
    await decide(ctx, review!.id, features.id, 'unchanged')
    const after = await getSpec(ctx, features.id)
    expect(after.basedOn.find((b) => b.ref === rules.id)?.version).toBe(loud.spec.version)
    expect(specStaleness(after, await listChanges(ctx))).toEqual([])
  })
})
