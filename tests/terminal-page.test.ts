// @vitest-environment happy-dom
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Terminals from '../src/renderer/src/pages/Terminals'
import type { TerminalSnapshot } from '../src/core/terminal'
import type { TerminalGroup } from '../src/core/terminalWorkspace'

const writes = vi.hoisted(() => [] as string[])
const keyHandlers = vi.hoisted(() => [] as ((event: KeyboardEvent) => boolean)[])
const disposals = vi.hoisted(() => vi.fn())
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 100; rows = 30; options = {}
  loadAddon() {} open() {} dispose() { disposals() } focus() {} onData() {}
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
let groups: TerminalGroup[]
let activeGroup: string
let listeners: Map<string, (data: unknown) => void>
const first: TerminalSnapshot = { id: 'term-one', kind: 'codex', title: '결제 작업', pid: 1, sessionId: 'saved-id', output: '이전 출력', sequence: 1 }
const second: TerminalSnapshot = { id: 'term-two', kind: 'shell', title: '확인용 셸', pid: 2, output: '셸 출력', sequence: 0 }

function layout() { return { tabs: structuredClone(saved), groups: structuredClone(groups), active, activeGroup } }
function reconcile() {
  const visible = saved.filter((tab) => activeGroup === 'all' || (activeGroup === 'ungrouped' ? !tab.groupId : tab.groupId === activeGroup))
  if (!visible.some((tab) => tab.id === active)) active = visible.at(-1)?.id ?? null
}

