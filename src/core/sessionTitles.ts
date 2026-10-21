import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { encodeClaudeProjectDir } from './drift'
import { validateSessionId } from './terminal'

interface TitleRow {
  id?: string
  sessionId?: string
  type?: string
  thread_name?: string
  customTitle?: string
  aiTitle?: string
}

function titleRows(raw: string): TitleRow[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line)
      return row && typeof row === 'object' && !Array.isArray(row) ? [row as TitleRow] : []
    } catch { return [] } // 쓰는 중인 줄은 다음 조회에서 읽는다.
  })
}

const nonempty = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** CLI가 저장한 이름만 읽는다. 첫 요청이나 세션 ID를 이름으로 만들지 않는다. */
export async function readSessionTitle(kind: 'claude' | 'codex', sessionId: string, cwd: string, home?: string): Promise<string | undefined> {
  validateSessionId(sessionId)
  const root = home || (kind === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), `.${kind}`)
  try {
    if (kind === 'codex') {
      const rows = titleRows(await fs.readFile(path.join(root, 'session_index.jsonl'), 'utf8'))
      // 같은 ID의 이름 변경은 뒤에 추가된다. 최신 thread_name이 세션의 name이다.
      return rows.reverse().filter((row) => row.id === sessionId).map((row) => nonempty(row.thread_name)).find(Boolean)
    }
    const dir = path.join(root, 'projects', encodeClaudeProjectDir(cwd))
    let customTitle: string | undefined
    let aiTitle: string | undefined
    let handle
    try {
      handle = await fs.open(path.join(dir, `${sessionId}.jsonl`), 'r')
      const { size } = await handle.stat()
      // Claude의 제목 메타데이터는 앞/뒤에 있다. 큰 대화 본문은 가져오지 않는다.
      const length = Math.min(size, 65536)
      for (const offset of new Set([0, Math.max(0, size - length)])) {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        for (const row of titleRows(buffer.subarray(0, bytesRead).toString('utf8'))) {
          if (row.sessionId !== sessionId) continue
          if (row.type === 'custom-title') customTitle = nonempty(row.customTitle) ?? customTitle
          if (row.type === 'ai-title') aiTitle = nonempty(row.aiTitle) ?? aiTitle
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    } finally { await handle?.close() }
    if (customTitle || aiTitle) return customTitle || aiTitle
    // 구버전 Claude는 세션 색인에 제목을 저장한다.
    const index = JSON.parse(await fs.readFile(path.join(dir, 'sessions-index.json'), 'utf8')) as { entries?: { sessionId?: string; customTitle?: string; summary?: string }[] } | null
    const entry = Array.isArray(index?.entries) ? index.entries.find((row) => row?.sessionId === sessionId) : undefined
    return nonempty(entry?.customTitle) || nonempty(entry?.summary)
  } catch (e) {
    if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
