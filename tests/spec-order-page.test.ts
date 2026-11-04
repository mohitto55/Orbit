// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SpecTable from '../src/renderer/src/pages/SpecTable'
import type { Domain, Feature, Spec } from '../src/renderer/src/types'

vi.mock('../src/renderer/src/Automation', () => ({ RunButton: () => null, SourceRuns: () => null }))

let root: Root, host: HTMLDivElement, spec: Spec
const domain: Domain = { id: 'dom-pay', title: '결제', folder: 'pay', subdomainType: 'Core', version: 1, status: 'active', links: [], content: '', role: '', model: [] }
const featureIds = () => [...host.querySelectorAll('[data-feature-id]')].map((row) => row.getAttribute('data-feature-id'))
const row = (id: string) => host.querySelector<HTMLElement>(`[data-feature-id="${id}"]`)!
const acs = (id: string) => [...row(id).querySelectorAll<HTMLElement>('[data-ac-id]')]
const acIds = (id: string) => acs(id).map((ac) => ac.dataset.acId)
const mount = () => act(async () => root.render(createElement(SpecTable, { domain, refreshKey: 0, onChanged() {} })))

async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
  await act(async () => button.click())
}
async function input(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function dragEvent(type: string, dataTransfer: DataTransfer, clientY: number) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientY: { value: clientY } })
  return event
}
async function drag(source: HTMLElement, target: HTMLElement, position: 'before' | 'after', cancel = false) {
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 100))
  const transfer = new DataTransfer(), y = position === 'before' ? 110 : 190
  const handle = source.querySelector<HTMLButtonElement>('.spec-drag-handle')!
  await act(async () => handle.dispatchEvent(dragEvent('dragstart', transfer, y)))
  const over = dragEvent('dragover', transfer, y)
  await act(async () => target.dispatchEvent(over))
  if (!cancel) await act(async () => target.dispatchEvent(dragEvent('drop', transfer, y)))
  await act(async () => handle.dispatchEvent(dragEvent('dragend', transfer, y)))
  expect(host.querySelector('.spec-drop-before, .spec-drop-after')).toBeNull()
  return over.defaultPrevented
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  spec = { id: 'spec-pay', domainId: domain.id, title: '결제 명세', folder: 'pay', file: 'pay/spec.md', role: 'feature', version: 1, basedOn: [], acSeq: {}, content: '', features: [
    { id: 'PA-F01', name: '결제 시작', purpose: '첫 목적', status: '초안', acs: [1, 2, 3].map((num) => ({ id: `PA-F01-AC${num}`, num, text: `조건 ${num}` })) },
    { id: 'PA-F02', name: '환불', purpose: '둘째 목적', status: '초안', acs: [{ id: 'PA-F02-AC1', num: 1, text: '환불 조건' }] },
    { id: 'PA-F03', name: '결제 복구', purpose: '셋째 목적', status: '초안', acs: [] }
  ] }
  window.orbit = {
    getPathForFile: (file) => file.name,
    async invoke(name, ...args) {
      if (name === 'listSpecs') return [structuredClone(spec)]
      if (name === 'listDomains') return [domain]
      if (name === 'listDesigns') return []
      if (name === 'specStatus') return { stale: [], acStatus: { 'PA-F01-AC2': 'pass' } }
      if (name === 'saveFeatures') { spec.features = structuredClone(args[1] as Feature[]); spec.content = JSON.stringify(spec.features); return { spec, change: null, review: null } }
      throw new Error(`지원하지 않는 API: ${name}`)
    }, on: () => () => {}
  }
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('[SP-F02-AC4] 기능 행을 위아래로 옮겨도 편집·선택을 유지하고 저장 후 순서를 복원한다', async () => {
  await mount()
  await input(row('PA-F01').querySelector('textarea')!, '수정한 기능')
  await act(async () => row('PA-F01').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(await drag(row('PA-F03'), row('PA-F01'), 'before')).toBe(true)
  expect(featureIds()).toEqual(['PA-F03', 'PA-F01', 'PA-F02'])
  expect(await drag(row('PA-F03'), row('PA-F02'), 'after')).toBe(true)
  expect(featureIds()).toEqual(['PA-F01', 'PA-F02', 'PA-F03'])
  await drag(row('PA-F01'), row('PA-F03'), 'after')
  expect(row('PA-F01').querySelector('textarea')!.value).toBe('수정한 기능')
  expect(row('PA-F01').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  await click('표 저장')
  expect(spec.features.map((f) => f.id)).toEqual(['PA-F02', 'PA-F03', 'PA-F01'])
  await act(async () => root.unmount()); root = createRoot(host); await mount()
  expect(featureIds()).toEqual(['PA-F02', 'PA-F03', 'PA-F01'])
})

it('[SP-F02-AC4] 검색 중 순서를 옮겨도 숨은 기능을 보존하고 취소하면 순서가 그대로다', async () => {
  await mount()
  await input(host.querySelector<HTMLInputElement>('input[type="search"]')!, '결제')
  await drag(row('PA-F03'), row('PA-F01'), 'before', true)
  expect(featureIds()).toEqual(['PA-F01', 'PA-F03'])
  await drag(row('PA-F03'), row('PA-F01'), 'before')
  await input(host.querySelector<HTMLInputElement>('input[type="search"]')!, '')
  expect(featureIds()).toEqual(['PA-F03', 'PA-F01', 'PA-F02'])
  expect(row('PA-F02').querySelectorAll('textarea')[1].value).toBe('둘째 목적')
})

it('[SP-F03-AC3] AC 순서를 바꿔도 번호·본문·검증 상태를 유지하며 다른 기능으로 넘기지 않는다', async () => {
  await mount()
  await input(acs('PA-F01')[1].querySelector('textarea')!, '수정한 조건')
  expect(await drag(acs('PA-F01')[1], acs('PA-F01')[0], 'before')).toBe(true)
  expect(acIds('PA-F01')).toEqual(['PA-F01-AC2', 'PA-F01-AC1', 'PA-F01-AC3'])
  expect(acs('PA-F01')[0].querySelector('.badge.pass')).not.toBeNull()
  expect(acs('PA-F01')[0].querySelector('textarea')!.value).toBe('수정한 조건')
  expect(await drag(acs('PA-F01')[0], acs('PA-F02')[0], 'after')).toBe(false)
  expect(acIds('PA-F01')).toEqual(['PA-F01-AC2', 'PA-F01-AC1', 'PA-F01-AC3'])
  expect(featureIds()).toEqual(['PA-F01', 'PA-F02', 'PA-F03'])
  await click('표 저장')
  await act(async () => root.unmount()); root = createRoot(host); await mount()
  expect(acIds('PA-F01')).toEqual(['PA-F01-AC2', 'PA-F01-AC1', 'PA-F01-AC3'])
})

it('[SP-F03-AC3] 저장 전 새 AC 여러 개도 각각 구분해 옮기고 수정·삭제한다', async () => {
  await mount()
  await click('+ AC', row('PA-F03')); await click('+ AC', row('PA-F03'))
  const ids = acIds('PA-F03')
  expect(new Set(ids).size).toBe(2)
  await input(acs('PA-F03')[0].querySelector('textarea')!, '새 첫 조건')
  await input(acs('PA-F03')[1].querySelector('textarea')!, '새 둘째 조건')
  await drag(acs('PA-F03')[1], acs('PA-F03')[0], 'before')
  expect(acs('PA-F03').map((ac) => ac.querySelector('textarea')!.value)).toEqual(['새 둘째 조건', '새 첫 조건'])
  await click('×', acs('PA-F03')[1])
  expect(acIds('PA-F03')).toEqual([ids[1]])
})

it('[SP-F02-AC5] 기능 이모지를 선택·직접 입력·제거하고 표 저장 후 복원한다', async () => {
  await mount()
  await click('결제 시작 아이콘 설정')
  await click('💳 아이콘')
  expect(row('PA-F01').querySelector('.spec-feature-icon')!.textContent).toBe('💳')
  await click('결제 시작 아이콘 설정')
  await input(host.querySelector<HTMLInputElement>('#emoji-value')!, '👩🏽‍💻')
  await click('적용')
  await click('표 저장')
  expect(spec.features[0].icon).toBe('👩🏽‍💻')
  await act(async () => root.unmount()); root = createRoot(host); await mount()
  expect(row('PA-F01').querySelector('.spec-feature-icon')!.textContent).toBe('👩🏽‍💻')
  await click('결제 시작 아이콘 설정')
  await input(host.querySelector<HTMLInputElement>('#emoji-value')!, '잘못된 입력')
  await click('적용')
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('이모지 한 개')
  await click('취소')
  expect(row('PA-F01').querySelector('.spec-feature-icon')!.textContent).toBe('👩🏽‍💻')
  await click('결제 시작 아이콘 설정'); await click('아이콘 없애기'); await click('표 저장')
  expect(spec.features[0].icon).toBeUndefined()
})
