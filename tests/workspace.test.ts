import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createProject, openProject, readSettings, saveSettings, SUBDIRS, resolveDataRoot } from '../src/core/workspace'
import { createApi } from '../src/main/api'
import { tempDir } from './helpers'

describe('Workspace', () => {
  it('[WS-F01-AC1] 폴더를 고르면 데이터 폴더와 하위 폴더가 생성된다', async () => {
    const dir = await tempDir()
    const ctx = await createProject(dir)
    for (const d of SUBDIRS) {
      expect((await fs.stat(path.join(ctx.dataRoot, d))).isDirectory()).toBe(true)
    }
  })

  it('[WS-F01-AC2] project.md에 프로젝트 이름과 생성일이 기록된다', async () => {
    const ctx = await createProject(await tempDir(), '내 프로젝트')
    const s = await readSettings(ctx)
    expect(s.name).toBe('내 프로젝트')
    expect(s.created).toBeTruthy()
  })

  it('[WS-F01-AC3] git 저장소가 아니어도 생성할 수 있다', async () => {
    const dir = await tempDir()
    await expect(createProject(dir)).resolves.toBeTruthy()
  })

  it('[WS-F01-AC4] 인덱스 캐시가 .gitignore에 추가된다', async () => {
    const dir = await tempDir()
    await createProject(dir)
    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8')
    expect(gi).toContain('.orbit/.cache/')
  })

  it('[WS-F02-AC1] 데이터 폴더가 있는 폴더를 고르면 프로젝트로 열린다', async () => {
    const dir = await tempDir()
    await createProject(dir)
    const ctx = await openProject(dir)
    expect(ctx.dataRoot).toBe(path.join(dir, '.orbit'))
  })

  it('[WS-F02-AC4] 이름을 바꾸기 전 .girsktop/ 프로젝트도 그대로 열린다', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, '.girsktop'), { recursive: true })
    await fs.writeFile(path.join(dir, '.girsktop', 'project.md'), '---\nname: old\n---\n')
    expect((await openProject(dir)).dataRoot).toBe(path.join(dir, '.girsktop'))
  })

  it('[WS-F02-AC3] docs/domains 구조의 저장소도 열 수 있다', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, 'docs', 'domains'), { recursive: true })
    expect(await resolveDataRoot(dir)).toBe(path.join(dir, 'docs'))
  })

  it('[WS-F04-AC2] 설정은 project.md frontmatter에 저장된다', async () => {
    const ctx = await createProject(await tempDir())
    const s = await readSettings(ctx)
    await saveSettings(ctx, { ...s, testCommand: 'npm test', driftIntervalDays: 3 })
    const raw = await fs.readFile(path.join(ctx.dataRoot, 'project.md'), 'utf8')
    expect(raw).toContain('testCommand: npm test')
    expect((await readSettings(ctx)).driftIntervalDays).toBe(3)
  })

  it('최근 목록에서 제거해도 프로젝트 파일은 보존하며 다시 열면 목록에 추가한다', async () => {
    const dir = await tempDir('orbit-recents-'), recentFile = path.join(dir, 'recent.json')
    const first = await createProject(path.join(dir, 'first')), second = await createProject(path.join(dir, 'second'))
    const document = path.join(first.dataRoot, 'project.md'), original = await fs.readFile(document, 'utf8')
    const source = path.join(first.projectDir, 'source.txt')
    await fs.writeFile(source, '보존할 프로젝트 파일')
    await fs.writeFile(recentFile, JSON.stringify([first.projectDir, first.projectDir.replace(/\\/g, '/').toUpperCase(), second.projectDir]))
    const deps = { send() {}, pickFolder: async () => null, recentFile, onProjectOpened() {} }
    const api = createApi(deps)
    await api.removeRecentProject(first.projectDir)
    expect(JSON.parse(await fs.readFile(recentFile, 'utf8'))).toEqual([second.projectDir])
    expect(await fs.readFile(document, 'utf8')).toBe(original)
    expect(await fs.readFile(source, 'utf8')).toBe('보존할 프로젝트 파일')
    const restarted = createApi(deps)
    try {
      expect(await restarted.recentProjects()).toEqual([second.projectDir])
      await restarted.openProject(first.projectDir)
      expect(await restarted.recentProjects()).toEqual([first.projectDir, second.projectDir])
    } finally { restarted.closeProject() }
  })
})
