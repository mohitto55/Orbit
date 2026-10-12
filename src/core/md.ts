import { promises as fs } from 'fs'
import path from 'path'
import matter from 'gray-matter'

export interface MdDoc<T = Record<string, any>> {
  path: string
  data: T
  content: string
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readMd<T = Record<string, any>>(p: string): Promise<MdDoc<T>> {
  const raw = (await fs.readFile(p, 'utf8')).replace(/\r\n/g, '\n')
  // 옵션 객체를 넘겨 gray-matter의 내용 기반 캐시를 끈다 (캐시된 객체를 수정하는 문제 방지)
  const parsed = matter(raw, {})
  return { path: p, data: parsed.data as T, content: parsed.content }
}

export async function writeMd(p: string, data: object, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  const clean = JSON.parse(JSON.stringify(data))
  const body = content.startsWith('\n') ? content : '\n' + content
  await fs.writeFile(p, matter.stringify(body, clean), 'utf8')
}

export async function listMd(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return []
  const names = await fs.readdir(dir)
  return names
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => path.join(dir, n))
}

export async function listDirs(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export function nowIso(): string {
  return new Date().toISOString()
}

let seq = 0
/** 파일 이름용 고유 시각 문자열: 20261012-213045-001 */
export function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  seq = (seq + 1) % 1000
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(seq, 3)}`
  )
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 본문에서 `## 제목` 섹션의 첫 문단을 꺼낸다. */
export function sectionText(content: string, heading: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return ''
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}
