import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { acStatuses, invalidLinks, loadLastRun, parseJUnit, saveRun, scanTestLinks, summarize } from '../src/core/verification'
import type { Feature } from '../src/core/spec'
import { listMd, readMd } from '../src/core/md'
import { newProject, tempDir } from './helpers'

/** 가짜 AC 태그. 소스에 대괄호 리터럴을 남기지 않아 스캐너가 실제 연결로 읽지 않게 한다. */
const tag = (id: string) => '[' + id + ']'

const features: Feature[] = [
  {
    id: 'PAY-F02',
    name: '가챠',
    purpose: '',
    status: '활성',
    acs: [
      { id: 'PAY-F02-AC1', num: 1, text: '천장' },
      { id: 'PAY-F02-AC2', num: 2, text: '확률표' },
      { id: 'PAY-F02-AC3', num: 3, text: '기록' }
    ]
  }
]

const junit = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="gacha">
    <testcase classname="gacha" name="${tag('PAY-F02-AC1')} 91회차 확정"/>
    <testcase classname="gacha" name="${tag('PAY-F02-AC2')} 합계 100%가 아니면 거부"><failure message="expected reject"/></testcase>
    <testcase classname="gacha" name="skip me"><skipped/></testcase>
  </testsuite>
</testsuites>`

describe('Verification', () => {
  it('[VR-F01-AC1] 테스트 코드에서 [기능ID-AC번호] 형식의 ID를 찾아 연결한다', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'gacha.test.ts'), `test("${tag('PAY-F02-AC1')} 천장", () => {})\n// ${tag('PAY-F02-AC2')} ${tag('PAY-F02-AC3')}\n`)
    await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true })
    await fs.writeFile(path.join(dir, 'node_modules', 'x', 'a.test.ts'), `${tag('PAY-F02-AC9')}`)
    const links = await scanTestLinks(dir)
    expect(links.map((l) => l.acId)).toEqual(['PAY-F02-AC1', 'PAY-F02-AC2', 'PAY-F02-AC3'])
    expect(links[0]).toMatchObject({ file: 'src/gacha.test.ts', line: 1 })
  })

  it('[VR-F01-AC3] 존재하지 않는 AC ID를 가리키는 테스트는 잘못된 연결이다', () => {
    const bad = invalidLinks([{ acId: 'PAY-F02-AC9', file: 'a', line: 1, text: '' }], features)
    expect(bad).toHaveLength(1)
  })

  it('[VR-F03-AC1] JUnit XML을 읽어 테스트별 통과/실패/건너뜀을 기록한다', () => {
    const results = parseJUnit(junit)
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'skipped'])
    expect(summarize('npm test', 1, results)).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 })
  })

  it('[VR-F03-AC2] 손상된 XML과 JUnit이 아닌 파일은 빈 성공 결과로 처리하지 않는다', () => {
    expect(() => parseJUnit('<testsuites><testsuite>')).toThrow(/JUnit XML/)
    expect(() => parseJUnit('<html>error</html>')).toThrow(/JUnit XML/)
    expect(parseJUnit('<testsuite/>')).toEqual([])
  })

  it('[VR-F07-AC3] 마지막 실행의 시각·결과·출력을 저장하고 다시 읽는다', async () => {
    const ctx = await newProject()
    const run = { ...summarize('npm test', 1, parseJUnit(junit)), output: '테스트 출력\n' }
    await saveRun(ctx, run)
    expect(await loadLastRun(ctx)).toEqual(run)
    // 같은 파일을 교체하는 다음 실행도 저장되고 임시 파일은 남지 않는다.
    const next = { ...summarize('npm test', 0, []), output: '다음 실행\n' }
    await saveRun(ctx, next)
    expect(await loadLastRun(ctx)).toEqual(next)
    expect(await fs.readdir(path.join(ctx.dataRoot, '.cache'))).toEqual(['last-run.json'])
  })

  it.each(['missing', 'broken', 'invalid'])('[VR-F07-AC3] 캐시가 %s 상태여도 가장 최근 이력의 요약을 복원한다', async (state) => {
    const ctx = await newProject()
    const older = { ...summarize('old test', 0, []), at: '2026-10-12T09:00:00.000Z' }
    const latest = { ...summarize('new test', 1, parseJUnit(junit)), at: '2026-10-13T09:00:00.000Z' }
    await saveRun(ctx, latest)
    await saveRun(ctx, older)
    const cache = path.join(ctx.dataRoot, '.cache', 'last-run.json')
    if (state === 'missing') await fs.rm(cache)
    else await fs.writeFile(cache, state === 'broken' ? '{' : JSON.stringify({ ...latest, results: [null] }))
    await fs.writeFile(path.join(ctx.dataRoot, 'verification', 'unreadable.md'), '---\nwrong: [\n---\n')
    expect(await loadLastRun(ctx)).toMatchObject({ ...latest, results: [] })
    // 요약만 남은 이력으로 테스트별 통과 결과를 만들어 내지 않는다.
    expect(acStatuses(features, [], await loadLastRun(ctx))['PAY-F02-AC1']).toBe('none')
  })

  it('[VR-F03-AC2] 결과 파일 오류는 이력에도 실패 원인으로 남는다', async () => {
    const ctx = await newProject()
    const run = summarize('npm test', 1, [], '결과 파일을 찾을 수 없습니다')
    await saveRun(ctx, run)
    const [file] = await listMd(path.join(ctx.dataRoot, 'verification'))
    const history = await readMd(file)
    expect(history.data.error).toBe(run.error)
    expect(history.content).toContain(run.error)
    expect(history.content).not.toContain('모두 통과')
    await fs.rm(path.join(ctx.dataRoot, '.cache', 'last-run.json'))
    expect(await loadLastRun(ctx)).toMatchObject(run)
  })

  it('[VR-F04-AC1] AC마다 통과 / 실패 / 테스트 없음 / 미실행 중 하나로 표시된다', () => {
    const links = [
      { acId: 'PAY-F02-AC1', file: 'a', line: 1, text: '' },
      { acId: 'PAY-F02-AC2', file: 'a', line: 2, text: '' }
    ]
    const run = summarize('t', 1, parseJUnit(junit))
    expect(acStatuses(features, links, run)).toEqual({ 'PAY-F02-AC1': 'pass', 'PAY-F02-AC2': 'fail', 'PAY-F02-AC3': 'none' })
    expect(acStatuses(features, links, null)['PAY-F02-AC1']).toBe('notrun')
  })

  it('[VR-F04-AC2] 연결된 테스트가 하나라도 실패하면 그 AC는 실패다', () => {
    const run = summarize('t', 1, [
      { name: `${tag('PAY-F02-AC1')} a`, classname: '', status: 'passed' },
      { name: `${tag('PAY-F02-AC1')} b`, classname: '', status: 'failed' }
    ])
    expect(acStatuses(features, [], run)['PAY-F02-AC1']).toBe('fail')
  })

  it('[VR-F05-AC3] 확인표시가 처리되기 전까지 통과해도 확인 필요로 표시된다', () => {
    const run = summarize('t', 0, [{ name: `${tag('PAY-F02-AC1')} a`, classname: '', status: 'passed' }])
    expect(acStatuses(features, [], run, new Set(['PAY-F02-AC1']))['PAY-F02-AC1']).toBe('review')
  })
})
