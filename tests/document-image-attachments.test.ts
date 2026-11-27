import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importDocumentImages, documentImageResponse } from '../src/main/documentImages'
import { markdownImageUrl } from '../src/renderer/src/markdownImages'
import { newProject, tempDir } from './helpers'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })
const image = { name: '사진 [한글].svg', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"/>') }

it('새 할 일과 중첩 도메인 문서에서 첨부를 표시하고 저장·이동 후 상대 경로를 유지한다', async () => {
  const ctx = await newProject(); roots.push(ctx.projectDir)
  for (const draft of ['tasks/new.md', 'domains/new/domain.md', 'domains/chat/design/new.md']) {
    const markdown = await importDocumentImages(ctx, [image], draft)
    expect(markdown).toContain('![사진 \\[한글\\].svg](')
    const source = markdown.match(/\]\(([^)]+)\)$/)![1]
    for (const document of [draft, draft.replace('new.md', 'saved.md').replace('/new/', '/chat/')]) {
      const response = await documentImageResponse(markdownImageUrl(source, document), ctx, [])
      expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(image.bytes)
    }
  }
  expect(await fs.readdir(path.join(ctx.dataRoot, 'assets'))).toHaveLength(1)
})

it('다중 첨부는 파일 이름이 같아도 내용을 덮어쓰지 않고 문서 밖 저장·파일 위장·링크를 거절한다', async () => {
  const ctx = await newProject(), outside = await tempDir(); roots.push(ctx.projectDir, outside)
  const second = { ...image, bytes: new TextEncoder().encode('<svg/>') }
  const markdown = await importDocumentImages(ctx, [image, second], 'tasks/new.md')
  expect(markdown.split('\n\n')).toHaveLength(2); expect(await fs.readdir(path.join(ctx.dataRoot, 'assets'))).toHaveLength(2)
  await expect(importDocumentImages(ctx, [{ ...image, name: 'x.html' }], 'tasks/new.md')).rejects.toThrow('이미지')
  await expect(importDocumentImages(ctx, [image], path.join(outside, 'doc.md'))).rejects.toThrow('저장할 수')
  const other = await newProject(); roots.push(other.projectDir)
  await fs.symlink(outside, path.join(other.dataRoot, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(importDocumentImages(other, [image], 'tasks/new.md')).rejects.toThrow('밖을')
  expect(await fs.readdir(outside)).toEqual([])
})

it('사용자 스킬은 스킬 폴더 안에 첨부를 저장한다', async () => {
  const ctx = await newProject(), skillRoot = await tempDir(); roots.push(ctx.projectDir, skillRoot)
  const folder = path.join(skillRoot, 'example'); await fs.mkdir(folder)
  const document = path.join(folder, 'SKILL.md'), markdown = await importDocumentImages(ctx, [image], document, [skillRoot])
  expect(markdown).toContain('](assets/')
  const response = await documentImageResponse(markdownImageUrl(markdown.match(/\]\(([^)]+)\)$/)![1], document), ctx, [skillRoot])
  expect(response.status).toBe(200)
})
