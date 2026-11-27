import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { AGENT_PROVIDERS, AGENT_LABELS, accountBlock, defaultAccountId, type AccountBlock, type AccountObservation, type AccountSelection, type AccountView, type AgentAccount, type AgentAccountInput, type AgentProvider } from '../core/agentAccounts'
import { accountHomeKey } from '../core/agentQuotaCapture'
import { claudeQuotaWindows, probeAgentAccount } from './agentAccountProbe'

export class AgentAccountStore {
  readonly quotaDir: string
  private saved: AgentAccount[] = []
  private observations: Record<string, AccountObservation> = {}
  private selected: AccountSelection = {}
  private loading?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private refreshing = new Map<string, Promise<AccountView>>()
  constructor(private root: string, private changed: () => void, private probe = probeAgentAccount) { this.quotaDir = path.join(root, 'claude-usage') }

  private defaults(): AgentAccount[] {
    return AGENT_PROVIDERS.map((provider) => ({ id: defaultAccountId(provider), provider, label: `${AGENT_LABELS[provider]} · 기본 계정`, configDir: path.resolve(provider === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')), builtin: true, enabled: true, minimumRemainingPercent: 0, blockWhenUnknown: false }))
  }

  private load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const data: { version?: unknown; accounts?: AgentAccount[]; observations?: Record<string, AccountObservation>; selected?: AccountSelection } = JSON.parse(await fs.readFile(path.join(this.root, 'accounts.json'), 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('계정 설정 파일 형식을 확인하세요')
        const ids = new Set<string>()
        for (const account of data.accounts) {
          if (!account || typeof account.id !== 'string' || !account.id || ids.has(account.id) || !AGENT_PROVIDERS.includes(account.provider) || typeof account.configDir !== 'string' || typeof account.label !== 'string' || typeof account.enabled !== 'boolean' || typeof account.blockWhenUnknown !== 'boolean' || !Number.isFinite(account.minimumRemainingPercent) || account.minimumRemainingPercent < 0 || account.minimumRemainingPercent > 99) throw new Error('계정 설정 파일 형식을 확인하세요')
          ids.add(account.id)
        }
        if (data.observations !== undefined && (!data.observations || typeof data.observations !== 'object' || Array.isArray(data.observations) || Object.values(data.observations).some((item) => !item || !Number.isFinite(Date.parse(item.checkedAt)) || ![true, false, null].includes(item.loggedIn) || !Array.isArray(item.windows) || item.windows.some((window) => !window || typeof window.id !== 'string' || typeof window.label !== 'string' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)))) throw new Error('저장된 계정 사용량 형식을 확인하세요')
        this.saved = data.accounts
        this.observations = data.observations ?? {}
        this.selected = Object.fromEntries(AGENT_PROVIDERS.flatMap((kind) => typeof data.selected?.[kind] === 'string' ? [[kind, data.selected[kind]]] : []))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
  }

  private accounts(): AgentAccount[] {
    const defaults = this.defaults()
    return [...defaults.map((account) => ({ ...account, ...this.saved.find((row) => row.id === account.id), configDir: account.configDir, provider: account.provider, builtin: true })), ...this.saved.filter((row) => !defaults.some((account) => account.id === row.id))]
  }

  identify(provider: AgentProvider, home: string): string {
    const key = accountHomeKey(home)
    return this.accounts().find((row) => row.provider === provider && accountHomeKey(row.configDir) === key)?.id ?? `unregistered-${provider}-${key}`
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const file = path.join(this.root, 'accounts.json'), temp = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, JSON.stringify({ version: 1, accounts: this.saved, observations: this.observations, selected: this.selected })); await fs.rename(temp, file) }
    finally { await fs.rm(temp, { force: true }) }
    this.changed()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => { await this.load(); return fn() })
    this.queue = work.catch(() => {})
    return work
  }

  private async view(account: AgentAccount): Promise<AccountView> {
    let observation = this.observations[account.id]
    if (account.provider === 'claude') {
      try {
        const capture: { at: string; rate_limits: unknown } = JSON.parse(await fs.readFile(path.join(this.quotaDir, `${accountHomeKey(account.configDir)}.json`), 'utf8'))
        if (Number.isFinite(Date.parse(capture.at)) && (!observation?.quotaCheckedAt || capture.at > observation.quotaCheckedAt)) {
          observation = { ...(observation ?? { checkedAt: capture.at, loggedIn: null }), quotaCheckedAt: capture.at, windows: claudeQuotaWindows(capture.rate_limits), message: undefined }
        }
      } catch { /* 아직 CLI 사용량이 전달되지 않았다. */ }
    }
    return structuredClone({ ...account, observation, selected: account.id === (this.selected[account.provider] ?? defaultAccountId(account.provider)) })
  }

  async list(): Promise<AccountView[]> {
    await this.load(); await this.queue
    return Promise.all(this.accounts().map((account) => this.view(account)))
  }

  async selection(): Promise<AccountSelection> { await this.load(); await this.queue; return { claude: defaultAccountId('claude'), codex: defaultAccountId('codex'), ...this.selected } }

  select(provider: AgentProvider, id: string): Promise<void> {
    return this.serial(async () => {
      const account = this.accounts().find((row) => row.id === id && row.provider === provider)
      if (!account || !account.enabled) throw new Error('사용 가능한 계정을 선택하세요')
      const previous = this.selected; this.selected = { ...previous, [provider]: id }
      try { await this.persist() } catch (error) { this.selected = previous; throw error }
    })
  }

  async refreshAll(force = false): Promise<AccountView[]> {
    const rows = await this.list()
    await Promise.all(AGENT_PROVIDERS.map(async (provider) => {
      for (const account of rows.filter((row) => row.provider === provider && row.enabled)) {
        if (Date.parse(account.observation?.retryAt ?? '') > Date.now()) continue
        if (force || !account.observation || Date.now() - Date.parse(account.observation.checkedAt) >= 60_000) await this.refresh(account.id)
      }
    }))
    return this.list()
  }

  async resolve(provider: AgentProvider, id?: string): Promise<AgentAccount> {
    await this.load(); await this.queue
    id ??= this.selected[provider] ?? defaultAccountId(provider)
    const account = this.accounts().find((row) => row.id === id)
    if (!account || account.provider !== provider) throw new Error(`${AGENT_LABELS[provider]} 계정을 다시 선택하세요`)
    return structuredClone(account)
  }

  save(input: AgentAccountInput): Promise<AgentAccount> {
    return this.serial(async () => {
      if (!AGENT_PROVIDERS.includes(input.provider) || typeof input.label !== 'string' || !input.label.trim() || (input.configDir !== undefined && typeof input.configDir !== 'string') || typeof input.enabled !== 'boolean' || typeof input.blockWhenUnknown !== 'boolean' || !Number.isFinite(input.minimumRemainingPercent) || input.minimumRemainingPercent < 0 || input.minimumRemainingPercent > 99) throw new Error('계정 이름과 잔여량 기준(0~99%)을 확인하세요')
      const old = input.id ? this.accounts().find((row) => row.id === input.id) : undefined
      if (input.id && !old) throw new Error('계정을 찾을 수 없습니다')
      if (old && input.provider !== old.provider) throw new Error('기존 계정의 제공자는 변경할 수 없습니다')
      const id = old?.id ?? `account-${randomUUID()}`
      const configDir = old?.configDir ?? (input.configDir?.trim() ? path.resolve(input.configDir.trim().replace(/^~(?=[/\\]|$)/, os.homedir())) : path.join(this.root, 'profiles', id))
      if (!old && this.accounts().some((row) => row.provider === input.provider && accountHomeKey(row.configDir) === accountHomeKey(configDir))) throw new Error('이 설정 폴더는 이미 등록한 계정이 사용하고 있습니다')
      const account: AgentAccount = { id, provider: input.provider, label: input.label.trim().slice(0, 100), configDir, ...(old?.builtin ? { builtin: true } : {}), enabled: input.enabled, minimumRemainingPercent: input.minimumRemainingPercent, blockWhenUnknown: input.blockWhenUnknown }
      if (!old) await fs.mkdir(configDir, { recursive: true })
      const previous = this.saved
      this.saved = [...this.saved.filter((row) => row.id !== id), account]
      try { await this.persist() } catch (error) { this.saved = previous; throw error }
      return structuredClone(account)
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const account = this.accounts().find((row) => row.id === id)
      if (!account || account.builtin) throw new Error('기본 계정은 등록 해제할 수 없습니다. 사용을 중지할 수 있습니다')
      if (this.selected[account.provider] === id) throw new Error('다른 계정으로 전환한 뒤 등록을 해제하세요')
      const old = this.saved; this.saved = this.saved.filter((row) => row.id !== id)
      try { await this.persist() } catch (error) { this.saved = old; throw error }
      // CLI 자격 증명과 세션 폴더는 계정 등록 해제로 지우지 않는다.
    })
  }

  refresh(id: string): Promise<AccountView> {
    const current = this.refreshing.get(id)
    if (current) return current
    const work = (async () => {
      await this.load(); await this.queue
      const account = this.accounts().find((row) => row.id === id)
      if (!account) throw new Error('계정을 찾을 수 없습니다')
      if (Date.parse(this.observations[id]?.retryAt ?? '') > Date.now()) return this.view(account)
      let observation: AccountObservation
      try { observation = await this.probe(account) }
      catch (error) { observation = { ...(this.observations[id] ?? { loggedIn: null, windows: [] }), checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : '계정 상태를 조회할 수 없습니다' } }
      await this.serial(async () => {
        if (!this.accounts().some((row) => row.id === id)) return
        const previous = this.observations[id]
        const identityChanged = !!previous?.email && previous.email !== observation.email && observation.loggedIn === true
        if (account.provider === 'claude' && !observation.quotaCheckedAt) {
          observation.quotaCheckedAt = identityChanged ? observation.checkedAt : previous?.quotaCheckedAt
          observation.windows = identityChanged ? [] : previous?.windows ?? []
        } else if (!identityChanged && !observation.quotaCheckedAt && previous?.quotaCheckedAt) {
          observation = { ...observation, quotaCheckedAt: previous.quotaCheckedAt, windows: previous.windows, ordinaryUsageAllowed: previous.ordinaryUsageAllowed }
        }
        if (!identityChanged && previous?.ordinaryUsageAllowed === false && observation.ordinaryUsageAllowed !== true) observation.ordinaryUsageAllowed = false
        this.observations[id] = observation
        try { await this.persist() } catch (error) { if (previous) this.observations[id] = previous; else delete this.observations[id]; throw error }
      })
      return this.view(account)
    })().finally(() => this.refreshing.delete(id))
    this.refreshing.set(id, work)
    return work
  }

  async check(providers: AgentProvider[], selection: AccountSelection = {}, refresh = false): Promise<AccountBlock | undefined> {
    for (const provider of [...new Set(providers)]) {
      const account = await this.resolve(provider, selection[provider])
      let view = await this.view(account)
      if (refresh && (!view.observation || Date.now() - Date.parse(view.observation.checkedAt) > 60_000)) view = await this.refresh(account.id)
      const block = accountBlock(view, view.observation)
      if (block) return block
    }
  }
}
