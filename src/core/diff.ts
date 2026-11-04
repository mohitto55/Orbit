import { diffLines } from 'diff'
import type { Ctx } from './workspace'
import { readSnapshot, type ChangeSet } from './changes'
import { parseSpecTable, type Feature } from './spec'

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

export type Difference = 'added' | 'removed' | 'modified' | 'same'
export interface TextDifference { id: string; label: string; before?: string; after?: string; kind: Difference }
export interface FeatureDifference {
  id: string
  name: string
  icon?: string
  kind: Difference
  fields: TextDifference[]
  acs: TextDifference[]
  acOrder?: { before: string[]; after: string[] }
}
export interface SpecDifference {
  features: FeatureDifference[]
  order?: { before: string[]; after: string[] }
  outside: LineDiff
}

function difference(before: string | undefined, after: string | undefined): Difference {
  return before === after ? 'same' : before === undefined ? 'added' : after === undefined ? 'removed' : 'modified'
}

function orderDifference(before: string[], after: string[]) {
  // 추가·삭제 때문에 밀린 위치는 이동으로 표시하지 않는다.
  const oldCommon = before.filter((id) => after.includes(id)), newCommon = after.filter((id) => before.includes(id))
  return oldCommon.join('\n') === newCommon.join('\n') ? undefined : { before: oldCommon, after: newCommon }
}

/** 마크다운 표의 한 줄 대신 기능 ID·AC ID로 맞춰 읽을 수 있는 변경 항목을 만든다. */
export function specDifference(before: string, after: string): SpecDifference | undefined {
  const oldTable = parseSpecTable(before), newTable = parseSpecTable(after)
  if (oldTable.start < 0 && newTable.start < 0) return undefined
  // ID가 겹치는 손상된 표는 원문 비교로 남겨 누락을 피한다.
  for (const table of [oldTable, newTable]) {
    if (new Set(table.features.map((f) => f.id)).size !== table.features.length || table.features.some((f) => new Set(f.acs.map((a) => a.id)).size !== f.acs.length)) return undefined
  }
  const oldById = new Map(oldTable.features.map((f) => [f.id, f])), newById = new Map(newTable.features.map((f) => [f.id, f]))
  const ids = [...newById.keys(), ...[...oldById.keys()].filter((id) => !newById.has(id))]
  const fields: { key: keyof Pick<Feature, 'name' | 'purpose' | 'status' | 'icon'>; label: string }[] = [
    { key: 'name', label: '기능' }, { key: 'purpose', label: '목적' }, { key: 'status', label: '상태' }, { key: 'icon', label: '아이콘' }
  ]
  const features = ids.map((id): FeatureDifference => {
    const old = oldById.get(id), next = newById.get(id)
    const changedFields = fields.map(({ key, label }): TextDifference => {
      const before = old?.[key], after = next?.[key]
      return { id: key, label, before, after, kind: difference(before, after) }
    }).filter((f) => f.kind !== 'same')
    const oldAcs = new Map(old?.acs.map((a) => [a.id, a]) ?? []), newAcs = new Map(next?.acs.map((a) => [a.id, a]) ?? [])
    const acIds = [...newAcs.keys(), ...[...oldAcs.keys()].filter((id) => !newAcs.has(id))]
    const acs = acIds.map((id): TextDifference => {
      const before = oldAcs.get(id), after = newAcs.get(id)
      return { id, label: `AC${(after ?? before)!.num}`, before: before?.text, after: after?.text, kind: difference(before?.text, after?.text) }
    })
    const acOrder = orderDifference([...oldAcs.keys()], [...newAcs.keys()])
    const kind = !old ? 'added' : !next ? 'removed' : changedFields.length || acOrder || acs.some((a) => a.kind !== 'same') ? 'modified' : 'same'
    return { id, name: (next ?? old)!.name, icon: (next ?? old)!.icon, kind, fields: changedFields, acs, acOrder }
  })
  const outside = (text: string, table: ReturnType<typeof parseSpecTable>) => table.start < 0 ? text : text.split('\n').filter((_, index) => index < table.start || index >= table.end).join('\n')
  return {
    features,
    order: orderDifference([...oldById.keys()], [...newById.keys()]),
    outside: lineDiff(outside(before, oldTable), outside(after, newTable))
  }
}

/** 변경 전·후 원문. 저장할 때 남긴 스냅샷만 쓴다. */
export async function changeDiff(ctx: Ctx, change: ChangeSet): Promise<ChangeDiff | { change: ChangeSet; unavailable: string }> {
  const snap = await readSnapshot(ctx, change.id)
  if (!snap) return { change, unavailable: '이 변경은 저장 시 스냅샷이 없습니다' }
  return { change, file: snap.file, before: snap.before, after: snap.after }
}
