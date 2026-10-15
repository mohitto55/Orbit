import { describe, expect, it } from 'vitest'
import { createDomain, saveDomain } from '../src/core/domain'
import { addFeature, createSpec, getSpec, parseSpecTable, renderSpecTable, saveFeatures, specStaleness, reconfirmSpec, type Feature } from '../src/core/spec'
import { listChanges } from '../src/core/changes'
import { newProject } from './helpers'

async function setup() {
  const ctx = await newProject()
  const d = await createDomain(ctx, { title: 'Task', folder: 'task' })
  const spec = await createSpec(ctx, d.id)
  return { ctx, d, spec }
}

describe('Spec', () => {
  it('[SP-F01-AC1] 도메인을 고르면 그 도메인의 표가 만들어진다 (도메인당 1개)', async () => {
    const { ctx, d, spec } = await setup()
    expect(spec.domainId).toBe(d.id)
    await expect(createSpec(ctx, d.id)).rejects.toThrow(/이미/)
  })

  it('[SP-F01-AC2] 도메인의 현재 버전이 기준 버전으로 기록된다', async () => {
    const { spec, d } = await setup()
    expect(spec.basedOn).toEqual([{ ref: d.id, version: 1 }])
  })

  it('[SP-F02-AC2] 기능 ID는 도메인코드-F번호로 자동 부여된다', async () => {
    const { ctx, spec } = await setup()
    await addFeature(ctx, spec.id, { name: '할 일 추가' })
    const s = await addFeature(ctx, spec.id, { name: '분류' })
    expect(s.features.map((f) => f.id)).toEqual(['TA-F01', 'TA-F02'])
  })

  it('[SP-F02-AC3] 수용 기준이 없으면 활성으로 바꿀 수 없다', async () => {
    const { ctx, spec } = await setup()
    const s = await addFeature(ctx, spec.id, { name: '할 일 추가' })
    const f = { ...s.features[0], status: '활성' as const }
    await expect(saveFeatures(ctx, spec.id, [f])).rejects.toThrow(/수용 기준/)
  })

  it('[SP-F03-AC1] AC는 기능ID-AC번호로 자동 부여된다', async () => {
    const { ctx, spec } = await setup()
    const s = await addFeature(ctx, spec.id, { name: '할 일 추가' })
    const f: Feature = { ...s.features[0], acs: [{ id: '', num: 0, text: '저장된다' }, { id: '', num: 0, text: '3초 안' }] }
    const { spec: out } = await saveFeatures(ctx, spec.id, [f])
    expect(out.features[0].acs.map((a) => a.id)).toEqual(['TA-F01-AC1', 'TA-F01-AC2'])
  })

  it('[SP-F03-AC2] 삭제된 AC 번호는 재사용되지 않는다', async () => {
    const { ctx, spec } = await setup()
    let s = await addFeature(ctx, spec.id, { name: 'x' })
    s = (await saveFeatures(ctx, spec.id, [{ ...s.features[0], acs: [{ id: '', num: 0, text: 'a' }, { id: '', num: 0, text: 'b' }] }])).spec
    // AC2 삭제 후 새 AC 추가
    s = (await saveFeatures(ctx, spec.id, [{ ...s.features[0], acs: [s.features[0].acs[0], { id: '', num: 0, text: 'c' }] }])).spec
    expect(s.features[0].acs.map((a) => a.num)).toEqual([1, 3])
  })

  it('[SP-F04-AC1] 활성 행을 고치면 변경 크기와 요약을 입력해야 한다', async () => {
    const { ctx, spec } = await setup()
    let s = await addFeature(ctx, spec.id, { name: 'x' })
    s = (await saveFeatures(ctx, spec.id, [{ ...s.features[0], status: '활성', acs: [{ id: '', num: 0, text: 'a' }] }])).spec
    const edited = { ...s.features[0], name: 'y' }
    await expect(saveFeatures(ctx, spec.id, [edited])).rejects.toThrow(/요약/)
  })

  it('[SP-F04-AC2] 표 버전이 오르고 변경 내역에 바뀐 기능·AC ID가 기록된다', async () => {
    const { ctx, spec } = await setup()
    let s = await addFeature(ctx, spec.id, { name: 'x' })
    s = (await saveFeatures(ctx, spec.id, [{ ...s.features[0], status: '활성', acs: [{ id: '', num: 0, text: 'a' }] }])).spec
    const f = s.features[0]
    const r = await saveFeatures(ctx, spec.id, [{ ...f, acs: [{ ...f.acs[0], text: 'a2' }] }], { size: 'major', summary: 'AC 수정' })
    expect(r.spec.version).toBe(spec.version + 1)
    expect(r.change?.changed).toEqual(['TA-F01', 'TA-F01-AC1'])
  })

  it('[SP-F04-AC3] 초안 행은 기록 없이 자유롭게 고칠 수 있다', async () => {
    const { ctx, spec } = await setup()
    const s = await addFeature(ctx, spec.id, { name: 'x' })
    const r = await saveFeatures(ctx, spec.id, [{ ...s.features[0], name: 'y' }])
    expect(r.change).toBeNull()
    expect(await listChanges(ctx)).toHaveLength(0)
  })

  it('[SP-F05-AC1] 재확인하면 내용은 그대로 두고 기준 버전만 올린다', async () => {
    const { ctx, d, spec } = await setup()
    await saveDomain(ctx, d.id, { title: 'Task2' }, { size: 'major', summary: '규칙 변경' })
    const s = await reconfirmSpec(ctx, spec.id, '여전히 유효')
    expect(s.basedOn[0].version).toBe(2)
    expect(s.version).toBe(spec.version)
  })

  it('[SP-F06-AC1] 기준 버전 이후 도메인에 큰 변경이 있으면 낡음이다', async () => {
    const { ctx, d, spec } = await setup()
    await saveDomain(ctx, d.id, { title: 'T' }, { size: 'major', summary: '규칙 변경' })
    expect(specStaleness(await getSpec(ctx, spec.id), await listChanges(ctx))).toHaveLength(1)
  })

  it('[SP-F06-AC2] 작은 변경만 있었으면 낡음이 아니다', async () => {
    const { ctx, d, spec } = await setup()
    await saveDomain(ctx, d.id, { title: 'T' }, { size: 'minor', summary: '오타' })
    expect(specStaleness(await getSpec(ctx, spec.id), await listChanges(ctx))).toHaveLength(0)
  })

  it('[SP-F02-AC1] 표는 렌더링 후 다시 읽어도 같은 내용이다', () => {
    const features: Feature[] = [
      { id: 'X-F01', name: 'a|b', purpose: 'p', status: '활성', acs: [{ id: 'X-F01-AC1', num: 1, text: 't1' }, { id: 'X-F01-AC3', num: 3, text: 't3' }] }
    ]
    const parsed = parseSpecTable(renderSpecTable(features).join('\n')).features
    expect(parsed).toEqual(features)
  })
})
