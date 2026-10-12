import path from 'path'
import type { Ctx } from './workspace'
import { exists, readMd, writeMd, nowIso } from './md'
import { listDomains, descendants, type Domain } from './domain'
import { readRaw, recordChange, requireChange, majorChangesAfter, type ChangeInput, type ChangeSet } from './changes'

export type FeatureStatus = '초안' | '활성' | '폐기'

export interface AC {
  id: string
  num: number
  text: string
}

export interface Feature {
  id: string
  name: string
  purpose: string
  acs: AC[]
  status: FeatureStatus
  /** 루트 도메인의 기능이 쓰는 하위 도메인 규칙 (규칙 명세의 기능 ID 또는 AC ID) */
  uses?: string[]
}

/**
 * 명세의 역할. 하위 도메인은 그 도메인이 혼자 지키는 규칙을 적는 '규칙 명세',
 * 루트 도메인은 하위 도메인 규칙을 조정해 이루는 사용자 기능을 적는 '기능 명세'.
 */
export type SpecRole = 'rule' | 'feature'
export const SPEC_LABEL: Record<SpecRole, string> = { rule: '규칙 명세', feature: '기능 명세' }

export interface BasedOn {
  ref: string
  version: number
}

export interface Spec {
  id: string
  domainId: string
  folder: string
  file: string
  title: string
  role: SpecRole
  version: number
  basedOn: BasedOn[]
  features: Feature[]
  acSeq: Record<string, number>
  content: string
}

const HEADER = ['ID', '기능', '목적', '수용 기준', '상태']

function splitRow(line: string): string[] {
  const cells = line.trim().split(/(?<!\\)\|/)
  if (cells.length && cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export function parseAcs(featureId: string, text: string): AC[] {
  const out: AC[] = []
  for (const part of text.split(/<br\s*\/?>/i)) {
    const m = part.trim().match(/^AC(\d+)\s*:\s*(.*)$/)
    if (m) out.push({ id: `${featureId}-AC${m[1]}`, num: Number(m[1]), text: m[2].trim() })
  }
  return out
}

/** 본문에서 기능 명세 표를 찾아 기능 목록과 표의 줄 범위를 돌려준다. */
export function parseSpecTable(content: string): { features: Feature[]; start: number; end: number } {
  const lines = content.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l.startsWith('|')) {
      const cells = splitRow(l)
      if (cells[0] === 'ID' && cells.includes('수용 기준')) {
        start = i
        break
      }
    }
  }
  if (start < 0) return { features: [], start: -1, end: -1 }
  let end = start + 1
  while (end < lines.length && lines[end].trim().startsWith('|')) end++
  const header = splitRow(lines[start])
  const col = (name: string) => header.indexOf(name)
  const features: Feature[] = []
  for (let i = start + 2; i < end; i++) {
    const c = splitRow(lines[i])
    const id = c[col('ID')]
    if (!id) continue
    features.push({
      id,
      name: c[col('기능')] ?? '',
      purpose: c[col('목적')] ?? '',
      acs: parseAcs(id, c[col('수용 기준')] ?? ''),
      status: ((c[col('상태')] ?? '초안') as FeatureStatus) || '초안'
    })
  }
  return { features, start, end }
}

export function renderSpecTable(features: Feature[]): string[] {
  const rows = [`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`]
  for (const f of features) {
    const acs = f.acs.map((a) => `AC${a.num}: ${a.text}`).join('<br>')
    rows.push(`| ${cell(f.id)} | ${cell(f.name)} | ${cell(f.purpose)} | ${cell(acs)} | ${f.status} |`)
  }
  return rows
}

export function replaceSpecTable(content: string, features: Feature[]): string {
  const { start, end } = parseSpecTable(content)
  const lines = content.split('\n')
  const table = renderSpecTable(features)
  if (start < 0) return content.trimEnd() + '\n\n' + table.join('\n') + '\n'
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join('\n')
}

