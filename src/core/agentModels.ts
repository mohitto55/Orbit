import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { isEffort, modelProblem, type AgentEffort } from './agentModel'

export interface AgentModel { id: string; name: string; efforts?: AgentEffort[] }

/** CLI가 받아 둔 모델 목록을 제안한다. 인증 정보나 전역 설정은 읽거나 바꾸지 않는다. */
export async function agentModels(kind: 'claude' | 'codex'): Promise<AgentModel[]> {
  if (kind === 'claude') return ['default', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, name: id }))
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return []
    const cache: { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_reasoning_levels?: { effort?: unknown }[] }[] } = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(cache.models)) return []
    return cache.models.flatMap((model) => typeof model?.slug === 'string' && model.slug && !modelProblem(model.slug) && model.visibility !== 'hide'
      ? [{ id: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug,
        ...(Array.isArray(model.supported_reasoning_levels) ? { efforts: model.supported_reasoning_levels.map((level) => level?.effort).filter(isEffort) } : {}) }] : [])
  } catch { return [] }
}
