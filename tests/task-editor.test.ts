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
    async invoke(name: string, ...args: unknown[]) {
      calls.push({ name, args })
      if (name === 'listTasks') return saved ? [saved] : []
      if (name === 'listInbox' || name === 'dueTasks' || name === 'listDomains' || name === 'snapshotFiles') return []
      if (name === 'createTask') {
        saved = { id: 'task-0001', title: '', body: '', type: 'feature', horizon: '지금', priority: '보통', status: '대기', links: [], created: '', file: '/tasks/task-0001.md', ...args[0] as Partial<Task> }
        return saved
      }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on() { return () => {} }
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals()
})

it('새 Task의 세부 내용을 Markdown으로 작성하고 편집·원문 전환과 저장·재열기에서 보존한다', async () => {
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('Task 추가')
  const modal = host.querySelector('.modal')!
  expect(modal.querySelector('.md-editor')).not.toBeNull()
  await input(modal.querySelector<HTMLInputElement>('input')!, '결제 검증')
  const selects = modal.querySelectorAll('select')
  await input(selects[0], 'feature')
  await input(selects[1], '지금')
  await click('원문')
  const markdown = '## 검증 계획\n\n**결제**를 확인한다.\n\n- [ ] 서버 확인\n\n```ts\nconst ok = true\n```'
  await input(modal.querySelector<HTMLTextAreaElement>('.task-body')!, markdown)
  await click('편집')
  expect(modal.querySelector('.md-editor h2')!.textContent).toBe('검증 계획')
  expect(modal.querySelector('.md-editor strong')!.textContent).toBe('결제')
  expect(modal.querySelector('.md-editor pre code')!.textContent).toContain('const ok = true')
  const block = modal.querySelector<HTMLDivElement>('.md-editor h2')!.closest('.md-block')!
  await act(async () => {
    block.querySelector('h2')!.textContent = '최종 검증 계획'
    block.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const checkbox = modal.querySelector<HTMLInputElement>('.task-checklist input')!
  await act(async () => checkbox.click())
  await click('원문')
  const expected = markdown.replace('## 검증 계획', '## 최종 검증 계획').replace('- [ ]', '- [x]')
  expect(modal.querySelector<HTMLTextAreaElement>('.task-body')!.value).toBe(expected)
  await click('Task 만들기')
  expect(calls.find((call) => call.name === 'createTask')!.args[0]).toMatchObject({ title: '결제 검증', body: expected })
  await click('결제 검증')
  expect(host.querySelector('.modal .md-editor h2')!.textContent).toBe('최종 검증 계획')
  await click('원문')
  expect(host.querySelector<HTMLTextAreaElement>('.task-body')!.value).toBe(expected)
})
