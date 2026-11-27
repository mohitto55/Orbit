import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect, openTask, saveTaskAndReopen, expectNoOverflow } from './fixtures'

for (const [kind, markup, resized] of [
  ['Markdown', '![도식](assets/size.svg "제목")', '![도식|300](assets/size.svg "제목")'],
  ['참조', '![도식][figure]\n\n[figure]: assets/size.svg "제목"', '![도식|300][figure]\n\n[figure]: assets/size.svg "제목"'],
  ['축약 참조', '![도식]\n\n[도식]: assets/size.svg', '![도식|300][도식]\n\n[도식]: assets/size.svg'],
  ['접힌 참조', '![도식][]\n\n[도식]: assets/size.svg', '![도식|300][도식]\n\n[도식]: assets/size.svg'],
  ['HTML', '<img src="assets/size.svg" alt="도식" width="180" height="90" title="제목">', '<img width="300" src="assets/size.svg" alt="도식" title="제목">'],
  ['표', '| 그림 | 메모 |\n|---|---|\n| ![도식](assets/size.svg) | 보존 |', '| 그림 | 메모 |\n|---|---|\n| ![도식\\|300](assets/size.svg) | 보존 |']
]) test(`${kind} 사진을 드래그로 확대하고 실행 취소·다시 실행·저장 후 크기를 유지한다`, async ({ orbit }) => {
  const folder = path.join(orbit.ctx.dataRoot, 'tasks/assets')
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'size.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#277f86"/></svg>')
  const source = '사진 앞\n\n' + markup + '\n\n사진 뒤'
  const { editor, task } = await openTask(orbit, source), image = editor.getByAltText('도식')
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(180)
  await image.click({ position: { x: 90, y: 75 } })
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(180)
  const handle = editor.getByRole('button', { name: '사진 크기 조절 se', exact: true })
  const box = (await handle.boundingBox())!
  await orbit.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await orbit.page.mouse.down(); await orbit.page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 }); await orbit.page.mouse.up()
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(300)
  expect(Math.round((await image.boundingBox())!.height)).toBe(150)
  await orbit.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(180)
  await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(300)
  const reopened = await saveTaskAndReopen(orbit, task, source.replace(markup, resized))
  await expect.poll(async () => Math.round((await reopened.getByAltText('도식').boundingBox())!.width)).toBe(300)
  await expectNoOverflow(reopened)
})

test('큰 사진의 높이 제한을 없애고 확대 보기에서 줌·이동·Escape가 본문을 보존한다', async ({ orbit }, testInfo) => {
  const folder = path.join(orbit.ctx.dataRoot, 'tasks/assets')
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'large.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="#277f86"/><text x="700" y="500" font-size="120" fill="white">확대 확인</text></svg>')
  const source = '![큰 도식](assets/large.svg)\n\n사진 뒤', { editor, task } = await openTask(orbit, source)
  const image = editor.getByAltText('큰 도식')
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2000)
  expect((await image.boundingBox())!.height).toBeGreaterThan(280)
  await image.dblclick({ position: { x: 100, y: 180 } })
  const dialog = orbit.page.getByRole('dialog', { name: '사진 크게 보기' })
  await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '원본 100%', exact: true }).click()
  await expect.poll(async () => Math.round((await dialog.getByAltText('큰 도식').boundingBox())!.width)).toBe(2000)
  await dialog.getByRole('button', { name: '확대', exact: true }).click()
  await expect(dialog.locator('output')).toHaveText('125%')
  const viewport = dialog.locator('.image-preview-viewport'), rect = (await viewport.boundingBox())!
  const before = await viewport.evaluate((el) => el.scrollLeft)
  await orbit.page.mouse.move(rect.x + 350, rect.y + 250); await orbit.page.mouse.down(); await orbit.page.mouse.move(rect.x + 250, rect.y + 180, { steps: 4 }); await orbit.page.mouse.up()
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 80)
  await orbit.page.mouse.wheel(0, -100); await expect(dialog.locator('output')).toHaveText('144%')
  await orbit.page.screenshot({ path: testInfo.outputPath('image-zoom.png') })
  await orbit.page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  await expect(editor).toBeVisible()
  await saveTaskAndReopen(orbit, task, source)
})

test('같은 사진 중 선택한 사진만 축소하고 드래그 취소·크기 초기화를 보존한다', async ({ orbit }, testInfo) => {
  const folder = path.join(orbit.ctx.dataRoot, 'tasks/assets')
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'same.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#277f86"/></svg>')
  const markup = '![사진](assets/same.svg)', source = `첫째\n\n${markup}\n\n둘째\n\n${markup}\n\n끝`
  const { editor, task } = await openTask(orbit, source), photos = editor.getByAltText('사진')
  await photos.nth(1).click()
  const frame = photos.nth(1).locator('xpath=../..'), handle = frame.getByRole('button', { name: '사진 크기 조절 se', exact: true })
  await handle.press('ArrowRight')
  await expect.poll(async () => Math.round((await photos.nth(1).boundingBox())!.width)).toBe(190)
  const drag = async (delta: number, cancel = false) => {
    await handle.scrollIntoViewIfNeeded(); const rect = (await handle.boundingBox())!
    await orbit.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await orbit.page.mouse.down(); await orbit.page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + rect.height / 2 + delta / 2, { steps: 4 })
    if (cancel) await orbit.page.keyboard.press('Escape')
    await orbit.page.mouse.up()
  }
  await drag(40, true)
  await expect.poll(async () => Math.round((await photos.nth(1).boundingBox())!.width)).toBe(190)
  await drag(-70)
  await expect.poll(async () => Math.round((await photos.nth(1).boundingBox())!.width)).toBe(120)
  expect(Math.round((await photos.first().boundingBox())!.width)).toBe(180)
  await orbit.page.screenshot({ path: testInfo.outputPath('image-handles.png') })
  const reopened = await saveTaskAndReopen(orbit, task, source.slice(0, source.lastIndexOf(markup)) + source.slice(source.lastIndexOf(markup)).replace(markup, '![사진|120](assets/same.svg)'))
  const selected = reopened.getByAltText('사진').nth(1)
  await selected.click(); await selected.locator('xpath=../..').getByRole('button', { name: '크기 초기화', exact: true }).click()
  await expect.poll(async () => Math.round((await selected.boundingBox())!.width)).toBe(180)
  await saveTaskAndReopen(orbit, task, source)
})
