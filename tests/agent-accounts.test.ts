import { promises as fs } from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { accountBlock, accountEnvironment, type AccountObservation, type AgentAccount } from '../src/core/agentAccounts'
import { accountHomeKey, prepareQuotaCapture } from '../src/core/agentQuotaCapture'
import { AgentAccountStore } from '../src/main/agentAccountStore'
import { parseCodexAccount, parseClaudeAccount, probeAgentAccount } from '../src/main/agentAccountProbe'
import { tempDir } from './helpers'

const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
async function fixture() {
  const dir = await tempDir('orbit-account-'); directories.push(dir)
  vi.stubEnv('CODEX_HOME', path.join(dir, 'default-codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'default-claude'))
  const account: AgentAccount = { id: 'account-work', provider: 'codex', label: '업무 계정', configDir: path.join(dir, 'work'), enabled: true, minimumRemainingPercent: 10, blockWhenUnknown: false }
  const observation: AccountObservation = { checkedAt: new Date().toISOString(), quotaCheckedAt: new Date().toISOString(), loggedIn: true, email: 'test@example.test', windows: [{ id: 'week', label: '7일', usedPercent: 25, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] }
  return { dir, account, observation }
}

it('기본 계정 환경을 보존하고 별도 계정에는 부모의 API 키를 전달하지 않는다', async () => {
  const { account } = await fixture(), env = { PATH: '/bin', OPENAI_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-token' }
  expect(accountEnvironment({ ...account, builtin: true }, env)).toEqual(env)
  expect(accountEnvironment(account, env)).toEqual({ PATH: '/bin', CODEX_HOME: account.configDir })
  expect(accountEnvironment({ ...account, provider: 'claude' }, env)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: account.configDir })
})

it('제공자의 사용 금지 응답은 잔여율·초기화 시각만으로 해제하지 않는다', async () => {
  const { account, observation } = await fixture()
  const denied = { ...observation, ordinaryUsageAllowed: false, windows: [{ id: 'week', label: '주간', usedPercent: 0, resetsAt: new Date(Date.now() - 1000).toISOString() }] }
  expect(accountBlock(account, denied)?.message).toContain('사용 한도 소진')
  expect(accountBlock(account, observation)).toBeUndefined()
  expect(accountBlock(account, { ...observation, windows: [{ id: '5h', label: '5시간', usedPercent: 90 }] })?.message).toContain('10% 이하')
})

it('미확인·오래된 사용량·지나간 초기화 시각은 무제한 또는 0% 사용으로 계산하지 않는다', async () => {
  const { account, observation } = await fixture(), strict = { ...account, blockWhenUnknown: true }
  expect(accountBlock(strict, undefined)?.message).toContain('최신 사용량')
  expect(accountBlock(strict, { ...observation, quotaCheckedAt: '2020-01-01T00:00:00.000Z' })?.message).toContain('최신 사용량')
  expect(accountBlock(strict, { ...observation, windows: [{ id: 'old', label: '지난 한도', usedPercent: 100, resetsAt: '2020-01-01T00:00:00.000Z' }] })?.message).toContain('최신 사용량')
  expect(accountBlock(account, { ...observation, loggedIn: false })?.message).toContain('로그인')
})

it('계정 등록·설정·재열기·등록 해제가 영속화되며 CLI 파일을 지우지 않는다', async () => {
  const { dir, observation } = await fixture(), root = path.join(dir, 'store'), probe = vi.fn(async () => observation)
  const store = new AgentAccountStore(root, () => {}, probe)
  expect(await store.list()).toHaveLength(2)
  const input = { provider: 'codex' as const, label: '업무', enabled: true, minimumRemainingPercent: 10, blockWhenUnknown: true }
  const account = await store.save(input)
  await fs.writeFile(path.join(account.configDir, 'keep.txt'), 'user data')
  await store.refresh(account.id)
  const reopened = new AgentAccountStore(root, () => {}, probe)
  expect((await reopened.list()).find((row) => row.id === account.id)).toMatchObject({ ...input, observation })
  await expect(store.save({ ...input, configDir: account.configDir })).rejects.toThrow('이미 등록')
  await expect(store.save({ ...input, minimumRemainingPercent: 100 })).rejects.toThrow('0~99')
  await store.save({ ...input, id: account.id, enabled: false })
  expect((await store.check(['codex'], { codex: account.id }))?.message).toContain('사용 중지')
  await store.remove(account.id)
  expect(await fs.readFile(path.join(account.configDir, 'keep.txt'), 'utf8')).toBe('user data')
  await expect(store.resolve('codex', account.id)).rejects.toThrow('다시 선택')
  await expect(store.remove('default-codex')).rejects.toThrow('기본 계정')
})

it('동시 새로고침은 한 번만 조회하고 API 장애는 알려진 소진 상태를 지우지 않는다', async () => {
  const { dir, observation } = await fixture()
  const probe = vi.fn(async (): Promise<AccountObservation> => ({ ...observation, ordinaryUsageAllowed: false }))
  const store = new AgentAccountStore(dir, () => {}, probe)
  await Promise.all([store.refresh('default-codex'), store.refresh('default-codex')]); expect(probe).toHaveBeenCalledTimes(1)
  probe.mockRejectedValueOnce(new Error('offline'))
  const next = await store.refresh('default-codex')
  expect(next.observation?.ordinaryUsageAllowed).toBe(false)
  expect(await store.check(['codex'])).toMatchObject({ message: expect.stringContaining('한도 소진') })
  probe.mockResolvedValueOnce({ ...observation })
  expect((await store.refresh('default-codex')).observation?.ordinaryUsageAllowed).toBe(false)
  probe.mockResolvedValueOnce({ ...observation, ordinaryUsageAllowed: true })
  await store.refresh('default-codex')
  expect(await store.check(['codex'])).toBeUndefined()
})

it('CLI JSON에서 계정·쿼터 필드만 읽고 0%와 null을 구분한다', () => {
  const response = parseCodexAccount({ account: { type: 'chatgpt', email: 'test@example.test', planType: 'pro', accessToken: 'do-not-copy' } }, { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null } })
  expect(response.windows).toMatchObject([{ usedPercent: 0, label: 'codex · 5시간' }])
  expect(JSON.stringify(response)).not.toContain('do-not-copy')
  expect(parseCodexAccount({ account: null }, undefined)).toMatchObject({ loggedIn: false, windows: [] })
  expect(parseClaudeAccount({ loggedIn: true, email: 'test@example.test', subscriptionType: 'max', token: 'do-not-copy' })).toMatchObject({ loggedIn: true, plan: 'max', windows: [] })
})

it('손상된 계정 설정을 덮어쓰거나 사용 가능한 쿼터로 표시하지 않는다', async () => {
  const { dir } = await fixture(), file = path.join(dir, 'accounts.json')
  const raw = JSON.stringify({ version: 1, accounts: [], observations: { 'default-codex': { checkedAt: new Date().toISOString(), loggedIn: true, windows: null } } })
  await fs.writeFile(file, raw)
  const store = new AgentAccountStore(dir, () => {})
  await expect(store.list()).rejects.toThrow('사용량 형식')
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
})

it('실제 자식 프로세스의 Codex 계정 프로토콜을 사용하며 모델 요청은 보내지 않는다', async () => {
  const { dir, account } = await fixture(), script = path.join(dir, 'fake-codex.cjs')
  await fs.writeFile(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={};else if(q.method==='account/read')result={account:{type:'chatgpt',email:process.env.OPENAI_API_KEY?'leaked':'isolated@example.test',planType:'pro'}};else if(q.method==='account/rateLimits/read')result={ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:35,windowDurationMins:300,resetsAt:2000000000}}};else process.exit(7);console.log(JSON.stringify({id:q.id,result}));});`)
  vi.stubEnv('OPENAI_API_KEY', 'parent-only')
  const result = await probeAgentAccount(account, { file: process.execPath, args: [script] })
  expect(result).toMatchObject({ loggedIn: true, email: 'isolated@example.test', windows: [{ usedPercent: 35 }] })
})

it('Claude 상태 표시줄 원문을 기존 명령에 전달하면서 한도 수치만 별도로 저장한다', async () => {
  const { dir, account } = await fixture(), scripts = path.join(dir, 'scripts'), home = path.join(dir, 'claude'), usage = path.join(dir, 'usage')
  await fs.mkdir(scripts); await fs.mkdir(home)
  const forward = path.join(dir, 'original.cjs')
  await fs.writeFile(forward, `let raw='';process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>process.stdout.write('original:'+JSON.parse(raw).session_id));`)
  const command = `"${process.execPath.replace(/\\/g, '/')}" "${forward.replace(/\\/g, '/')}"`
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command, padding: 2 } }))
  const status = prepareQuotaCapture(scripts, dir, home, usage, 'capture-command')
  expect(status).toMatchObject({ command: 'capture-command', padding: 2 })
  const payload = { session_id: 'current', prompt: 'do-not-save', token: 'do-not-copy', rate_limits: { five_hour: { used_percentage: 71, resets_at: 2000000000 }, seven_day: { used_percentage: 20, resets_at: 2001000000 } } }
  const stdout = execFileSync(process.execPath, [path.join(scripts, 'quota-status.cjs')], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home }, timeout: 10_000 })
  expect(stdout).toBe('original:current')
  const raw = await fs.readFile(path.join(usage, `${accountHomeKey(home)}.json`), 'utf8')
  expect(raw).not.toMatch(/do-not-save|do-not-copy|session_id/)
  expect(JSON.parse(raw).rate_limits.five_hour.used_percentage).toBe(71)
  expect(JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8')).statusLine.command).toBe(command)
}, 15_000)
