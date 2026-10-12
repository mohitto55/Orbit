import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import type { Ctx } from './workspace'
import { exists } from './md'
import type { Domain } from './domain'

/**
 * 모델 표의 코드 위치가 실제 코드에 있는지 찾는다.
 * `BaseRoom`처럼 이름이면 정의(class·interface·type·function 등)를, `src/a/b.ts`처럼 경로면 파일을 찾는다.
 */

export interface AnchorHit {
  domainId: string
  concept: string
  anchor: string
  /** 찾은 위치 (프로젝트 기준 경로:줄). 못 찾으면 null */
  found: string | null
}

const DEF_KEYWORDS = 'class|interface|type|enum|object|struct|record|trait|def|function|fun|func|const|let|var'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function findDefinition(projectDir: string, name: string): Promise<string | null> {
  // 메서드 표기(Room.advance)는 마지막 이름으로 찾는다
  const ident = name.split(/[.#:]/).pop()!.replace(/\(\)$/, '')
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null
  const pattern = `(\\b(${DEF_KEYWORDS})\\s+${escapeRe(ident)}\\b)|(^\\s*(public|private|protected|static|async|\\s)*${escapeRe(ident)}\\s*\\()`
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['-C', projectDir, 'grep', '--no-index', '--exclude-standard', '-n', '-E', '-I', '-m', '1', pattern, '--', '.', ':!*.md', ':!node_modules', ':!out', ':!dist'],
      { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }
    )
    const first = stdout.split('\n').find(Boolean)
    if (!first) return null
    const m = first.match(/^(.*?):(\d+):/)
    return m ? `${m[1]}:${m[2]}` : first
  } catch {
    // git grep은 못 찾으면 종료 코드 1
    return null
  }
}

export async function checkAnchors(ctx: Ctx, domains: Domain[]): Promise<AnchorHit[]> {
  const out: AnchorHit[] = []
  const cache = new Map<string, string | null>()
  for (const d of domains) {
    for (const c of d.model) {
      for (const anchor of c.code) {
        if (!cache.has(anchor)) {
          const looksPath = /[\\/]/.test(anchor) || /\.(ts|tsx|js|jsx|mjs|py|java|kt|cs|go|rs|rb|php|swift|scala|cpp|h)$/.test(anchor)
          const found = looksPath
            ? (await exists(path.join(ctx.projectDir, anchor))) ? anchor : null
            : await findDefinition(ctx.projectDir, anchor)
          cache.set(anchor, found)
        }
        out.push({ domainId: d.id, concept: c.name, anchor, found: cache.get(anchor) ?? null })
      }
    }
  }
  return out
}
