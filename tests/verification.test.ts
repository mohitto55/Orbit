import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { acStatuses, invalidLinks, parseJUnit, scanTestLinks, summarize } from '../src/core/verification'
import type { Feature } from '../src/core/spec'
import { tempDir } from './helpers'

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