async function mount(visible = true) {
  root = createRoot(host)
  await render(visible)
}
async function render(visible: boolean) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Terminals, { visible }))))
}
async function activity(id: string, value: 'idle' | 'working' | 'completed') {
  const tab = saved.find((item) => item.id === id)!
  tab.activity = value
  tab.activityRevision = (tab.activityRevision ?? 0) + 1
  await act(async () => listeners.get('term-info')?.({ ...tab }))
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
  if (!button) throw new Error(`버튼 없음: ${label}`)
  await act(async () => button.click())
}
async function saveName(value: string) {
  const input = host.querySelector<HTMLInputElement>('#terminal-name')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  host = document.createElement('div'); document.body.appendChild(host)
  saved = [{ ...first }, { ...second }]; active = first.id; calls = []; inputWrites = []; listeners = new Map(); writes.length = 0; keyHandlers.length = 0
  groups = []; activeGroup = 'all'; disposals.mockClear()
  window.orbit = {
    async invoke(name: string, ...args: unknown[]) {
      calls.push(name)
      if (name === 'termState') {
        const state = layout()
        listeners.get('term-data')?.({ id: first.id, data: '이전 출력', sequence: 1 })
        listeners.get('term-data')?.({ id: first.id, data: '새 출력', sequence: 2 })
        return state
      }
      if (name === 'termActivate') { active = String(args[0]); return layout() }
      if (name === 'termAcknowledge') {
        const tab = saved.find((item) => item.id === args[0])!
        if (tab.activity === 'completed' && tab.activityRevision === args[1]) {
          tab.activity = 'idle'; tab.activityRevision = (tab.activityRevision ?? 0) + 1
          listeners.get('term-info')?.({ ...tab })
        }
        return
      }
      if (['listPipelines', 'listTasks', 'listSkills', 'listSpecs', 'pipelineRuns'].includes(name)) return []
      if (name === 'termKill') { saved = saved.filter((tab) => tab.id !== args[0]); reconcile(); return layout() }
      if (name === 'termRename') { const tab = saved.find((tab) => tab.id === args[0])!; tab.title = String(args[1]); return { ...tab } }
      if (name === 'termSelectGroup') { activeGroup = String(args[0]); reconcile(); return layout() }
      if (name === 'termCreateGroup') { const group = { id: `group-${groups.length + 1}`, title: String(args[0]) }; groups.push(group); activeGroup = group.id; reconcile(); return layout() }
      if (name === 'termRenameGroup') { groups.find((g) => g.id === args[0])!.title = String(args[1]); return layout() }
      if (name === 'termMoveToGroup') { saved.find((tab) => tab.id === args[0])!.groupId = args[1] === null ? undefined : String(args[1]); reconcile(); return layout() }
      if (name === 'termDeleteGroup') {
        groups = groups.filter((g) => g.id !== args[0]); saved.forEach((tab) => { if (tab.groupId === args[0]) delete tab.groupId })
        if (activeGroup === args[0]) activeGroup = 'ungrouped'
        reconcile(); return layout()
      }
      if (name === 'termCreate') {
        const tab: TerminalSnapshot = { ...second, id: 'term-new', groupId: groups.some((g) => g.id === activeGroup) ? activeGroup : undefined }
        saved.push(tab); active = tab.id; return { ...tab }
      }
      if (name === 'termResize') return
      if (name === 'termWrite') { inputWrites.push({ id: String(args[0]), data: String(args[1]) }); return }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, cb) { listeners.set(channel, cb); return () => { listeners.delete(channel) } }
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('[TE-F01-AC3] 버튼을 누르지 않아도 탭·활성 탭·출력을 복원하고 겹치는 출력은 한 번만 그린다', async () => {
  await mount()
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('결제 작업')
  expect(host.textContent).not.toContain('저장된 대화')
  expect(calls.every((name) => name === 'termState' || name === 'termResize')).toBe(true)
  expect(writes.filter((text) => text === '이전 출력')).toHaveLength(1)
  expect(writes.filter((text) => text === '새 출력')).toHaveLength(1)
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.term-tab-select')[1].click())
  expect(active).toBe(second.id)
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('확인용 셸')
})

it('[TE-F01-AC4] 탭 이름 변경과 닫기를 저장하고 재마운트에도 반영한다', async () => {
  await mount()
  await click('결제 작업 이름 변경')
  await saveName('서버 작업')
  expect(saved[0].title).toBe('서버 작업')
  await click('×')
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
  expect(host.querySelector('.term-tab')!.textContent).toContain('확인용 셸')
})

it('[TE-F03-AC1] [TE-F03-AC2] 점은 작업 상태를 표시하고 사용자가 그 탭을 열어야 완료 알림이 해제된다', async () => {
  await mount()
  expect(host.querySelector('.term-tab.on .dot')?.getAttribute('aria-label')).toBe('기본 상태')
  await activity(first.id, 'working')
  expect(host.querySelector('.term-tab.on .dot')?.classList.contains('working')).toBe(true)
  await activity(second.id, 'completed')
  expect(host.querySelector('.dot.completed')?.getAttribute('title')).toBe('작업 완료 · 미확인')
  expect(calls).not.toContain('termAcknowledge')
  await click('확인용 셸')
  expect(host.querySelector('.term-tab.on .dot')?.classList.contains('idle')).toBe(true)
  expect(saved[0].activity).toBe('working')
  expect(calls.filter((call) => call === 'termAcknowledge')).toHaveLength(1)
})

it('[TE-F03-AC2] 다른 페이지·작업 그래프·비활성 창에서는 완료 알림을 유지하고 실제 터미널 화면으로 돌아오면 해제한다', async () => {
  await mount(false)
  await activity(first.id, 'working')
  await activity(first.id, 'completed')
  expect(saved[0].activity).toBe('completed')
  expect(calls).not.toContain('termAcknowledge')
  await render(true)
  expect(saved[0].activity).toBe('idle')
  await click('작업 그래프')
  await activity(first.id, 'working')
  await activity(first.id, 'completed')
  expect(saved[0].activity).toBe('completed')
  await click('터미널')
  expect(saved[0].activity).toBe('idle')
  await act(async () => window.dispatchEvent(new Event('blur')))
  await activity(first.id, 'working')
  await activity(first.id, 'completed')
  expect(saved[0].activity).toBe('completed')
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(saved[0].activity).toBe('idle')
})

it('[TE-F03-AC2] 뒤늦은 화면 정보가 새 작업 상태를 덮어쓰지 않으며 보고 있는 세션의 완료는 확인 처리한다', async () => {
  await mount()
  await activity(first.id, 'working')
  await act(async () => listeners.get('term-info')?.({ ...first, activity: 'completed', activityRevision: 0 }))
  expect(host.querySelector('.term-tab.on .dot')?.classList.contains('working')).toBe(true)
  expect(calls).not.toContain('termAcknowledge')
  await activity(first.id, 'completed')
  expect(host.querySelector('.term-tab.on .dot')?.classList.contains('idle')).toBe(true)
})

it('[DM-F02-AC4] 작업 그래프가 기존 터미널을 재사용하면 탭과 출력을 중복해서 만들지 않는다', async () => {
  await mount()
  const outputBefore = [...writes]
  const hostsBefore = host.querySelectorAll('.term-host').length
  await act(async () => listeners.get('term-created')?.({ ...first, output: '기존 출력 전체' }))
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelectorAll('.term-host')).toHaveLength(hostsBefore)
  expect(writes).toEqual(outputBefore)
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('결제 작업')
})

it('[TE-F02-AC1] [TE-F02-AC2] [TE-F02-AC5] 그룹 생성·선택 이동·이름 변경·해제 중에도 모든 터미널과 숨긴 출력을 유지한다', async () => {
  await mount()
  await click('+ 그룹')
  await saveName('서버 작업')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(0)
  expect(host.textContent).toContain('이 그룹에는 터미널이 없습니다')
  await click('전체 그룹, 터미널 2개')
  await click('결제 작업')
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="선택한 터미널의 그룹"]')!
    select.value = groups[0].id
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.querySelector('.term-tab-group')!.textContent).toBe('서버 작업')
  await click('서버 작업 그룹, 터미널 1개')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('결제 작업')
  await act(async () => listeners.get('term-data')?.({ id: second.id, data: '숨긴 셸의 새 출력', sequence: 1 }))
  expect(writes).toContain('숨긴 셸의 새 출력')
  await click('그룹 이름 변경')
  await saveName('백엔드')
  expect(host.querySelector('.term-group.on')!.textContent).toContain('백엔드')
  expect(saved[0].title).toBe(first.title)
  await click('그룹 해제')
  expect(host.querySelector('.term-group.on')!.textContent).toContain('미분류')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelectorAll('.term-host')).toHaveLength(2)
  expect(keyHandlers).toHaveLength(2)
  expect(disposals).not.toHaveBeenCalled()
  expect(calls).not.toContain('termKill')
  expect(calls).not.toContain('termRestart')
  expect(calls).not.toContain('termCreate')
  expect(writes.filter((text) => text === '이전 출력')).toHaveLength(1)
})

