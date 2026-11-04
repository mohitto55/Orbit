// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
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

const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.modal .cm-content')!)!
async function body(value: string) {
  const view = editor()
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.userEvent.of('input.paste') }))
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

it('[TK-F11-AC5] 서식이 보이는 본문에서 바로 편집·체크하고 저장·재열기에서도 원문을 보존한다', async () => {
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('Task 추가')
  const modal = host.querySelector('.modal')!
  expect(modal.querySelector('[contenteditable="true"][aria-label="세부 내용"]')).not.toBeNull()
  await input(modal.querySelector<HTMLInputElement>('input')!, '결제 검증')
  const selects = modal.querySelectorAll('select')
  await input(selects[0], 'feature')
  await input(selects[1], '지금')
  const view = editor()
  expect(modal.querySelector('textarea')).toBeNull()
  expect(modal.textContent).not.toContain('미리보기')
  expect([...modal.querySelectorAll('button')].some((b) => /편집/.test(b.textContent ?? ''))).toBe(false)
  const markdown = '## 검증 계획\n\n**결제**를 확인한다.\n줄바꿈 한 번\n\n\n- [ ] 서버 확인\n\n```ts\nconst ok = true\n```'
  await body(markdown)
  expect(modal.querySelector('.cm-md-h2')!.textContent).toBe('검증 계획')
  expect(modal.querySelector('.cm-md-strong')!.textContent).toBe('결제')
  expect(modal.querySelector('.live-markdown')!.textContent).toContain('const ok = true')
  await act(async () => view.dispatch({ changes: { from: 3, insert: '최종 ' } }))
  expect(editor()).toBe(view)
  const checkbox = modal.querySelector<HTMLInputElement>('.live-markdown input[type="checkbox"]')!
  expect(checkbox.disabled).toBe(false)
  await act(async () => checkbox.click())
  const expected = markdown.replace('## 검증 계획', '## 최종 검증 계획').replace('- [ ]', '- [x]')
  expect(view.state.sliceDoc()).toBe(expected)
  await click('Task 만들기')
  expect(calls.find((call) => call.name === 'createTask')!.args[0]).toMatchObject({ title: '결제 검증', body: expected })
  await click('결제 검증')
  expect(editor().state.sliceDoc()).toBe(expected)
  expect(host.querySelector('.modal .cm-md-h2')?.textContent).toBe('최종 검증 계획')
  const updated = expected + '\n\n추가 메모\n마지막 줄'
  await body(updated)
  await click('저장')
  expect(calls.find((call) => call.name === 'updateTask')!.args[1]).toMatchObject({ body: updated })
  await click('결제 검증')
  expect(editor().state.sliceDoc()).toBe(updated)
})

it('완료 조건이 늘어도 하나의 편집 본문만 유지하고 위에 목록을 중복 생성하지 않는다', async () => {
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('Task 추가')
  const modal = host.querySelector('.modal')!, content = modal.querySelector('.cm-content')!
  for (const count of [1, 50]) {
    await body(Array.from({ length: count }, (_, i) => `- [ ] 완료 조건 ${i + 1}`).join('\n'))
    expect(modal.querySelector('.cm-content')).toBe(content)
    expect(modal.querySelectorAll('.cm-content')).toHaveLength(1)
    expect(modal.querySelector('textarea')).toBeNull()
    expect(modal.querySelectorAll('input[type="checkbox"]')).toHaveLength(count)
    expect(modal.querySelectorAll('.cm-content input[type="checkbox"]')).toHaveLength(count)
  }
})

it('기존 할 일은 마크다운으로 열리고 본문의 체크 변경도 취소하면 저장하지 않는다', async () => {
  saved = { id: 'task-0001', title: '기존 할 일', body: '## 해야 할 일\n\n- [ ] 검증', type: 'feature', horizon: '지금', priority: '보통', status: '대기', links: [], created: '', file: '/tasks/task-0001.md' }
  const original = saved.body
  await act(async () => root.render(createElement(Tasks, { refreshKey: 0, reloadBadges() {}, go() {} })))
  await click('기존 할 일')
  expect(host.querySelector('.modal .cm-md-h2')?.textContent).toBe('해야 할 일')
  await act(async () => host.querySelector<HTMLInputElement>('.modal .cm-content input[type="checkbox"]')!.click())
  expect(editor().state.sliceDoc()).toContain('- [x] 검증')
  await click('취소')
  expect(saved.body).toBe(original)
  expect(calls.some((call) => call.name === 'updateTask')).toBe(false)
  await click('기존 할 일')
  expect(host.querySelector<HTMLInputElement>('.modal .cm-content input[type="checkbox"]')?.checked).toBe(false)
})
