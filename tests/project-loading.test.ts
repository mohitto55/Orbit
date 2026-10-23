import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { createApi } from '../src/main/api'
import { recordChange } from '../src/core/changes'
import * as impact from '../src/core/impact'
import { writeMd } from '../src/core/md'
import * as verification from '../src/core/verification'
import { newProject } from './helpers'

const apis: ReturnType<typeof createApi>[] = []
afterEach(() => { for (const api of apis.splice(0)) api.closeProject(); vi.restoreAllMocks() })

async function setup() {
  const ctx = await newProject()
  const send = vi.fn()
  const api = createApi({ send, pickFolder: async () => null, recentFile: path.join(ctx.projectDir, 'recent.json'), onProjectOpened() {} })
  apis.push(api)
  return { ctx, api, send }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('[WS-F02-AC7] 변경이 없는 프로젝트는 전체 소스 검사 없이 열린다', async () => {
  const { ctx, api } = await setup()
  const scan = vi.spyOn(verification, 'scanTestLinks').mockRejectedValue(new Error('전체 검사 불필요'))
  await expect(api.openProject(ctx.projectDir)).resolves.toMatchObject(ctx)
  expect(scan).not.toHaveBeenCalled()
})

it('[WS-F02-AC7] 오래 걸리는 검사를 기다리지 않고 프로젝트를 열며 완료 후 검토를 알린다', async () => {
  const { ctx, api, send } = await setup()
  const change = await recordChange(ctx, { target: 'spec-large', from: 1, to: 2, size: 'major', summary: '기능 변경', changed: [] })
  const started = deferred<void>()
  const done = deferred<verification.TestLink[]>()
  vi.spyOn(verification, 'scanTestLinks').mockImplementation(() => { started.resolve(); return done.promise })
  const review = vi.spyOn(impact, 'openReview').mockResolvedValue(null)
  let opened = false
  const opening = api.openProject(ctx.projectDir).then(() => { opened = true })
  try {
    await started.promise
    expect(opened).toBe(true)
    expect(review).not.toHaveBeenCalled()
  } finally { done.resolve([]); await opening }
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('files-changed', null))
  expect(review).toHaveBeenCalledWith(ctx, change, [])
})

it('[WS-F02-AC7] 프로젝트를 닫으면 진행 중인 검사를 취소하고 뒤늦은 검토·알림을 만들지 않는다', async () => {
  const { ctx, api, send } = await setup()
  await recordChange(ctx, { target: 'spec-large', from: 1, to: 2, size: 'major', summary: '기능 변경', changed: [] })
  const started = deferred<AbortSignal | undefined>()
  const done = deferred<verification.TestLink[]>()
  vi.spyOn(verification, 'scanTestLinks').mockImplementation((_dir, signal) => { started.resolve(signal); return done.promise })
  const review = vi.spyOn(impact, 'openReview').mockResolvedValue(null)
  await api.openProject(ctx.projectDir)
  const signal = await started.promise
  api.closeProject()
  expect(signal?.aborted).toBe(true)
  done.resolve([])
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(review).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('[WS-F02-AC7] 이미 검토를 생성한 변경은 소스 검사와 검토를 반복하지 않는다', async () => {
  const { ctx, api } = await setup()
  const change = await recordChange(ctx, { target: 'spec-large', from: 1, to: 2, size: 'major', summary: '이미 처리한 변경', changed: [] })
  await writeMd(path.join(ctx.dataRoot, 'reviews', 'existing.md'), {
    id: 'existing', trigger: change.id, items: [{ target: 'design-large', layer: 'design', status: 'pending', changes: [change.id] }]
  }, '')
  const scan = vi.spyOn(verification, 'scanTestLinks').mockResolvedValue([])
  const review = vi.spyOn(impact, 'openReview').mockResolvedValue(null)
  const list = vi.spyOn(impact, 'listReviews')
  await api.openProject(ctx.projectDir)
  await vi.waitFor(() => expect(list).toHaveBeenCalled())
  await list.mock.results[0].value
  // 두 파일 조회가 모두 끝난 뒤에도 복원 작업이 생기지 않는다.
  await fs.readdir(ctx.dataRoot)
  expect(scan).not.toHaveBeenCalled()
  expect(review).not.toHaveBeenCalled()
})

it('[WS-F02-AC7] 복원 오류는 열린 프로젝트를 닫지 않고 별도 알림으로 전달한다', async () => {
  const { ctx, api, send } = await setup()
  await recordChange(ctx, { target: 'spec-large', from: 1, to: 2, size: 'major', summary: '기능 변경', changed: [] })
  vi.spyOn(verification, 'scanTestLinks').mockRejectedValue(new Error('읽을 수 없는 테스트'))
  await expect(api.openProject(ctx.projectDir)).resolves.toMatchObject(ctx)
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('project-error', expect.stringContaining('읽을 수 없는 테스트')))
  expect(await api.currentProject()).toMatchObject(ctx)
})
