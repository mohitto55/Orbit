// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import type { Domain, Design, Knowledge } from '../src/renderer/src/types'
import { buildDomainMapFrom } from '../src/core/domainmap'

// 터미널 프로세스는 이 화면 이동 검증에서 실행하지 않는다.
vi.mock('../src/renderer/src/pages/Terminals', () => ({ default: () => null }))

const domain = (id: string, title: string, parent?: string): Domain => ({
  id, title, parent, folder: id, subdomainType: 'Core', version: 1, status: 'active', links: [], content: '', role: '', model: []
})
const domains = [domain('root', '서비스'), domain('child', '하위 도메인', 'root'), domain('leaf', '세부 도메인', 'child')]
const designs: (Design & { stale: [] })[] = ['첫 설계', '두 번째 설계'].map((title, i) => ({
  id: `design-${i}`, title, folder: 'leaf', file: `/project/design-${i}.md`, system: false, version: 1,
  basedOn: [], refs: [], content: `## ${title}`, stale: []
}))
const knowledge: Knowledge = { id: 'memo', title: '탐색 메모', type: '결정', status: '유효', content: '저장된 메모', sources: [], file: '/project/memo.md' }
const requests = ['요청 A', '요청 B'].map((note, i) => ({ id: `req-${i}`, domain: 'leaf', note, excerpt: note, source: 'test', status: 'pending', created: `2026-10-29T0${i}:00:00Z` }))
let host: HTMLDivElement, root: Root, projectDir: string
let calls: string[], listeners: Map<string, Set<(value: unknown) => void>>

const shown = () => host.querySelector<HTMLElement>('.page-view:not([hidden])')!
async function click(text: string, scope: ParentNode = shown()) {
  const button = [...scope.querySelectorAll('button')].find((b) => {
    const label = b.cloneNode(true) as HTMLButtonElement
    label.querySelectorAll('.badge, .count').forEach((badge) => badge.remove())
    return label.textContent?.trim() === text
  })
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}
const navigate = (text: string) => click(text, host.querySelector('nav')!)
async function input(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function openDesign() {
  await click('문서로'); await click('세부 도메인'); await click('설계 (3층)'); await click('두 번째 설계')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  projectDir = '/project'; calls = []; listeners = new Map()
  localStorage.clear(); localStorage.setItem('orbit:last-page', 'domains')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  const project = () => ({ projectDir, dataRoot: `${projectDir}/docs`, settings: { name: projectDir, driftIntervalDays: 7, reminderTime: '09:00' } })
  window.orbit = {
    getPathForFile: (file: File) => file.name,
    async invoke(name: string, ...args: unknown[]) {
      calls.push(name)
      if (name === 'currentProject') return project()
      if (name === 'listPipelineRuns') return { runs: [], total: 0 }
      if (name === 'recentProjects') return ['/other-project']
      if (name === 'closeProject') return
      if (name === 'openProject') { projectDir = String(args[0]); return project() }
      if (name === 'dashboard') return { pendingReviews: 0, pendingRequests: 0, inbox: 0, dueTasks: [], pendingSessions: 0, driftDue: false }
      if (name === 'updateStatus') return { state: 'dev', currentVersion: 'test' }
      if (name === 'updateSettings') return { autoCheck: false, autoDownload: false }
      if (name === 'listDomains') return structuredClone(domains)
      if (name === 'domainMap') return buildDomainMapFrom(domains)
      if (name === 'listRequests') return structuredClone(requests)
      if (name === 'listDesigns') return structuredClone(designs)
      if (name === 'listKnowledge') return [structuredClone(knowledge)]
      if (['listSpecs', 'pendingItems', 'listReviews', 'scanTests', 'changesById'].includes(name)) return []
      if (name === 'docIndex' || name === 'allAcStatuses') return {}
      if (name === 'requestDraft') return null
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, callback) {
      const set = listeners.get(channel) ?? new Set(); set.add(callback); listeners.set(channel, set)
      return () => { set.delete(callback) }
    }
  }
  await act(async () => root.render(createElement(App)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); localStorage.clear(); vi.unstubAllGlobals()
})

it('[PL-F01-AC3] 메뉴를 왕복해도 하위 도메인·설계·작성 내용·검색과 스크롤을 유지한다', async () => {
  expect(calls).not.toContain('listKnowledge') // 아직 방문하지 않은 화면은 읽지 않는다.
  await openDesign()
  const domainPage = shown(), editor = domainPage.querySelector<HTMLTextAreaElement>('.md-source')!
  await input(editor, '## 작성 중인 두 번째 설계\n\n다른 화면을 보고 돌아올 내용')
  domainPage.querySelector<HTMLElement>('.pane-main')!.scrollTop = 240
  const reads = calls.filter((name) => name === 'listDomains').length

  await navigate('지식')
  expect(domainPage.hidden).toBe(true)
  await input(shown().querySelector<HTMLInputElement>('input[placeholder="검색"]')!, '탐색')
  const memo = [...shown().querySelectorAll<HTMLButtonElement>('.tree-item')].find((b) => b.textContent?.includes('탐색 메모'))!
  await act(async () => memo.click())
  const memoEditor = shown().querySelector<HTMLTextAreaElement>('.md-source')!
  await input(memoEditor, '메모 작성 중')
  await act(async () => { for (const listener of listeners.get('files-changed') ?? []) listener(null) })
  expect(calls.filter((name) => name === 'listDomains')).toHaveLength(reads)

  await navigate('도메인')
  expect(shown()).toBe(domainPage)
  expect(shown().querySelector('.tabs .on')?.textContent).toBe('설계 (3층)')
  expect(shown().querySelector('.split.inner .tree-item.on')?.textContent?.trim()).toBe('두 번째 설계')
  expect(shown().querySelector('.md-source')).toBe(editor)
  expect(editor.value).toContain('작성 중인 두 번째 설계')
  expect(shown().querySelector<HTMLElement>('.pane-main')!.scrollTop).toBe(240)
  expect(calls.filter((name) => name === 'listDomains')).toHaveLength(reads + 1)

  await navigate('지식')
  expect(shown().querySelector<HTMLInputElement>('input[placeholder="검색"]')!.value).toBe('탐색')
  expect(shown().querySelector('.md-source')).toBe(memoEditor)
  expect(memoEditor.value).toBe('메모 작성 중')
})

it('[PL-F01-AC3] 보존된 변경 검토 화면에서도 바로가기가 지정한 탭과 요청으로 이동한다', async () => {
  await navigate('변경 검토')
  await click('확인할 문서')
  await navigate('도메인')
  await click('문서로'); await click('세부 도메인'); await click('요청 A')
  expect(shown().querySelector('.drift-tabs .on')?.textContent).toContain('변경 요청')
  expect(shown().querySelector('.review-item.on')?.textContent).toContain('요청 A')

  await navigate('도메인')
  await click('요청 B')
  expect(shown().querySelector('.review-item.on')?.textContent).toContain('요청 B')
  await click('도메인 문서 열어서 고치기')
  expect(shown().querySelector('h2')?.textContent).toContain('세부 도메인')
})

it('[PL-F01-AC3] 프로젝트를 닫으면 보관한 화면을 해제하여 다른 프로젝트에 섞이지 않는다', async () => {
  await openDesign()
  const previous = shown()
  await click('프로젝트 닫기', host)
  expect(host.querySelector('.page-view')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('.recent button')!.click())
  expect(projectDir).toBe('/other-project')
  expect(shown()).not.toBe(previous)
  expect(shown().querySelector('.md-source')).toBeNull()
  expect(shown().textContent).toContain('왼쪽에서 도메인을 고르면')
})
