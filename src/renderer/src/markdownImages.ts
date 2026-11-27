import { parser } from '@lezer/markdown'

/** Obsidian 방식의 이미지 너비를 남기고 URL·참조·주변 Markdown은 보존한다. */
export function resizeImageMarkup(source: string, width: number | null, inTable = false): string {
  const pixels = width === null ? '' : String(Math.max(24, Math.min(10000, Math.round(width))))
  const size = pixels ? `${inTable ? '\\|' : '|'}${pixels}` : ''
  if (/^<img\b/i.test(source)) {
    const tag = source.replace(/(\s+)([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, (attribute, _space: string, name: string) => /^(width|height)$/i.test(name) ? '' : attribute)
    return width === null ? tag : tag.replace(/^<img\b/i, (start) => `${start} width="${pixels}"`)
  }
  let end = -1
  parser.parse(source).iterate({ enter(node) {
    if (node.name === 'Image' && node.from === 0) {
      end = node.node.getChildren('LinkMark').find((mark) => source.slice(mark.from, mark.to) === ']')?.from ?? -1
      return false
    }
  } })
  if (end < 0) return source
  const alt = source.slice(2, end).replace(/(?<!\\)(?:\\)?\|\d+(?:x\d+)?$/, '')
  const tail = source.slice(end + 1)
  // 축약·접힌 참조는 설명이 바뀌면 링크 대상도 바뀌므로 기존 참조 이름을 명시한다.
  const reference = width !== null && (tail === '' || tail === '[]') ? `[${source.slice(2, end)}]` : tail
  return `![${alt}${size}]${reference}`
}

/** 원문은 그대로 두고, 로컬 이미지만 문서 위치를 아는 앱 이미지 경로로 표시한다. */
export function markdownImageUrl(source: string, documentPath?: string): string {
  if (!source || /[\u0000-\u001f]/.test(source)) return ''
  if (/^https?:\/\//i.test(source)) return source
  if (source.startsWith('//')) return `https:${source}`
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(source)) return source
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^file:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) return ''
  const params = new URLSearchParams({ source })
  if (documentPath) params.set('document', documentPath)
  return `orbit-image://local/?${params}`
}
