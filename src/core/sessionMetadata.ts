import { promises as fs } from 'fs'
import path from 'path'

export interface CodexMetadata {
  id: string
  cwd: string
  originator?: string
  source?: unknown
  timestamp?: string
}

export async function* codexMetadataFiles(dir: string, since = 0): AsyncGenerator<string> {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* codexMetadataFiles(file, since)
    else if (entry.name.endsWith('.jsonl')) {
      try { if ((await fs.stat(file)).mtimeMs >= since - 1000) yield file } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
  }
}

/** JSONL 전체를 문자열로 바꾸지 않고 첫 줄의 session_meta만 읽는다. */
export async function readCodexMetadata(file: string): Promise<CodexMetadata | undefined> {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const chunks: Buffer[] = []
    // ponytail: 메타데이터는 최대 256KB. 더 커지는 형식은 전용 스트리밍 파서가 필요하다.
    for (let offset = 0; offset < 256 * 1024; offset += 4096) {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const end = buffer.subarray(0, bytesRead).indexOf(10)
      chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end))
      if (end < 0 && bytesRead === buffer.length) continue
      const row = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string; payload?: Partial<CodexMetadata> }
      if (row.type === 'session_meta' && typeof row.payload?.id === 'string' && typeof row.payload.cwd === 'string') return row.payload as CodexMetadata
      return
    }
  } catch (e) {
    if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  } finally { await handle?.close() }
}

export const sameProjectPath = (a: string, b: string): boolean => {
  const normalize = (dir: string) => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)
  return normalize(a) === normalize(b)
}