function specFile(ctx: Ctx, folder: string): string {
  return path.join(ctx.dataRoot, 'domains', folder, 'spec.md')
}

async function loadSpec(ctx: Ctx, domain: Domain): Promise<Spec | null> {
  const file = specFile(ctx, domain.folder)
  const folder = domain.folder
  if (!(await exists(file))) return null
  const { data, content } = await readMd(file)
  const uses: Record<string, string[]> = data.uses ?? {}
  const features = parseSpecTable(content).features.map((f) => (uses[f.id]?.length ? { ...f, uses: uses[f.id] } : f))
  const role: SpecRole = domain.parent ? 'rule' : 'feature'
  return {
    id: data.id ?? `spec-${folder}`,
    domainId: domain.id,
    folder,
    file,
    title: data.title ?? `${domain.title} ${SPEC_LABEL[role]}`,
    role,
    version: Number(data.version ?? 1),
    basedOn: Array.isArray(data.basedOn) ? data.basedOn.map((b: any) => ({ ref: b.ref, version: Number(b.version) })) : [],
    features,
    acSeq: data.acSeq ?? {},
    content
  }
}

export async function listSpecs(ctx: Ctx, domains?: Domain[]): Promise<Spec[]> {
  const out: Spec[] = []
  for (const d of domains ?? (await listDomains(ctx))) {
    const s = await loadSpec(ctx, d)
    if (s) out.push(s)
  }
  return out
}

export async function getSpec(ctx: Ctx, specId: string): Promise<Spec> {
  const s = (await listSpecs(ctx)).find((x) => x.id === specId)
  if (!s) throw new Error(`기능 명세 표를 찾을 수 없습니다: ${specId}`)
  return s
}

export async function createSpec(ctx: Ctx, domainId: string): Promise<Spec> {
  const domain = (await listDomains(ctx)).find((d) => d.id === domainId)
  if (!domain) throw new Error(`도메인을 찾을 수 없습니다: ${domainId}`)
  if (await exists(specFile(ctx, domain.folder))) throw new Error('이 도메인에는 이미 명세가 있습니다')
  const label = SPEC_LABEL[domain.parent ? 'rule' : 'feature']
  const data = {
    id: `spec-${domain.folder}`,
    kind: 'spec',
    title: `${domain.title} ${label}`,
    basedOn: [{ ref: domain.id, version: domain.version }],
    version: 1,
    status: 'draft'
  }
  const content = `# ${domain.title} ${label}

${domain.parent ? '이 도메인이 혼자 지키는 규칙(조건, 상태 전이, 계산, 불변식)과 수용 기준.' : '하위 도메인의 규칙을 조정해 이루는 사용자 기능과 수용 기준. 기능마다 쓰는 규칙을 참조한다.'}

${renderSpecTable([]).join('\n')}

## 규칙

## 미결정 사항
`
  await writeMd(specFile(ctx, domain.folder), data, content)
  return (await loadSpec(ctx, domain))!
}

export function featureCode(spec: Spec): string {
  const first = spec.features[0]?.id.match(/^(.+)-F\d+$/)
  if (first) return first[1]
  const parts = spec.folder.split('-').filter(Boolean)
  return (parts.length > 1 ? parts.map((p) => p[0]).join('') : spec.folder.slice(0, 2)).toUpperCase()
}

export async function addFeature(ctx: Ctx, specId: string, input: { name: string; purpose?: string }): Promise<Spec> {
  const spec = await getSpec(ctx, specId)
  const code = featureCode(spec)
  const max = spec.features.reduce((m, f) => Math.max(m, Number(f.id.match(/-F(\d+)$/)?.[1] ?? 0)), 0)
  const id = `${code}-F${String(max + 1).padStart(2, '0')}`
  const features = [...spec.features, { id, name: input.name, purpose: input.purpose ?? '', acs: [], status: '초안' as const }]
  await writeSpecFeatures(ctx, spec, features, spec.version, spec.acSeq)
  return getSpec(ctx, specId)
}

