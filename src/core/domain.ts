import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx } from './workspace'
import { exists, listDirs, readMd, writeMd, slugify, sectionText } from './md'
import { recordChange, requireChange, type ChangeInput, type ChangeSet } from './changes'

export type SubdomainType = 'Core' | 'Supporting' | 'Generic'

export interface DomainLink {
  type: string
  to: string
}

export interface Domain {
  id: string
  title: string
  folder: string
  parent?: string
  subdomainType: SubdomainType
  version: number
  status: string
  links: DomainLink[]
  content: string
  role: string
}

export function domainFile(ctx: Ctx, folder: string): string {
  return path.join(ctx.dataRoot, 'domains', folder, 'domain.md')
}

export async function listDomains(ctx: Ctx): Promise<Domain[]> {
  const out: Domain[] = []
  for (const folder of await listDirs(path.join(ctx.dataRoot, 'domains'))) {
    const file = domainFile(ctx, folder)
    if (!(await exists(file))) continue
    const { data, content } = await readMd(file)
    out.push({
      id: data.id ?? `dom-${folder}`,
      title: data.title ?? folder,
      folder,
      parent: data.parent || undefined,
      subdomainType: data.subdomainType ?? 'Supporting',
      version: Number(data.version ?? 1),
      status: data.status ?? 'draft',
      links: Array.isArray(data.links) ? data.links : [],
      content,
      role: sectionText(content, '역할')
    })
  }
  return out
}

export function domainPathLabel(domains: Domain[], id: string): string {
  const byId = new Map(domains.map((d) => [d.id, d]))
  const names: string[] = []
  let cur = byId.get(id)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.title)
    cur = cur.parent ? byId.get(cur.parent) : undefined
  }
  return names.join(' › ')
}

export function descendants(domains: Domain[], id: string): Set<string> {
  const out = new Set<string>()
  const walk = (pid: string) => {
    for (const d of domains) {
      if (d.parent === pid && !out.has(d.id)) {
        out.add(d.id)
        walk(d.id)
      }
    }
  }
  walk(id)
  return out
}

function validateParent(domains: Domain[], selfId: string | null, parent: string | undefined): void {
  if (!parent) return
  if (!domains.some((d) => d.id === parent)) throw new Error(`상위 도메인을 찾을 수 없습니다: ${parent}`)
  if (selfId) {
    if (parent === selfId) throw new Error('자기 자신을 상위 도메인으로 지정할 수 없습니다')
    if (descendants(domains, selfId).has(parent)) {
      throw new Error('자기 하위 도메인을 상위 도메인으로 지정할 수 없습니다')
    }
  }
}

function validateSiblingName(domains: Domain[], selfId: string | null, parent: string | undefined, title: string): void {
  const clash = domains.find((d) => d.id !== selfId && (d.parent ?? '') === (parent ?? '') && d.title === title)
  if (clash) throw new Error(`같은 상위 아래에 같은 이름의 도메인이 있습니다: ${title}`)
}

export interface CreateDomainInput {
  title: string
  folder?: string
  parent?: string
  subdomainType?: SubdomainType
  role?: string
}

function domainTemplate(title: string, role: string): string {
  return `# ${title}

## 역할

${role || '(이 도메인이 책임지는 일)'}

## 용어

이 도메인(바운디드 컨텍스트) 안에서의 뜻이다. 같은 단어도 다른 도메인에서는 뜻이 다를 수 있다.

| 용어 | 뜻 | 비고 |
|---|---|---|

## 하지 않는 것

-
`
}

export async function createDomain(ctx: Ctx, input: CreateDomainInput): Promise<Domain> {
  const title = input.title?.trim()
  if (!title) throw new Error('도메인 이름을 입력하세요')
  const domains = await listDomains(ctx)
  validateParent(domains, null, input.parent)
  validateSiblingName(domains, null, input.parent, title)
  let folder = slugify(input.folder || title)
  if (!folder) folder = `d-${Date.now().toString(36)}`
  if (await exists(path.join(ctx.dataRoot, 'domains', folder))) {
    throw new Error(`이미 있는 도메인 폴더입니다: ${folder}`)
  }
  const data = {
    id: `dom-${folder}`,
    kind: 'domain',
    title,
    ...(input.parent ? { parent: input.parent } : {}),
    subdomainType: input.subdomainType ?? 'Supporting',
    version: 1,
    status: 'draft'
  }
  await writeMd(domainFile(ctx, folder), data, domainTemplate(title, input.role ?? ''))
  const created = (await listDomains(ctx)).find((d) => d.folder === folder)
  return created!
}

export interface DomainPatch {
  title?: string
  parent?: string | null
  subdomainType?: SubdomainType
  status?: string
  content?: string
  links?: DomainLink[]
}

export async function saveDomain(
  ctx: Ctx,
  id: string,
  patch: DomainPatch,
  changeInput: ChangeInput
): Promise<{ domain: Domain; change: ChangeSet }> {
  const change = requireChange(changeInput)
  const domains = await listDomains(ctx)
  const cur = domains.find((d) => d.id === id)
  if (!cur) throw new Error(`도메인을 찾을 수 없습니다: ${id}`)
  const newParent = patch.parent === undefined ? cur.parent : patch.parent || undefined
  const newTitle = patch.title?.trim() || cur.title
  validateParent(domains, id, newParent)
  validateSiblingName(domains, id, newParent, newTitle)
  const moved = (newParent ?? '') !== (cur.parent ?? '')
  const size = moved ? 'major' : change.size

  const file = domainFile(ctx, cur.folder)
  const { data } = await readMd(file)
  const next = {
    ...data,
    title: newTitle,
    subdomainType: patch.subdomainType ?? cur.subdomainType,
    status: patch.status ?? cur.status,
    version: cur.version + 1,
    ...(patch.links ? { links: patch.links } : {})
  } as Record<string, any>
  if (newParent) next.parent = newParent
  else delete next.parent
  await writeMd(file, next, patch.content ?? cur.content)

  const recorded = await recordChange(ctx, {
    target: id,
    from: cur.version,
    to: cur.version + 1,
    size,
    summary: moved && change.size === 'minor' ? `${change.summary} (도메인 이동으로 큰 변경 처리)` : change.summary,
    source: change.source,
    changed: []
  })
  const domain = (await listDomains(ctx)).find((d) => d.id === id)!
  return { domain, change: recorded }
}

/** 하위 도메인이나 폐기되지 않은 기능이 있으면 삭제할 수 없다. */
export async function deleteDomain(ctx: Ctx, id: string, activeFeatureCount: number): Promise<void> {
  const domains = await listDomains(ctx)
  const cur = domains.find((d) => d.id === id)
  if (!cur) throw new Error(`도메인을 찾을 수 없습니다: ${id}`)
  const reasons: string[] = []
  const children = domains.filter((d) => d.parent === id)
  if (children.length) reasons.push(`하위 도메인 ${children.length}개 (${children.map((c) => c.title).join(', ')})`)
  if (activeFeatureCount > 0) reasons.push(`폐기되지 않은 기능 ${activeFeatureCount}개`)
  if (reasons.length) {
    throw new Error(`삭제할 수 없습니다: ${reasons.join(', ')}. 먼저 정리하거나 '폐기됨' 상태로 바꾸세요`)
  }
  await fs.rm(path.join(ctx.dataRoot, 'domains', cur.folder), { recursive: true, force: true })
}
