import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { diffLines } from 'diff'
import type { Ctx } from './workspace'
import { readSnapshot, type ChangeSet } from './changes'
import { listDomains, domainFile } from './domain'
import { listSpecs } from './spec'
import { listDesigns } from './design'

const run = promisify(execFile)

export type LineType = 'add' | 'del' | 'ctx'

export interface DiffLine {
  type: LineType
  text: string
  oldNo?: number
  newNo?: number
}

export interface Hunk {
  /** 이 덩어리 앞에서 접힌(같은) 줄 수 */
  skippedBefore: number
  lines: DiffLine[]
}

export interface LineDiff {
  hunks: Hunk[]
  /** 끝에서 접힌 줄 수 */
  skippedAfter: number
  added: number
  removed: number
}

/** GitHub처럼 줄 단위로 비교하고, 바뀐 곳 주변 context 줄만 남기고 나머지는 접는다. context < 0 이면 접지 않는다. */
export function lineDiff(before: string, after: string, context = 3): LineDiff {
  const all: DiffLine[] = []
  let o = 1
  let n = 1
  // 끝 줄바꿈 유무 차이로 마지막 줄이 바뀐 것처럼 보이지 않게 맞춘다
  const norm = (x: string) => (x === '' || x.endsWith('\n') ? x : x + '\n')
  for (const part of diffLines(norm(before), norm(after))) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const text of lines) {
      if (part.added) all.push({ type: 'add', text, newNo: n++ })
      else if (part.removed) all.push({ type: 'del', text, oldNo: o++ })
      else all.push({ type: 'ctx', text, oldNo: o++, newNo: n++ })
    }
  }
  const added = all.filter((l) => l.type === 'add').length
  const removed = all.filter((l) => l.type === 'del').length
  if (context < 0) return { hunks: [{ skippedBefore: 0, lines: all }], skippedAfter: 0, added, removed }

  const keep = new Array(all.length).fill(false)
  all.forEach((l, i) => {
    if (l.type === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true
  })
  const hunks: Hunk[] = []
  let skipped = 0
  let cur: Hunk | null = null
  all.forEach((l, i) => {
    if (!keep[i]) {
      skipped++
      cur = null
      return
    }
    if (!cur) {
      cur = { skippedBefore: skipped, lines: [] }
      hunks.push(cur)
      skipped = 0
    }
    cur.lines.push(l)
  })
  return { hunks, skippedAfter: skipped, added, removed }
}

export interface ChangeDiff {
  change: ChangeSet
  source: 'snapshot' | 'git'
  file: string
  before: string
  after: string
}

/** 변경 대상 문서의 파일 경로 (데이터 폴더 기준). */
async function targetFile(ctx: Ctx, target: string): Promise<string | null> {
  const domain = (await listDomains(ctx)).find((d) => d.id === target)
  if (domain) return domainFile(ctx, domain.folder)
  const spec = (await listSpecs(ctx)).find((s) => s.id === target)
  if (spec) return spec.file
  const design = (await listDesigns(ctx)).find((d) => d.id === target)
  return design?.file ?? null
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' })
    return stdout.replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/**
 * 변경 전·후 원문. 저장할 때 남긴 스냅샷을 쓰고,
 * 스냅샷이 없는 예전 변경은 그 변경 기록이 들어간 git 커밋 직전·직후의 파일에서 꺼낸다.
 */
export async function changeDiff(ctx: Ctx, change: ChangeSet): Promise<ChangeDiff | { change: ChangeSet; unavailable: string }> {
  const snap = await readSnapshot(ctx, change.id)
  if (snap) return { change, source: 'snapshot', file: snap.file, before: snap.before, after: snap.after }

  const abs = await targetFile(ctx, change.target)
  if (!abs) return { change, unavailable: '대상 문서를 찾을 수 없습니다' }
  const rel = (p: string) => path.relative(ctx.projectDir, p).replace(/\\/g, '/')
  const changeFile = rel(path.join(ctx.dataRoot, 'changes', `${change.id}.md`))
  const commit = (await git(ctx.projectDir, ['log', '--diff-filter=A', '--format=%H', '--', changeFile]))?.trim().split('\n').pop()
  if (!commit) return { change, unavailable: '이 변경은 스냅샷이 없고, git 커밋에서도 찾을 수 없습니다 (커밋 전이거나 git 저장소가 아님)' }
  const after = await git(ctx.projectDir, ['show', `${commit}:${rel(abs)}`])
  if (after === null) return { change, unavailable: '그 커밋에서는 문서가 다른 위치에 있었습니다' }
  // 직전 커밋에 파일이 없으면(지웠다가 되살린 경우 등) 파일이 있던 가장 최근 커밋까지 거슬러 올라간다
  let before = await git(ctx.projectDir, ['show', `${commit}^:${rel(abs)}`])
  if (before === null) {
    const earlier = (await git(ctx.projectDir, ['log', '--format=%H', '-n', '10', `${commit}^`, '--', rel(abs)]))?.trim().split('\n') ?? []
    for (const c of earlier) {
      if (!c) continue
      before = await git(ctx.projectDir, ['show', `${c}:${rel(abs)}`])
      if (before !== null) break
    }
  }
  before ??= ''
  return { change, source: 'git', file: path.relative(ctx.dataRoot, abs).replace(/\\/g, '/'), before, after }
}
