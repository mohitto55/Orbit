import spawn from 'cross-spawn'
import { execFile, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { accountEnvironment, type AccountObservation, type AgentAccount, type QuotaWindow } from '../core/agentAccounts'
import { queryClaudeUsage, UsageQueryError, type UsageFetch } from './claudeUsage'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const shortText = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : undefined
function resetTime(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  const date = new Date(value * 1000)
  if (Number.isFinite(date.getTime())) return date.toISOString()
}
function quota(id: string, label: string, raw: unknown, claude = false): QuotaWindow[] {
  const row = object(raw), percent = row[claude ? 'used_percentage' : 'usedPercent']
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return []
  return [{ id, label, usedPercent: Math.min(100, percent), resetsAt: resetTime(row[claude ? 'resets_at' : 'resetsAt']) }]
}

export function claudeQuotaWindows(value: unknown): QuotaWindow[] {
  const limits = object(value)
  return [...quota('five_hour', '5시간', limits.five_hour, true), ...quota('seven_day', '7일', limits.seven_day, true), ...quota('spend_limit', '지출 한도', limits.spend_limit, true)]
}

export function parseCodexAccount(accountValue: unknown, quotaValue: unknown, checkedAt = new Date().toISOString()): AccountObservation {
  const account = object(object(accountValue).account), response = object(quotaValue)
  const buckets = Object.entries(object(response.rateLimitsByLimitId))
  if (!buckets.length && response.rateLimits) buckets.push(['codex', response.rateLimits])
  const windows: QuotaWindow[] = []
  for (const [id, value] of buckets) {
    const bucket = object(value)
    for (const key of ['primary', 'secondary']) {
      const window = object(bucket[key]), minutes = window.windowDurationMins
      const duration = typeof minutes === 'number' && minutes > 0 ? minutes % 1440 === 0 ? `${minutes / 1440}일` : minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분` : key === 'primary' ? '단기 한도' : '장기 한도'
      windows.push(...quota(`${id}:${key}`, `${shortText(bucket.limitName) ?? id} · ${duration}`, window))
    }
  }
  // 직접 지정한 모델 공급자(requires_openai_auth = false)는 OpenAI 로그인이 없어도 실행된다. 로그인 안 됨으로 막지 않는다.
  const loggedIn = typeof account.type === 'string' ? true : object(accountValue).requiresOpenaiAuth === false ? null : false
  return { checkedAt, ...(windows.length || typeof response.ordinaryUsageAllowed === 'boolean' ? { quotaCheckedAt: checkedAt } : {}), loggedIn, email: shortText(account.email), plan: shortText(account.planType), authMethod: shortText(account.type), windows,
    ...(typeof response.ordinaryUsageAllowed === 'boolean' ? { ordinaryUsageAllowed: response.ordinaryUsageAllowed } : {}),
    ...(!windows.length ? { message: '이 계정의 사용 한도를 조회할 수 없습니다' } : {}) }
}

export function parseClaudeAccount(value: unknown, checkedAt = new Date().toISOString()): AccountObservation {
  const data = object(value)
  return { checkedAt, loggedIn: typeof data.loggedIn === 'boolean' ? data.loggedIn : null, email: shortText(data.email), plan: shortText(data.subscriptionType), authMethod: shortText(data.authMethod), windows: [], message: '이 인증 방식에서 조회 가능한 사용량이 없습니다' }
}

function terminate(child: ChildProcess): void {
  child.stdin?.end()
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  else child.kill('SIGTERM')
}

export interface AccountProbeCommand { file: string; args: string[] }
/** CLI로 로그인 상태를 읽고 제공자의 사용량을 조회한다. 모델 응답은 생성하지 않는다. */
export async function probeAgentAccount(account: AgentAccount, command?: AccountProbeCommand, fetcher: UsageFetch = fetch): Promise<AccountObservation> {
  const invocation = command ?? { file: account.provider, args: account.provider === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['auth', 'status', '--json'] }
  const child = spawn(invocation.file, invocation.args, { env: accountEnvironment(account, process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // 일부 CLI는 종료 중 stderr를 쓰므로 항상 소비하되 계정 응답·토큰을 로그에 남기지 않는다.
  child.stderr?.resume()
  const checkedAt = new Date().toISOString()
  if (account.provider === 'claude') {
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        let data = ''
        const timer = setTimeout(() => { terminate(child); reject(new Error('Claude 계정 조회 시간이 초과됐습니다')) }, 15_000)
        child.stdout?.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); if (data.length > 128_000) { terminate(child); reject(new Error('CLI 응답이 너무 큽니다')) } })
        child.once('error', () => { clearTimeout(timer); reject(new Error('Claude CLI를 실행할 수 없습니다')) })
        child.once('close', () => { clearTimeout(timer); resolve(data) })
      })
      let observation: AccountObservation
      try { observation = parseClaudeAccount(JSON.parse(raw), checkedAt) } catch { throw new Error('Claude 로그인 상태를 읽을 수 없습니다. CLI 버전을 확인하세요') }
      if (observation.loggedIn && observation.authMethod !== 'api_key') {
        try { observation.windows = await queryClaudeUsage(account, fetcher); observation.quotaCheckedAt = new Date().toISOString(); observation.message = observation.windows.length ? undefined : '이 계정에서 조회 가능한 사용량이 없습니다' }
        catch (error) { observation.message = error instanceof UsageQueryError ? error.message : 'Claude 사용량을 조회할 수 없습니다'; if (error instanceof UsageQueryError) observation.retryAt = error.retryAt }
      }
      return observation
    } finally { terminate(child) }
  }
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let sequence = 0, stopped = false
  const fail = (message: string) => { stopped = true; for (const item of pending.values()) item.reject(new Error(message)); pending.clear() }
  const timer = setTimeout(() => { fail('Codex 계정 조회 시간이 초과됐습니다'); terminate(child) }, 20_000)
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', (line) => {
    if (line.length > 2_000_000) { fail('CLI 응답이 너무 큽니다'); terminate(child); return }
    let response: Record<string, unknown>
    try { response = object(JSON.parse(line)) } catch { return }
    if (typeof response.id !== 'number' || !pending.has(response.id)) return
    const item = pending.get(response.id)!; pending.delete(response.id)
    if (response.error) item.reject(new Error('Codex 계정 정보를 조회할 수 없습니다. 로그인과 CLI 버전을 확인하세요'))
    else item.resolve(response.result)
  })
  child.once('error', () => fail('Codex CLI를 실행할 수 없습니다'))
  child.once('close', () => fail('Codex 계정 조회가 종료되었습니다'))
  child.stdin?.on('error', () => fail('Codex CLI 연결이 끊어졌습니다'))
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (stopped) { reject(new Error('Codex CLI 연결이 종료되었습니다')); return }
    const id = ++sequence; pending.set(id, { resolve, reject })
    child.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '1.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true } })
    child.stdin!.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    const info = await request('account/read', { refreshToken: false })
    let limits: unknown
    if (object(object(info).account).type === 'chatgpt') {
      try { limits = await request('account/rateLimits/read', {}) } catch { /* 인증 정보는 표시하되 사용량은 미조회로 남긴다. */ }
    }
    return parseCodexAccount(info, limits, checkedAt)
  } finally { clearTimeout(timer); lines.close(); terminate(child) }
}
