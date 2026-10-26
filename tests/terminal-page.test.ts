// @vitest-environment happy-dom
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Terminals from '../src/renderer/src/pages/Terminals'
import type { TerminalSnapshot } from '../src/core/terminal'
import type { TerminalGroup } from '../src/core/terminalWorkspace'
import * as ui from '../src/renderer/src/ui'

const writes = vi.hoisted(() => [] as string[])
const pastes = vi.hoisted(() => [] as string[])
const keyHandlers = vi.hoisted(() => [] as ((event: KeyboardEvent) => boolean)[])
const disposals = vi.hoisted(() => vi.fn())
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 100; rows = 30; options = {}
  input = (_data: string) => {}
  loadAddon() {} open() {} dispose() { disposals() } focus() {}
  onData(handler: (data: string) => void) { this.input = handler }
  paste(data: string) { pastes.push(data); this.input(data) }
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
let filePaths: WeakMap<File, string>
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

function dragEvent(type: string, transfer: DataTransfer, clientX = 110) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  // happy-dom의 DragEvent는 생성자에 전달한 포인터 좌표·DataTransfer를 보존하지 않는다.
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: clientX } })
  return event
}

function droppedFiles(paths: string[]) {
  const transfer = new DataTransfer()
  const files = paths.map((path) => {
    const file = new File(['fixture'], path.split(/[\\/]/).at(-1) || 'unknown.png')
    filePaths.set(file, path)
    return file
  })
  // happy-dom은 files와 types를 DataTransferItemList에서 구성하지 않는다.
  Object.defineProperties(transfer, { types: { value: ['Files'] }, files: { value: files } })
  return transfer
}

