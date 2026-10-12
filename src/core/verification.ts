import { promises as fs } from 'fs'
import path from 'path'
import { XMLParser } from 'fast-xml-parser'
import type { Ctx } from './workspace'
import { exists, writeMd, stamp, nowIso } from './md'
import type { Feature } from './spec'

export const AC_ID_RE = /\[([A-Z][A-Z0-9]*-F\d+-AC\d+)\]/g
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.(py|go)$)|(^test_.*\.py$)|(Tests?\.(java|kt|cs)$)/
const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'release', '.girsktop', '.venv', 'venv', 'target'])

export interface TestLink {
  acId: string
  file: string
  line: number
  text: string
}

export type TestStatus = 'passed' | 'failed' | 'skipped'

export interface TestResult {
  name: string
  classname: string
  status: TestStatus
  message?: string
}

export interface RunSummary {
  at: string
  command: string
  exitCode: number | null
  total: number
  passed: number
  failed: number
  skipped: number
  results: TestResult[]
  error?: string
}

export type AcStatus = 'pass' | 'fail' | 'none' | 'notrun' | 'review'

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), root, out)
    } else if (TEST_FILE_RE.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
}

export async function scanTestLinks(projectDir: string): Promise<TestLink[]> {
  const files: string[] = []
  await walk(projectDir, projectDir, files)
  const out: TestLink[] = []
  for (const f of files) {
    const lines = (await fs.readFile(f, 'utf8')).split(/\r?\n/)
    lines.forEach((text, i) => {
      for (const m of text.matchAll(AC_ID_RE)) {
        out.push({ acId: m[1], file: path.relative(projectDir, f).replace(/\\/g, '/'), line: i + 1, text: text.trim() })
      }
    })
  }
  return out
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

export function parseJUnit(xml: string): TestResult[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const doc = parser.parse(xml)
  const results: TestResult[] = []
  const visitSuite = (suite: any) => {
    for (const tc of asArray(suite.testcase)) {
      const failure = tc.failure ?? tc.error
      const status: TestStatus = failure !== undefined ? 'failed' : tc.skipped !== undefined ? 'skipped' : 'passed'
      const message =
        failure === undefined ? undefined : typeof failure === 'string' ? failure : failure.message ?? failure['#text']
      results.push({ name: String(tc.name ?? ''), classname: String(tc.classname ?? ''), status, message })
    }
    for (const child of asArray(suite.testsuite)) visitSuite(child)
  }
  if (doc.testsuites) visitSuite(doc.testsuites)
  else if (doc.testsuite) visitSuite({ testsuite: doc.testsuite })
  return results
}

export function summarize(command: string, exitCode: number | null, results: TestResult[], error?: string): RunSummary {
  return {
    at: nowIso(),
    command,
    exitCode,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
    ...(error ? { error } : {})
  }
}

/**
 * AC별 검증 상태.
 * 연결된 테스트가 하나라도 실패하면 실패, 확인 대기 중인 AC는 통과해도 확인 필요.
 */
export function acStatuses(
  features: Feature[],
  links: TestLink[],
  run: RunSummary | null,
  pendingReviewAcs: Set<string> = new Set()
): Record<string, AcStatus> {
  const out: Record<string, AcStatus> = {}
  const linked = new Set(links.map((l) => l.acId))
  for (const f of features) {
    if (f.status === '폐기') continue
    for (const ac of f.acs) {
      const tag = `[${ac.id}]`
      const rs = run ? run.results.filter((r) => r.name.includes(tag) || r.classname.includes(tag)) : []
      let s: AcStatus
      if (rs.some((r) => r.status === 'failed')) s = 'fail'
      else if (rs.some((r) => r.status === 'passed')) s = 'pass'
      else s = linked.has(ac.id) || rs.length ? 'notrun' : 'none'
      if (pendingReviewAcs.has(ac.id) && s !== 'fail') s = 'review'
      out[ac.id] = s
    }
  }
  return out
}

export function invalidLinks(links: TestLink[], features: Feature[]): TestLink[] {
  const known = new Set(features.flatMap((f) => f.acs.map((a) => a.id)))
  return links.filter((l) => !known.has(l.acId))
}

export async function saveRun(ctx: Ctx, run: RunSummary): Promise<void> {
  const cache = path.join(ctx.dataRoot, '.cache')
  await fs.mkdir(cache, { recursive: true })
  await fs.writeFile(path.join(cache, 'last-run.json'), JSON.stringify(run, null, 2), 'utf8')
  const failed = run.results.filter((r) => r.status === 'failed').map((r) => r.name)
  await writeMd(
    path.join(ctx.dataRoot, 'verification', `run-${stamp()}.md`),
    { kind: 'test-run', at: run.at, command: run.command, exitCode: run.exitCode, total: run.total, passed: run.passed, failed: run.failed, skipped: run.skipped },
    failed.length ? `## 실패\n\n${failed.map((n) => `- ${n}`).join('\n')}\n` : '모두 통과\n'
  )
}

export async function loadLastRun(ctx: Ctx): Promise<RunSummary | null> {
  const file = path.join(ctx.dataRoot, '.cache', 'last-run.json')
  if (!(await exists(file))) return null
  return JSON.parse(await fs.readFile(file, 'utf8'))
}
