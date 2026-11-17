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
