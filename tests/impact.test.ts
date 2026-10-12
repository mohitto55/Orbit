import { describe, expect, it } from 'vitest'
import { createDomain, saveDomain } from '../src/core/domain'
import { addFeature, createSpec, getSpec, saveFeatures } from '../src/core/spec'
import { createDesign, listDesigns } from '../src/core/design'
import { decide, listReviews, openReview, pendingItems } from '../src/core/impact'
import { listTasks } from '../src/core/task'
import { newProject } from './helpers'

async function setup() {
  const ctx = await newProject()
  const d = await createDomain(ctx, { title: 'Pay', folder: 'pay' })
  let spec = await createSpec(ctx, d.id)
  spec = await addFeature(ctx, spec.id, { name: 'gacha' })
  spec = await addFeature(ctx, spec.id, { name: 'shop' })
  spec = (
    await saveFeatures(
      ctx,
      spec.id,
      spec.features.map((f) => ({ ...f, status: '활성' as const, acs: [{ id: '', num: 0, text: 'ok' }] }))
    )
  ).spec
  return { ctx, d, spec }
}

describe('Impact Review', () => {
  it('[IR-F01-AC1] 작은 변경이면 검토가 열리지 않는다', async () => {
    const { ctx, d } = await setup()
    const { change } = await saveDomain(ctx, d.id, { title: 'P' }, { size: 'minor', summary: '오타' })
    expect(await openReview(ctx, change)).toBeNull()
  })

  it('[IR-F01-AC3] 큰 변경이면 대상마다 확인표시가 생기고 검토 파일이 남는다', async () => {
    const { ctx, d, spec } = await setup()
    const { change } = await saveDomain(ctx, d.id, { title: 'P' }, { size: 'major', summary: '규칙 변경' })
    const review = await openReview(ctx, change)
    expect(review?.items).toEqual([expect.objectContaining({ target: spec.id, layer: 'spec', status: 'pending' })])
    expect(await listReviews(ctx)).toHaveLength(1)
  })

  it('[IR-F01-AC2] 기능 명세 변경은 바뀐 기능을 기준으로 한 설계와 바뀐 AC에 연결된 테스트만 대상이다', async () => {
    const { ctx, spec } = await setup()
    await createDesign(ctx, spec.id, 'PA-F01')
    await createDesign(ctx, spec.id, 'PA-F02')
    const f1 = spec.features[0]
    const { change } = await saveFeatures(
      ctx,
      spec.id,
      [{ ...f1, acs: [{ ...f1.acs[0], text: 'changed' }] }, spec.features[1]],
      { size: 'major', summary: '천장 변경' }
    )
    const links = [
      { acId: 'PA-F01-AC1', file: 'a.test.ts', line: 1, text: '' },
      { acId: 'PA-F02-AC1', file: 'b.test.ts', line: 1, text: '' }
    ]
    const review = await openReview(ctx, change!, links)
    expect(review!.items.map((i) => i.target).sort()).toEqual(['design-PA-F01', 'test:PA-F01-AC1'])
  })

  it('[IR-F02-AC1] 하위 도메인의 표는 확인표시 없이 참고 목록에만 나온다', async () => {
    const { ctx, d } = await setup()
    const child = await createDomain(ctx, { title: 'Child', folder: 'child', parent: d.id })
    const childSpec = await createSpec(ctx, child.id)
    const { change } = await saveDomain(ctx, d.id, { title: 'P' }, { size: 'major', summary: '규칙 변경' })
    const review = await openReview(ctx, change)
    expect(review!.reference).toContain(childSpec.id)
    expect(review!.items.some((i) => i.target === childSpec.id)).toBe(false)
  })

  it('[IR-F04-AC1] 보류하면 spec-sync Task가 생기고, 변경 불필요는 기준 버전만 갱신한다', async () => {
    const { ctx, d, spec } = await setup()
    const { change } = await saveDomain(ctx, d.id, { title: 'P' }, { size: 'major', summary: '규칙 변경' })
    const review = (await openReview(ctx, change))!
    await decide(ctx, review.id, spec.id, 'defer')
    expect((await listTasks(ctx)).map((t) => t.type)).toEqual(['spec-sync'])

    const { change: c2 } = await saveDomain(ctx, d.id, { title: 'P2' }, { size: 'major', summary: '또 변경' })
    const r2 = (await openReview(ctx, c2))!
    await decide(ctx, r2.id, spec.id, 'unchanged')
    expect((await getSpec(ctx, spec.id)).basedOn[0].version).toBe(3)
  })

  it('[IR-F04-AC1] 설계 변경 불필요는 설계의 기준 버전을 현재 표 버전으로 갱신한다', async () => {
    const { ctx, spec } = await setup()
    await createDesign(ctx, spec.id, 'PA-F01')
    const f1 = spec.features[0]
    const { change, spec: s2 } = await saveFeatures(ctx, spec.id, [{ ...f1, name: 'gacha2' }, spec.features[1]], { size: 'major', summary: 'x' })
    const review = (await openReview(ctx, change!))!
    await decide(ctx, review.id, 'design-PA-F01', 'unchanged')
    const design = (await listDesigns(ctx)).find((x) => x.id === 'design-PA-F01')!
    expect(design.basedOn[0].version).toBe(s2.version)
  })

  it('[IR-F06-AC1] 미처리 확인표시가 있으면 새 항목 대신 기존 항목에 변경 내역이 덧붙는다', async () => {
    const { ctx, d } = await setup()
    const { change: c1 } = await saveDomain(ctx, d.id, { title: 'P' }, { size: 'major', summary: '1' })
    await openReview(ctx, c1)
    const { change: c2 } = await saveDomain(ctx, d.id, { title: 'P2' }, { size: 'major', summary: '2' })
    await openReview(ctx, c2)
    const pending = await pendingItems(ctx)
    expect(pending).toHaveLength(1)
    expect(pending[0].item.changes).toEqual([c1.id, c2.id])
  })
})
