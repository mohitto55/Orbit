// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import Automation from '../src/renderer/src/pages/Automation'
import { summarizeRun, type RunFilter, type RunState } from '../src/core/pipeline'
import type { Task } from '../src/core/task'

vi.mock('../src/renderer/src/pages/Terminals', () => ({ default: () => null }))

let host: HTMLDivElement, root: Root, runs: RunState[]
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const run = (): RunState => ({ runId: 'run-active', pipelineId: 'graph', title: '작업 처리', status: 'running', started: '2026-11-02T09:35:00Z', sources: [{ kind: 'task', id: 'task-active', title: '실행 중인 작업' }], nodes: { work: { status: 'running', name: '처리' } } })
const task: Task = { id: 'task-other', title: '다른 작업', body: '', type: 'research', status: '대기', horizon: '지금', priority: '보통', links: [], created: '', file: '' }
const shown = () => host.querySelector<HTMLElement>('.page-view:not([hidden])')!
async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`버튼 없음: ${label}`)
  await act(async () => button.click())
}
const emit = (state: RunState) => { for (const listener of listeners.get('pipeline-state') ?? []) listener(structuredClone(state)) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear(); localStorage.setItem('orbit:last-page', 'tasks')
  runs = []; listeners.clear()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  window.orbit = {
    getPathForFile: (file) => file.name,
    async invoke(name, ...args) {
      if (name === 'currentProject') return { projectDir: '/project', dataRoot: '/project/.orbit', settings: { name: 'Project', driftIntervalDays: 7, reminderTime: '09:00' } }
      if (name === 'dashboard') return { pendingReviews: 0, pendingRequests: 0, inbox: 0, dueTasks: [], pendingSessions: 0, driftDue: false }
      if (name === 'updateStatus') return { state: 'dev', currentVersion: 'test' }
      if (name === 'updateSettings') return { autoCheck: false, autoDownload: false }
      if (name === 'listTasks') return [task]
      if (['listInbox', 'dueTasks', 'listDomains'].includes(name)) return []
      if (name === 'listPipelineRuns') {
        const filter = (args[0] ?? {}) as RunFilter
        const matching = runs.map(summarizeRun).filter((r) => !filter.source || r.sources.some((s) => s.kind === filter.source!.kind && s.id === filter.source!.id))
        const counts = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 }
        for (const r of matching) counts[r.waiting ? 'waiting' : r.status]++
        const rows = matching.filter((r) => !filter.status || (r.waiting ? 'waiting' : r.status) === filter.status)
        return { runs: rows, total: rows.length, counts }
      }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, callback) {
      const set = listeners.get(channel) ?? new Set(); set.add(callback); listeners.set(channel, set)
      return () => { set.delete(callback) }
    }
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); localStorage.clear(); listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('특정 할일의 빈 실행 기록을 본 뒤 자동화 메뉴를 누르면 전체 실행 목록을 보여준다', async () => {
  runs = [run()]
  await act(async () => root.render(createElement(App)))
  await click('실행 기록', shown())
  expect(shown().querySelector('.run-table')).toBeNull()
  await click('자동화', host.querySelector('nav')!)
  expect(shown().querySelector('.run-table')?.textContent).toContain('실행 중인 작업')
  expect(shown().textContent).toContain('실행 중 1')
})

it('상태 이벤트가 계속 들어와도 실행 목록 갱신을 미루지 않는다', async () => {
  await act(async () => root.render(createElement(Automation, { refreshKey: 0, go() {}, reloadBadges() {} })))
  expect(host.querySelector('.run-table')).toBeNull()
  runs = [run()]
  for (let i = 0; i < 4; i++) await act(async () => { emit(runs[0]); await vi.advanceTimersByTimeAsync(50) })
  expect(host.querySelector('.run-table')?.textContent).toContain('실행 중인 작업')
  runs[0] = { ...runs[0], status: 'done', nodes: { work: { status: 'done', name: '처리' } } }
  await act(async () => { emit(runs[0]); await vi.advanceTimersByTimeAsync(150) })
  expect(host.querySelector('.run-table .run-status')?.textContent).toContain('완료')
})
