import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import type { AgentAccount, QuotaWindow } from '../core/agentAccounts'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export type UsageFetch = (url: string, init?: RequestInit) => Promise<Response>
export class UsageQueryError extends Error {
  constructor(message: string, readonly retryAt?: string) { super(message) }
}

/** CLI의 기존 자격 증명은 메모리에서 읽어 제공자의 고정된 사용량 주소에만 보낸다. */
async function tokenFor(account: AgentAccount): Promise<string | undefined> {
  if (account.builtin && process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN
  let raw: string | undefined
  if (process.platform === 'darwin') {
    const scoped = !account.builtin || !!process.env.CLAUDE_CONFIG_DIR
    const homes = [...new Set([account.configDir, await fs.realpath(account.configDir).catch(() => account.configDir)])]
    const services = scoped ? homes.map((home) => `Claude Code-credentials-${createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)}`) : ['Claude Code-credentials']
    for (const service of services) {
      raw = await new Promise<string | undefined>((resolve) => execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 3000, maxBuffer: 128_000 }, (error, stdout) => resolve(error ? undefined : stdout)))
      if (raw) break
    }
  }
  raw ??= await fs.readFile(path.join(account.configDir, '.credentials.json'), 'utf8').catch(() => undefined)
  if (!raw) return
  try { const value = object(object(JSON.parse(raw)).claudeAiOauth).accessToken; return typeof value === 'string' && value.trim() ? value : undefined }
  catch { return }
}

export function parseClaudeUsage(value: unknown): QuotaWindow[] {
  const data = object(value), windows: QuotaWindow[] = []
  const labels: Record<string, string> = { five_hour: '5시간', seven_day: '7일', seven_day_opus: 'Opus · 7일', seven_day_sonnet: 'Sonnet · 7일', seven_day_fable: 'Fable · 7일' }
  for (const [id, label] of Object.entries(labels)) {
    const row = object(data[id]), percent = row.utilization
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) continue
    const reset = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN
    windows.push({ id, label, usedPercent: Math.min(100, percent), ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}) })
  }
  return windows
}

export async function queryClaudeUsage(account: AgentAccount, fetcher: UsageFetch = fetch): Promise<QuotaWindow[]> {
  const token = await tokenFor(account)
  if (!token) throw new UsageQueryError('사용량 조회용 로그인이 없습니다. Claude에 로그인한 뒤 새로고침하세요')
  let response: Response
  try { response = await fetcher(CLAUDE_USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }) }
  catch { throw new UsageQueryError('Claude 사용량 서버에 연결할 수 없습니다') }
  if (!response.ok) {
    if (response.status === 429) {
      const header = response.headers.get('retry-after'), seconds = header ? Number(header) : NaN
      const retry = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header ?? '')
      throw new UsageQueryError('사용량 조회가 제한되었습니다. 잠시 후 자동으로 다시 확인합니다', new Date(Math.min(Date.now() + 86400_000, Math.max(Date.now() + 60_000, Number.isFinite(retry) ? retry : Date.now() + 300_000))).toISOString())
    }
    throw new UsageQueryError(response.status === 401 || response.status === 403 ? 'Claude 사용량 조회 권한을 확인하세요. 다시 로그인해야 할 수 있습니다' : 'Claude 사용량을 조회할 수 없습니다')
  }
  try { return parseClaudeUsage(await response.json()) } catch { throw new UsageQueryError('Claude 사용량 응답을 읽을 수 없습니다') }
}
