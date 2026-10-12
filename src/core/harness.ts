import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx, HarnessTarget } from './workspace'
import { exists, readMd, writeMd, nowIso } from './md'
import { listDomains, domainPathLabel, type Domain } from './domain'
import { listSpecs } from './spec'
import { listDesigns } from './design'
import { listKnowledge } from './knowledge'
import { listChanges, majorChangesAfter } from './changes'

export const MARK_START = '<!-- girsktop:start -->'
export const MARK_END = '<!-- girsktop:end -->'

export const HARNESS_FILES: Record<HarnessTarget, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md'
}

export interface HarnessPreview {
  target: HarnessTarget
  file: string
  before: string
  after: string
  sources: Record<string, number>
}

/** HN-F03: 표식 사이만 바꾸고, 표식이 없으면 끝에 덧붙인다. 표식 밖 내용은 그대로 둔다. */
export function applyManagedBlock(existing: string | null, block: string): string {
  const managed = `${MARK_START}\n${block.trim()}\n${MARK_END}`
  if (!existing) return managed + '\n'
  const s = existing.indexOf(MARK_START)
  const e = existing.indexOf(MARK_END)
  if (s >= 0 && e > s) return existing.slice(0, s) + managed + existing.slice(e + MARK_END.length)
  return existing.trimEnd() + '\n\n' + managed + '\n'
}

function tree(domains: Domain[], parent: string | undefined, depth: number, rel: (p: string) => string): string[] {
  return domains
    .filter((d) => (d.parent ?? undefined) === parent && d.status !== '폐기됨')
    .flatMap((d) => [
      `${'  '.repeat(depth)}- **${d.title}** (\`${rel(path.join('domains', d.folder))}/\`): ${d.role.split('\n')[0] || '-'}`,
      ...tree(domains, d.id, depth + 1, rel)
    ])
}

export async function buildHarnessBlock(ctx: Ctx): Promise<{ block: string; sources: Record<string, number> }> {
  const rel = (p: string) => path.relative(ctx.projectDir, path.join(ctx.dataRoot, p)).replace(/\\/g, '/')
  const domains = await listDomains(ctx)
  const specs = await listSpecs(ctx, domains)
  const designs = await listDesigns(ctx)
  const knowledge = (await listKnowledge(ctx)).filter((k) => k.harness && k.status === '유효')
  const sources: Record<string, number> = {}
  domains.forEach((d) => (sources[d.id] = d.version))
  specs.forEach((s) => (sources[s.id] = s.version))
  designs.forEach((d) => (sources[d.id] = d.version))
  knowledge.forEach((k) => (sources[k.id] = 1))

  const lines: string[] = [
    '# 프로젝트 문서 체계 (Girsktop 관리 영역)',
    '',
    '이 구간은 Girsktop이 생성한다. 직접 고치지 말고 원본 문서를 고친다.',
    '',
    '## 도메인',
    '',
    ...tree(domains, undefined, 0, rel),
    '',
    '## 기능 명세 표와 설계',
    '',
    ...specs.map((s) => `- ${domainPathLabel(domains, s.domainId)}: \`${rel(path.join('domains', s.folder, 'spec.md'))}\` (기능 ${s.features.length}개)`),
    ...designs.filter((d) => d.system).map((d) => `- 시스템 공통 설계: \`${rel('system-design.md')}\``),
    '',
    '## 작업 규칙',
    '',
    `- 나중에 할 일이 생기면 \`${rel('inbox')}/\`에 md 파일을 만든다. 첫 줄이 제목이다.`,
    '- 테스트 이름에 검증하는 수용 기준 ID를 붙인다. 예: `test("[TK-F03-AC2] 유형 없으면 저장 거부", ...)`',
    '- 도메인 규칙이 바뀌는 작업이면 작업을 마칠 때 사람에게 알린다. 도메인 문서는 사람이 확인 후 고친다.',
    '- 요구사항은 기능 명세 표를, 구현 방법은 설계 문서를 먼저 읽는다.'
  ]
  if (knowledge.length) {
    lines.push('', '## 프로젝트 지식', '')
    for (const k of knowledge) lines.push(`- [${k.type}] ${k.title}${k.content.trim() ? ': ' + k.content.trim().split('\n')[0] : ''}`)
  }
  return { block: lines.join('\n'), sources }
}

export async function previewHarness(ctx: Ctx, target: HarnessTarget): Promise<HarnessPreview> {
  const file = path.join(ctx.projectDir, HARNESS_FILES[target])
  const before = (await exists(file)) ? await fs.readFile(file, 'utf8') : ''
  const { block, sources } = await buildHarnessBlock(ctx)
  return { target, file, before, after: applyManagedBlock(before || null, block), sources }
}

export async function writeHarness(ctx: Ctx, target: HarnessTarget): Promise<HarnessPreview> {
  const preview = await previewHarness(ctx, target)
  await fs.writeFile(preview.file, preview.after, 'utf8')
  await writeMd(
    path.join(ctx.dataRoot, 'harness', `generation-${target}.md`),
    { kind: 'harness-generation', target, file: HARNESS_FILES[target], generatedAt: nowIso(), sources: preview.sources },
    `# ${HARNESS_FILES[target]} 생성 기록\n`
  )
  return preview
}

/** HN-F05: 생성 이후 바뀐 원본 목록. 도메인은 큰 변경만 센다. */
export async function harnessStaleness(ctx: Ctx, target: HarnessTarget): Promise<{ generatedAt?: string; changed: string[] }> {
  const file = path.join(ctx.dataRoot, 'harness', `generation-${target}.md`)
  if (!(await exists(file))) return { changed: [] }
  const { data } = await readMd(file)
  const recorded: Record<string, number> = data.sources ?? {}
  const { sources } = await buildHarnessBlock(ctx)
  const changes = await listChanges(ctx)
  const changed: string[] = []
  for (const [id, v] of Object.entries(sources)) {
    const old = recorded[id]
    if (old === undefined) changed.push(id)
    else if (v !== old) {
      if (id.startsWith('dom-') && majorChangesAfter(changes, id, old).length === 0) continue
      changed.push(id)
    }
  }
  for (const id of Object.keys(recorded)) if (!(id in sources)) changed.push(id)
  return { generatedAt: data.generatedAt, changed }
}
