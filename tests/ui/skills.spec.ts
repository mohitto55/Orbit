import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect, blurEditor, type Orbit } from './fixtures'
import { SKILL_LOCATIONS, SKILL_LOCATION_LABELS } from '../../src/core/skillLocations'
import { readMd, writeMd } from '../../src/core/md'

async function openSkills(orbit: Orbit) {
  await orbit.page.reload()
  await orbit.page.locator('nav').getByRole('button', { name: '자동화', exact: true }).click()
  await orbit.page.getByRole('button', { name: '그래프', exact: true }).click()
  await expect(orbit.page.getByRole('searchbox', { name: '스킬 검색' })).toBeVisible()
}

test('사용자 Codex backend 스킬 세 개를 검색하고 원래 파일에 저장한다', async ({ orbit }) => {
  await openSkills(orbit)
  const names = ['backend-caching-strategy', 'backend-cdn-cache-busting', 'backend-file-versioning']
  const body = '# 기준\n\n- [ ] 확인\n\n![도식](assets/flow.svg)\n\n끝'
  for (const name of names) {
    const folder = path.join(orbit.isolatedHome, '.codex/skills', name)
    await writeMd(path.join(folder, 'SKILL.md'), { name, description: `검증: ${name}`, custom: 'preserve' }, body)
    await fs.mkdir(path.join(folder, 'assets'))
    await fs.writeFile(path.join(folder, 'assets/flow.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="teal"/></svg>')
  }
  await orbit.page.getByTitle('스킬 새로고침', { exact: true }).click()
  await orbit.page.getByRole('searchbox', { name: '스킬 검색' }).fill('backend-')
  await expect(orbit.page.locator('.pipe-skill-row')).toHaveCount(3)
  for (const name of names) await expect(orbit.page.getByRole('button', { name: `${name} 내 스킬 · Codex`, exact: true })).toBeVisible()
  await orbit.page.getByRole('button', { name: `${names[0]} 내 스킬 · Codex`, exact: true }).click()
  await expect(orbit.page.getByLabel('저장 위치', { exact: true })).toHaveValue('codex')
  await expect(orbit.page.getByLabel('저장 위치', { exact: true })).toBeDisabled()
  const editor = orbit.page.locator('.live-markdown:visible')
  await expect.poll(() => editor.getByAltText('도식').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120)
  await editor.locator('.cm-content').focus()
  await orbit.page.keyboard.press('ControlOrMeta+End')
  await orbit.page.keyboard.insertText('\n\nCodex 저장 확인')
  await blurEditor(orbit.page)
  await orbit.page.getByRole('button', { name: '저장', exact: true }).click()
  const file = path.join(orbit.isolatedHome, '.codex/skills', names[0], 'SKILL.md')
  await expect.poll(async () => (await readMd(file)).content.trim()).toBe(body + '\n\nCodex 저장 확인')
  expect((await readMd(file)).data.custom).toBe('preserve')
  expect(await fs.stat(path.join(orbit.isolatedHome, '.claude/skills', names[0])).catch(() => null)).toBeNull()
  await openSkills(orbit)
  await orbit.page.getByRole('button', { name: `${names[0]} 내 스킬 · Codex`, exact: true }).click()
  await expect(editor.locator('.cm-content')).toContainText('Codex 저장 확인')
})

test('동명 스킬 여섯 개의 저장 위치·범위를 구분해 선택한다', async ({ orbit }) => {
  for (const scope of ['project', 'user'] as const) for (const location of SKILL_LOCATIONS) {
    const base = scope === 'project' ? orbit.ctx.projectDir : orbit.isolatedHome
    await writeMd(path.join(base, `.${location}/skills/same-name/SKILL.md`), { name: 'same-name' }, `${scope}/${location}의 본문`)
  }
  await openSkills(orbit)
  await orbit.page.getByRole('searchbox', { name: '스킬 검색' }).fill('same-name')
  await expect(orbit.page.locator('.pipe-skill-row')).toHaveCount(6)
  for (const scope of ['project', 'user'] as const) for (const location of SKILL_LOCATIONS) {
    await orbit.page.getByRole('button', { name: `same-name ${scope === 'project' ? '프로젝트' : '내 스킬'} · ${SKILL_LOCATION_LABELS[location]}`, exact: true }).click()
    await expect(orbit.page.locator('.live-markdown:visible .cm-content')).toHaveText(`${scope}/${location}의 본문`)
    await orbit.page.getByRole('button', { name: '취소', exact: true }).click()
  }
})

test('새 Codex 스킬을 선택한 위치에 만들고 검색·재열기한다', async ({ orbit }) => {
  await openSkills(orbit)
  await orbit.page.getByTitle('새 스킬', { exact: true }).click()
  await orbit.page.getByLabel('스킬 이름', { exact: true }).fill('new-codex-skill')
  await orbit.page.getByLabel('저장 위치', { exact: true }).selectOption('codex')
  await orbit.page.locator('.live-markdown .cm-content').fill('# 새 기준\n\n- [ ] 완료')
  await blurEditor(orbit.page)
  await orbit.page.getByRole('button', { name: '저장', exact: true }).click()
  const file = path.join(orbit.ctx.projectDir, '.codex/skills/new-codex-skill/SKILL.md')
  await expect.poll(async () => (await readMd(file)).content.trim()).toBe('# 새 기준\n\n- [ ] 완료')
  await openSkills(orbit)
  await orbit.page.getByRole('searchbox', { name: '스킬 검색' }).fill('.codex/skills')
  await orbit.page.getByRole('button', { name: 'new-codex-skill 프로젝트 · Codex', exact: true }).click()
  await expect(orbit.page.locator('.cm-md-task-box')).not.toBeChecked()
})
