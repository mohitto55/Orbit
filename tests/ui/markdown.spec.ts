import { test, expect, openTask, blurEditor, expectNoOverflow, saveTaskAndReopen, replaceDocument } from './fixtures'
import { markdownCases } from './markdown-cases'

test('제목·강조·취소선·코드·인용이 실제 화면 서식으로 구분된다', async ({ orbit }) => {
  const { editor } = await openTask(orbit, '# 제목\n\n평문\n\n**강조** *기울임* ~~취소~~ `inline`\n\n> 인용\n\n```ts\n  const x = 1\n```')
  const normal = Number.parseFloat(await editor.getByText('평문', { exact: true }).evaluate((el) => getComputedStyle(el).fontSize))
  const heading = Number.parseFloat(await editor.locator('.cm-md-h1').evaluate((el) => getComputedStyle(el).fontSize))
  expect(heading).toBeGreaterThan(normal * 1.4)
  expect(Number(await editor.locator('.cm-md-strong').evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(650)
  await expect(editor.locator('.cm-md-em')).toHaveCSS('font-style', 'italic')
  await expect(editor.locator('.cm-md-strike')).toHaveCSS('text-decoration-line', 'line-through')
  expect(await editor.locator('.cm-md-inline-code').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  expect(Number.parseFloat(await editor.locator('.cm-md-quote').evaluate((el) => getComputedStyle(el).borderLeftWidth))).toBeGreaterThan(0)
  await expect(editor.locator('.cm-md-code', { hasText: 'const x' })).toHaveText('  const x = 1', { useInnerText: false })
})

test('표가 바로 앞 문단 아래에 배치되고 원문 줄 수만큼 밀리지 않는다', async ({ orbit }, testInfo) => {
  const source = '표 앞 문단\n\n| 이름 | 설명 |\n| --- | --- |\n' + Array.from({ length: 8 }, (_, i) => `| 항목 ${i + 1} | 설명 ${i + 1} |`).join('\n') + '\n\n표 뒤 문단'
  const { editor } = await openTask(orbit, source)
  const before = editor.locator('.cm-line', { hasText: '표 앞 문단' })
  const table = editor.locator('table')
  await expect(table).toBeAttached()
  const gap = await table.evaluate((el) => {
    const before = [...el.closest('.cm-content')!.querySelectorAll('.cm-line')].find((line) => line.textContent === '표 앞 문단')!
    return el.getBoundingClientRect().top - before.getBoundingClientRect().bottom
  })
  await testInfo.attach('table-gap', { body: JSON.stringify({ gap, maximum: 60 }), contentType: 'application/json' })
  expect(gap, 'Table must follow one blank line, not the hidden Markdown source lines').toBeLessThan(60)
  await expect(before).toBeVisible()
})

test('여러 표와 인용·목록 안의 표가 본문 순서대로 렌더링된다', async ({ orbit }) => {
  const source = '첫 표 앞\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n둘째 표 앞\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\n> 인용 표\n>\n> | E | F |\n> | --- | --- |\n> | 5 | 6 |\n\n- 목록 표\n\n  | G | H |\n  | --- | --- |\n  | 7 | 8 |\n\n마지막'
  const { editor, task } = await openTask(orbit, source)
  await expect(editor.locator('table')).toHaveCount(4)
  const positions = await editor.locator('table').evaluateAll((tables) => tables.map((table) => ({ top: table.getBoundingClientRect().top, bottom: table.getBoundingClientRect().bottom })))
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i].top).toBeGreaterThanOrEqual(positions[i - 1].bottom)
    expect(positions[i].top - positions[i - 1].bottom).toBeLessThan(130)
  }
  await editor.getByRole('cell', { name: '5', exact: true }).click()
  await orbit.page.keyboard.insertText('인용 ')
  await blurEditor(orbit.page)
  await expect(editor.getByRole('cell', { name: '인용 5', exact: true })).toBeAttached()
  await saveTaskAndReopen(orbit, task, source.replace('> | 5 |', '> | 인용 5 |'))
})

for (const item of markdownCases) {
  test(`Markdown: ${item.name} — 표시·입력·실행 취소·저장·재열기`, async ({ orbit }) => {
    const { editor, task } = await openTask(orbit, item.source)
    for (const [selector, count] of item.checks) await expect(editor.locator(selector), selector).toHaveCount(count)
    if (item.name.startsWith('escaped syntax')) await expect(editor.locator('.cm-content')).not.toContainText('\\')
    if (item.name.startsWith('inline links')) await expect(editor.locator('.cm-content')).not.toContainText('<https://')
    await expectNoOverflow(editor)
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press('ControlOrMeta+End')
    await orbit.page.keyboard.insertText('\n\n추가한 한글 문장')
    await expect(editor.locator('.cm-content')).toContainText('추가한 한글 문장')
    await orbit.page.keyboard.press('ControlOrMeta+z')
    await expect(editor.locator('.cm-content')).not.toContainText('추가한 한글 문장')
    await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await blurEditor(orbit.page)
    await expect(editor.locator('.cm-content')).toContainText('추가한 한글 문장')
    const reopened = await saveTaskAndReopen(orbit, task, item.source + '\n\n추가한 한글 문장')
    for (const [selector, count] of item.checks) {
      if (selector !== '.cm-line') await expect(reopened.locator(selector), selector).toHaveCount(count)
    }
    await expectNoOverflow(reopened)
  })
}

