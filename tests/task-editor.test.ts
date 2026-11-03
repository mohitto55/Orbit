// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Tasks from '../src/renderer/src/pages/Tasks'
import type { Task } from '../src/core/task'

let root: Root
let host: HTMLDivElement
let saved: Task | null
let calls: { name: string; args: unknown[] }[]

async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}

async function input(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  saved = null; calls = []
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  window.orbit = {
    getPathForFile: (file: File) => file.name,
    async invoke(name: string, ...args: unknown[]) {
      calls.push({ name, args })
      if (name === 'listTasks') return saved ? [saved] : []
      if (name === 'listInbox' || name === 'dueTasks' || name === 'listDomains' || name === 'snapshotFiles') return []
      if (name === 'createTask') {
        saved = { id: 'task-0001', title: '', body: '', type: 'feature', horizon: '지금', priority: '보통', status: '대기', links: [], created: '', file: '/tasks/task-0001.md', ...args[0] as Partial<Task> }
        return saved
      }
      if (name === 'updateTask') { saved = { ...saved!, ...args[1] as Partial<Task> }; return saved }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on() { return () => {} }
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals()
})

it('[TK-F11-AC5] Task의 기본 마크다운 본문과 원문 편집·체크·저장·재열기에서 내용을 보존한다', async () => {
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('Task 추가')
  const modal = host.querySelector('.modal')!
  expect(modal.querySelector('.md-editor')).not.toBeNull()
  await input(modal.querySelector<HTMLInputElement>('input')!, '결제 검증')
  const selects = modal.querySelectorAll('select')
  await input(selects[0], 'feature')
  await input(selects[1], '지금')
  const area = modal.querySelector<HTMLTextAreaElement>('.md-source')!
  expect(area.style.display).toBe('none')
  expect(modal.textContent).not.toContain('미리보기')
  await click('편집')
  expect(area.style.display).toBe('')
  expect(modal.querySelector('[contenteditable="true"]')).toBeNull()
  const markdown = '## 검증 계획\n\n**결제**를 확인한다.\n줄바꿈 한 번\n\n\n- [ ] 서버 확인\n\n```ts\nconst ok = true\n```'
  await input(area, markdown)
  await click('편집 마치기')
  expect(modal.querySelector('.md-editor h2')!.textContent).toBe('검증 계획')
  expect(modal.querySelector('.md-editor strong')!.textContent).toBe('결제')
  expect(modal.querySelector('.md-editor pre code')!.textContent).toContain('const ok = true')
  await click('편집')
  await input(area, markdown.replace('## 검증 계획', '## 최종 검증 계획'))
  await click('편집 마치기')
  const checkbox = modal.querySelector<HTMLInputElement>('.md-editor input[type="checkbox"]')!
  expect(checkbox.disabled).toBe(false)
  await act(async () => checkbox.click())
  const expected = markdown.replace('## 검증 계획', '## 최종 검증 계획').replace('- [ ]', '- [x]')
  expect(area.value).toBe(expected)
  await click('Task 만들기')
  expect(calls.find((call) => call.name === 'createTask')!.args[0]).toMatchObject({ title: '결제 검증', body: expected })
  await click('결제 검증')
  const reopened = host.querySelector<HTMLTextAreaElement>('.modal .md-source')!
  expect(reopened.value).toBe(expected)
  expect(reopened.style.display).toBe('none')
  expect(host.querySelector('.modal .md-editor h2')?.textContent).toBe('최종 검증 계획')
  const updated = expected + '\n\n추가 메모\n마지막 줄'
  await click('편집')
  await input(reopened, updated)
  await click('저장')
  expect(calls.find((call) => call.name === 'updateTask')!.args[1]).toMatchObject({ body: updated })
  await click('결제 검증')
  expect(host.querySelector<HTMLTextAreaElement>('.modal .md-source')!.value).toBe(updated)
  expect(host.querySelector<HTMLTextAreaElement>('.modal .md-source')!.style.display).toBe('none')
})

it('완료 조건을 추가해도 입력칸 위에 목록이 중복 생성되지 않고 기본 본문에만 표시한다', async () => {
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('Task 추가')
  const modal = host.querySelector('.modal')!, area = modal.querySelector<HTMLTextAreaElement>('.md-source')!
  await click('편집')
  for (const count of [1, 50]) {
    await input(area, Array.from({ length: count }, (_, i) => `- [ ] 완료 조건 ${i + 1}`).join('\n'))
    expect(modal.querySelector('textarea')).toBe(area)
    expect(modal.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  }
  await click('편집 마치기')
  expect(modal.querySelectorAll('input[type="checkbox"]')).toHaveLength(50)
  expect(modal.querySelectorAll('.md-editor input[type="checkbox"]')).toHaveLength(50)
})

it('기존 할 일은 마크다운으로 열리고 본문의 체크 변경도 취소하면 저장하지 않는다', async () => {
  saved = { id: 'task-0001', title: '기존 할 일', body: '## 해야 할 일\n\n- [ ] 검증', type: 'feature', horizon: '지금', priority: '보통', status: '대기', links: [], created: '', file: '/tasks/task-0001.md' }
  const original = saved.body
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('기존 할 일')
  const area = host.querySelector<HTMLTextAreaElement>('.modal .md-source')!
  expect(area.style.display).toBe('none')
  expect(host.querySelector('.modal h2')?.textContent).toBe('해야 할 일')
  await act(async () => host.querySelector<HTMLInputElement>('.modal .md-editor input[type="checkbox"]')!.click())
  expect(area.value).toContain('- [x] 검증')
  await click('취소')
  expect(saved.body).toBe(original)
  expect(calls.some((call) => call.name === 'updateTask')).toBe(false)
  await click('기존 할 일')
  expect(host.querySelector<HTMLInputElement>('.modal .md-editor input[type="checkbox"]')?.checked).toBe(false)
})