async function reorderByDrag(source: Element, target: Element, position: 'before' | 'after') {
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 100, 30))
  const transfer = new DataTransfer()
  const x = position === 'before' ? 110 : 190
  await act(async () => source.dispatchEvent(dragEvent('dragstart', transfer, x)))
  const over = dragEvent('dragover', transfer, x)
  await act(async () => target.dispatchEvent(over))
  expect(over.defaultPrevented).toBe(true)
  expect(target.classList.contains(`drop-${position}`)).toBe(true)
  await act(async () => target.dispatchEvent(dragEvent('drop', transfer, x)))
  await act(async () => source.dispatchEvent(dragEvent('dragend', transfer, x)))
  expect(host.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  host = document.createElement('div'); document.body.appendChild(host)
  saved = [{ ...first }, { ...second }]; active = first.id; calls = []; inputWrites = []; listeners = new Map(); writes.length = 0; keyHandlers.length = 0
  groups = []; activeGroup = 'all'; disposals.mockClear()
  pastes.length = 0; filePaths = new WeakMap()
  window.orbit = {
    getPathForFile: (file: File) => filePaths.get(file) ?? '',
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
      if (name === 'termReorderTab' || name === 'termReorderGroup') {
        const move = <T extends { id: string }>(items: T[]) => {
          const [item] = items.splice(items.findIndex((entry) => entry.id === args[0]), 1)
          items.splice(items.findIndex((entry) => entry.id === args[1]) + (args[2] === 'after' ? 1 : 0), 0, item)
        }
        if (name === 'termReorderTab') move(saved)
        else move(groups)
        return layout()
      }
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
  expect(writes.join('').match(/이전 출력/g)).toHaveLength(1)
  expect(writes.join('').match(/새 출력/g)).toHaveLength(1)
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

it('[TE-F01-AC11] 탭 100개의 화면은 선택할 때 만들고 숨긴 출력은 중복 없이 보관한다', async () => {
  saved = Array.from({ length: 100 }, (_, index) => ({ ...second, id: `many-${index}`, title: `작업 ${index}`, output: `기록 ${index}\n` }))
  active = saved[0].id
  await mount(false)
  expect(host.querySelectorAll('.term-tab')).toHaveLength(100)
  expect(host.querySelectorAll('.term-host')).toHaveLength(0)
  expect(writes).toEqual([])
  await act(async () => {
    listeners.get('term-data')?.({ id: saved[99].id, sequence: 1, data: '첫 번째 추가\n' })
    listeners.get('term-data')?.({ id: saved[99].id, sequence: 1, data: '중복 출력\n' })
    listeners.get('term-data')?.({ id: saved[99].id, sequence: 2, data: '두 번째 추가\n' })
  })
  await render(true)
  expect(host.querySelectorAll('.term-host')).toHaveLength(1)
  expect(writes).toEqual(['기록 0\n'])
  await click('작업 99')
  expect(host.querySelectorAll('.term-host')).toHaveLength(2)
  expect(writes.at(-1)).toBe('기록 99\n첫 번째 추가\n두 번째 추가\n')
  await click('작업 0')
  expect(writes.filter((value) => value === '기록 0\n')).toHaveLength(1)
  expect(calls).not.toContain('termCreate')
  expect(calls).not.toContain('termRestart')
})

it('[TE-F01-AC11] 처음 보는 탭의 대량 출력은 최근 20만 자를 보관하고 종료 상태도 표시한다', async () => {
  await mount()
  expect(host.querySelectorAll('.term-host')).toHaveLength(1)
  await act(async () => {
    listeners.get('term-data')?.({ id: second.id, sequence: 1, data: '오래된 기록' + 'x'.repeat(200000) })
    listeners.get('term-data')?.({ id: second.id, sequence: 2, data: '\n최근 기록' })
    listeners.get('term-exit')?.({ id: second.id, code: 0 })
  })
  expect(writes.join('')).not.toContain('최근 기록')
  await click('확인용 셸')
  expect(writes.at(-1)?.length).toBeLessThanOrEqual(200000)
  expect(writes.at(-1)).toContain('최근 기록')
  expect(writes.at(-1)).toContain('프로세스 종료: 0')
  expect(writes.at(-1)).not.toContain('오래된 기록')
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
  await click('서버 작업 그룹 이름 변경')
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
  expect(writes.join('').match(/이전 출력/g)).toHaveLength(1)
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

it('[TE-F02-AC7] 드래그 위치 앞뒤에 탭을 넣으며 선택·소속·터미널 화면을 유지한다', async () => {
  groups = [{ id: 'group-server', title: '서버' }, { id: 'group-client', title: '클라이언트' }]
  saved[0].groupId = groups[0].id; saved[1].groupId = groups[1].id
  await mount()
  const terminal = host.querySelector('.term-host')
  const outputBefore = [...writes]
  const firstTab = host.querySelectorAll('.term-tab')[0]
  const secondTab = host.querySelectorAll('.term-tab')[1]
  await reorderByDrag(secondTab, firstTab, 'before')
  expect([...host.querySelectorAll('.term-tab-select')].map((button) => button.textContent)).toEqual(['확인용 셸클라이언트', '결제 작업서버'])
  await reorderByDrag(secondTab, firstTab, 'after')
  expect(saved.map((tab) => tab.id)).toEqual([first.id, second.id])
  expect(saved.map((tab) => tab.groupId)).toEqual(['group-server', 'group-client'])
  expect(active).toBe(first.id)
  expect(host.querySelector('.term-host')).toBe(terminal)
  expect(writes).toEqual(outputBefore)
  expect(disposals).not.toHaveBeenCalled()
  expect(calls.filter((name) => name === 'termReorderTab')).toHaveLength(2)
  expect(calls).not.toContain('termMoveToGroup')
  await reorderByDrag(secondTab, firstTab, 'before')
  await act(async () => root.unmount())
  await mount()
  expect(host.querySelector('.term-tab-select')?.textContent).toContain('확인용 셸')
  expect(host.querySelector('.term-tab.on')?.textContent).toContain('결제 작업')
})

it('[TE-F02-AC1] [TE-F02-AC8] 그룹을 앞뒤로 정렬하고 선택하지 않은 그룹도 연필 버튼으로 이름을 바꾼다', async () => {
  groups = [{ id: 'group-server', title: '서버' }, { id: 'group-client', title: '클라이언트' }, { id: 'group-docs', title: '문서' }]
  saved[0].groupId = groups[0].id; saved[1].groupId = groups[1].id; activeGroup = groups[0].id
  await mount()
  const terminal = host.querySelector('.term-host')
  const outputBefore = [...writes]
  const wrappers = [...host.querySelectorAll('.term-group-wrap')]
  expect(wrappers.slice(0, 2).every((group) => group.getAttribute('draggable') === 'false')).toBe(true)
  await reorderByDrag(wrappers[4], wrappers[2], 'before')
  expect([...host.querySelectorAll('.term-group')].map((button) => button.textContent)).toEqual(['전체2', '미분류0', '문서0', '서버1', '클라이언트1'])
  await reorderByDrag(wrappers[4], wrappers[3], 'after')
  await click('클라이언트 그룹 이름 변경')
  await saveName('프런트엔드')
  expect(groups.map((group) => group.title)).toEqual(['서버', '프런트엔드', '문서'])
  expect(activeGroup).toBe('group-server')
  expect(active).toBe(first.id)
  expect(host.querySelector('.term-host')).toBe(terminal)
  expect(writes).toEqual(outputBefore)
  expect(disposals).not.toHaveBeenCalled()
  expect(calls).not.toContain('termSelectGroup')
  expect(calls.filter((name) => name === 'termReorderGroup')).toHaveLength(2)
  await act(async () => root.unmount())
  await mount()
  expect([...host.querySelectorAll('.term-group')].map((button) => button.textContent)).toEqual(['전체2', '미분류0', '서버1', '프런트엔드1', '문서0'])
})

it('[TE-F02-AC7] [TE-F02-AC8] 취소·자기 자신·기본 그룹·다른 종류에 놓으면 순서를 바꾸지 않는다', async () => {
  groups = [{ id: 'group-server', title: '서버' }, { id: 'group-client', title: '클라이언트' }]
  await mount()
  const wrappers = [...host.querySelectorAll('.term-group-wrap')]
  const tab = host.querySelector('.term-tab')!
  const transfer = new DataTransfer()
  await act(async () => wrappers[3].dispatchEvent(dragEvent('dragstart', transfer)))
  await act(async () => wrappers[2].dispatchEvent(dragEvent('dragover', transfer)))
  expect(host.querySelector('.drop-after')).not.toBeNull()
  await act(async () => wrappers[3].dispatchEvent(dragEvent('dragend', transfer)))
  expect(host.querySelector('.drop-after')).toBeNull()
  for (const target of [wrappers[0], wrappers[1], wrappers[3], tab]) {
    await act(async () => wrappers[3].dispatchEvent(dragEvent('dragstart', transfer)))
    const over = dragEvent('dragover', transfer)
    await act(async () => target.dispatchEvent(over))
    expect(over.defaultPrevented).toBe(false)
    await act(async () => target.dispatchEvent(dragEvent('drop', transfer)))
  }
  await act(async () => tab.dispatchEvent(dragEvent('dragstart', transfer)))
  await act(async () => tab.dispatchEvent(dragEvent('drop', transfer)))
  expect(groups.map((group) => group.id)).toEqual(['group-server', 'group-client'])
  expect(saved.map((item) => item.id)).toEqual([first.id, second.id])
  expect(calls).not.toContain('termReorderTab')
  expect(calls).not.toContain('termReorderGroup')
  expect(calls).not.toContain('termMoveToGroup')
})

it.each(['codex', 'claude'] as const)('[TE-F01-AC12] %s 터미널에 사진·파일을 함께 놓으면 활성 입력창에 추가하고 전송하지 않는다', async (kind) => {
  saved[0].kind = kind
  await mount()
  const area = host.querySelector('.term-area')!
  const transfer = droppedFiles(['C:\\사진 폴더\\첫 사진.png', "C:\\사진 폴더\\second's.png", 'C:\\설계 문서.md'])
  const over = dragEvent('dragover', transfer)
  await act(async () => area.dispatchEvent(over))
  expect(over.defaultPrevented).toBe(true)
  expect(transfer.dropEffect).toBe('copy')
  expect(host.querySelector('.term-file-drop')?.textContent).toContain('결제 작업')
  const drop = dragEvent('drop', transfer)
  await act(async () => area.dispatchEvent(drop))
  expect(drop.defaultPrevented).toBe(true)
  expect(host.querySelector('.term-file-drop')).toBeNull()
  expect(pastes).toEqual(['"C:/사진 폴더/첫 사진.png" ', '"C:/사진 폴더/second\'s.png" ', '"C:/설계 문서.md" '])
  expect(inputWrites.every((input) => input.id === first.id && !/[\r\n]/.test(input.data))).toBe(true)
  expect(inputWrites.filter((input) => input.data === '\x05')).toHaveLength(kind === 'codex' ? 3 : 0)
  expect(calls).not.toContain('termCreate')
  expect(calls).not.toContain('termReorderTab')
  expect(active).toBe(first.id)
})

it('[TE-F01-AC12] 선택한 셸에만 인용한 파일 경로를 넣고 드래그를 취소하면 표시를 지운다', async () => {
  await mount()
  await click('확인용 셸')
  const area = host.querySelector('.term-area')!
  const transfer = droppedFiles(["C:\\a'b\\한 글.png", 'C:\\$(echo oops);file.txt'])
  await act(async () => area.dispatchEvent(dragEvent('dragenter', transfer)))
  expect(host.querySelector('.term-file-drop')).not.toBeNull()
  await act(async () => area.dispatchEvent(dragEvent('dragleave', transfer)))
  expect(host.querySelector('.term-file-drop')).toBeNull()
  expect(inputWrites).toEqual([])
  await act(async () => area.dispatchEvent(dragEvent('drop', transfer)))
  expect(inputWrites).toEqual([{ id: second.id, data: "'C:\\a''b\\한 글.png' 'C:\\$(echo oops);file.txt' " }])
})

it('[TE-F01-AC12] 탭이나 화면 밖에 파일을 놓아도 탐색·정렬·입력이 발생하지 않는다', async () => {
  await mount()
  const transfer = droppedFiles(['C:\\photo.png'])
  for (const target of [host.querySelector('.term-tab')!, document.body]) {
    const drop = dragEvent('drop', transfer)
    await act(async () => target.dispatchEvent(drop))
    expect(drop.defaultPrevented).toBe(true)
  }
  const tabDrag = new DataTransfer()
  tabDrag.setData('application/x-orbit-terminal', first.id)
  await act(async () => host.querySelector('.term-area')!.dispatchEvent(dragEvent('drop', tabDrag)))
  expect(inputWrites).toEqual([])
  expect(calls).not.toContain('termReorderTab')
  expect(calls).not.toContain('termMoveToGroup')
})

it.each(['종료', '빈 목록', '숨김', '이름 편집'] as const)('[TE-F01-AC12] %s 상태에서는 파일을 입력하지 않는다', async (state) => {
  if (state === '종료') saved[0].exited = 0
  if (state === '빈 목록') { saved = []; active = null }
  await mount(state !== '숨김')
  if (state === '이름 편집') await click('결제 작업 이름 변경')
  const area = host.querySelector('.term-area')!
  const transfer = droppedFiles(['C:\\photo.png'])
  await act(async () => area.dispatchEvent(dragEvent('dragover', transfer)))
  expect(transfer.dropEffect).toBe('none')
  expect(host.querySelector('.term-file-drop')).toBeNull()
  await act(async () => area.dispatchEvent(dragEvent('drop', transfer)))
  expect(inputWrites).toEqual([])
})

it('[TE-F01-AC12] 읽을 수 없는 파일은 알림을 보이고 일부만 입력하지 않는다', async () => {
  const error = vi.spyOn(ui, 'errorToast').mockImplementation(() => {})
  await mount()
  await act(async () => host.querySelector('.term-area')!.dispatchEvent(dragEvent('drop', droppedFiles(['C:\\ok.png', '']))))
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('파일 경로') }))
  expect(inputWrites).toEqual([])
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