test('표 셀을 클릭한 자리에서 수정하고 포커스를 옮겨도 표가 제자리에 남는다', async ({ orbit }) => {
  const source = '표 앞 문단\n\n| 첫 열 | 둘째 열 |\n| --- | --- |\n| 첫 셀 | 수정 대상 |\n\n표 뒤 문단'
  const { editor, task } = await openTask(orbit, source)
  for (let cycle = 0; cycle < 3; cycle++) {
    const cell = editor.getByRole('cell', { name: '수정 대상', exact: true })
    await cell.click()
    await expect(editor.locator('table')).toHaveCount(0)
    await expect.poll(() => orbit.page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent)).toContain('| 첫 셀 | 수정 대상 |')
    await blurEditor(orbit.page)
    await expect(editor.getByRole('cell', { name: '수정 대상', exact: true })).toBeVisible()
  }
  await editor.getByRole('cell', { name: '수정 대상', exact: true }).click()
  await orbit.page.keyboard.insertText('바뀐 ')
  await blurEditor(orbit.page)
  await expect(editor.getByRole('cell', { name: '바뀐 수정 대상', exact: true })).toBeVisible()
  await saveTaskAndReopen(orbit, task, source.replace('수정 대상', '바뀐 수정 대상'))
})

for (const width of [960, 1360]) for (const theme of ['light', 'dark'] as const) {
  test(`표·체크박스 배치 ${width}px ${theme}`, async ({ orbit }) => {
    await orbit.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), width)
    await orbit.page.evaluate((theme) => window.orbit.invoke('setThemeMode', theme), theme)
    const source = '체크 앞\n\n- [ ] TODO\n  - [x] 중첩 완료\n\n표 앞\n\n| 왼쪽 | 가운데 | 오른쪽 |\n| :--- | :---: | ---: |\n| A | B | C |\n\n표 뒤'
    const { editor } = await openTask(orbit, source)
    const box = editor.locator('.cm-md-task-box').first()
    const geometry = await box.evaluate((el) => {
      const rect = el.getBoundingClientRect(), line = el.closest('.cm-line')!.getBoundingClientRect()
      return { width: rect.width, height: rect.height, left: rect.left - line.left }
    })
    expect(geometry.width).toBeGreaterThan(12)
    expect(geometry.width).toBeLessThan(18)
    expect(geometry.left).toBeLessThan(3)
    const nested = await editor.locator('.cm-md-task-box').nth(1).boundingBox()
    const first = await box.boundingBox()
    expect(nested!.x).toBeGreaterThan(first!.x + 3)
    for (const [column, align] of ['left', 'center', 'right'].entries()) {
      await expect(editor.locator('th').nth(column)).toHaveCSS('text-align', align)
      await expect(editor.locator('td').nth(column)).toHaveCSS('text-align', align)
    }
    await expectNoOverflow(editor)
  })
}

for (const height of [680, 860]) test(`긴 표·연속 표·수평 스크롤·문서 스크롤 ${height}px`, async ({ orbit }) => {
  await orbit.app.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setSize(1024, height), height)
  const table = '| 이름 | 설명 |\n| --- | --- |\n' + Array.from({ length: 35 }, (_, i) => `| 행 ${i} | 설명 ${i} |`).join('\n')
  const { editor } = await openTask(orbit, '맨 위\n\n' + table + '\n\n두 표 사이\n\n' + table + '\n\n맨 아래')
  // CodeMirror virtualizes offscreen blocks. Check both ends after scrolling.
  await expect(editor.locator('table').first()).toBeAttached()
  const blocks = await editor.locator('.cm-md-block').evaluateAll((elements) => elements.map((block) => {
    const table = block.querySelector('table')!, b = block.getBoundingClientRect(), t = table.getBoundingClientRect()
    return { gap: t.top - b.top, excess: b.height - t.height }
  }))
  for (const block of blocks) { expect(block.gap).toBeLessThan(15); expect(block.excess).toBeLessThan(30) }
  // The modal itself scrolls on short displays. Bring the editor into the window
  // before testing scrolling inside it; otherwise the modal clips its last line.
  await editor.locator('.cm-scroller').scrollIntoViewIfNeeded()
  await editor.locator('.cm-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(editor.getByText('맨 아래', { exact: true })).toBeInViewport()
  await expect(editor.locator('table').last().getByRole('cell', { name: '행 34', exact: true })).toBeAttached()
  await editor.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 0 })
  await expect(editor.getByText('맨 위', { exact: true })).toBeInViewport()
  await replaceDocument(orbit.page, editor, '| 첫 열 | 둘째 |\n| --- | --- |\n| ' + 'x'.repeat(300) + ' | 값 |')
  await expectNoOverflow(editor)
  const wrapper = editor.locator('.md-table')
  await expect(wrapper).toBeAttached()
  expect(await wrapper.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100)
})

test('체크 상태 변경·실행 취소·다시 실행·저장 후 재열기', async ({ orbit }) => {
  const source = '- [ ] TODO\n  - [x] 중첩 완료\n\n끝'
  const { editor, task } = await openTask(orbit, source)
  await editor.locator('.cm-md-task-box').first().check()
  await expect(editor.locator('.cm-md-task-box').first()).toBeChecked()
  await editor.locator('.cm-content').focus()
  await orbit.page.keyboard.press('ControlOrMeta+End')
  await orbit.page.keyboard.press('ControlOrMeta+z')
  await blurEditor(orbit.page)
  await expect(editor.locator('.cm-md-task-box').first()).not.toBeChecked()
  await editor.locator('.cm-content').focus()
  await orbit.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await blurEditor(orbit.page)
  await expect(editor.locator('.cm-md-task-box').first()).toBeChecked()
  await saveTaskAndReopen(orbit, task, source.replace('- [ ]', '- [x]'))
})
