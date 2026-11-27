import { useState } from 'react'
import { useAccounts } from './AccountStatus'
import { api } from './api'
import { RunDrawer } from './Automation'
import { AGENT_LABELS, AGENT_PROVIDERS, accountBlock, type AccountView, type AgentAccountInput, type AgentProvider } from '../../core/agentAccounts'
import { Empty, errorToast, toast } from './ui'

function AccountEditor({ account, onClose }: { account?: AccountView; onClose: () => void }) {
  const [provider, setProvider] = useState<AgentProvider>(account?.provider ?? 'claude')
  const [label, setLabel] = useState(account?.label ?? ''), [configDir, setConfigDir] = useState(account?.configDir ?? '')
  const [enabled, setEnabled] = useState(account?.enabled ?? true), [blockUnknown, setBlockUnknown] = useState(account?.blockWhenUnknown ?? false)
  const [minimum, setMinimum] = useState(String(account?.minimumRemainingPercent ?? 0)), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const input: AgentAccountInput = { id: account?.id, provider, label, configDir, enabled, minimumRemainingPercent: Number(minimum), blockWhenUnknown: blockUnknown }
      await api.saveAgentAccount(input); toast('계정 설정을 저장했습니다'); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <RunDrawer title={account ? '계정 설정' : '계정 등록'} onClose={() => { if (!busy) onClose() }}>
    <div className="field"><label htmlFor="account-provider">제공자</label><select id="account-provider" value={provider} disabled={!!account || busy} onChange={(e) => setProvider(e.target.value as AgentProvider)}>{AGENT_PROVIDERS.map((kind) => <option key={kind} value={kind}>{AGENT_LABELS[kind]}</option>)}</select></div>
    <div className="field"><label htmlFor="account-label">계정 이름</label><input id="account-label" value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} placeholder="예: 업무 계정" /></div>
    <div className="field"><label htmlFor="account-home">CLI 설정 폴더</label><input id="account-home" value={configDir} disabled={!!account || busy} onChange={(e) => setConfigDir(e.target.value)} placeholder="비워 두면 별도 로그인 폴더를 만듭니다" /><span className="small muted">이미 사용 중인 계정은 그 CLI 설정 폴더를 지정하세요. 새 계정은 등록 후 ‘로그인 / 터미널 열기’에서 로그인합니다.</span></div>
    <div className="field"><label htmlFor="account-minimum">이 잔여량 이하이면 새 실행 보류 (%)</label><input id="account-minimum" type="number" min={0} max={99} value={minimum} disabled={busy} onChange={(e) => setMinimum(e.target.value)} /><span className="small muted">0은 한도를 모두 썼을 때 보류합니다. 이미 실행 중인 작업은 계속 진행합니다.</span></div>
    <label className="run-terminal"><input type="checkbox" checked={blockUnknown} disabled={busy} onChange={(e) => setBlockUnknown(e.target.checked)} />최신 사용량이 미확인이면 실행 보류</label>
    <label className="run-terminal"><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />자동화에서 이 계정 사용</label>
    {error && <p role="alert">{error}</p>}
    <footer className="row between"><button disabled={busy} onClick={onClose}>취소</button><button className="primary" disabled={busy || !label.trim()} onClick={() => void save()}>{busy ? '저장 중…' : '계정 저장'}</button></footer>
  </RunDrawer>
}

