import path from 'path'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, stamp, nowIso } from './md'

export const KN_TYPES = ['결정', '용어', '컨벤션', '교훈', '주의'] as const
export type KnowledgeType = (typeof KN_TYPES)[number]
export type KnowledgeStatus = '초안' | '유효' | '폐기됨'

export interface Knowledge {
  id: string
  type: KnowledgeType
  title: string
  content: string
  status: KnowledgeStatus
  sources: string[]
  supersedes?: string
  supersededBy?: string
  file: string
}

export interface KnowledgeInput {
  id?: string
  type: KnowledgeType
  title: string
  content?: string
  status?: KnowledgeStatus
  sources?: string[]
  supersedes?: string
}

const ADR_TEMPLATE = `## 배경\n\n## 결정\n\n## 대안\n\n## 결과\n`

export async function listKnowledge(ctx: Ctx): Promise<Knowledge[]> {
  const out: Knowledge[] = []
  for (const file of await listMd(path.join(ctx.dataRoot, 'knowledge'))) {
    const { data, content } = await readMd(file)
    out.push({
      id: data.id ?? path.basename(file, '.md'),
      type: data.type ?? '교훈',
      title: data.title ?? '',
      content,
      status: data.status ?? '유효',
      sources: data.sources ?? [],
      supersedes: data.supersedes,
      supersededBy: data.supersededBy,
      file
    })
  }
  return out
}

export async function saveKnowledge(ctx: Ctx, input: KnowledgeInput): Promise<Knowledge> {
  if (!KN_TYPES.includes(input.type)) throw new Error('지식 종류를 고르세요')
  if (!input.title?.trim()) throw new Error('제목을 입력하세요')
  const all = await listKnowledge(ctx)
  const existing = input.id ? all.find((k) => k.id === input.id) : undefined
  const id = existing?.id ?? `kn-${stamp()}`
  const file = existing?.file ?? path.join(ctx.dataRoot, 'knowledge', `${id}.md`)
  const status = input.status ?? existing?.status ?? '유효'
  const data = {
    id,
    kind: 'knowledge',
    type: input.type,
    title: input.title.trim(),
    status,
    sources: input.sources ?? existing?.sources ?? [],
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(existing?.supersededBy ? { supersededBy: existing.supersededBy } : {}),
    updated: nowIso()
  }
  const content = input.content ?? existing?.content ?? (input.type === '결정' ? ADR_TEMPLATE : '')
  await writeMd(file, data, content)
  // KN-F04: 새 결정이 이전 항목을 대체하면 이전 항목을 폐기하고 서로 연결한다
  if (input.supersedes) {
    const old = all.find((k) => k.id === input.supersedes)
    if (old) {
      const { data: od, content: oc } = await readMd(old.file)
      await writeMd(old.file, { ...od, status: '폐기됨', supersededBy: id }, oc)
    }
  }
  return (await listKnowledge(ctx)).find((k) => k.id === id)!
}
