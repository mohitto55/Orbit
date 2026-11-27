import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { test, expect, openTask, blurEditor, saveTaskAndReopen, expectNoOverflow } from './fixtures'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#277f86"/><circle cx="90" cy="45" r="24" fill="#fff"/></svg>'

for (const [index, kind] of ['상대', '절대', 'file URL', '한글 경로', '참조', 'HTML', '표', 'HTTP', 'data'].entries()) test(`${kind} 이미지 로드·저장·재열기`, async ({ orbit }) => {
  const assets = path.join(orbit.ctx.dataRoot, 'tasks/assets')
  await fs.mkdir(assets, { recursive: true })
  await fs.writeFile(path.join(assets, 'flow.svg'), svg)
  await fs.writeFile(path.join(assets, '한글 도식.svg'), svg)
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end(svg) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP image fixture did not start')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII='
    const images = [
      '![상대](assets/flow.svg)',
      `![절대](${path.join(assets, 'flow.svg').replace(/\\/g, '/')})`,
      `![파일](${pathToFileURL(path.join(assets, 'flow.svg')).href})`,
      '![한글](assets/%ED%95%9C%EA%B8%80%20%EB%8F%84%EC%8B%9D.svg)',
      '![참조][diagram]',
      '<img src="assets/flow.svg" alt="HTML" width="120">',
      '| 이미지 |\n| --- |\n| ![표 이미지](assets/flow.svg) |',
      `![HTTP](http://127.0.0.1:${address.port}/flow.svg)`,
      `![data](data:image/png;base64,${png})`
    ]
    const source = '이미지 시작\n\n' + images[index] + '\n\n[diagram]: assets/flow.svg\n\n이미지 끝'
    const { editor, task } = await openTask(orbit, source)
    await expect(editor.locator('.md img')).toHaveCount(1)
    await expect.poll(() => editor.locator('.md img').evaluateAll((imgs) => imgs.every((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0))).toBe(true)
    await expect(editor.locator('.cm-md-image-error')).toHaveCount(0)
    await expectNoOverflow(editor)
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press('ControlOrMeta+End')
    await orbit.page.keyboard.insertText('\n\n이미지 검증 완료')
    const reopened = await saveTaskAndReopen(orbit, task, source + '\n\n이미지 검증 완료')
    await expect.poll(() => reopened.locator('.md img').evaluateAll((imgs) => imgs.length === 1 && imgs.every((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0))).toBe(true)
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

for (const markup of ['![도식](assets/flow.svg)', '<img src="assets/flow.svg" alt="도식" width="120">']) {
  test(`이미지 클릭 → 설명 편집 → 되돌리기 → 저장: ${markup}`, async ({ orbit }) => {
    const assets = path.join(orbit.ctx.dataRoot, 'tasks/assets')
    await fs.mkdir(assets, { recursive: true }); await fs.writeFile(path.join(assets, 'flow.svg'), svg)
    const source = '문서 시작\n\n' + markup + '\n\n문서 끝'
    const { editor, task } = await openTask(orbit, source)
    const image = editor.getByAltText('도식')
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(180)
    await image.click()
    await editor.getByRole('button', { name: '설명·경로 편집', exact: true }).click()
    await expect(editor.locator('.cm-content')).toContainText(markup)
    for (let i = 0; i < markup.indexOf('도식'); i++) await orbit.page.keyboard.press('ArrowRight')
    await orbit.page.keyboard.insertText('새 ')
    await blurEditor(orbit.page)
    await expect(editor.getByAltText('새 도식')).toBeVisible()
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press('ControlOrMeta+End')
    await orbit.page.keyboard.press('ControlOrMeta+z')
    await blurEditor(orbit.page)
    await expect(editor.getByAltText('도식')).toBeVisible()
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await blurEditor(orbit.page)
    await saveTaskAndReopen(orbit, task, source.replace('도식', '새 도식'))
  })
}

test('깨진 이미지의 경로를 본문에서 수정해 복구한다', async ({ orbit }) => {
  const assets = path.join(orbit.ctx.dataRoot, 'tasks/assets')
  await fs.mkdir(assets, { recursive: true }); await fs.writeFile(path.join(assets, 'flow.svg'), svg)
  const source = '이미지 앞\n\n![깨진 도식](assets/missing.svg)\n\n이미지 뒤'
  const { editor, task } = await openTask(orbit, source)
  await editor.locator('.cm-md-image-error').click()
  await orbit.page.keyboard.press('ControlOrMeta+a')
  await orbit.page.keyboard.insertText(source.replace('missing.svg', 'flow.svg'))
  await blurEditor(orbit.page)
  await expect.poll(() => editor.getByAltText('깨진 도식').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(180)
  await expect(editor.locator('.cm-md-image-error')).toHaveCount(0)
  await saveTaskAndReopen(orbit, task, source.replace('missing.svg', 'flow.svg'))
})

test('HTML·링크의 위험한 속성은 실행되지 않고 안전한 본문은 표시된다', async ({ orbit }) => {
  const source = '<div>안전한 본문<img src="missing.svg" onerror="window.__markdownExecuted=true"><script>window.__markdownExecuted=true</script></div>\n\n| 링크 |\n| --- |\n| [위험](javascript:alert%281%29) |'
  const { editor } = await openTask(orbit, source)
  await expect(editor.locator('script,[onerror],a[href^="javascript:"]')).toHaveCount(0)
  await expect(editor.locator('.cm-content')).toContainText('안전한 본문')
  expect(await orbit.page.evaluate(() => '__markdownExecuted' in window)).toBe(false)
})

test('한글 IME 조합 중 렌더링이 입력을 끊지 않고 실행 취소·저장한다', async ({ orbit }) => {
  const { editor, task } = await openTask(orbit, '시작\n\n')
  await editor.locator('.cm-content').focus()
  await orbit.page.keyboard.press('ControlOrMeta+End')
  await orbit.page.keyboard.insertText('\n\n')
  const session = await orbit.app.context().newCDPSession(orbit.page)
  // Chromium's composition path, including beforeinput/input and composition events.
  for (const text of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
    await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await expect(editor.locator('.cm-content')).toContainText(text)
  }
  await session.send('Input.insertText', { text: '한글' })
  await session.detach()
  await orbit.page.keyboard.insertText(' 입력 완료')
  await expect(editor.locator('.cm-content')).toContainText('한글 입력 완료')
  await orbit.page.keyboard.press('ControlOrMeta+z')
  await expect(editor.locator('.cm-content')).not.toContainText('입력 완료')
  await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect(editor.locator('.cm-content')).toContainText('한글 입력 완료')
  await blurEditor(orbit.page)
  await saveTaskAndReopen(orbit, task, '시작\n\n한글 입력 완료')
})

test('Markdown 붙여넣기 후 Enter로 목록을 이어 쓰고 빈 항목에서 끝낸다', async ({ orbit }) => {
  const { editor, task } = await openTask(orbit, '시작')
  await editor.locator('.cm-content').focus()
  await orbit.page.keyboard.press('ControlOrMeta+a')
  await editor.locator('.cm-content').evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', '# 붙여넣기\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\n- [x] 완료')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await orbit.page.keyboard.press('ControlOrMeta+End')
  await orbit.page.keyboard.press('Enter')
  await orbit.page.keyboard.insertText('새 항목')
  await orbit.page.keyboard.press('Enter')
  await orbit.page.keyboard.press('Enter')
  await orbit.page.keyboard.insertText('목록 끝')
  await blurEditor(orbit.page)
  await expect(editor.locator('table')).toHaveCount(1)
  await expect(editor.locator('.cm-md-task-box')).toHaveCount(2)
  await saveTaskAndReopen(orbit, task, '# 붙여넣기\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 완료\n- [ ] 새 항목\n목록 끝')
})
