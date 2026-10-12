import path from 'path'
import type { Ctx } from './workspace'
import { exists, listDirs, listMd, readMd, writeMd } from './md'
import { recordChange, requireChange, type ChangeInput, type ChangeSet } from './changes'
import { getSpec } from './spec'

export const SYSTEM_DESIGN_ID = 'system-design'

export interface DesignBasedOn {
  ref: string
  feature: string
  version: number
}

export interface DesignRef {
  ref: string
  section: string
  version?: number
}

export interface Design {
  id: string
  title: string
  file: string
  folder?: string
  system: boolean
  version: number
  basedOn: DesignBasedOn[]
  refs: DesignRef[]
  content: string
}

async function loadDesign(file: string, folder: string | undefined): Promise<Design> {
  const { data, content } = await readMd(file)
  const system = !folder
  return {
    id: data.id ?? (system ? SYSTEM_DESIGN_ID : `design-${path.basename(file, '.md')}`),
    title: data.title ?? path.basename(file, '.md'),
    file,
    folder,
    system,
    version: Number(data.version ?? 1),
    basedOn: Array.isArray(data.basedOn)
      ? data.basedOn.map((b: any) => ({ ref: b.ref, feature: b.feature, version: Number(b.version) }))
      : [],
    refs: Array.isArray(data.refs)
      ? data.refs.map((r: any) => ({ ref: r.ref, section: r.section, version: r.version == null ? undefined : Number(r.version) }))
      : [],
    content
  }
}

export async function listDesigns(ctx: Ctx): Promise<Design[]> {
  const out: Design[] = []
  const sys = path.join(ctx.dataRoot, 'system-design.md')
  if (await exists(sys)) out.push(await loadDesign(sys, undefined))
  for (const root of ['domains', 'features']) {
    for (const folder of await listDirs(path.join(ctx.dataRoot, root))) {
      for (const f of await listMd(path.join(ctx.dataRoot, root, folder, 'design'))) {
        out.push(await loadDesign(f, folder))
      }
    }
  }
  return out
}

export async function createSystemDesign(ctx: Ctx): Promise<Design> {
  const file = path.join(ctx.dataRoot, 'system-design.md')
  if (await exists(file)) throw new Error('시스템 공통 설계가 이미 있습니다')
  await writeMd(
    file,
    { id: SYSTEM_DESIGN_ID, kind: 'design', title: '시스템 공통 설계', version: 1, status: 'draft' },
    `# 시스템 공통 설계

## S1. 비기능 요구사항 {#s1}

## S2. 규모 산정 {#s2}

## S3. 전체 구조 {#s3}

## S4. 공통 기술 결정 {#s4}
`
  )
  return loadDesign(file, undefined)
}

export async function createDesign(ctx: Ctx, specId: string, featureId: string): Promise<Design> {
  const spec = await getSpec(ctx, specId)
  const feature = spec.features.find((f) => f.id === featureId)
  if (!feature) throw new Error(`기능을 찾을 수 없습니다: ${featureId}`)
  const file = path.join(path.dirname(spec.file), 'design', `${featureId}.md`)
  if (await exists(file)) throw new Error(`이미 설계가 있습니다: ${featureId}`)
  await writeMd(
    file,
    {
      id: `design-${featureId}`,
      kind: 'design',
      title: `${feature.name} 설계`,
      basedOn: [{ ref: spec.id, feature: featureId, version: spec.version }],
      refs: [],
      version: 1,
      status: 'draft'
    },
    `# ${feature.name} 설계

## 개요

## 처리 흐름

## 데이터

## 인터페이스 (API)

## 예외 처리

## 대안과 선택 이유
`
  )
  return loadDesign(file, spec.folder)
}

export async function saveDesign(
  ctx: Ctx,
  id: string,
  content: string,
  changeInput: ChangeInput,
  changedSections: string[] = []
): Promise<{ design: Design; change: ChangeSet }> {
  const change = requireChange(changeInput)
  const design = (await listDesigns(ctx)).find((d) => d.id === id)
  if (!design) throw new Error(`설계를 찾을 수 없습니다: ${id}`)
  const { data } = await readMd(design.file)
  await writeMd(design.file, { ...data, version: design.version + 1 }, content)
  const recorded = await recordChange(ctx, {
    target: design.id,
    from: design.version,
    to: design.version + 1,
    size: change.size,
    summary: change.summary,
    source: change.source,
    changed: design.system ? changedSections : []
  })
  return { design: await loadDesign(design.file, design.folder), change: recorded }
}

/** 기준 기능 또는 참조한 공통 설계 섹션에 큰 변경이 있으면 낡음. */
export function designStaleness(design: Design, changes: ChangeSet[]): ChangeSet[] {
  return changes.filter((c) => {
    if (c.size !== 'major') return false
    const byFeature = design.basedOn.some(
      (b) => c.target === b.ref && c.to > b.version && (c.changed.length === 0 || c.changed.includes(b.feature))
    )
    const byRef = design.refs.some(
      (r) => c.target === r.ref && c.to > (r.version ?? 0) && (c.changed.length === 0 || c.changed.includes(r.section))
    )
    return byFeature || byRef
  })
}

/** 기준 버전을 현재 버전으로 갱신한다 (변경 불필요 판단). */
export async function rebaseDesign(ctx: Ctx, id: string, ref: string, currentVersion: number): Promise<void> {
  const design = (await listDesigns(ctx)).find((d) => d.id === id)
  if (!design) throw new Error(`설계를 찾을 수 없습니다: ${id}`)
  const { data, content } = await readMd(design.file)
  const basedOn = design.basedOn.map((b) => (b.ref === ref ? { ...b, version: currentVersion } : b))
  const refs = design.refs.map((r) => (r.ref === ref ? { ...r, version: currentVersion } : r))
  await writeMd(design.file, { ...data, basedOn, refs }, content)
}
