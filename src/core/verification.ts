import { promises as fs } from 'fs'
import path from 'path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, stamp, nowIso } from './md'
import type { Feature } from './spec'

export const AC_ID_RE = /\[([A-Z][A-Z0-9]*-F\d+-AC\d+)\]/g
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.(py|go)$)|(^test_.*\.py$)|(Tests?\.(java|kt|cs)$)/
const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'release', '.orbit', '.girsktop', '.venv', 'venv', 'target', 'cdk.out', '__pycache__', 'coverage'])

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
  output?: string
}

export const TEST_OUTPUT_LIMIT = 200000

export interface TestRunState {
  revision: number
  running: boolean
  log: string
  run: RunSummary | null
}

export type TestRunEvent =
  | { type: 'state'; state: TestRunState }
  | { type: 'output'; revision: number; chunk: string }

export type AcStatus = 'pass' | 'fail' | 'none' | 'notrun' | 'review'

async function walk(dir: string, out: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    signal?.throwIfAborted()
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), out, signal)
    } else if (TEST_FILE_RE.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
}

export async function scanTestLinks(projectDir: string, signal?: AbortSignal): Promise<TestLink[]> {
  const files: string[] = []
  await walk(projectDir, files, signal)
  const out: TestLink[] = []
  for (const f of files) {
    signal?.throwIfAborted()
    const lines = (await fs.readFile(f, { encoding: 'utf8', signal })).split(/\r?\n/)
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
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`JUnit XML을 읽을 수 없습니다: ${valid.err.msg}`)
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const doc = parser.parse(xml)
  if (doc.testsuites === undefined && doc.testsuite === undefined) throw new Error('JUnit XML에 testsuites 또는 testsuite가 없습니다')
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
  // 조회 중인 화면이 쓰다 만 JSON을 읽지 않도록 완성된 파일로 교체한다.
  const temporary = path.join(cache, `last-run-${stamp()}.tmp`)
  try {
    await fs.writeFile(temporary, JSON.stringify(run, null, 2), 'utf8')
    await fs.rename(temporary, path.join(cache, 'last-run.json'))
  } finally {
    await fs.rm(temporary, { force: true })
  }
  const failed = run.results.filter((r) => r.status === 'failed').map((r) => r.name)
  const error = run.error || (run.exitCode !== 0 && !run.failed ? `테스트 명령 종료 코드: ${run.exitCode ?? '없음'}` : '')
  const body = [
    error ? `## 실행 오류\n\n${error}\n` : '',
    failed.length ? `## 실패\n\n${failed.map((n) => `- ${n}`).join('\n')}\n` : '',
    !error && !failed.length ? (run.total ? `통과 ${run.passed} / 건너뜀 ${run.skipped} / 전체 ${run.total}\n` : '실행된 테스트 없음\n') : ''
  ].filter(Boolean).join('\n')
  await writeMd(
    path.join(ctx.dataRoot, 'verification', `run-${stamp()}.md`),
    { kind: 'test-run', at: run.at, command: run.command, exitCode: run.exitCode, total: run.total, passed: run.passed, failed: run.failed, skipped: run.skipped, ...(error ? { error } : {}) },
    body
  )
}

type RunRecord = Omit<RunSummary, 'results' | 'output'>

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) && typeof r.command === 'string'
    && (r.exitCode === null || typeof r.exitCode === 'number')
    && ['total', 'passed', 'failed', 'skipped'].every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] >= 0)
    && (r.error === undefined || typeof r.error === 'string')
}

function isTestResult(value: unknown): value is TestResult {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.name === 'string' && typeof r.classname === 'string'
    && (r.status === 'passed' || r.status === 'failed' || r.status === 'skipped')
    && (r.message === undefined || typeof r.message === 'string')
}

export async function loadLastRun(ctx: Ctx): Promise<RunSummary | null> {
  const file = path.join(ctx.dataRoot, '.cache', 'last-run.json')
  try {
    const cached: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (isRunRecord(cached) && 'results' in cached && Array.isArray(cached.results) && cached.results.every(isTestResult)) {
      const output = 'output' in cached && typeof cached.output === 'string' ? cached.output : undefined
      return { ...cached, results: cached.results, output }
    }
  } catch {
    // 캐시가 없거나 손상되어도 버전 관리되는 실행 요약은 읽을 수 있다.
  }
  let latest: RunSummary | null = null
  for (const history of await listMd(path.join(ctx.dataRoot, 'verification'))) {
    try {
      const { data } = await readMd<unknown>(history)
      if (!isRunRecord(data) || !('kind' in data) || data.kind !== 'test-run') continue
      if (!latest || Date.parse(data.at) > Date.parse(latest.at)) latest = { ...data, results: [] }
    } catch {
      // 읽을 수 없는 이력 하나 때문에 다른 실행 기록까지 사라지지 않게 한다.
    }
  }
  return latest
}
