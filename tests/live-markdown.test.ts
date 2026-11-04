// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import { LiveMarkdownEditor } from '../src/renderer/src/LiveMarkdownEditor'

let host: HTMLDivElement, root: Root, changed: string[]
// 브라우저와 달리 happy-dom은 Selection.collapse 중 selectionchange를 동기 전송한다.
const queuedSelection = new WeakSet<Event>()
const deferSelection = (event: Event) => {
  if (queuedSelection.has(event)) return
  event.stopImmediatePropagation()
  queueMicrotask(() => { const next = new Event('selectionchange'); queuedSelection.add(next); document.dispatchEvent(next) })
}
const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-content')!)!
async function mount(initial: string) {
  function Editor() {
    const [value, setValue] = useState(initial)
    return createElement(LiveMarkdownEditor, { value, onChange: (next: string) => { changed.push(next); setValue(next) } })
  }
  await act(async () => root.render(createElement(Editor)))
  return editor()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.addEventListener('selectionchange', deferSelection, true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); changed = []
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.removeEventListener('selectionchange', deferSelection, true); vi.unstubAllGlobals() })

it('[TK-F11-AC5] 제목·강조·인용·코드·표를 표시하고 편집하지 않은 원문은 그대로 둔다', async () => {
  const source = '# 제목\n\n**굵게** *강조* ~~취소~~ `코드`\n\n> 인용\n\n- 항목\n\n```md\n- [ ] 코드 안의 예제\n```\n\n| 항목 | 내용 |\n|---|---|\n| A | **값** |\n\n\n끝\n'
  const view = await mount(source)
  expect(host.querySelector('.cm-md-h1')?.textContent).toBe('제목')
  expect(host.querySelector('.cm-md-strong')?.textContent).toBe('굵게')
  expect(host.querySelector('.cm-md-em')?.textContent).toBe('강조')
  expect(host.querySelector('.cm-md-inline-code')?.textContent).toBe('코드')
  expect(host.querySelector('.cm-md-quote')?.textContent).toBe('인용')
  expect(host.querySelector('.cm-md-bullet')?.textContent).toBe('•')
  expect(host.querySelector('table strong')?.textContent).toBe('값')
  expect(host.querySelector('input[type="checkbox"]')).toBeNull()
  expect(view.state.sliceDoc()).toBe(source)
  expect(changed).toEqual([])
})

it('[TK-F11-AC5] 한글 본문을 편집할 때 서식·커서·편집기를 유지하고 실행 취소·재실행한다', async () => {
  const source = '## 제목\n\n**한글** 본문\n\n끝'
  const view = await mount(source), at = source.indexOf('한글')
  await act(async () => { view.focus(); view.dispatch({ selection: { anchor: at + 1 } }) })
  expect(host.querySelector('.cm-md-strong')).not.toBeNull()
  await act(async () => {
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const { node, offset } = view.domAtPos(at)
    expect(node.nodeType).toBe(Node.TEXT_NODE)
    node.nodeValue = node.nodeValue!.slice(0, offset) + '한글 입력 완료' + node.nodeValue!.slice(offset + 2)
    document.getSelection()!.collapse(node, offset + 8)
    await vi.waitFor(() => expect(view.state.sliceDoc()).toBe(source.replace('한글', '한글 입력 완료')))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  expect(editor()).toBe(view)
  expect(view.state.selection.main.head).toBe(at + 8)
  expect(changed.at(-1)).toBe(source.replace('한글', '한글 입력 완료'))
  await act(async () => { expect(undo(view)).toBe(true) })
  expect(changed.at(-1)).toBe(source)
  await act(async () => { expect(redo(view)).toBe(true) })
  expect(changed.at(-1)).toBe(source.replace('한글', '한글 입력 완료'))
})

it('[TK-F11-AC5] Enter는 같은 편집기 안에서 목록을 이어 쓰고 새 완료 조건은 미완료로 만든다', async () => {
  const view = await mount('- [x] 첫 항목')
  await act(async () => view.dispatch({ selection: { anchor: view.state.doc.length } }))
  const run = () => act(async () => { expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }), 'editor')).toBe(true) })
  await run()
  expect(view.state.doc.toString()).toBe('- [x] 첫 항목\n- [ ] ')
  await run()
  expect(view.state.doc.toString()).not.toMatch(/- \[ \] $/)
})

it('[TK-F12-AC2] 중첩·중복 문구의 체크 하나만 바꾸며 실행 취소와 CRLF 원문을 보존한다', async () => {
  const source = '## 조건\r\n\r\n- [ ] **확인**\r\n  - [ ] **확인**\r\n\r\n근거: [문서](./memo.md)\r\n'
  const view = await mount(source)
  const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  expect(boxes).toHaveLength(2)
  await act(async () => boxes[1].click())
  expect(changed.at(-1)).toBe(source.replace('  - [ ]', '  - [x]'))
  expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(true)
  await act(async () => { undo(view) })
  expect(changed.at(-1)).toBe(source)
  expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(false)
})

it('[TK-F11-AC5] 표를 클릭하면 해당 셀에서 바로 수정하고 원문 구조는 유지한다', async () => {
  const source = '| 항목 | 내용 |\n|---|---|\n| A | 값 |\n\n메모'
  const view = await mount(source), at = source.indexOf('값')
  await act(async () => host.querySelectorAll('td')[1].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })))
  expect(view.state.selection.main.head).toBe(at)
  expect(host.querySelector('table')).toBeNull()
  expect(host.querySelector('[contenteditable="true"]')).not.toBeNull()
  await act(async () => view.dispatch({ changes: { from: at, to: at + 1, insert: '수정한 값' } }))
  expect(changed.at(-1)).toBe(source.replace('값', '수정한 값'))
  await act(async () => { view.contentDOM.blur(); await vi.waitFor(() => expect(host.querySelectorAll('td')).toHaveLength(2)) })
  expect(host.querySelectorAll('td')[1].textContent).toBe('수정한 값')
})

it('[TK-F11-AC5] 표·HTML을 렌더링해도 스크립트와 위험한 속성을 실행 가능한 DOM으로 만들지 않는다', async () => {
  const source = '<div>설명<img src="x" onerror="alert(1)"><script>alert(1)</script></div>\n\n| 링크 |\n|---|\n| [위험](javascript:alert%281%29) |'
  const view = await mount(source)
  expect(host.querySelector('script,[onerror],a[href^="javascript:"]')).toBeNull()
  expect(view.state.sliceDoc()).toBe(source)
  expect(changed).toEqual([])
})
