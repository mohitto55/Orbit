import { expect, it } from 'vitest'
import { specDifference } from '../src/core/diff'
import { renderSpecTable, type Feature } from '../src/core/spec'

const feature: Feature = { id: 'COUT-F01', name: 'N턴·조건 달성 후 아이템 획득', purpose: '보상 카드를 대화에서 확인한다.', status: '활성', acs: [1, 3, 4, 5, 7].map((num) => ({ id: `COUT-F01-AC${num}`, num, text: `기존 조건 ${num}` })) }
const table = (features: Feature[]) => renderSpecTable(features).join('\n')

it('[IR-F03-AC4] AC8·AC9 추가를 기존 AC의 삭제·재추가와 구분한다', () => {
  const after = { ...feature, acs: [...feature.acs, { id: 'COUT-F01-AC8', num: 8, text: '턴을 되돌려도 아이템 보상을 다시 지급하지 않는다.' }, { id: 'COUT-F01-AC9', num: 9, text: '이미 획득한 영상은 다시 출력하지 않는다.' }] }
  const result = specDifference(table([feature]), table([after]))!
  expect(result.features[0].fields).toEqual([])
  expect(result.features[0].acs.filter((a) => a.kind !== 'same').map((a) => [a.id, a.kind])).toEqual([['COUT-F01-AC8', 'added'], ['COUT-F01-AC9', 'added']])
  expect(result.features[0].acs.filter((a) => a.kind === 'same')).toHaveLength(5)
  expect(result.features[0].acOrder).toBeUndefined()
})

it('[IR-F03-AC4] ID로 수정·삭제·순서 변경을 맞추고 표 밖의 변경도 보존한다', () => {
  const after: Feature = { ...feature, purpose: '달라진 목적', acs: [{ ...feature.acs[2], text: '**달라진 조건**' }, feature.acs[0], feature.acs[1], feature.acs[3]] }
  const result = specDifference(table([feature]) + '\n\n## 규칙\n이전 규칙', table([after]) + '\n\n## 규칙\n새 규칙')!
  expect(result.features[0].fields).toEqual([{ id: 'purpose', label: '목적', before: feature.purpose, after: after.purpose, kind: 'modified' }])
  expect(result.features[0].acs.find((a) => a.id.endsWith('AC4'))).toMatchObject({ kind: 'modified', before: '기존 조건 4', after: '**달라진 조건**' })
  expect(result.features[0].acs.find((a) => a.id.endsWith('AC7'))?.kind).toBe('removed')
  expect(result.features[0].acOrder?.after[0]).toBe('COUT-F01-AC4')
  expect(result.outside.hunks.flatMap((h) => h.lines)).toContainEqual(expect.objectContaining({ type: 'add', text: '새 규칙' }))
})

it('[IR-F03-AC4] 기능 추가·삭제와 순서 변경을 구분하고 같은 ID가 중복되면 원문 비교를 사용한다', () => {
  const second: Feature = { ...feature, id: 'COUT-F02', name: '둘째 기능', acs: [] }
  const third: Feature = { ...second, id: 'COUT-F03', name: '셋째 기능' }
  const result = specDifference(table([feature, second]), table([second, third]))!
  expect(result.features.map((f) => [f.id, f.kind])).toEqual([['COUT-F02', 'same'], ['COUT-F03', 'added'], ['COUT-F01', 'removed']])
  expect(result.order).toBeUndefined()
  expect(specDifference(table([feature, second]), table([second, feature]))?.order?.after).toEqual(['COUT-F02', 'COUT-F01'])
  expect(specDifference(table([feature, feature]), table([feature]))).toBeUndefined()
  expect(specDifference('일반 문서', '일반 문서 변경')).toBeUndefined()
})
