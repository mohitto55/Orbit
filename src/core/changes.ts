import path from 'path'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, stamp, nowIso } from './md'

export type ChangeSize = 'major' | 'minor'
export type ChangeSource = 'manual' | 'drift' | 'task' | 'review'

export interface ChangeInput {
  size: ChangeSize
  summary: string
  source?: ChangeSource
}

export interface ChangeSet {
  id: string
  target: string
  from: number
  to: number
  size: ChangeSize
  summary: string
  source: ChangeSource
  /** 바뀐 하위 항목 (기능 ID, AC ID, 섹션 id). 비어 있으면 문서 전체 */
  changed: string[]
  created: string
}

export function requireChange(change: ChangeInput | undefined | null): ChangeInput {
  if (!change || !change.summary || !change.summary.trim()) {
    throw new Error('변경 크기와 변경 요약을 입력해야 저장할 수 있습니다')
  }
  if (change.size !== 'major' && change.size !== 'minor') {
    throw new Error('변경 크기는 큰 변경 또는 작은 변경이어야 합니다')
  }
  return change
}

export async function recordChange(
  ctx: Ctx,
  c: Omit<ChangeSet, 'id' | 'created' | 'source'> & { source?: ChangeSource }
): Promise<ChangeSet> {
  const change: ChangeSet = {
    id: `chg-${stamp()}`,
    created: nowIso(),
    ...c,
    source: c.source ?? 'manual'
  }
  await writeMd(path.join(ctx.dataRoot, 'changes', `${change.id}.md`), change, `${change.summary}\n`)
  return change
}

export async function listChanges(ctx: Ctx): Promise<ChangeSet[]> {
  const files = await listMd(path.join(ctx.dataRoot, 'changes'))
  const out: ChangeSet[] = []
  for (const f of files) {
    const { data } = await readMd<ChangeSet>(f)
    if (data && data.target) out.push({ ...data, changed: data.changed ?? [] })
  }
  return out.sort((a, b) => a.created.localeCompare(b.created))
}

export function majorChangesAfter(changes: ChangeSet[], target: string, version: number): ChangeSet[] {
  return changes.filter((c) => c.target === target && c.size === 'major' && c.to > version)
}
