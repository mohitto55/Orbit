import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect, openTask, blurEditor } from './fixtures'
import { listTasks } from '../../src/core/task'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#277f86"/></svg>'

test('새 할 일에 여러 사진을 드롭하고 원본 파일을 지워도 저장·재열기 후 표시한다', async ({ orbit }) => {
  const photos = ['사진 한글.svg', '사진 둘.svg'].map((name) => path.join(orbit.directory, name))
  for (const photo of photos) await fs.writeFile(photo, svg)
  await orbit.page.locator('nav').getByRole('button', { name: '할 일', exact: true }).click()
  await orbit.page.getByRole('button', { name: 'Task 추가', exact: true }).click()
  await orbit.page.locator('.modal input').first().fill('사진 드롭 할 일')
  await orbit.page.locator('.modal select').nth(0).selectOption('feature')
  await orbit.page.locator('.modal select').nth(1).selectOption('지금')
  const editor = orbit.page.locator('.modal .live-markdown')
  const rect = await editor.locator('.cm-content').boundingBox()
  const cdp = await orbit.app.context().newCDPSession(orbit.page)
  const data = { items: [], files: photos, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: rect!.x + 24, y: rect!.y + 20, data })
  await cdp.detach(); await blurEditor(orbit.page)
  await expect(editor.locator('.md img')).toHaveCount(2)
  await expect.poll(() => editor.locator('.md img').evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth === 180))).toBe(true)
  for (const photo of photos) await fs.rm(photo)
  await orbit.page.locator('.modal').getByRole('button', { name: 'Task 만들기', exact: true }).click()
  await expect(orbit.page.locator('.modal')).toHaveCount(0)
  const task = (await listTasks(orbit.ctx))[0]
  expect(task.body).toContain('](../assets/'); expect(task.body).not.toContain(orbit.directory)
  await orbit.page.getByText('사진 드롭 할 일', { exact: true }).click()
  await orbit.page.locator('.modal input').first().focus()
  await expect.poll(() => editor.locator('.md img').evaluateAll((imgs) => imgs.length === 2 && imgs.every((img) => (img as HTMLImageElement).naturalWidth === 180))).toBe(true)
})

test('클립보드 사진 붙여넣기는 한 번의 실행 취소·다시 실행으로 되돌리고 저장한다', async ({ orbit }) => {
  const { editor, task } = await openTask(orbit, '사진 앞 문장')
  await editor.locator('.cm-content').focus(); await orbit.page.keyboard.press('ControlOrMeta+End')
  await editor.locator('.cm-content').evaluate((node, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([bytes], '클립보드.svg', { type: 'image/svg+xml' }))
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, svg)
  await expect(editor).toHaveAttribute('aria-busy', 'false'); await blurEditor(orbit.page)
  await expect(editor.getByAltText('클립보드.svg')).toBeVisible()
  await editor.locator('.cm-content').focus(); await orbit.page.keyboard.press('ControlOrMeta+z'); await blurEditor(orbit.page)
  await expect(editor.locator('.md img')).toHaveCount(0)
  await editor.locator('.cm-content').focus(); await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'); await blurEditor(orbit.page)
  await expect(editor.getByAltText('클립보드.svg')).toBeVisible()
  const source = await editor.locator('.cm-content').evaluate((node) => node.textContent ?? '')
  expect(source).toContain('사진 앞 문장')
  await orbit.page.locator('.modal').getByRole('button', { name: '저장', exact: true }).click()
  await expect(orbit.page.locator('.modal')).toHaveCount(0)
  const saved = (await listTasks(orbit.ctx)).find((row) => row.id === task.id)!
  expect(saved.body).toMatch(/^사진 앞 문장\n\n!\[클립보드.svg\]\(\.\.\/assets\//)
  await orbit.page.getByText(task.title, { exact: true }).click(); await orbit.page.locator('.modal input').first().focus()
  await expect.poll(() => editor.getByAltText('클립보드.svg').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(180)
})
