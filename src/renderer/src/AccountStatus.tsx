import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, on } from './api'
import { AGENT_LABELS, AGENT_PROVIDERS, defaultAccountId, type AccountView } from '../../core/agentAccounts'
import { errorToast } from './ui'

const AccountsContext = createContext<{ rows: AccountView[]; loading: boolean; busy: boolean; error: string; refresh: (force?: boolean) => Promise<void> }>({ rows: [], loading: true, busy: false, error: '', refresh: async () => {} })
export const useAccounts = () => useContext(AccountsContext)

export function AccountsProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<AccountView[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true, refreshing = false
    const failed = (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) }
    const load = () => { void api.listAgentAccounts().then((data) => { if (alive) { setRows(data ?? []); setError('') } }).catch(failed).finally(() => { if (alive) setLoading(false) }) }
    const update = async () => {
      if (document.visibilityState === 'hidden' || refreshing) return
      refreshing = true
      try { await api.refreshAgentAccounts(false) } catch (e) { failed(e) } finally { refreshing = false; if (alive) load() }
    }
    load(); void update()
    const off = on('accounts-changed', load), timer = setInterval(() => { load(); void update() }, 10_000)
    window.addEventListener('focus', update)
    return () => { alive = false; off(); clearInterval(timer); window.removeEventListener('focus', update) }
  }, [])
  const refresh = async (force = true) => {
    if (busy) return
    setBusy(true)
    try { setRows(await api.refreshAgentAccounts(force)); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <AccountsContext.Provider value={{ rows, loading, busy, error, refresh }}>{children}</AccountsContext.Provider>
}

export function remainingQuota(row?: AccountView): string {
  const observation = row?.observation, checked = Date.parse(observation?.quotaCheckedAt ?? '')
  if (!observation || Date.now() - checked > 15 * 60_000 || !Number.isFinite(checked) || checked > Date.now() + 60_000) return '사용량 미확인'
  const windows = observation.windows.filter((item) => !item.resetsAt || Date.parse(item.resetsAt) > Date.now())
  return windows.length ? windows.map((item) => `${item.label} 잔여 ${Math.max(0, 100 - item.usedPercent).toFixed(0)}%`).join(' · ') : '사용량 미확인'
}

export function AccountStatus({ onManage }: { onManage: () => void }) {
  const { rows, busy, error, refresh } = useAccounts()
  return <section className="account-status" aria-label="실행 계정과 사용량">
    <div className="row between"><button className="link" onClick={onManage}>계정·사용량</button><button className="icon" aria-label="모든 계정 사용량 새로고침" disabled={busy} onClick={() => void refresh()} title="사용량 새로고침">↻</button></div>
    {AGENT_PROVIDERS.map((provider) => {
      const selected = rows.find((row) => row.provider === provider && row.selected)
      return <div key={provider}><label htmlFor={`active-account-${provider}`}>{AGENT_LABELS[provider]}</label><select id={`active-account-${provider}`} aria-label={`${AGENT_LABELS[provider]} 현재 계정`} value={selected?.id ?? defaultAccountId(provider)} onChange={(e) => void api.selectAgentAccount(provider, e.target.value).catch(errorToast)}>
        {!rows.length && <option value={defaultAccountId(provider)}>기본 계정</option>}
        {rows.filter((row) => row.provider === provider).map((row) => <option key={row.id} value={row.id} disabled={!row.enabled}>{row.observation?.email ?? row.label}</option>)}
      </select><small title={selected?.observation?.message}>{remainingQuota(selected)}</small></div>
    })}
    <small className="muted">전환은 새 작업부터 적용 · 1분마다 갱신</small>
    {error && <small role="alert">{error}</small>}
  </section>
}