export function AgentAccounts({ onTerminal }: { onTerminal: (id: string) => void }) {
  const { rows, error, loading } = useAccounts()
  const [editing, setEditing] = useState<AccountView | 'new'>(), [busy, setBusy] = useState<string>()
  const act = async (row: AccountView, action: 'refresh' | 'open' | 'remove') => {
    if (busy) return
    if (action === 'remove' && !await api.confirmAction(`“${row.label}” 계정 등록을 해제할까요? CLI 로그인과 세션 파일은 유지합니다.`)) return
    setBusy(row.id)
    try {
      if (action === 'refresh') await api.refreshAgentAccount(row.id)
      else if (action === 'open') onTerminal((await api.openAgentAccount(row.id)).id)
      else await api.removeAgentAccount(row.id)
    } catch (e) { errorToast(e) } finally { setBusy(undefined) }
  }
  return <section className="account-list" aria-label="계정과 쿼터">
    <div className="row between"><p className="small muted">이 컴퓨터의 계정 설정 · 그래프와 예약에서 사용할 계정을 각각 선택할 수 있습니다.</p><button className="primary" onClick={() => setEditing('new')}>계정 등록</button></div>
    <p className="small muted">Claude·Codex 사용량을 1분마다 자동으로 조회합니다. 계정 전환은 새 터미널·새 작업에 즉시 적용됩니다. 실행 중인 작업과 계정을 지정해 저장한 예약은 기존 계정을 유지합니다.</p>
    {error && <p role="alert">{error}</p>}
    {loading ? <Empty>계정을 불러오는 중…</Empty> : <div className="schedule-cards">{rows.map((row) => {
      const observation = row.observation, block = accountBlock(row, observation), quotaAt = observation?.quotaCheckedAt ?? observation?.checkedAt
      const fresh = quotaAt && Date.now() - Date.parse(quotaAt) < 15 * 60_000 && Date.parse(quotaAt) <= Date.now() + 60_000
      return <article className="schedule-card account-card" key={row.id} aria-label={row.label}>
        <div className="row between"><h3>{row.label}</h3><span className="small muted">{AGENT_LABELS[row.provider]}{row.selected ? ' · 현재 선택' : ''}</span></div>
        <p>{observation?.email ?? (observation?.loggedIn === true ? '로그인됨' : observation?.loggedIn === false ? '로그인 필요' : '로그인 상태 미확인')}{observation?.plan ? ` · ${observation.plan}` : ''}</p>
        <p className="small muted account-path">{row.configDir}</p>
        {observation?.windows.length ? observation.windows.map((window) => {
          const current = fresh && (!window.resetsAt || Date.parse(window.resetsAt) > Date.now())
          const remaining = Math.max(0, 100 - window.usedPercent)
          return <div className="account-quota" key={window.id}><div className="row between"><span>{window.label}</span><b>{current ? `잔여 ${remaining.toFixed(0)}%` : '현재 잔여량 미확인'}</b></div>{current && <progress aria-label={`${row.label} ${window.label} 잔여량`} value={remaining} max={100} className={remaining <= row.minimumRemainingPercent ? 'quota-low' : ''} />}<div className="small muted">{window.resetsAt ? `초기화: ${new Date(window.resetsAt).toLocaleString()}` : '초기화 시각 미제공'}{!current ? ` · 마지막 확인 당시 ${remaining.toFixed(0)}%` : ''}</div></div>
        }) : <p className="small muted">사용량 미확인</p>}
        {observation?.message && <p className="small muted">{observation.message}</p>}
        {observation?.retryAt && <p className="small muted">다시 확인: {new Date(observation.retryAt).toLocaleString()}</p>}
        {block && <p className="small run-status waiting">{block.message}</p>}
        <p className="small muted">계정 확인: {observation ? new Date(observation.checkedAt).toLocaleString() : '아직 조회하지 않음'}{observation?.quotaCheckedAt ? ` · 사용량 확인: ${new Date(observation.quotaCheckedAt).toLocaleString()}` : ''}</p>
        <div className="row"><button disabled={!!busy || !row.enabled || row.selected} onClick={() => void api.selectAgentAccount(row.provider, row.id).catch(errorToast)}>{row.selected ? '현재 선택' : '이 계정으로 전환'}</button><button disabled={!!busy} onClick={() => void act(row, 'refresh')}>{busy === row.id ? '처리 중…' : '새로고침'}</button><button onClick={() => setEditing(row)}>계정 설정</button><button disabled={!!busy} onClick={() => void act(row, 'open')}>로그인 / 터미널 열기</button>{!row.builtin && <button className="ghost danger" disabled={!!busy || row.selected} onClick={() => void act(row, 'remove')}>등록 해제</button>}</div>
      </article>
    })}</div>}
    {editing && <AccountEditor account={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
  </section>
}
