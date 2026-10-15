// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MdEditor } from '../src/renderer/src/Markdown'

it.each([false, true])('표 하단에 행을 추가하고 기존 편집과 새 행을 보존한다 (기존 행: %s)', async (hasRow) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const before = '## 용어 {#terms}\n\n'
  const after = '\n\n## 하지 않는 것\n\n기존 내용\n'
  let value = before + '| 용어 | 뜻 |\n| :--- | ---: |' + (hasRow ? '\n| 도메인 | 업무 영역 |' : '') + after
  const onChange = (next: string) => { value = next }
  try {
    await act(async () => root.render(createElement(MdEditor, { value, onChange })))
    const block = host.querySelector('table')!.closest<HTMLDivElement>('.md-block')!
    const edited = host.querySelector('td, th')!
    edited.textContent = '수정한 내용'
    await act(async () => block.dispatchEvent(new Event('input', { bubbles: true })))

    const add = host.querySelector<HTMLButtonElement>('button')!
    expect(add.textContent).toContain('+ 행 추가')
    await act(async () => add.click())
    let table = host.querySelector('table')!
    expect(table.rows).toHaveLength(hasRow ? 3 : 2)
    const row = table.rows[table.rows.length - 1]
    expect(row.cells).toHaveLength(2)
    expect(row.cells[1].style.textAlign).toBe('right')
    expect(window.getSelection()?.anchorNode).toBe(row.cells[0])
    expect(value).toContain('수정한 내용')
    expect(value).toContain('\n|  |  |')

    row.cells[0].textContent = '새 용어'
    row.cells[1].textContent = '새 설명'
    await act(async () => block.dispatchEvent(new Event('input', { bubbles: true })))
    await act(async () => block.blur())
    expect(value.startsWith(before)).toBe(true)
    expect(value.endsWith(after)).toBe(true)
    expect(value).toContain('| 새 용어 | 새 설명 |')

    await act(async () => root.render(createElement(MdEditor, { key: 'reload', value, onChange })))
    table = host.querySelector('table')!
    expect(table.rows).toHaveLength(hasRow ? 3 : 2)
    expect(table.rows[table.rows.length - 1].cells[0].textContent).toBe('새 용어')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
