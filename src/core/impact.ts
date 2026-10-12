import path from 'path'
import type { Ctx } from './workspace'
import { exists, listMd, readMd, writeMd, nowIso } from './md'
import { listChanges, type ChangeSet } from './changes'
import { listDomains, type Domain } from './domain'
import { listSpecs, reconfirmSpec, type Spec } from './spec'
import { listDesigns, rebaseDesign, SYSTEM_DESIGN_ID } from './design'
import { createTask } from './task'
import type { TestLink } from './verification'

export type Layer = 'spec' | 'design' | 'test'
export type ItemStatus = 'pending' | 'modify' | 'unchanged' | 'defer'
export type Decision = 'modify' | 'unchanged' | 'defer'

export interface ReviewItem {
  /** 문서 id 또는 `test:<AC ID>` */
  target: string
  layer: Layer
  status: ItemStatus
  changes: string[]
  note?: string
  decidedAt?: string
  taskId?: string
}

export interface Review {
  id: string
  trigger: string
  created: string
  items: ReviewItem[]
  reference: string[]
  file: string
}

function reviewFile(ctx: Ctx, id: string) {
  return path.join(ctx.dataRoot, 'reviews', `${id}.md`)
}

export async function listReviews(ctx: Ctx): Promise<Review[]> {
  const out: Review[] = []
  for (const file of await listMd(path.join(ctx.dataRoot, 'reviews'))) {
    const { data } = await readMd(file)
    out.push({
      id: data.id ?? path.basename(file, '.md'),
      trigger: data.trigger,
      created: data.created ?? '',
      items: data.items ?? [],
      reference: data.reference ?? [],
      file
    })
  }
  return out
}

async function writeReview(r: Omit<Review, 'file'>, file: string) {
  const { items, reference, ...rest } = r
  const lines = items.map((i) => `- [${i.status === 'pending' ? ' ' : 'x'}] ${i.layer}: ${i.target} (${i.status})`)
  await writeMd(file, { ...rest, kind: 'review', items, reference }, `# 영향 검토\n\n${lines.join('\n')}\n`)
}

function hasLiveFeatures(spec: Spec) {
  return spec.features.some((f) => f.status !== '폐기')
}

/** IR-F01: 큰 변경일 때 확인 대상을 계산해 검토를 연다. 설계: domains/impact-review/design/IR-F01.md */
export async function openReview(ctx: Ctx, change: ChangeSet, testLinks: TestLink[] = []): Promise<Review | null> {
  if (change.size !== 'major') return null
  const file = reviewFile(ctx, `rev-${change.id}`)
  if (await exists(file)) return null

  const domains = await listDomains(ctx)
  const specs = await listSpecs(ctx, domains)
  const designs = await listDesigns(ctx)
  const candidates: { target: string; layer: Layer }[] = []
  const reference: string[] = []

  const domain = domains.find((d) => d.id === change.target)
  const spec = specs.find((s) => s.id === change.target)
  if (domain) {
    for (const s of specs) {
      const b = s.basedOn.find((x) => x.ref === domain.id)
      if (b && b.version < change.to && hasLiveFeatures(s)) candidates.push({ target: s.id, layer: 'spec' })
    }
    reference.push(...referenceSpecs(domain, domains, specs).filter((id) => !candidates.some((c) => c.target === id)))
  } else if (spec) {
    const changed = new Set(change.changed)
    for (const d of designs) {
      const hit = d.basedOn.some((b) => b.ref === spec.id && b.version < change.to && (changed.size === 0 || changed.has(b.feature)))
      if (hit) candidates.push({ target: d.id, layer: 'design' })
    }
    const acIds = new Set<string>()
    for (const id of change.changed) {
      if (/-AC\d+$/.test(id)) acIds.add(id)
      else spec.features.find((f) => f.id === id)?.acs.forEach((a) => acIds.add(a.id))
    }
    if (changed.size === 0) spec.features.forEach((f) => f.acs.forEach((a) => acIds.add(a.id)))
    for (const ac of acIds) if (testLinks.some((l) => l.acId === ac)) candidates.push({ target: `test:${ac}`, layer: 'test' })
  } else if (change.target === SYSTEM_DESIGN_ID) {
    const changed = new Set(change.changed)
    for (const d of designs) {
      if (d.system) continue
      const hit = d.refs.some((r) => r.ref === SYSTEM_DESIGN_ID && (r.version ?? 0) < change.to && (changed.size === 0 || changed.has(r.section)))
      if (hit) candidates.push({ target: d.id, layer: 'design' })
    }
  }

  // IR-F06: 이미 미처리 항목이 있는 대상은 기존 항목에 변경 내역을 덧붙인다
  const reviews = await listReviews(ctx)
  const items: ReviewItem[] = []
  for (const c of candidates) {
    const existing = reviews.find((r) => r.items.some((i) => i.target === c.target && i.status === 'pending'))
    if (existing) {
      const item = existing.items.find((i) => i.target === c.target && i.status === 'pending')!
      if (!item.changes.includes(change.id)) item.changes.push(change.id)
      await writeReview(existing, existing.file)
    } else {
      items.push({ target: c.target, layer: c.layer, status: 'pending', changes: [change.id] })
    }
  }
  if (items.length === 0 && reference.length === 0) return null
  const review = { id: `rev-${change.id}`, trigger: change.id, created: nowIso(), items, reference }
  await writeReview(review, file)
  return { ...review, file }
}

