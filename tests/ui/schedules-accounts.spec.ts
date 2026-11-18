import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect, type Orbit } from './fixtures'
import { savePipeline } from '../../src/core/pipelineStore'
import { localDateTime } from '../../src/core/automationSchedule'

async function openTab(orbit: Orbit, name: string) {
  await orbit.page.locator('nav').getByRole('button', { name: '자동화', exact: true }).click()
  await orbit.page.locator('.automation-page > .row .seg').getByRole('button', { name, exact: true }).click()
}
async function graph(orbit: Orbit) {
  return savePipeline(orbit.ctx, { title: '예약 검증 그래프', nodes: [
    { id: 'start', kind: 'start', terminal: 'new', text: '' },
    { id: 'text', kind: 'text', terminal: 'new', text: '예약 출력' },
    { id: 'print', kind: 'print', terminal: 'new', text: '' }
  ], edges: [{ from: 'start', to: 'print' }, { from: 'text', to: 'print' }] })
}

test('세 예약 방식을 저장하고 다시 열며 일시정지·재개·삭제한다', async ({ orbit }) => {
  await graph(orbit); await openTab(orbit, '예약')
  for (const kind of ['daily', 'interval', 'once']) {
    await orbit.page.getByRole('button', { name: '새 예약', exact: true }).click()
    await orbit.page.getByLabel('예약 이름', { exact: true }).fill(`예약 ${kind}`)
    await orbit.page.getByLabel('예약 방식', { exact: true }).selectOption(kind)
    if (kind === 'daily') await orbit.page.getByLabel('매일 실행 시각').fill('23:58')
    if (kind === 'interval') { await orbit.page.getByLabel('반복 간격').fill('4'); await orbit.page.getByLabel('간격 단위').selectOption('hours') }
    if (kind === 'once') await orbit.page.getByLabel('실행 날짜와 시각').fill(localDateTime(Date.now() + 86400_000))
    await orbit.page.getByRole('button', { name: '예약 저장', exact: true }).click()
    await expect(orbit.page.getByRole('article', { name: `예약 ${kind}`, exact: true })).toBeVisible()
  }
  const row = orbit.page.getByRole('article', { name: '예약 interval', exact: true })
  await row.getByRole('button', { name: '일시정지', exact: true }).click(); await expect(row).toContainText('꺼짐')
  await row.getByRole('button', { name: '다시 켜기', exact: true }).click(); await expect(row).toContainText('예약 켜짐')
  await orbit.page.evaluate(async (dir) => { await window.orbit.invoke('closeProject'); await window.orbit.invoke('openProject', dir) }, orbit.ctx.projectDir)
  await orbit.page.reload(); await openTab(orbit, '예약')
  await expect(orbit.page.locator('.schedule-card')).toHaveCount(3)
  await row.getByRole('button', { name: '편집', exact: true }).click(); await expect(orbit.page.getByLabel('반복 간격')).toHaveValue('4')
  await orbit.page.getByRole('button', { name: '취소', exact: true }).click()
  await orbit.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await row.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(row).toHaveCount(0)
})

test('예약한 시각에 실제 그래프를 한 번 실행하고 실행 기록에서 예약 이름을 표시한다', async ({ orbit }) => {
  await graph(orbit); await openTab(orbit, '예약')
  const due = localDateTime(Date.now() + 120_000)
  await orbit.page.getByRole('button', { name: '새 예약', exact: true }).click()
  await orbit.page.getByLabel('예약 이름', { exact: true }).fill('한 번 실행 검증')
  await orbit.page.getByLabel('예약 방식', { exact: true }).selectOption('once')
  await orbit.page.getByLabel('실행 날짜와 시각').fill(due)
  await orbit.page.getByRole('button', { name: '예약 저장', exact: true }).click()
  await expect(orbit.page.getByRole('article', { name: '한 번 실행 검증', exact: true })).toBeVisible()
  // 생산 코드의 타이머를 그대로 두고 Electron 메인 프로세스의 시계만 이동한다.
  await orbit.app.evaluate((_electron, now) => { Date.now = () => now }, new Date(due).getTime() + 1)
  await expect(orbit.page.getByRole('article', { name: '한 번 실행 검증', exact: true })).toContainText('실행됨')
  await openTab(orbit, '실행')
  await expect(orbit.page.locator('.run-table tbody tr')).toHaveCount(1)
  await expect(orbit.page.locator('.run-table')).toContainText('예약: 한 번 실행 검증')
  await expect(orbit.page.locator('.run-table')).toContainText('완료')
  await orbit.page.reload(); await openTab(orbit, '실행')
  await expect(orbit.page.locator('.run-table tbody tr')).toHaveCount(1)
})

