import { diffLines } from 'diff'
import type { Ctx } from './workspace'
import { readSnapshot, type ChangeSet } from './changes'

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
  file: string
  before: string
  after: string
}

/** 변경 전·후 원문. 저장할 때 남긴 스냅샷만 쓴다. */
export async function changeDiff(ctx: Ctx, change: ChangeSet): Promise<ChangeDiff | { change: ChangeSet; unavailable: string }> {
  const snap = await readSnapshot(ctx, change.id)
  if (!snap) return { change, unavailable: '이 변경은 저장 시 스냅샷이 없습니다' }
  return { change, file: snap.file, before: snap.before, after: snap.after }
}
