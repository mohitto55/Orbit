// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { Markdown } from '../src/renderer/src/Markdown'
import { LiveMarkdownEditor } from '../src/renderer/src/LiveMarkdownEditor'
import { setChecklistChecked } from '../src/renderer/src/checklistMarkdown'

let host: HTMLDivElement
let root: Root
const markdown = '## 제목 {#keep}\n\n첫 줄\n둘째 줄\n\n\n- [ ] 확인\n  - 하위 항목\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n| 용어 | 뜻 |\n| :--- | ---: |\n| a \\| b | 두 줄<br>내용 |\n\n[[task|할 일]]\n\n<details><summary>더보기</summary>원문</details>\n'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals()
})
const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-content')!)!

it('공통 편집기는 렌더링된 본문 하나로 열리고 문법·빈 줄·위키 링크를 보존한다', async () => {
  const onChange = vi.fn()
  const onWiki = vi.fn()
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: markdown, onChange, onWiki, label: '본문' })))
  const view = editor()
  expect(host.querySelector('textarea')).toBeNull()
  expect(host.querySelector('[contenteditable="true"][aria-label="본문"]')).not.toBeNull()
  expect(host.textContent).not.toContain('미리보기')
  expect(host.querySelector('.cm-md-h2')?.textContent).toBe('제목')
  expect(host.querySelector('table')).not.toBeNull()
  expect(host.querySelector('.cm-content')?.textContent).toContain('const a = 1')
  const link = host.querySelector<HTMLElement>('[data-wiki="task"]')!
  expect(link.textContent).toBe('할 일')
  await act(async () => link.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true })))
  expect(onWiki).toHaveBeenCalledWith('task')
  expect(editor()).toBe(view)
  expect(view.state.sliceDoc()).toBe(markdown)
  expect(onChange).not.toHaveBeenCalled()
})

it('저장 중에는 입력과 체크를 잠그고 저장 후 같은 편집기에서 계속 작성한다', async () => {
  const onChange = vi.fn()
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: markdown, onChange })))
  const view = editor()
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: markdown, onChange, disabled: true })))
  expect(view.state.readOnly).toBe(true)
  expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
  expect(host.querySelector<HTMLInputElement>('.cm-md-task-box')?.disabled).toBe(true)
  await act(async () => host.querySelector<HTMLInputElement>('.cm-md-task-box')!.click())
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: markdown, onChange })))
  expect(editor()).toBe(view)
  expect(view.contentDOM.getAttribute('contenteditable')).toBe('true')
  expect(host.querySelector<HTMLInputElement>('.cm-md-task-box')?.disabled).toBe(false)
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n추가 내용' } }))
  expect(onChange).toHaveBeenLastCalledWith(markdown + '\n추가 내용')
})

it('외부에서 갱신한 원문도 동일한 편집 본문에 반영하고 변경 콜백을 재호출하지 않는다', async () => {
  const onChange = vi.fn()
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: markdown, onChange })))
  const view = editor()
  const updated = markdown.replace('- [ ] 확인', '- [x] 확인')
  await act(async () => root.render(createElement(LiveMarkdownEditor, { value: updated, onChange })))
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
  expect(editor()).toBe(view)
  expect(view.state.sliceDoc()).toBe(updated)
  expect(onChange).not.toHaveBeenCalled()
})

it('본문에서 중첩·동일 문구의 체크 항목을 구분하고 HTML 예제·CRLF·원문 서식을 보존한다', async () => {
  const original = '## 제목 {#keep}\r\n\r\n[[task|할 일]]\r\n\r\n<input type="checkbox" data-checklist-index="0" checked>\r\n\r\n- [ ] **확인**\r\n\r\n  설명\r\n  - [ ] **확인**\r\n\r\n> 1. [X] 출시\r\n\r\n```md\r\n- [ ] 코드 예제\r\n```\r\n'
  let changed = original
  function Document() {
    const [value, setValue] = useState(original)
    return createElement(Markdown, { source: value, onChecklistToggle: (item, checked) => {
      changed = setChecklistChecked(value, item.offset, checked)
      setValue(changed)
    } })
  }
  await act(async () => root.render(createElement(Document)))
  const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes()).toHaveLength(4)
  expect(boxes().map((box) => box.disabled)).toEqual([true, false, false, false])
  expect(boxes()[2].getAttribute('aria-label')).toBe('확인')
  await act(async () => boxes()[2].click())
  expect(changed).toBe(original.replace('  - [ ] **확인**', '  - [x] **확인**'))
  expect(boxes().map((box) => box.checked)).toEqual([true, false, true, true])
  await act(async () => boxes()[3].click())
  expect(changed).toBe(original.replace('  - [ ] **확인**', '  - [x] **확인**').replace('1. [X]', '1. [ ]'))
  expect(host.querySelector('pre code')?.textContent).toBe('- [ ] 코드 예제\n')
})
