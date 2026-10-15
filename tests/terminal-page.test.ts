// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Terminals from '../src/renderer/src/pages/Terminals'
import type { TerminalInfo } from '../src/core/terminal'

const writes = vi.hoisted(() => [] as string[])
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 100; rows = 30; options = {}
  loadAddon() {} open() {} dispose() {} focus() {} onData() {} attachCustomKeyEventHandler() {}
  write(data: string) { writes.push(data) }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

let root: Root | null
let host: HTMLDivElement
let savedTitle: string
let calls: { name: string; args: unknown[] }[]
let listeners: Map<string, (data: unknown) => void>
const info: TerminalInfo = { id: 'term-resumed', kind: 'codex', title: '이전 작업', pid: 1, sessionId: 'saved-id' }

async function mount() {
  root = createRoot(host)
  await act(async () => root!.render(createElement(Terminals, { visible: true })))
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`버튼 없음: ${label}`)
  await act(async () => button.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  host = document.createElement('div'); document.body.appendChild(host)
  root = null; savedTitle = '이전 작업'; calls = []; listeners = new Map(); writes.length = 0
  window.orbit = {
    async invoke(name: string, ...args: unknown[]) {
      calls.push({ name, args })
      if (name === 'termSessions') return { errors: [], sessions: [{ id: 'codex:saved-id', sessionId: 'saved-id', agent: 'codex', title: savedTitle, firstPrompt: '결제 정책', updatedAt: '2026-10-15T00:00:00Z' }] }
      if (name === 'termResume') {
        listeners.get('term-data')?.({ id: info.id, data: '초기 터미널 출력' })
        return { ...info, title: savedTitle }
      }
      if (name === 'termRenameSession') { savedTitle = String(args[1]); return }
      if (name === 'termKill' || name === 'termResize') return
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, cb) { listeners.set(channel, cb); return () => { listeners.delete(channel) } }
  }
})
afterEach(async () => {
  await act(async () => root?.unmount())
  host.remove(); vi.unstubAllGlobals()
})

describe('저장된 대화 화면', () => {
  it('[TE-F01-AC3] 선택한 대화를 재개하고 실행 중인 대화를 다시 누르면 같은 탭으로 간다', async () => {
    await mount()
    await click('저장된 대화')
    expect(host.textContent).toContain('이전 작업')
    await click('재개')
    expect(calls).toContainEqual({ name: 'termResume', args: ['codex:saved-id', 100, 30] })
    expect(writes).toContain('초기 터미널 출력')
    expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
    await click('저장된 대화')
    await click('재개')
    expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
    await click('×')
    expect(host.querySelectorAll('.term-tab')).toHaveLength(0)
  })

  it('[TE-F01-AC4] 저장된 대화 이름을 변경하고 화면을 다시 열어도 변경한 이름을 표시한다', async () => {
    await mount()
    await click('저장된 대화')
    await click('이름 변경')
    const input = host.querySelector<HTMLInputElement>('#terminal-name')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '결제 정책 수정')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(calls).toContainEqual({ name: 'termRenameSession', args: ['codex:saved-id', '결제 정책 수정'] })
    await act(async () => root!.unmount())
    await mount()
    await click('저장된 대화')
    expect(host.querySelector('.terminal-history')!.textContent).toContain('결제 정책 수정')
  })
})
