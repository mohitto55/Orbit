import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { test, expect, blurEditor, expectNoOverflow, replaceDocument, type Orbit } from './fixtures'
import { integrationSource } from './markdown-cases'
import { createDomain, saveDomain, listDomains } from '../../src/core/domain'
import { createSystemDesign, saveDesign } from '../../src/core/design'
import { saveKnowledge } from '../../src/core/knowledge'
import { saveSkill } from '../../src/core/skills'
import { writeDraft, readDraft } from '../../src/core/requestDraft'
import { writeMd, readMd } from '../../src/core/md'

type Kind = 'role' | 'design' | 'system' | 'knowledge' | 'skill' | 'request'

async function seed(orbit: Orbit, kind: Kind) {
  let file: string
  if (kind === 'knowledge') file = (await saveKnowledge(orbit.ctx, { type: '결정', title: 'Markdown QA 지식', content: integrationSource })).file
  else if (kind === 'skill') file = (await saveSkill(orbit.ctx.projectDir, { scope: 'project', name: 'markdown-ui-qa', description: 'Markdown QA', body: integrationSource })).file
  else {
    const domain = await createDomain(orbit.ctx, { title: 'Markdown QA 도메인', folder: 'markdown-qa' })
    await saveDomain(orbit.ctx, domain.id, { content: integrationSource }, { size: 'minor', summary: 'UI test fixture' })
    file = domain.file!
    if (kind === 'design') {
      file = path.join(orbit.ctx.dataRoot, 'domains/markdown-qa/design/qa.md')
      await writeMd(file, { id: 'design-ui-qa', title: 'Markdown QA 설계', version: 1, basedOn: [], refs: [] }, integrationSource)
    } else if (kind === 'system') {
      const design = await createSystemDesign(orbit.ctx)
      await saveDesign(orbit.ctx, design.id, integrationSource, { size: 'minor', summary: 'UI test fixture' })
      file = design.file
    } else if (kind === 'request') {
      file = path.join(orbit.ctx.dataRoot, 'requests/req-ui-qa.md')
      await writeMd(file, { id: 'req-ui-qa', kind: 'domain-request', domain: domain.id, excerpt: 'Markdown QA 요청', source: 'UI test', status: 'pending', created: new Date().toISOString() }, 'Markdown QA 요청')
      await writeDraft(file, { agent: 'codex', base: domain.version + 1, content: integrationSource })
    }
  }
  // A request draft resolves images relative to the target domain document.
  const folder = kind === 'request' ? path.join(orbit.ctx.dataRoot, 'domains/markdown-qa') : path.dirname(file)
  await fs.mkdir(path.join(folder, 'assets'), { recursive: true })
  await fs.writeFile(path.join(folder, 'assets/flow.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#277f86"/></svg>')
  return file
}

test('새 도메인의 역할도 렌더링된 본문에서 작성하고 생성 후 다시 연다', async ({ orbit }) => {
  const page = orbit.page
  await page.locator('nav').getByRole('button', { name: '도메인', exact: true }).click()
  await page.getByRole('button', { name: '+ 새 도메인', exact: true }).click()
  await page.locator('.modal input').first().fill('새 Markdown 도메인')
  await page.getByPlaceholder('예: order-customer').fill('new-markdown')
  const source = '**새 역할**\n\n- [ ] 확인\n\n| 항목 | 내용 |\n| --- | --- |\n| 생성 | 보존 |'
  const editor = page.locator('.modal .live-markdown')
  await replaceDocument(page, editor, source)
  await expect(editor.locator('table')).toHaveCount(1)
  await expect(editor.locator('.cm-md-task-box')).not.toBeChecked()
  await page.locator('.modal').getByRole('button', { name: '만들기', exact: true }).click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect.poll(async () => (await listDomains(orbit.ctx))[0]?.content).toContain(source)
  await page.reload()
  await page.getByRole('button', { name: '문서로', exact: true }).click()
  await expect(page.locator('.live-markdown:visible').getByRole('cell', { name: '생성', exact: true })).toBeAttached()
  await expect(page.locator('.live-markdown:visible .cm-md-strong')).toHaveText('새 역할')
})

async function openDocument(orbit: Orbit, kind: Kind) {
  const page = orbit.page
  await page.reload()
  if (kind === 'knowledge') {
    await page.locator('nav').getByRole('button', { name: '지식', exact: true }).click()
    await page.locator('.pane-list').getByRole('button', { name: /Markdown QA 지식/ }).click()
  } else if (kind === 'skill') {
    await page.locator('nav').getByRole('button', { name: '자동화', exact: true }).click()
    await page.getByRole('button', { name: '그래프', exact: true }).click()
    await page.locator('.pipe-skill-row').getByRole('button', { name: /^markdown-ui-qa\s*프로젝트 · Claude Code$/ }).click()
  } else if (kind === 'request') {
    await page.locator('nav').getByRole('button', { name: /^변경 검토/ }).click()
    await page.getByRole('button', { name: '직접 다듬기', exact: true }).click()
  } else {
    await page.locator('nav').getByRole('button', { name: '도메인', exact: true }).click()
    await page.getByRole('button', { name: kind === 'system' ? '공통 설계' : '문서로', exact: true }).click()
    if (kind === 'design') await page.getByRole('button', { name: '설계 (3층)', exact: true }).click()
  }
  const editor = page.locator('.live-markdown:visible')
  await expect(editor).toHaveCount(1)
  await expect(editor.locator('.cm-content')).toBeVisible()
  return editor
}

for (const kind of ['role', 'design', 'system', 'knowledge', 'skill', 'request'] as const) {
  test(`${kind}: 같은 본문에서 표·체크·이미지 표시, 편집, 실제 파일 저장 및 재열기`, async ({ orbit }) => {
    const file = await seed(orbit, kind)
    let editor = await openDocument(orbit, kind)
    await expect(editor.locator('.cm-md-h1')).toHaveText('문서 제목')
    await expect(editor.getByRole('cell', { name: '첫 셀', exact: true })).toBeAttached()
    await expect(editor.locator('.cm-md-task-box')).toHaveCount(2)
    await expect(editor.locator('textarea')).toHaveCount(0)
    await expectNoOverflow(editor)
    const geometry = await editor.locator('table').evaluate((table) => table.getBoundingClientRect().top - table.closest('.cm-md-block')!.getBoundingClientRect().top)
    expect(geometry).toBeLessThan(15)
    await editor.locator('.cm-md-task-box').first().check()
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press('ControlOrMeta+End')
    await orbit.page.keyboard.insertText('\n\n저장 검증 한글')
    const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="45" height="30"><rect width="45" height="30"/></svg>'
    await editor.locator('.cm-content').evaluate((node, picture) => {
      const data = new DataTransfer(); data.items.add(new File([picture], '첨부.svg', { type: 'image/svg+xml' }))
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, picture)
    await expect(editor).toHaveAttribute('aria-busy', 'false')
    await blurEditor(orbit.page)
    await expect.poll(() => editor.getByAltText('첨부.svg').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(45)
    await expect.poll(() => editor.getByAltText('도식').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160)
    const photo = editor.getByAltText('첨부.svg')
    await photo.click()
    const handle = photo.locator('xpath=..').getByRole('button', { name: '사진 크기 조절 se', exact: true })
    await handle.scrollIntoViewIfNeeded()
    const rect = (await handle.boundingBox())!
    await orbit.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await orbit.page.mouse.down(); await orbit.page.mouse.move(rect.x + rect.width / 2 + 30, rect.y + rect.height / 2 + 20, { steps: 4 }); await orbit.page.mouse.up()
    await expect.poll(async () => Math.round((await photo.boundingBox())!.width)).toBe(75)
    if (kind === 'request') await orbit.page.getByRole('button', { name: '다듬은 내용 저장', exact: true }).click()
    else {
      await orbit.page.getByRole('button', { name: '저장', exact: true }).click()
      if (['role', 'design', 'system'].includes(kind)) {
        await orbit.page.getByPlaceholder('무엇이 왜 바뀌었나').fill('Markdown UI 저장 검증')
        await orbit.page.locator('.modal').getByRole('button', { name: '저장', exact: true }).click()
      }
    }
    const imageDocument = kind === 'request' ? path.join(orbit.ctx.dataRoot, 'domains/markdown-qa/domain.md') : file
    const source = path.relative(path.dirname(imageDocument), path.join(orbit.ctx.dataRoot, 'assets', createHash('sha256').update(picture).digest('hex') + '.svg')).split(path.sep).join('/')
    const expected = integrationSource.replace('- [ ]', '- [x]') + `\n\n저장 검증 한글\n\n![첨부.svg|75](${source})`
    await expect.poll(async () => (kind === 'request' ? (await readDraft(file))!.content : (await readMd(file)).content).trim()).toBe(expected)
    editor = await openDocument(orbit, kind)
    await expect(editor.locator('.cm-md-task-box').first()).toBeChecked()
    await editor.locator('.cm-content').focus()
    await orbit.page.keyboard.press('ControlOrMeta+End')
    await blurEditor(orbit.page)
    await expect(editor.locator('.cm-content')).toContainText('저장 검증 한글')
    await expect.poll(() => editor.getByAltText('도식').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160)
    await expect.poll(() => editor.getByAltText('첨부.svg').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(45)
    await expect.poll(async () => Math.round((await editor.getByAltText('첨부.svg').boundingBox())!.width)).toBe(75)
    await expectNoOverflow(editor)
  })
}
