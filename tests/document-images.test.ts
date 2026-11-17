import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { documentImageResponse } from '../src/main/documentImages'
import { markdownImageUrl } from '../src/renderer/src/markdownImages'
import { newProject, tempDir } from './helpers'
import { SKILL_LOCATIONS } from '../src/core/skillLocations'

it('문서 상대 경로·파일 URL·절대 경로의 PNG와 SVG를 원본 바이트로 표시한다', async () => {
  const ctx = await newProject(), folder = path.join(ctx.dataRoot, 'domains', 'chat', 'design'), document = path.join(folder, 'flow.md')
  await fs.mkdir(path.join(folder, 'assets'), { recursive: true })
  const image = path.join(folder, 'assets', '그림 #1.svg'), bytes = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>'
  await fs.writeFile(image, bytes)
  const sources = ['assets/그림%20%231.svg', pathToFileURL(image).href, image.replace(/\\/g, '/').replace(/#/g, '%23')]
  if (process.platform === 'win32') sources.push('/' + sources[2])
  for (const source of sources) {
    const response = await documentImageResponse(markdownImageUrl(source, document), ctx, [path.join(ctx.projectDir, '.claude/skills')])
    expect(response.status, source).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(await response.text()).toBe(bytes)
  }
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  await fs.writeFile(path.join(folder, 'assets', 'image.png'), png)
  const response = await documentImageResponse(markdownImageUrl('assets/image.png', document), ctx, [ctx.projectDir])
  expect(response.headers.get('Content-Type')).toBe('image/png')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
})

it('없는 이미지, 프로젝트 밖 파일, HTML·스크립트는 이미지 경로로 읽지 않는다', async () => {
  const ctx = await newProject(), outside = await tempDir(), document = path.join(ctx.dataRoot, 'system-design.md')
  await fs.writeFile(path.join(outside, 'private.svg'), '<svg/>')
  await fs.writeFile(path.join(ctx.dataRoot, 'script.html'), '<script>alert(1)</script>')
  const read = (source: string) => documentImageResponse(markdownImageUrl(source, document), ctx, [path.join(ctx.projectDir, '.claude/skills')])
  expect((await read('missing.png')).status).toBe(404)
  expect((await read(path.join(outside, 'private.svg'))).status).toBe(403)
  expect((await read('script.html')).status).toBe(403)
  await fs.symlink(outside, path.join(ctx.dataRoot, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await read('outside/private.svg')).status).toBe(403)
  expect((await documentImageResponse(markdownImageUrl('image.png'), null, [outside])).status).toBe(404)
})

it('공백·#·%가 들어간 문서 폴더와 내 스킬의 이미지도 해당 문서를 기준으로 읽는다', async () => {
  const ctx = await newProject(), skillRoot = await tempDir(), folder = path.join(skillRoot, '한글 # 100%')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'image.svg'), '<svg/>')
  const response = await documentImageResponse(markdownImageUrl('image.svg', path.join(folder, 'SKILL.md')), ctx, [skillRoot])
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('<svg/>')
})

it('원격·내장 이미지만 허용하고 이미지에 실행 URL을 넣어도 전달하지 않는다', () => {
  for (const source of ['https://example.com/image.png', 'http://localhost/image.png', 'data:image/png;base64,iVBORw0KGgo=']) expect(markdownImageUrl(source)).toBe(source)
  expect(markdownImageUrl('//example.com/a.png')).toBe('https://example.com/a.png')
  for (const source of ['javascript:alert(1)', 'data:text/html,<script/>', 'data:image/svg+xml,<svg onload="alert(1)"/>', 'vbscript:x', 'orbit-image://local/?source=secret', '\nhttps://example.com/x']) expect(markdownImageUrl(source)).toBe('')
})

it('세 사용자 스킬 위치의 상대 이미지만 읽고 홈의 다른 파일은 차단한다', async () => {
  const ctx = await newProject(), home = await tempDir(), roots = SKILL_LOCATIONS.map((location) => path.join(home, `.${location}/skills`))
  for (const root of roots) {
    const folder = path.join(root, 'sample')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'diagram.svg'), '<svg/>')
    expect((await documentImageResponse(markdownImageUrl('diagram.svg', path.join(folder, 'SKILL.md')), ctx, roots)).status).toBe(200)
  }
  await fs.writeFile(path.join(home, 'private.svg'), '<svg/>')
  expect((await documentImageResponse(markdownImageUrl(path.join(home, 'private.svg')), ctx, roots)).status).toBe(403)
})