test('계정을 등록하고 쿼터 정책을 저장한 뒤 예약의 실행 계정으로 선택한다', async ({ orbit }) => {
  await graph(orbit); await openTab(orbit, '계정·쿼터')
  await orbit.page.getByRole('button', { name: '계정 등록', exact: true }).click()
  await orbit.page.getByLabel('제공자', { exact: true }).selectOption('codex')
  await orbit.page.getByLabel('계정 이름', { exact: true }).fill('업무 Codex')
  await orbit.page.getByLabel('이 잔여량 이하이면 새 실행 보류 (%)').fill('20')
  await orbit.page.getByLabel('최신 사용량이 미확인이면 실행 보류').check()
  await orbit.page.getByRole('button', { name: '계정 저장', exact: true }).click()
  const card = orbit.page.getByRole('article', { name: '업무 Codex', exact: true })
  await expect(card).toContainText('사용량 미확인')
  await card.getByRole('button', { name: '계정 설정', exact: true }).click()
  await expect(orbit.page.getByLabel('이 잔여량 이하이면 새 실행 보류 (%)')).toHaveValue('20')
  await expect(orbit.page.getByLabel('CLI 설정 폴더', { exact: true })).toBeDisabled()
  await orbit.page.getByRole('button', { name: '취소', exact: true }).click()
  await openTab(orbit, '예약'); await orbit.page.getByRole('button', { name: '새 예약', exact: true }).click()
  await orbit.page.getByLabel('예약 이름', { exact: true }).fill('업무 계정 예약')
  await orbit.page.getByLabel('Codex 실행 계정', { exact: true }).selectOption({ label: '업무 Codex' })
  await orbit.page.getByRole('button', { name: '예약 저장', exact: true }).click()
  const row = orbit.page.getByRole('article', { name: '업무 계정 예약', exact: true })
  await row.getByRole('button', { name: '편집', exact: true }).click()
  await expect(orbit.page.getByLabel('Codex 실행 계정', { exact: true }).locator('option:checked')).toHaveText('업무 Codex')
})

test('잔여 쿼터와 초기화 시각을 표시하고 정책 변경을 즉시 반영한다', async ({ orbit }) => {
  const folder = path.join(orbit.directory, 'profile/agent-accounts')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'accounts.json'), JSON.stringify({ version: 1, accounts: [], observations: { 'default-codex': { checkedAt: new Date().toISOString(), quotaCheckedAt: new Date().toISOString(), loggedIn: true, email: 'qa@example.test', plan: 'pro', windows: [{ id: 'week', label: '7일', usedPercent: 95, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] } } }))
  await openTab(orbit, '계정·쿼터')
  const card = orbit.page.getByRole('article', { name: 'Codex · 기본 계정', exact: true })
  await expect(card).toContainText('잔여 5%'); await expect(card).toContainText('초기화:')
  await card.getByRole('button', { name: '계정 설정', exact: true }).click()
  await orbit.page.getByLabel('이 잔여량 이하이면 새 실행 보류 (%)').fill('10')
  await orbit.page.getByRole('button', { name: '계정 저장', exact: true }).click()
  await expect(card).toContainText('잔여 사용량이 설정한 10% 이하')
  await orbit.page.reload(); await openTab(orbit, '계정·쿼터'); await expect(card).toContainText('잔여 5%')
})
