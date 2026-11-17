import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
export async function documentImageResponse(url: string, ctx: Ctx | null, skillRoot: string): Promise<Response> {
  try {
    const request = new URL(url), source = request.searchParams.get('source'), document = request.searchParams.get('document')
    if (request.protocol !== 'orbit-image:' || request.hostname !== 'local' || !source || !ctx) return new Response(null, { status: 404 })
    const base = document ? path.dirname(document) : ctx.dataRoot
    const candidate = path.resolve(base, localPath(source)), allowed = [ctx.projectDir, ctx.dataRoot, skillRoot]
    if (!allowed.some((root) => inside(path.resolve(root), candidate))) return new Response(null, { status: 403 })
    const file = await fs.realpath(candidate)
    const roots = await Promise.all(allowed.map((root) => fs.realpath(root).catch(() => null)))
    const type = imageTypes[path.extname(file).toLowerCase()]
    if (!type || !roots.some((root) => root && inside(root, file))) return new Response(null, { status: 403 })
    const info = await fs.stat(file)
    if (!info.isFile()) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(await fs.readFile(file)), { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-cache' } })
  } catch { return new Response(null, { status: 404 }) }
}
