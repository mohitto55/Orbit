import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Ctx } from '../core/workspace'

const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

function localPath(value: string): string {
  if (/^file:/i.test(value)) return fileURLToPath(value)
  const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0])
  // Markdown에 자주 쓰는 /C:/... 경로를 Windows 파일 경로로 읽는다.
  return process.platform === 'win32' ? decoded.replace(/^\/(?=[a-z]:[\\/])/i, '').replace(/\//g, '\\') : decoded
}

/** 임의 파일·실행 문서를 제공하지 않고 현재 프로젝트와 내 스킬의 이미지 파일만 읽는다. */
export async function documentImageResponse(url: string, ctx: Ctx | null, skillRoots: readonly string[]): Promise<Response> {
  try {
    const request = new URL(url), source = request.searchParams.get('source'), document = request.searchParams.get('document')
    if (request.protocol !== 'orbit-image:' || request.hostname !== 'local' || !source || !ctx) return new Response(null, { status: 404 })
    const base = document ? path.dirname(path.resolve(ctx.dataRoot, document)) : ctx.dataRoot
    const candidate = path.resolve(base, localPath(source)), allowed = [ctx.projectDir, ctx.dataRoot, ...skillRoots]
    // 짧은 Windows 경로·심볼릭 링크도 최종 실경로로 권한을 확인한다.
    const file = await fs.realpath(candidate)
    const roots = await Promise.all(allowed.map((root) => fs.realpath(root).catch(() => null)))
    const type = imageTypes[path.extname(file).toLowerCase()]
    if (!type || !roots.some((root) => root && inside(root, file))) return new Response(null, { status: 403 })
    const info = await fs.stat(file)
    if (!info.isFile()) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(await fs.readFile(file)), { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-cache' } })
  } catch { return new Response(null, { status: 404 }) }
}

export interface DocumentImageInput { name: string; bytes: Uint8Array }
export const IMAGE_FILE_LIMIT = 20 * 1024 * 1024

/** 원본을 첨부 폴더에 보관하고 문서와 함께 이동 가능한 Markdown 상대 경로를 돌려준다. */
export async function importDocumentImages(ctx: Ctx, files: DocumentImageInput[], document: string, skillRoots: readonly string[] = []): Promise<string> {
  if (!document || typeof document !== 'string') throw new Error('문서를 먼저 저장한 뒤 사진을 첨부하세요')
  if (!Array.isArray(files) || !files.length || files.length > 20) throw new Error('사진은 한 번에 1~20개를 첨부하세요')
  let total = 0
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !imageTypes[path.extname(file.name).toLowerCase()]) throw new Error('PNG·JPEG·GIF·WebP·SVG 등 이미지 파일을 첨부하세요')
    if (!(file.bytes instanceof Uint8Array) || !file.bytes.byteLength || file.bytes.byteLength > IMAGE_FILE_LIMIT) throw new Error('사진 한 장의 크기는 20MB 이하여야 합니다')
    total += file.bytes.byteLength
  }
  if (total > 100 * 1024 * 1024) throw new Error('한 번에 첨부하는 사진은 합계 100MB 이하여야 합니다')
  const doc = path.resolve(ctx.dataRoot, document)
  const root = [ctx.projectDir, ctx.dataRoot, ...skillRoots].find((folder) => inside(path.resolve(folder), doc))
  if (!root || path.extname(doc).toLowerCase() !== '.md') throw new Error('이 문서에는 사진을 저장할 수 없습니다')
  const inProject = inside(ctx.projectDir, doc) || inside(ctx.dataRoot, doc)
  const folder = path.join(inProject ? ctx.dataRoot : path.dirname(doc), 'assets')
  // 기존 링크를 따라 프로젝트 밖에 파일을 쓰지 않는다. 새 문서는 부모 폴더를 만들 필요가 없다.
  const allowed = await fs.realpath(inProject ? ctx.dataRoot : root)
  const parent = await fs.realpath(path.dirname(folder))
  if (!inside(allowed, parent)) throw new Error('첨부 폴더가 문서 저장 위치 밖을 가리킵니다')
  await fs.mkdir(folder, { recursive: true })
  const realFolder = await fs.realpath(folder)
  if (!inside(allowed, realFolder)) throw new Error('첨부 폴더가 문서 저장 위치 밖을 가리킵니다')
  const markdown: string[] = []
  for (const file of files) {
    const name = createHash('sha256').update(file.bytes).digest('hex') + path.extname(file.name).toLowerCase()
    const target = path.join(realFolder, name)
    try { await fs.writeFile(target, file.bytes, { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('첨부 파일의 링크를 확인하세요') }
    const source = path.relative(path.dirname(doc), path.join(folder, name)).split(path.sep).map(encodeURIComponent).join('/')
    const alt = path.basename(file.name).replace(/[\r\n]/g, ' ').replace(/[\\\[\]]/g, '\\$&')
    markdown.push(`![${alt}](${source})`)
  }
  return markdown.join('\n\n')
}