/** IR-F02: 하위 도메인(1단계)과 이 도메인에 의존하는 도메인의 표. */
function referenceSpecs(domain: Domain, domains: Domain[], specs: Spec[]): string[] {
  const related = domains.filter(
    (d) => d.parent === domain.id || d.links.some((l) => (l.type === 'depends-on' || l.type === '의존') && l.to === domain.id)
  )
  return specs.filter((s) => related.some((d) => d.id === s.domainId)).map((s) => s.id)
}

export async function pendingItems(ctx: Ctx): Promise<{ review: Review; item: ReviewItem }[]> {
  const out: { review: Review; item: ReviewItem }[] = []
  for (const review of await listReviews(ctx)) {
    for (const item of review.items) if (item.status === 'pending') out.push({ review, item })
  }
  return out
}

export async function decide(ctx: Ctx, reviewId: string, target: string, decision: Decision, note = ''): Promise<ReviewItem> {
  const review = (await listReviews(ctx)).find((r) => r.id === reviewId)
  if (!review) throw new Error(`검토를 찾을 수 없습니다: ${reviewId}`)
  const item = review.items.find((i) => i.target === target)
  if (!item) throw new Error(`확인 항목을 찾을 수 없습니다: ${target}`)
  if (item.status !== 'pending') throw new Error('이미 처리된 항목입니다')

  const changes = (await listChanges(ctx)).filter((c) => item.changes.includes(c.id))
  const refs = [...new Set(changes.map((c) => c.target))]
  const summary = changes.map((c) => c.summary).join(' / ')

  const makeTask = async (type: 'spec-sync' | 'design-sync' | 'test') => {
    const t = await createTask(ctx, {
      title: `${target} 확인: ${summary}`,
      type,
      horizon: '다음',
      links: [target.replace(/^test:/, '')],
      source: reviewId
    })
    item.taskId = t.id
  }

  if (item.layer === 'spec') {
    if (decision === 'defer') await makeTask('spec-sync')
    else for (const ref of refs) await reconfirmSpec(ctx, target, note || (decision === 'modify' ? '수정 후 재확인' : '변경 불필요'), ref)
  } else if (item.layer === 'design') {
    if (decision === 'defer') await makeTask('design-sync')
    else {
      const specs = await listSpecs(ctx)
      const designs = await listDesigns(ctx)
      for (const ref of refs) {
        const v = specs.find((s) => s.id === ref)?.version ?? designs.find((d) => d.id === ref)?.version
        if (v != null) await rebaseDesign(ctx, target, ref, v)
      }
    }
  } else if (decision !== 'unchanged') {
    await makeTask('test')
  }

  item.status = decision
  item.note = note || undefined
  item.decidedAt = nowIso()
  await writeReview(review, review.file)
  return item
}