async function writeSpecFeatures(ctx: Ctx, spec: Spec, features: Feature[], version: number, acSeq: Record<string, number>, basedOn = spec.basedOn) {
  const { data, content } = await readMd(spec.file)
  const uses = Object.fromEntries(features.filter((f) => f.uses?.length).map((f) => [f.id, f.uses]))
  const { uses: _old, ...rest } = data
  await writeMd(spec.file, { ...rest, version, acSeq, basedOn, ...(Object.keys(uses).length ? { uses } : {}) }, replaceSpecTable(content, features))
}

function sameFeature(a: Feature, b: Feature): boolean {
  return (
    a.name === b.name &&
    a.purpose === b.purpose &&
    a.status === b.status &&
    (a.uses ?? []).join(',') === (b.uses ?? []).join(',') &&
    a.acs.length === b.acs.length &&
    a.acs.every((x, i) => x.num === b.acs[i].num && x.text === b.acs[i].text)
  )
}

/** 활성 행을 고친 경우 바뀐 기능·AC ID 목록. 초안 행은 기록 없이 고칠 수 있다. */
export function diffActive(oldF: Feature[], newF: Feature[]): string[] {
  const changed: string[] = []
  const newMap = new Map(newF.map((f) => [f.id, f]))
  for (const o of oldF) {
    if (o.status !== '활성') continue
    const n = newMap.get(o.id)
    if (!n) {
      changed.push(o.id)
      continue
    }
    if (sameFeature(o, n)) continue
    changed.push(o.id)
    const oAc = new Map(o.acs.map((a) => [a.num, a]))
    const nAc = new Map(n.acs.map((a) => [a.num, a]))
    for (const [num, a] of oAc) if (!nAc.has(num) || nAc.get(num)!.text !== a.text) changed.push(a.id)
    for (const [num, a] of nAc) if (!oAc.has(num)) changed.push(a.id)
  }
  return changed
}

export async function saveFeatures(
  ctx: Ctx,
  specId: string,
  input: Feature[],
  changeInput?: ChangeInput | null
): Promise<{ spec: Spec; change: ChangeSet | null }> {
  const spec = await getSpec(ctx, specId)
  const acSeq = { ...spec.acSeq }
  const features: Feature[] = input.map((f) => {
    let seq = Math.max(acSeq[f.id] ?? 0, ...f.acs.map((a) => a.num || 0), 0)
    const acs = f.acs
      .filter((a) => a.text.trim())
      .map((a) => {
        const num = a.num > 0 ? a.num : ++seq
        return { id: `${f.id}-AC${num}`, num, text: a.text.trim() }
      })
    acSeq[f.id] = Math.max(seq, ...acs.map((a) => a.num), 0)
    const uses = spec.role === 'feature' ? [...new Set((f.uses ?? []).map((u) => u.trim()).filter(Boolean))] : []
    return { id: f.id, name: f.name.trim(), purpose: f.purpose.trim(), acs, status: f.status, ...(uses.length ? { uses } : {}) }
  })
  // 루트의 기능은 자기 아래 하위 도메인의 규칙만 쓸 수 있다
  const { ruleSpecs, owner } = await rulesUnder(ctx, spec)
  for (const f of features) for (const u of f.uses ?? []) if (!owner.has(u)) throw new Error(`${f.id}: 이 도메인 아래 규칙이 아닙니다: ${u}`)
  // 쓰는 규칙이 있는 규칙 명세는 기준으로 기록한다 (이미 있던 기준 버전은 그대로)
  const basedOn = [
    ...spec.basedOn.filter((b) => !ruleSpecs.some((r) => r.id === b.ref)),
    ...ruleSpecs
      .filter((r) => features.some((f) => f.uses?.some((u) => owner.get(u) === r.id)))
      .map((r) => spec.basedOn.find((b) => b.ref === r.id) ?? { ref: r.id, version: r.version })
  ]
  for (const f of features) {
    if (f.status === '활성' && f.acs.length === 0) {
      throw new Error(`${f.id}: 수용 기준이 1개 이상 있어야 활성으로 바꿀 수 있습니다`)
    }
  }
  const changedIds = diffActive(spec.features, features)
  if (changedIds.length === 0) {
    await writeSpecFeatures(ctx, spec, features, spec.version, acSeq, basedOn)
    return { spec: await getSpec(ctx, specId), change: null }
  }
  const change = requireChange(changeInput)
  const before = await readRaw(spec.file)
  await writeSpecFeatures(ctx, spec, features, spec.version + 1, acSeq, basedOn)
  const recorded = await recordChange(ctx, {
    target: spec.id,
    from: spec.version,
    to: spec.version + 1,
    size: change.size,
    summary: change.summary,
    source: change.source,
    changed: changedIds
  }, { file: spec.file, before, after: await readRaw(spec.file) })
  return { spec: await getSpec(ctx, specId), change: recorded }
}

