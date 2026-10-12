import { promises as fs } from 'fs'
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

/** 바뀌기 전·후 파일 원문. 변경 검토에서 GitHub처럼 줄 단위로 비교하는 데 쓴다. */
export interface Snapshot {
  /** 데이터 폴더 기준 경로 */
  file: string
  before: string
  after: string
}

function snapshotFile(ctx: Ctx, id: string) {
  return path.join(ctx.dataRoot, 'changes', 'snapshots', `${id}.json`)
}

/** 파일 원문을 읽는다 (없으면 빈 문자열). */
export async function readRaw(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}

export async function readSnapshot(ctx: Ctx, id: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await fs.readFile(snapshotFile(ctx, id), 'utf8'))
  } catch {
    return null
  }
}

export async function recordChange(
  ctx: Ctx,
  c: Omit<ChangeSet, 'id' | 'created' | 'source'> & { source?: ChangeSource },
  snapshot?: { file: string; before: string; after: string }
): Promise<ChangeSet> {
  const change: ChangeSet = {
    id: `chg-${stamp()}`,
    created: nowIso(),
    ...c,
    source: c.source ?? 'manual'
  }
  await writeMd(path.join(ctx.dataRoot, 'changes', `${change.id}.md`), change, `${change.summary}\n`)
  if (snapshot) {
    const rel = path.relative(ctx.dataRoot, snapshot.file).replace(/\\/g, '/')
    await fs.mkdir(path.dirname(snapshotFile(ctx, change.id)), { recursive: true })
    await fs.writeFile(snapshotFile(ctx, change.id), JSON.stringify({ file: rel, before: snapshot.before, after: snapshot.after }, null, 1), 'utf8')
  }
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
