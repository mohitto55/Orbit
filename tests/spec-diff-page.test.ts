// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import DiffView from '../src/renderer/src/pages/DiffView'
import { lineDiff, specDifference } from '../src/core/diff'
import { renderSpecTable, type Feature } from '../src/core/spec'

it('[IR-F03-AC4] 변경 검토는 AC 추가를 기본으로 읽기 쉽게 보여주고 전체·원문 보기도 제공한다', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const feature: Feature = { id: 'COUT-F01', name: 'N턴·조건 달성 후 아이템 획득', purpose: '보상 카드를 표시한다.', status: '활성', acs: [1, 3, 4, 5, 7].map((num) => ({ id: `COUT-F01-AC${num}`, num, text: `기존 조건 ${num}` })) }
  const before = renderSpecTable([feature]).join('\n')
  const after = renderSpecTable([{ ...feature, acs: [...feature.acs, { id: 'COUT-F01-AC8', num: 8, text: '보상을 **다시 지급하지 않는다**.' }, { id: 'COUT-F01-AC9', num: 9, text: '이미 획득한 영상은 출력하지 않는다.' }] }]).join('\n')
  window.orbit = { getPathForFile: (file) => file.name, on: () => () => {}, async invoke() { return { file: 'spec.md', diff: lineDiff(before, after), spec: specDifference(before, after) } } }
  const click = async (text: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click())
  try {
    await act(async () => root.render(createElement(DiffView, { changeId: 'change-one' })))
    expect(host.querySelector('.diff-table')).toBeNull()
    expect(host.querySelector('[role="status"]')!.textContent).toContain('수용 기준 추가 2개')
    expect(host.querySelector('[data-change-id="COUT-F01-AC8"] strong')!.textContent).toBe('다시 지급하지 않는다')
    expect(host.querySelector('[data-change-id="COUT-F01-AC9"]')!.classList.contains('added')).toBe(true)
    expect(host.querySelector('details')!.open).toBe(false)
    expect(host.querySelector('details summary')!.textContent).toBe('변경 없는 수용 기준 5개')
    await click('전체')
    expect(host.querySelector('details.spec-diff-unchanged')).toBeNull()
    expect(host.querySelector('[data-change-id="COUT-F01-AC1"]')).not.toBeNull()
    await click('원문 비교')
    expect(host.querySelector('.diff-table')).not.toBeNull()
    await click('항목별 비교')
    expect(host.querySelector('.diff-table')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
