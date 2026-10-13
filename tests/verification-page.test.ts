// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Verification from '../src/renderer/src/pages/Verification'
import type { RunSummary, Spec, TestRunEvent, TestRunState } from '../src/renderer/src/types'

const acId = 'DEMO-F01-AC1'
const spec: Spec = {
  id: 'spec-demo', domainId: 'dom-demo', folder: 'demo', file: 'spec.md', title: '예제 기능 명세', role: 'feature',
  version: 1, basedOn: [], acSeq: {}, content: '',
  features: [{ id: 'DEMO-F01', name: '기능', purpose: '', status: '활성', acs: [{ id: acId, num: 1, text: '조건 확인' }] }]
}

let state: TestRunState
let snapshotResponse: Promise<TestRunState> | null
let finishRun: ((run: RunSummary) => void) | undefined
let listeners: Set<(event: TestRunEvent) => void>
let host: HTMLDivElement
let root: Root | null

function publish(event: TestRunEvent) {
  for (const listener of listeners) listener(event)
}

function output(chunk: string) {
  state = { ...state, revision: state.revision + 1, log: state.log + chunk }
  publish({ type: 'output', revision: state.revision, chunk })
}

function complete(error?: string) {
  const run: RunSummary = {
    at: '2026-10-13T03:00:00.000Z', command: 'npm test', exitCode: error ? 1 : 0,
    total: error ? 0 : 1, passed: error ? 0 : 1, failed: 0, skipped: 0,
    results: error ? [] : [{ name: '[' + acId + '] 조건', classname: '', status: 'passed' }],
    output: state.log, ...(error ? { error } : {})
  }
  state = { ...state, revision: state.revision + 1, running: false, run }
  publish({ type: 'state', state })
  finishRun?.(run)
  finishRun = undefined
}

async function mount() {
  root = createRoot(host)
  await act(async () => root!.render(createElement(Verification, { refreshKey: 0, reloadBadges: () => {}, go: () => {} })))
}

async function unmount() {
  await act(async () => root?.unmount())
  root = null
}

function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`버튼 없음: ${text}`)
  return found
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state = { revision: 0, running: false, log: '', run: null }
  snapshotResponse = null
  finishRun = undefined
  listeners = new Set()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = null
  window.orbit = {
    async invoke(name: string) {
      if (name === 'testState') return snapshotResponse ?? structuredClone(state)
      if (name === 'listSpecs') return [spec]
      if (name === 'scanTests') return [{ acId, file: 'demo.test.ts', line: 1, text: '' }]
      if (name === 'allAcStatuses') return { [spec.id]: { [acId]: state.run?.passed ? 'pass' : 'notrun' } }
      if (name === 'runTests') {
        state = { ...state, revision: state.revision + 1, running: true, log: '' }
        publish({ type: 'state', state })
        output('$ npm test\n')
        return new Promise<RunSummary>((resolve) => { finishRun = resolve })
      }
      if (name === 'stopTests') { complete('실행 중단'); return }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on(channel, cb) {
      if (channel !== 'test-state') throw new Error(`지원하지 않는 이벤트: ${channel}`)
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    }
  }
})

afterEach(async () => {
  await unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('테스트 화면 재진입', () => {
  it('[VR-F02-AC4] 실행 중 페이지를 나갔다 돌아오면 누적 출력·중단 버튼과 완료 결과가 보인다', async () => {
    await mount()
    await act(async () => button('테스트 실행').click())
    await act(async () => output('이동 전 출력\n'))
    await unmount()
    expect(listeners.size).toBe(0)
    output('다른 페이지에 있는 동안 출력\n')
    await mount()
    expect(button('중단')).toBeDefined()
    expect(host.querySelector('.log')?.textContent).toBe('$ npm test\n이동 전 출력\n다른 페이지에 있는 동안 출력\n')
    await act(async () => complete())
    expect(button('테스트 실행').disabled).toBe(false)
    expect(host.querySelectorAll('.card-value')[2].textContent).toBe('1/1')
    expect(host.querySelectorAll('.card-value')[0].textContent).toBe('100%')
    expect(host.textContent).toContain(new Date(state.run!.at).toLocaleString())
  })

  it('[VR-F07-AC3] 다른 페이지에서 실행이 끝나도 돌아왔을 때 결과와 출력이 복원된다', async () => {
    await mount()
    await act(async () => button('테스트 실행').click())
    await unmount()
    output('완료 출력\n')
    complete()
    await mount()
    expect(button('테스트 실행').disabled).toBe(false)
    expect(host.querySelector('.log')?.textContent).toContain('완료 출력')
    expect(host.querySelectorAll('.card-value')[2].textContent).toBe('1/1')
    expect(host.querySelectorAll('.card-value')[0].textContent).toBe('100%')
  })

  it.each([false, true])('[VR-F02-AC4] 초기 조회와 실시간 출력이 겹쳐도 누락·중복되지 않는다 (조회에 포함: %s)', async (included) => {
    state = { revision: 1, running: true, log: '이전 출력\n', run: null }
    let reply!: (state: TestRunState) => void
    snapshotResponse = new Promise((resolve) => { reply = resolve })
    const before = structuredClone(state)
    await mount()
    await act(async () => {
      output('새 출력\n')
      reply(included ? structuredClone(state) : before)
    })
    expect(host.querySelector('.log')?.textContent).toBe('이전 출력\n새 출력\n')
    expect(button('중단')).toBeDefined()
  })

  it('[VR-F02-AC4] 완료 알림보다 늦게 도착한 조회가 최신 결과를 덮어쓰지 않는다', async () => {
    state = { revision: 1, running: true, log: '실행 중\n', run: null }
    let reply!: (state: TestRunState) => void
    snapshotResponse = new Promise((resolve) => { reply = resolve })
    const before = structuredClone(state)
    await mount()
    await act(async () => {
      output('완료\n')
      complete()
      reply(before)
    })
    expect(button('테스트 실행').disabled).toBe(false)
    expect(host.querySelectorAll('.card-value')[2].textContent).toBe('1/1')
    expect(host.querySelector('.log')?.textContent).toBe('실행 중\n완료\n')
  })

  it('[VR-F03-AC2] 결과 파일 오류와 중단 상태도 재진입 후 표시된다', async () => {
    await mount()
    await act(async () => button('테스트 실행').click())
    await unmount()
    output('테스트 실행기의 원인 출력\n')
    await mount()
    await act(async () => button('중단').click())
    await unmount()
    await mount()
    expect(host.querySelectorAll('.card-value')[2].textContent).toBe('실행 오류')
    expect(host.querySelector('.banner.warn')?.textContent).toBe('실행 중단')
    expect(host.querySelector('.log')?.textContent).toContain('테스트 실행기의 원인 출력')
  })
})
