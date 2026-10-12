import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx } from './workspace'
import { exists } from './md'
import type { Domain } from './domain'

/**
 * 모델 표의 코드 위치가 실제 코드에 있는지 찾는다.
 * `BaseRoom`처럼 이름이면 정의(class·interface·type·function 등)를, `src/a/b.ts`처럼 경로면 파일을 찾는다.
 * 운영체제마다 다른 grep 정규식에 기대지 않도록 소스 파일을 직접 읽어 찾는다.
 */

export interface AnchorHit {
  domainId: string
  concept: string
  anchor: string
  /** 찾은 위치 (프로젝트 기준 경로:줄). 못 찾으면 null */
  found: string | null
}

const DEF_KEYWORDS = 'class|interface|type|enum|object|struct|record|trait|def|function|fun|func|const|let|var'
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|kts|cs|go|rs|rb|php|swift|scala|cpp|cc|c|h|hpp)$/
const IGNORE_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'release', 'target', 'venv', 'bin', 'obj'])
const MAX_FILE = 1024 * 1024

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) await sourceFiles(p, out)
    } else if (SOURCE_RE.test(e.name)) out.push(p)
  }
  return out
}

function definitionRe(name: string): RegExp | null {
  // 메서드 표기(Room.advance)는 마지막 이름으로 찾는다
  const ident = name.split(/[.#:]/).pop()!.replace(/\(\)$/, '')
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null
  const id = escapeRe(ident)
  return new RegExp(`(\\b(${DEF_KEYWORDS})\\s+${id}(?![\\w$]))|(^\\s*((public|private|protected|static|async|export)\\s+)*${id}\\s*\\()`, 'm')
}

export async function checkAnchors(ctx: Ctx, domains: Domain[]): Promise<AnchorHit[]> {
  const out: AnchorHit[] = []
  const cache = new Map<string, string | null>()
  // 소스 파일은 필요할 때 한 번만 읽는다
  let files: { rel: string; text: string }[] | null = null
  const loadFiles = async () => {
    if (files) return files
    files = []
    for (const f of await sourceFiles(ctx.projectDir)) {
      try {
        if ((await fs.stat(f)).size > MAX_FILE) continue
        files.push({ rel: path.relative(ctx.projectDir, f).replace(/\\/g, '/'), text: (await fs.readFile(f, 'utf8')).replace(/\r\n/g, '\n') })
      } catch {
        // 못 읽는 파일은 건너뛴다
      }
    }
    return files
  }
  const findDefinition = async (name: string): Promise<string | null> => {
    const re = definitionRe(name)
    if (!re) return null
    for (const f of await loadFiles()) {
      const m = re.exec(f.text)
      // 정의 이름은 일치한 부분의 끝에 있으므로 그 줄 번호를 쓴다
      if (m) return `${f.rel}:${f.text.slice(0, m.index + m[0].length).split('\n').length}`
    }
    return null
  }
  for (const d of domains) {
    for (const c of d.model) {
      for (const anchor of c.code) {
        if (!cache.has(anchor)) {
          const looksPath = /[\\/]/.test(anchor) || /\.(ts|tsx|js|jsx|mjs|py|java|kt|cs|go|rs|rb|php|swift|scala|cpp|h)$/.test(anchor)
          const found = looksPath
            ? (await exists(path.join(ctx.projectDir, anchor))) ? anchor : null
            : await findDefinition(anchor)
          cache.set(anchor, found)
        }
        out.push({ domainId: d.id, concept: c.name, anchor, found: cache.get(anchor) ?? null })
      }
    }
  }
  return out
}
