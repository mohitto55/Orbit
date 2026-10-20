import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx } from './workspace'
import { listMd, readMd, writeMd, nowIso, stamp } from './md'
import { NODE_KINDS, withNames, type NodeKind, type PipeEdge, type PipeNode, type Pipeline } from './pipeline'

/** 연동: 작업 그래프를 데이터 폴더의 pipelines/<id>.md 로 저장한다. */

function dir(ctx: Ctx) {
  return path.join(ctx.dataRoot, 'pipelines')
}

/** 이름이 없는 예전 노드에는 종류 이름을 붙이고, 겹치는 이름은 뒤에 숫자를 붙여 가른다 */
function readNodes(v: unknown): PipeNode[] {
  if (!Array.isArray(v)) return []
  const nodes = v
    .filter((n) => n && typeof n.id === 'string')
    .map((n) => ({
      id: n.id,
      ...(typeof n.name === 'string' ? { name: n.name } : {}),
      kind: (NODE_KINDS as readonly string[]).includes(n.kind) ? (n.kind as NodeKind) : 'shell',
      text: String(n.text ?? ''),
      ...(Array.isArray(n.items) ? { items: n.items.map((x: unknown) => String(x ?? '')) } : {}),
      terminal: n.terminal === 'continue' ? 'continue' : 'new',
      ...(typeof n.session === 'string' && n.session && (n.kind === 'claude' || n.kind === 'codex') ? { session: n.session } : {}),
      ...(typeof n.ref === 'string' && n.ref ? { ref: n.ref } : {}),
      ...(typeof n.x === 'number' ? { x: n.x } : {}),
      ...(typeof n.y === 'number' ? { y: n.y } : {})
    })) as PipeNode[]
  return withNames(nodes)
}

/** 있는 노드끼리만, 같은 핀의 같은 선은 하나만 */
function readEdges(v: unknown, ids: Set<string>): PipeEdge[] {
  if (!Array.isArray(v)) return []
  const out: PipeEdge[] = []
  for (const e of v) {
    if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue
    const edge: PipeEdge = { from: e.from, to: e.to, ...(e.pin === 'data' ? { pin: 'data' as const } : {}) }
    if (!out.some((o) => o.from === edge.from && o.to === edge.to && o.pin === edge.pin)) out.push(edge)
  }
  return out
}

export async function listPipelines(ctx: Ctx): Promise<Pipeline[]> {
  const out: Pipeline[] = []
  for (const file of await listMd(dir(ctx))) {
    const { data } = await readMd(file)
    const nodes = readNodes(data.nodes)
    const ids = new Set(nodes.map((n) => n.id))
    const edges = readEdges(data.edges, ids)
    out.push({ id: data.id ?? path.basename(file, '.md'), title: data.title ?? '', ...(data.template ? { template: true } : {}), nodes, edges, updated: data.updated, file })
  }
  return out
}

export async function savePipeline(
  ctx: Ctx,
  input: { id?: string; title: string; template?: boolean; nodes: PipeNode[]; edges: PipeEdge[] }
): Promise<Pipeline> {
  const id = input.id || `pipe-${stamp()}`
  const file = path.join(dir(ctx), `${id}.md`)
  const nodes = readNodes(input.nodes)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = readEdges(input.edges, ids)
  const data = { id, kind: 'pipeline', title: input.title.trim() || '이름 없는 작업 그래프', ...(input.template ? { template: true } : {}), nodes, edges, updated: nowIso() }
  await writeMd(file, data, '')
  return (await listPipelines(ctx)).find((p) => p.id === id)!
}

/** 이 템플릿을 쓰는 다른 작업 그래프 */
export function templateUsers(all: Pipeline[], id: string): Pipeline[] {
  return all.filter((p) => p.id !== id && p.nodes.some((n) => n.kind === 'template' && n.ref === id))
}

/** 다른 그래프가 템플릿으로 쓰고 있으면 지우지 않는다 (쓰는 쪽이 실행할 수 없게 되므로). */
export async function deletePipeline(ctx: Ctx, id: string): Promise<void> {
  const all = await listPipelines(ctx)
  const p = all.find((x) => x.id === id)
  if (!p) return
  const users = templateUsers(all, id)
  if (users.length) throw new Error(`다음 작업 그래프가 이 템플릿을 쓰고 있어 지울 수 없습니다: ${users.map((u) => u.title).join(', ')}`)
  await fs.rm(p.file, { force: true })
}
