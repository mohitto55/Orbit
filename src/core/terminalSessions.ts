import os from 'os'
import path from 'path'
import { listClaudeSessions, listCodexSessions, type SessionInfo } from './drift'
import { exists, readMd, writeMd } from './md'
import { validateSessionId } from './terminal'
import type { Ctx } from './workspace'

export interface TerminalSession extends SessionInfo {
  title: string
  sessionId: string
}

function nameFile(ctx: Ctx, id: string): string {
  const [agent, sessionId, extra] = id.split(':')
  if ((agent !== 'claude' && agent !== 'codex') || !sessionId || extra !== undefined) throw new Error('올바르지 않은 대화 ID입니다')
  validateSessionId(sessionId)
  return path.join(ctx.dataRoot, 'terminals', `${agent}-${sessionId}.md`)
}

/** 원본 대화는 CLI가 저장한다. Orbit에는 프로젝트별 표시 이름만 저장한다. */
export async function listTerminalSessions(ctx: Ctx, home = os.homedir()): Promise<{ sessions: TerminalSession[]; errors: string[] }> {
  const results = await Promise.allSettled([listClaudeSessions(ctx.projectDir, home), listCodexSessions(ctx.projectDir, home)])
  const sessions: TerminalSession[] = []
  const errors: string[] = []
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      errors.push(`${index === 0 ? 'Claude Code' : 'Codex'} 대화를 읽지 못했습니다: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      continue
    }
    for (const info of result.value) {
      try {
        const file = nameFile(ctx, info.id)
        const saved = await exists(file) ? await readMd<{ title?: string }>(file) : null
        sessions.push({ ...info, sessionId: info.id.slice(info.agent.length + 1), title: saved?.data.title || info.firstPrompt.slice(0, 100) || `${info.agent} 대화` })
      } catch (e) {
        errors.push(`대화 ${info.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return { sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors }
}

export async function renameTerminalSession(ctx: Ctx, id: string, title: string): Promise<void> {
  const file = nameFile(ctx, id)
  const name = title.trim()
  if (!name || name.length > 100) throw new Error('세션 이름은 1~100자로 입력해 주세요')
  await writeMd(file, { id, kind: 'terminal-session', title: name }, '')
}
