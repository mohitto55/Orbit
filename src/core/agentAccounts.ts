export const AGENT_PROVIDERS = ['claude', 'codex'] as const
export type AgentProvider = (typeof AGENT_PROVIDERS)[number]
export const AGENT_LABELS: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }
export type AccountSelection = Partial<Record<AgentProvider, string>>

export interface AgentAccount {
  id: string
  provider: AgentProvider
  label: string
  configDir: string
  builtin?: boolean
  enabled: boolean
  minimumRemainingPercent: number
  blockWhenUnknown: boolean
}
export interface AgentAccountInput {
  id?: string
  provider: AgentProvider
  label: string
  configDir?: string
  enabled: boolean
  minimumRemainingPercent: number
  blockWhenUnknown: boolean
}
export interface QuotaWindow { id: string; label: string; usedPercent: number; resetsAt?: string }
export interface AccountObservation {
  checkedAt: string
  quotaCheckedAt?: string
  loggedIn: boolean | null
  email?: string
  plan?: string
  authMethod?: string
  windows: QuotaWindow[]
  ordinaryUsageAllowed?: boolean
  message?: string
  retryAt?: string
}
export interface AccountView extends AgentAccount { observation?: AccountObservation; selected?: boolean }
export interface AccountBlock { message: string; retryAt?: string }
export const defaultAccountId = (provider: AgentProvider) => `default-${provider}`

// 별도 계정에 부모 프로세스의 API 키가 섞이지 않게 한다.
export const ACCOUNT_CREDENTIAL_ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY'] as const
export function accountEnvironment(account: AgentAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  if (account.builtin) return env
  for (const key of ACCOUNT_CREDENTIAL_ENV) delete env[key]
  env[account.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = account.configDir
  return env
}

export function accountBlock(account: AgentAccount, observation: AccountObservation | undefined, now = Date.now()): AccountBlock | undefined {
  const prefix = `${account.label}: `
  if (!account.enabled) return { message: prefix + '사용 중지한 계정입니다' }
  if (observation?.loggedIn === false) return { message: prefix + 'CLI에 로그인한 뒤 계정을 새로고침하세요' }
  const quotaTime = Date.parse(observation?.quotaCheckedAt ?? observation?.checkedAt ?? '')
  const fresh = observation && now - quotaTime < 15 * 60_000 && quotaTime <= now + 60_000
  const windows = fresh ? observation.windows.filter((window) => !window.resetsAt || Date.parse(window.resetsAt) > now) : []
  if (observation?.ordinaryUsageAllowed === false) {
    const resets = observation.windows.map((window) => Date.parse(window.resetsAt ?? '')).filter((value) => value > now)
    return { message: prefix + '제공자가 현재 사용 한도 소진을 알렸습니다', ...(resets.length ? { retryAt: new Date(Math.min(...resets)).toISOString() } : {}) }
  }
  const blocked = windows.filter((window) => 100 - window.usedPercent <= account.minimumRemainingPercent)
  if (blocked.length) {
    const resets = blocked.map((window) => Date.parse(window.resetsAt ?? '')).filter((value) => value > now)
    return { message: prefix + `잔여 사용량이 설정한 ${account.minimumRemainingPercent}% 이하입니다`, ...(resets.length ? { retryAt: new Date(Math.max(...resets)).toISOString() } : {}) }
  }
  if (account.blockWhenUnknown && (!fresh || !windows.length || observation?.loggedIn !== true)) return { message: prefix + '최신 사용량을 확인할 수 없어 실행을 보류합니다' }
}
