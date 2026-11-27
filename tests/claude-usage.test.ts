import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { CLAUDE_USAGE_URL, parseClaudeUsage, queryClaudeUsage } from '../src/main/claudeUsage'
import { AgentAccountStore } from '../src/main/agentAccountStore'
import { probeAgentAccount } from '../src/main/agentAccountProbe'
import type { AccountObservation, AgentAccount } from '../src/core/agentAccounts'
import { tempDir } from './helpers'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); vi.unstubAllEnvs() })
async function fixture() {
  const dir = await tempDir('orbit-usage-'); dirs.push(dir)
  const account: AgentAccount = { id: 'test', provider: 'claude', configDir: dir, label: '검증', enabled: true, minimumRemainingPercent: 0, blockWhenUnknown: false }
  await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'local-test-token', refreshToken: 'never-copy' } }))
  return { dir, account }
}

it('Claude 첫 응답 없이 사용량을 조회하고 토큰은 고정된 제공자 주소로만 전송한다', async () => {
  const { dir, account } = await fixture(), script = path.join(dir, 'auth.cjs')
  await fs.writeFile(script, `console.log(JSON.stringify({loggedIn:true,email:'qa@example.test',subscriptionType:'max',authMethod:'oauth_token'}))`)
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 35, resets_at: '2099-01-01T00:00:00Z' }, seven_day: { utilization: 0, resets_at: null } })))
  const result = await probeAgentAccount(account, { file: process.execPath, args: [script] }, fetcher)
  expect(result).toMatchObject({ loggedIn: true, windows: [{ usedPercent: 35 }, { usedPercent: 0 }] })
  expect(fetcher).toHaveBeenCalledWith(CLAUDE_USAGE_URL, expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer local-test-token' }) }))
  expect(JSON.stringify(result)).not.toMatch(/local-test-token|never-copy/)
})

it('권한 오류와 429 응답에서 토큰·서버 본문을 노출하지 않고 재조회 시각을 지킨다', async () => {
  const { account } = await fixture()
  await expect(queryClaudeUsage(account, async () => new Response('local-test-token', { status: 403 }))).rejects.toThrow('조회 권한')
  const error = await queryClaudeUsage(account, async () => new Response('local-test-token', { status: 429, headers: { 'retry-after': '120' } })).catch((e: unknown) => e) as Error & { retryAt: string }
  expect(error.message).not.toContain('local-test-token'); expect(Date.parse(error.retryAt) - Date.now()).toBeGreaterThan(115_000)
  const { dir } = await fixture(), observation: AccountObservation = { checkedAt: new Date().toISOString(), loggedIn: true, windows: [], retryAt: error.retryAt }
  const probe = vi.fn(async () => observation), store = new AgentAccountStore(dir, () => {}, probe)
  await Promise.all([store.refreshAll(), store.refreshAll()]); expect(probe).toHaveBeenCalledTimes(2)
  await store.refreshAll(true); await store.refresh('default-claude'); expect(probe).toHaveBeenCalledTimes(2)
})

it('사용량 미제공·잘못된 수치와 실제 0%를 구분한다', () => {
  expect(parseClaudeUsage({ five_hour: { utilization: null }, seven_day: { utilization: 0 }, seven_day_opus: { utilization: -1 }, seven_day_sonnet: { utilization: 130 } })).toEqual([{ id: 'seven_day', label: '7일', usedPercent: 0 }, { id: 'seven_day_sonnet', label: 'Sonnet · 7일', usedPercent: 100 }])
})
