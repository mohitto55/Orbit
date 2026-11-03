// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Markdown, MdEditor } from '../src/renderer/src/Markdown'
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
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent === text)!
  await act(async () => button.click())
}
async function input(area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('공통 편집기는 원문으로 열리고 미리보기 전환 시 빈 줄·문법·커서를 그대로 보존한다', async () => {
  const onChange = vi.fn()
  const onWiki = vi.fn()
  await act(async () => root.render(createElement(MdEditor, { value: markdown, onChange, onWiki, label: '본문' })))
  const area = host.querySelector('textarea')!
  expect(area.value).toBe(markdown)
  expect(area.getAttribute('aria-label')).toBe('본문 Markdown 원문')
  expect(host.querySelector('[contenteditable="true"]')).toBeNull()
  expect(host.querySelector('h2')).toBeNull()
  area.focus(); area.setSelectionRange(12, 18)
  await click('미리보기')
  expect(area.style.display).toBe('none')
  expect(host.querySelector('h2')?.textContent).toBe('제목')
  expect(host.querySelector('table')).not.toBeNull()
  expect(host.querySelector('pre code')?.textContent).toContain('const a = 1\n\nconst b = 2')
  await click('할 일')
  expect(onWiki).toHaveBeenCalledWith('task')
  await click('편집')
  expect(host.querySelector('textarea')).toBe(area)
  expect(area.style.display).toBe('')
  expect(area.value).toBe(markdown)
  expect([area.selectionStart, area.selectionEnd]).toEqual([12, 18])
  expect(onChange).not.toHaveBeenCalled()
})

it('줄바꿈·한글 조합·붙여넣기·실행 취소 키는 기본 텍스트 입력에 맡기고 내용을 변환하지 않는다', async () => {
  let changed = ''
  function Editor() {
    const [value, setValue] = useState(markdown)
    return createElement(MdEditor, { value, onChange: (next: string) => { changed = next; setValue(next) } })
  }
  await act(async () => root.render(createElement(Editor)))
  const area = host.querySelector('textarea')!
  for (const init of [{ key: 'Enter' }, { key: 'Enter', shiftKey: true }, { key: 'Enter', isComposing: true }, { key: 'Backspace' }, { key: 'z', ctrlKey: true }, { key: 'v', ctrlKey: true }]) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    area.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  const next = markdown.replace('첫 줄\n둘째 줄', '수정한 첫 줄\n새 줄\n\n둘째 줄')
  await input(area, next)
  expect(changed).toBe(next)
  await click('미리보기'); await click('편집')
  expect(area.value).toBe(next)
})

it('체크 항목 변경 등 외부에서 갱신한 원문도 편집과 미리보기에 함께 반영한다', async () => {
  const onChange = vi.fn()
  await act(async () => root.render(createElement(MdEditor, { value: markdown, onChange })))
  const area = host.querySelector('textarea')!
  await click('미리보기')
  const updated = markdown.replace('- [ ] 확인', '- [x] 확인')
  await act(async () => root.render(createElement(MdEditor, { value: updated, onChange })))
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
  await click('편집')
  expect(area.value).toBe(updated)
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
