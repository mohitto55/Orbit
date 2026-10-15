// @vitest-environment happy-dom
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Terminals from '../src/renderer/src/pages/Terminals'
import type { TerminalSnapshot } from '../src/core/terminal'

const writes = vi.hoisted(() => [] as string[])
const keyHandlers = vi.hoisted(() => [] as ((event: KeyboardEvent) => boolean)[])
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 100; rows = 30; options = {}
  loadAddon() {} open() {} dispose() {} focus() {} onData() {}
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { keyHandlers.push(handler) }
  write(data: string) { writes.push(data) }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

let root: Root
let host: HTMLDivElement
let calls: string[]
let inputWrites: { id: string; data: string }[]
let saved: TerminalSnapshot[]
let active: string | null
let listeners: Map<string, (data: unknown) => void>
const first: TerminalSnapshot = { id: 'term-one', kind: 'codex', title: '결제 작업', pid: 1, sessionId: 'saved-id', output: '이전 출력', sequence: 1 }
const second: TerminalSnapshot = { id: 'term-two', kind: 'shell', title: '확인용 셸', pid: 2, output: '셸 출력', sequence: 0 }

async function mount() {
  root = createRoot(host)
  await act(async () => root.render(createElement(StrictMode, null, createElement(Terminals, { visible: true }))))
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
  if (!button) throw new Error(`버튼 없음: ${label}`)
  await act(async () => button.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  host = document.createElement('div'); document.body.appendChild(host)
  saved = [{ ...first }, { ...second }]; active = first.id; calls = []; inputWrites = []; listeners = new Map(); writes.length = 0; keyHandlers.length = 0
  window.orbit = {
    async invoke(name: string, ...args: unknown[]) {
      calls.push(name)
      if (name === 'termState') {
        const state = { tabs: structuredClone(saved), active }
        listeners.get('term-data')?.({ id: first.id, data: '이전 출력', sequence: 1 })
        listeners.get('term-data')?.({ id: first.id, data: '새 출력', sequence: 2 })
        return state
      }
      if (name === 'termActivate') { active = String(args[0]); return }
      if (name === 'termKill') { saved = saved.filter((tab) => tab.id !== args[0]); active = saved.at(-1)?.id ?? null; return }
      if (name === 'termRename') { const tab = saved.find((tab) => tab.id === args[0])!; tab.title = String(args[1]); return { ...tab } }
      if (name === 'termResize') return
      if (name === 'termWrite') { inputWrites.push({ id: String(args[0]), data: String(args[1]) }); return }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, cb) { listeners.set(channel, cb); return () => { listeners.delete(channel) } }
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals()
})

it('[TE-F01-AC3] 버튼을 누르지 않아도 탭·활성 탭·출력을 복원하고 겹치는 출력은 한 번만 그린다', async () => {
  await mount()
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('결제 작업')
  expect(host.textContent).not.toContain('저장된 대화')
  expect(calls.every((name) => name === 'termState' || name === 'termResize')).toBe(true)
  expect(writes.filter((text) => text === '이전 출력')).toHaveLength(1)
  expect(writes.filter((text) => text === '새 출력')).toHaveLength(1)
  await act(async () => host.querySelectorAll<HTMLElement>('.term-tab')[1].click())
  expect(active).toBe(second.id)
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('확인용 셸')
})

it('[TE-F01-AC4] 탭 이름 변경과 닫기를 저장하고 재마운트에도 반영한다', async () => {
  await mount()
  await click('결제 작업 이름 변경')
  const input = host.querySelector<HTMLInputElement>('#terminal-name')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '서버 작업')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(saved[0].title).toBe('서버 작업')
  await click('×')
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
  expect(host.querySelector('.term-tab')!.textContent).toContain('확인용 셸')
})

it.each(['codex', 'claude'] as const)('%s에서 Ctrl/Shift+Enter는 한 번만 줄바꿈하고 일반 Enter·붙여넣기·한글 조합은 가로채지 않는다', async (kind) => {
  saved = [{ ...first, kind }]
  await mount()
  const handler = keyHandlers.at(-1)!
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }]) {
    const before = inputWrites.length
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', cancelable: true, ...modifiers })
      expect(handler(event)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(inputWrites.slice(before)).toEqual([{ id: first.id, data: '\x1b\r' }])
  }
  const before = inputWrites.length
  expect(handler(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }))).toBe(true)
  expect(handler(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, isComposing: true }))).toBe(true)
  expect(handler(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, keyCode: 229 }))).toBe(true)
  const paste = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, cancelable: true })
  expect(handler(paste)).toBe(false)
  expect(paste.defaultPrevented).toBe(false)
  expect(inputWrites).toHaveLength(before)
})

it('일반 셸의 Enter 조합은 셸이 처리한다', async () => {
  saved = [{ ...second }]; active = second.id
  await mount()
  const handler = keyHandlers.at(-1)!
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }]) {
    expect(handler(new KeyboardEvent('keydown', { key: 'Enter', ...modifiers }))).toBe(true)
  }
  expect(inputWrites).toEqual([])
})
