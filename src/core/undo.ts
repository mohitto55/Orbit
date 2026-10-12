import { promises as fs } from 'fs'
import path from 'path'
import type { Ctx } from './workspace'

/** 되돌리기용 파일 스냅샷. raw가 null이면 그 시점에 파일이 없었다는 뜻. */
export interface FileSnap {
  file: string
  raw: string | null
}

function inside(ctx: Ctx, file: string): string {
  const abs = path.resolve(file)
  const root = path.resolve(ctx.dataRoot) + path.sep
  if (!abs.startsWith(root)) throw new Error(`데이터 폴더 밖의 파일은 되돌릴 수 없습니다: ${file}`)
  return abs
}

export async function snapshotFiles(ctx: Ctx, files: string[]): Promise<FileSnap[]> {
  return Promise.all(
    files.map(async (f) => {
      const file = inside(ctx, f)
      try {
        return { file, raw: await fs.readFile(file, 'utf8') }
      } catch {
        return { file, raw: null }
      }
    })
  )
}

export async function restoreFiles(ctx: Ctx, snaps: FileSnap[]): Promise<void> {
  for (const s of snaps) {
    const file = inside(ctx, s.file)
    if (s.raw == null) await fs.rm(file, { force: true })
    else {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, s.raw, 'utf8')
    }
  }
}
