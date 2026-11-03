// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Domains from '../src/renderer/src/pages/Domains'
import { AutomationProvider, useAutomation } from '../src/renderer/src/Automation'
import type { Domain, Feature, Spec } from '../src/renderer/src/types'
import type { PipelineRunRequest } from '../src/core/pipelineExecution'

let root: Root, host: HTMLDivElement, specs: Spec[], requests: PipelineRunRequest[]
let saved: Feature[] | undefined
const domains: Domain[] = ['로그인', '결제'].map((title, i) => ({ id: `domain-${i}`, title, folder: title, subdomainType: 'Core', version: 1, status: 'active', links: [], content: '', role: '', model: [] }))

async function click(text: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}
async function input(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  requests = []; saved = undefined
  specs = domains.map((d, i) => ({ id: `spec-${i}`, title: `${d.title} 명세`, domainId: d.id, folder: d.folder, file: `${d.folder}/spec.md`, role: 'feature', version: 1, basedOn: [], acSeq: {}, content: '', features: [
    { id: `F${i}-1`, name: `${d.title} 시작`, purpose: '유지할 목적', status: '초안', acs: [] },
    { id: `F${i}-2`, name: `${d.title} 복구`, purpose: '바꿀 목적', status: '초안', acs: [{ id: `F${i}-2-AC1`, num: 1, text: i ? 'PAYMENT 재시도' : '리프레시 토큰' }] }
  ] }))
  window.orbit = {
    getPathForFile: (file) => file.name,
    async invoke(name, ...args) {
      if (name === 'listDomains') return domains
      if (name === 'listSpecs') return structuredClone(specs)
      if (name === 'domainMap' || name === 'domainScope') return null
      if (name === 'allAcStatuses') return {}
      if (name === 'specStatus') return { stale: [], acStatus: {} }
      if (name === 'listDesigns' || name === 'listRequests') return []
      if (name === 'saveFeatures') { saved = args[1] as Feature[]; specs[0].features = structuredClone(saved); specs[0].version++; return { review: null } }
      if (name === 'listPipelineRuns') return { runs: [], total: 0 }
      if (name === 'termLayout') return { tabs: [] }
      if (name === 'pipelineSources') return [
        { kind: 'task', id: 'task-a', title: '로그인 검토' }, { kind: 'task', id: 'task-b', title: '결제 검토' },
        ...specs.map((s) => ({ kind: 'spec', id: s.id, title: s.title }))
      ]
      if (name === 'listPipelines') return [{ id: 'g', title: '명세 검증', nodes: [{ id: 'in', kind: 'function-input', params: [{ id: 'jobs', name: '할일', type: 'task[]' }, { id: 'doc', name: '명세', type: 'spec' }] }], edges: [] }]
      if (name === 'runPipelineBatch') { requests.push(args[0] as PipelineRunRequest); return [] }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on: () => () => {}
  }
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('도메인 전체에서 수용 기준을 검색해 명세를 열고 필터한 행을 수정해도 다른 행을 보존한다', async () => {
  await act(async () => root.render(createElement(Domains, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await input(host.querySelector<HTMLInputElement>('[aria-label="기능명세서 검색"]')!, '리프레시')
  expect([...host.querySelectorAll('.spec-search-result')].map((e) => e.textContent)).toEqual([expect.stringContaining('로그인 명세')])
  await act(async () => host.querySelector<HTMLButtonElement>('.spec-search-result')!.click())
  expect(host.querySelector<HTMLButtonElement>('.tabs .on')?.textContent).toBe('기능 명세 (2층)')
  expect(host.querySelector<HTMLInputElement>('[aria-label="기능명세서 검색"]')!.value).toBe('리프레시')
  await input(host.querySelector<HTMLInputElement>('[aria-label="명세 내 기능 검색"]')!, '리프레시')
  expect(host.querySelectorAll('table.spec tbody tr')).toHaveLength(1)
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="보이는 기능 전체 선택"]')!.click())
  expect(host.querySelector<HTMLInputElement>('[aria-label="로그인 복구 실행 대상 선택"]')!.checked).toBe(true)
  await input(host.querySelectorAll<HTMLTextAreaElement>('table.spec tbody textarea')[1], '수정한 목적')
  await click('표 저장')
  expect(saved?.map((f) => f.purpose)).toEqual(['유지할 목적', '수정한 목적'])
  await input(host.querySelector<HTMLInputElement>('[aria-label="명세 내 기능 검색"]')!, '')
  expect(host.querySelectorAll('table.spec tbody tr')).toHaveLength(2)
  expect(host.querySelector<HTMLInputElement>('[aria-label="로그인 시작 실행 대상 선택"]')!.checked).toBe(false)
  await input(host.querySelector<HTMLInputElement>('[aria-label="기능명세서 검색"]')!, 'payment')
  expect([...host.querySelectorAll('.spec-search-result')].map((e) => e.textContent)).toEqual([expect.stringContaining('결제 명세')])
})

function OpenAutomation() {
  const automation = useAutomation()
  return createElement('button', { onClick: () => automation.open([], 'g') }, '열기')
}

it('자동화에서 검색을 바꿔도 다중 선택을 유지하고 선택한 명세와 할일 ID만 전달한다', async () => {
  await act(async () => root.render(createElement(AutomationProvider, { go() {}, children: createElement(OpenAutomation) })))
  await click('열기')
  const taskSearch = host.querySelector<HTMLInputElement>('[aria-label="할일 검색"]')!
  await input(taskSearch, '로그인')
  await act(async () => host.querySelector<HTMLInputElement>('.source-options input')!.click())
  await input(taskSearch, '결제')
  await act(async () => host.querySelector<HTMLInputElement>('.source-options input')!.click())
  await input(taskSearch, '없는 결과')
  expect(host.querySelectorAll('.source-options input')).toHaveLength(0)
  expect(host.querySelectorAll('.source-selected button')).toHaveLength(2)
  await input(host.querySelector<HTMLInputElement>('[aria-label="명세 검색"]')!, '결제')
  const select = host.querySelector<HTMLSelectElement>('[aria-label="명세"]')!
  expect([...select.options].map((o) => o.value)).toEqual(['', 'spec-1'])
  await input(select, 'spec-1')
  await input(host.querySelector<HTMLInputElement>('[aria-label="명세 검색"]')!, '로그인')
  expect(select.value).toBe('spec-1')
  await click('1건 실행')
  expect(requests).toHaveLength(1)
  expect(requests[0].values).toEqual({ jobs: 'task-a\ntask-b', doc: 'spec-1' })
})
