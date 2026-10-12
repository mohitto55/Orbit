import { describe, expect, it } from 'vitest'
import { createDomain, deleteDomain, domainPathLabel, listDomains, saveDomain } from '../src/core/domain'
import { listChanges } from '../src/core/changes'
import { newProject } from './helpers'

describe('Domain Modeling', () => {
  it('[DM-F01-AC1] 이름, 유형, 상위 도메인으로 생성된다', async () => {
    const ctx = await newProject()
    const parent = await createDomain(ctx, { title: '주문', folder: 'order', subdomainType: 'Core' })
    const child = await createDomain(ctx, { title: '고객', folder: 'order-customer', parent: parent.id })
    expect(child.parent).toBe(parent.id)
    expect(parent.subdomainType).toBe('Core')
  })

  it('[DM-F01-AC2] 생성 시 불변 id가 정해지고 버전은 v1이다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '결제', folder: 'payment' })
    expect(d.id).toBe('dom-payment')
    expect(d.version).toBe(1)
  })

  it('[DM-F01-AC3] 같은 상위 아래 형제와 이름이 겹치면 생성이 거부된다', async () => {
    const ctx = await newProject()
    const order = await createDomain(ctx, { title: '주문', folder: 'order' })
    const settle = await createDomain(ctx, { title: '정산', folder: 'settlement' })
    await createDomain(ctx, { title: '고객', folder: 'order-customer', parent: order.id })
    await expect(createDomain(ctx, { title: '고객', folder: 'order-customer2', parent: order.id })).rejects.toThrow(/같은 이름/)
    // 상위가 다르면 같은 이름도 별개 도메인이다
    const other = await createDomain(ctx, { title: '고객', folder: 'settlement-customer', parent: settle.id })
    expect(domainPathLabel(await listDomains(ctx), other.id)).toBe('정산 › 고객')
  })

  it('[DM-F03-AC1] 변경 크기와 요약 없이는 저장되지 않는다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    await expect(saveDomain(ctx, d.id, { title: '주문2' }, { size: 'major', summary: '' })).rejects.toThrow(/요약/)
  })

  it('[DM-F03-AC2] 저장하면 버전이 1 오르고 ChangeSet이 남는다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    const { domain, change } = await saveDomain(ctx, d.id, { content: '# 주문\n\n## 역할\n\n바뀜\n' }, { size: 'minor', summary: '설명 보강' })
    expect(domain.version).toBe(2)
    expect(change).toMatchObject({ target: d.id, from: 1, to: 2, size: 'minor' })
    expect(await listChanges(ctx)).toHaveLength(1)
  })

  it('[DM-F03-AC4] ChangeSet에 출처가 기록된다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order' })
    const { change } = await saveDomain(ctx, d.id, { title: '주문 관리' }, { size: 'minor', summary: 'drift 반영', source: 'drift' })
    expect(change.source).toBe('drift')
  })

  it('[DM-F04-AC1] 이동은 항상 큰 변경으로 기록된다', async () => {
    const ctx = await newProject()
    const a = await createDomain(ctx, { title: 'A', folder: 'a' })
    const b = await createDomain(ctx, { title: 'B', folder: 'b' })
    const c = await createDomain(ctx, { title: 'C', folder: 'c', parent: a.id })
    const { change, domain } = await saveDomain(ctx, c.id, { parent: b.id }, { size: 'minor', summary: '이동' })
    expect(change.size).toBe('major')
    expect(domain.parent).toBe(b.id)
  })

  it('[DM-F04-AC2] 자기 자신이나 자기 하위로 옮기면 거부된다', async () => {
    const ctx = await newProject()
    const a = await createDomain(ctx, { title: 'A', folder: 'a' })
    const b = await createDomain(ctx, { title: 'B', folder: 'b', parent: a.id })
    await expect(saveDomain(ctx, a.id, { parent: a.id }, { size: 'major', summary: 'x' })).rejects.toThrow(/자기 자신/)
    await expect(saveDomain(ctx, a.id, { parent: b.id }, { size: 'major', summary: 'x' })).rejects.toThrow(/하위/)
  })

  it('[DM-F05-AC1] 하위 도메인이나 활성 기능이 남아 있으면 삭제가 거부된다', async () => {
    const ctx = await newProject()
    const a = await createDomain(ctx, { title: 'A', folder: 'a' })
    await createDomain(ctx, { title: 'B', folder: 'b', parent: a.id })
    await expect(deleteDomain(ctx, a.id, 0)).rejects.toThrow(/하위 도메인/)
    const c = await createDomain(ctx, { title: 'C', folder: 'c' })
    await expect(deleteDomain(ctx, c.id, 2)).rejects.toThrow(/기능 2개/)
    await deleteDomain(ctx, c.id, 0)
    expect((await listDomains(ctx)).some((d) => d.id === c.id)).toBe(false)
  })
})
