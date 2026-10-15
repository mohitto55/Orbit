import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/main/api'
import * as drift from '../src/core/drift'
import { newProject, tempDir } from './helpers'

const junit = '<testsuites><testsuite><testcase name="first"/><testcase name="second"/></testsuite></testsuites>'

async function runner(xml: string | null = junit) {
  const ctx = await newProject()
  const send = vi.fn((_channel: string, _payload: unknown) => {})
  const deps = { send, pickFolder: async () => null, recentFile: path.join(ctx.projectDir, 'recent.json'), onProjectOpened: () => {} }
  const api = createApi(deps)
  await api.openProject(ctx.projectDir)
  if (xml !== null) await fs.writeFile(path.join(ctx.projectDir, 'fixture.xml'), xml)
  await fs.writeFile(path.join(ctx.projectDir, 'runner.cjs'), `
const fs = require('fs')
console.log('before navigation')
const timeout = setTimeout(() => process.exit(1), 10000)
const timer = setInterval(() => {
  if (!fs.existsSync('finish')) return
  clearInterval(timer)
  clearTimeout(timeout)
  if (fs.existsSync('fixture.xml')) {
    fs.mkdirSync('test-results', { recursive: true })
    fs.copyFileSync('fixture.xml', 'test-results/junit.xml')
  }
  console.error('after navigation')
}, 20)
`)
  await api.saveSettings({ ...await api.getSettings(), testCommand: `"${process.execPath}" runner.cjs` })
  const finish = () => fs.writeFile(path.join(ctx.projectDir, 'finish'), '')
  return { api, ctx, deps, send, finish }
}

describe('테스트 실행 상태와 저장', () => {
  it('[VR-F02-AC4] 화면이 없어도 실행 상태와 출력을 보관하고 중복 실행을 막는다', async () => {
    const { api, finish, deps, ctx } = await runner()
    const pending = api.runTests()
    try {
      await expect(api.runTests()).rejects.toThrow('이미 실행 중')
      await vi.waitFor(async () => expect((await api.testState()).log).toContain('before navigation'))
      expect(await api.testState()).toMatchObject({ running: true, run: null })
    } finally {
      await finish()
      await pending
    }
    const run = await pending
    expect(run).toMatchObject({ exitCode: 0, passed: 2, total: 2 })
    expect(run.error).toBeUndefined()
    expect(run.output).toContain('before navigation')
    expect(run.output).toContain('after navigation')
    expect(await api.testState()).toMatchObject({ running: false, run, log: run.output })
    expect(await api.lastRun()).toEqual(run)
    // 메모리가 없는 새 앱 인스턴스에서도 같은 결과와 출력이 복원된다.
    const reopened = createApi(deps)
    await reopened.openProject(ctx.projectDir)
    const restored = await reopened.testState()
    expect(restored).toMatchObject({ running: false, log: run.output })
    expect(restored.run).toEqual(run)
    // 대시보드의 관련 없는 대화 기록 스캔은 실제 사용자 폴더를 읽지 않는다.
    const sessions = vi.spyOn(drift, 'pendingSessionCount').mockResolvedValue(0)
    try {
      expect((await reopened.dashboard()).lastRun).toMatchObject({ at: run.at, passed: 2, total: 2 })
    } finally {
      sessions.mockRestore()
    }
  })

  it.each([null, '<testsuites><testsuite>'])('[VR-F03-AC2] 결과 파일이 없거나 손상돼도 실행을 저장하고 완료를 알린다 (%s)', async (xml) => {
    const { api, finish, send } = await runner(xml)
    await finish()
    const run = await api.runTests()
    expect(run.error).toMatch(/결과 파일|JUnit XML/)
    expect(run.output).toContain(run.error)
    expect(await api.lastRun()).toEqual(run)
    expect(await api.testState()).toMatchObject({ running: false, run })
    expect(send).toHaveBeenCalledWith('test-done', run)
    expect(send).toHaveBeenCalledWith('test-state', expect.objectContaining({ type: 'state', state: expect.objectContaining({ running: false, run }) }))
    // 오류 뒤에도 실행 잠금이 풀려 다시 시도할 수 있다.
    expect((await api.runTests()).error).toBeDefined()
  })

  it('[VR-F02-AC4] 실행 중 다른 프로젝트를 열어도 결과와 출력이 섞이지 않는다', async () => {
    const { api, finish, send, ctx } = await runner()
    const pending = api.runTests()
    try {
      await vi.waitFor(async () => expect((await api.testState()).log).toContain('before navigation'))
      api.closeProject()
      await api.createProject(await tempDir())
      send.mockClear()
      expect(await api.testState()).toMatchObject({ running: false, log: '', run: null })
    } finally {
      await finish()
      await pending
    }
    expect(send).not.toHaveBeenCalled()
    expect(await api.lastRun()).toBeNull()
    await api.openProject(ctx.projectDir)
    expect(await api.testState()).toMatchObject({ running: false, run: await pending })
  })
})