/** 루트 명세 아래 하위 도메인들의 규칙 명세와, 규칙 ID(기능·AC) → 그 규칙 명세 id */
export async function rulesUnder(ctx: Ctx, spec: Spec): Promise<{ ruleSpecs: Spec[]; owner: Map<string, string> }> {
  if (spec.role !== 'feature') return { ruleSpecs: [], owner: new Map() }
  const domains = await listDomains(ctx)
  const under = descendants(domains, spec.domainId)
  const ruleSpecs = (await listSpecs(ctx, domains)).filter((s) => under.has(s.domainId))
  const owner = new Map<string, string>()
  for (const r of ruleSpecs) for (const f of r.features) {
    owner.set(f.id, r.id)
    for (const a of f.acs) owner.set(a.id, r.id)
  }
  return { ruleSpecs, owner }
}

/** 규칙 명세의 변경이 이 명세의 기능이 쓰는 규칙을 건드렸는가 (바뀐 항목이 비면 전체가 바뀐 것) */
export function usesTouched(spec: Spec, change: ChangeSet): boolean {
  if (change.changed.length === 0) return true
  const changed = new Set(change.changed)
  return spec.features.some((f) => f.uses?.some((u) => changed.has(u) || changed.has(u.replace(/-AC\d+$/, ''))))
}

export interface StaleReason {
  ref: string
  basedOnVersion: number
  changes: ChangeSet[]
}

export function specStaleness(spec: Spec, changes: ChangeSet[]): StaleReason[] {
  return spec.basedOn
    .map((b) => ({
      ref: b.ref,
      basedOnVersion: b.version,
      // 규칙 명세를 기준으로 삼은 경우 기능이 쓰는 규칙이 바뀐 것만 본다
      changes: majorChangesAfter(changes, b.ref, b.version).filter((c) => !c.target.startsWith('spec-') || usesTouched(spec, c))
    }))
    .filter((r) => r.changes.length > 0)
}

/** 내용은 그대로 두고 기준 버전만 현재 버전으로 올린다. */
export async function reconfirmSpec(ctx: Ctx, specId: string, note: string, onlyRef?: string): Promise<Spec> {
  const spec = await getSpec(ctx, specId)
  const domains = await listDomains(ctx)
  const specs = await listSpecs(ctx, domains)
  const file = spec.file
  const { data, content } = await readMd(file)
  const basedOn = spec.basedOn.map((b) => {
    if (onlyRef && b.ref !== onlyRef) return b
    const v = domains.find((x) => x.id === b.ref)?.version ?? specs.find((x) => x.id === b.ref)?.version
    return v != null ? { ref: b.ref, version: v } : b
  })
  const reconfirmed = [...(Array.isArray(data.reconfirmed) ? data.reconfirmed : []), { at: nowIso(), note }]
  await writeMd(file, { ...data, basedOn, reconfirmed }, content)
  return getSpec(ctx, specId)
}