it('[TE-F02-AC2] [TE-F02-AC3] [TE-F02-AC4] 선택한 그룹에서 새 탭을 열고 드래그로 옮기며 다시 마운트해도 그룹을 복원한다', async () => {
  groups = [{ id: 'group-server', title: '서버' }, { id: 'group-client', title: '클라이언트' }]
  saved[0].groupId = groups[0].id; saved[1].groupId = groups[1].id; activeGroup = groups[0].id
  await mount()
  expect(host.querySelector('.term-group.on')!.textContent).toContain('서버')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
  await click('+ 터미널')
  expect(saved.find((tab) => tab.id === 'term-new')!.groupId).toBe(groups[0].id)
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  const transfer = new DataTransfer()
  // happy-dom의 DragEvent 생성자는 dataTransfer 초기값을 반영하지 않는다.
  const dragEvent = (type: string) => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    return event
  }
  await act(async () => {
    host.querySelector('.term-tab')!.dispatchEvent(dragEvent('dragstart'))
    const target = host.querySelector('[aria-label="클라이언트 그룹, 터미널 1개"]')!
    const over = dragEvent('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    target.dispatchEvent(dragEvent('drop'))
  })
  expect(saved[0].groupId).toBe(groups[1].id)
  expect(host.querySelectorAll('.term-tab')).toHaveLength(1)
  await click('클라이언트 그룹, 터미널 2개')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelectorAll('.term-host')).toHaveLength(3)
  expect(disposals).not.toHaveBeenCalled()
  expect(keyHandlers).toHaveLength(3)
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelector('.term-group.on')!.textContent).toContain('클라이언트')
  expect(host.querySelectorAll('.term-tab')).toHaveLength(2)
  expect(host.querySelector('.term-tab.on')!.textContent).toContain('확인용 셸')
  expect(calls).not.toContain('termKill')
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
  await act(async () => listeners.get('term-info')?.({ ...second, kind: 'codex', sessionId: 'manual-session' }))
  const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })
  expect(handler(newline)).toBe(false)
  expect(newline.defaultPrevented).toBe(true)
  expect(inputWrites).toEqual([{ id: second.id, data: '\x1b\r' }])
  await act(async () => listeners.get('term-info')?.(second))
  expect(handler(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))).toBe(true)
})
