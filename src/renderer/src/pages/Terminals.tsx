import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, on } from '../api'
import { Empty, Modal, errorToast } from '../ui'
import type { TerminalActivity, TerminalInfo, TerminalKind, TerminalSnapshot } from '../../../core/terminal'
import type { TerminalGroup, TerminalLayout } from '../../../core/terminalWorkspace'
import PipelineEditor from './Pipelines'

interface Output { id: string; data: string; sequence: number }
type Editing = { kind: 'tab'; id: string } | { kind: 'new-group' } | { kind: 'group'; id: string }
const TAB_DRAG_TYPE = 'application/x-orbit-terminal'
const ACTIVITY_LABEL: Record<TerminalActivity, string> = { idle: '기본 상태', working: '작업 중', completed: '작업 완료 · 미확인' }

function mergeActivity<T extends TerminalInfo>(info: T, previous?: TerminalInfo): T {
  return (previous?.activityRevision ?? 0) > (info.activityRevision ?? 0)
    ? { ...info, activity: previous?.activity, activityRevision: previous?.activityRevision }
    : info
}

function theme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? { background: '#1c2026', foreground: '#e4e7ec', cursor: '#3fbfae', selectionBackground: '#24584f' }
    : { background: '#ffffff', foreground: '#1c2230', cursor: '#0b7a70', selectionBackground: '#cfe8e4' }
}

/** TE-F01: 프로젝트를 열면 이전 탭과 세션을 자동으로 복원한다. */
export default function Terminals({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [groups, setGroups] = useState<TerminalGroup[]>([])
  const [activeGroup, setActiveGroup] = useState('all')
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [updating, setUpdating] = useState(false)
  const [name, setName] = useState('')
  const [view, setView] = useState<'terms' | 'graph'>('terms')
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())
  const area = useRef<HTMLDivElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const xterms = useRef(new Map<string, { term: Terminal; fit: FitAddon; host: HTMLDivElement; sequence: number; kind: TerminalKind }>()).current
  const pending = useRef(new Map<string, Output[]>()).current
  const snapshots = useRef(new Map<string, TerminalSnapshot>()).current
  const busy = loading || opening || updating
  const shownTabs = tabs.filter((tab) => activeGroup === 'all' || (activeGroup === 'ungrouped' ? !tab.groupId : tab.groupId === activeGroup))
  const selectedGroup = groups.find((g) => g.id === activeGroup)
  const activeTab = tabs.find((tab) => tab.id === active)

  function applyLayout(layout: TerminalLayout) {
    if (!mounted.current) return
    setGroups(layout.groups)
    setActiveGroup(layout.activeGroup)
    setTabs((current) => layout.tabs.map((tab) => {
      const previous = current.find((t) => t.id === tab.id)
      const updated = mergeActivity(tab, previous)
      return previous?.exited !== undefined && tab.exited === undefined ? { ...updated, exited: previous.exited } : updated
    }))
    setActive(layout.active)
  }

  async function changeLayout(action: () => Promise<TerminalLayout>) {
    if (busy) return
    setUpdating(true)
    try { applyLayout(await action()) }
    catch (e) { errorToast(e) }
    finally { if (mounted.current) setUpdating(false) }
  }

  function dropTab(event: DragEvent<HTMLButtonElement>, groupId: string | null) {
    event.preventDefault()
    const id = event.dataTransfer.getData(TAB_DRAG_TYPE)
    if (tabs.some((tab) => tab.id === id)) void changeLayout(() => api.termMoveToGroup(id, groupId))
  }

  function write(event: Output) {
    const x = xterms.get(event.id)
    if (x) {
      if (event.sequence <= x.sequence) return
      x.term.write(event.data)
      x.sequence = event.sequence
    } else {
      const snapshot = snapshots.get(event.id)
      if (snapshot) {
        if (event.sequence <= snapshot.sequence) return
        snapshot.output = (snapshot.output + event.data).slice(-200000)
        snapshot.sequence = event.sequence
      } else pending.set(event.id, [...(pending.get(event.id) ?? []), event].slice(-200))
    }
  }

  function remember(snapshot: TerminalSnapshot) {
    if (xterms.has(snapshot.id)) return
    const previous = snapshots.get(snapshot.id)
    if (!previous || previous.sequence <= snapshot.sequence) snapshots.set(snapshot.id, { ...snapshot })
    for (const event of pending.get(snapshot.id) ?? []) write(event)
    pending.delete(snapshot.id)
  }

  function attach(snapshot: TerminalSnapshot) {
    if (!area.current || xterms.has(snapshot.id)) return
    const { id, kind } = snapshot
    const host = document.createElement('div')
    host.className = 'term-host'
    host.style.display = 'none'
    area.current.appendChild(host)
    const term = new Terminal({ fontFamily: "'Cascadia Code', Consolas, 'D2Coding', monospace", fontSize: 13, cursorBlink: true, theme: theme(), scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    xterms.set(id, { term, fit, host, sequence: snapshot.sequence, kind })
    term.write(snapshot.output)
    snapshots.delete(id)
    for (const event of pending.get(id) ?? []) write(event)
    pending.delete(id)
    term.onData((data) => void api.termWrite(id, data).catch(errorToast))
    // LF는 Windows ConPTY에서 사라진다. 두 CLI 모두 인식하는 Alt+Enter를 보낸다.
    const isMac = navigator.platform.startsWith('Mac')
    term.attachCustomKeyEventHandler((event) => {
      const pasteModifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (pasteModifier && !event.altKey && (event.code === 'KeyV' || event.key.toLowerCase() === 'v')) return false
      if (xterms.get(id)?.kind === 'shell' || event.key !== 'Enter' || !(event.shiftKey || event.ctrlKey) || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return true
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'keydown') void api.termWrite(id, '\x1b\r').catch(errorToast)
      return false
    })
  }

  useEffect(() => {
    let alive = true
    mounted.current = true
    const exits = new Map<string, number>()
    const infos = new Map<string, TerminalInfo>()
    const offData = on('term-data', write)
    const offError = on('term-error', (message: string) => errorToast(new Error(message)))
    const offInfo = on('term-info', (info: TerminalInfo) => {
      infos.set(info.id, mergeActivity(info, infos.get(info.id)))
      const x = xterms.get(info.id)
      if (x) x.kind = info.kind
      const snapshot = snapshots.get(info.id)
      if (snapshot) snapshot.kind = info.kind
      setTabs((all) => all.map((tab) => tab.id === info.id ? mergeActivity({ ...tab, ...info }, tab) : tab))
    })
    const offExit = on('term-exit', ({ id, code }: { id: string; code: number }) => {
      exits.set(id, code)
      setTabs((all) => all.map((tab) => tab.id === id ? { ...tab, exited: code } : tab))
      const message = `\r\n\x1b[90m[프로세스 종료: ${code}]\x1b[0m\r\n`
      xterms.get(id)?.term.write(message)
      const snapshot = snapshots.get(id)
      if (snapshot) snapshot.output = (snapshot.output + message).slice(-200000)
    })
    // IN-F11: 작업 그래프가 연 터미널도 탭으로 붙인다
    const offCreated = on('term-created', (snapshot: TerminalSnapshot) => {
      remember(snapshot)
      setTabs((all) => all.some((tab) => tab.id === snapshot.id) ? all : [...all, mergeActivity(snapshot, infos.get(snapshot.id))])
      setActive((a) => a ?? snapshot.id)
    })
    void api.termState().then((state) => {
      if (!alive) return
      for (const tab of state.tabs) remember(tab)
      setTabs(state.tabs.map((tab) => {
        const updated = mergeActivity(tab, infos.get(tab.id))
        return exits.has(tab.id) ? { ...updated, exited: exits.get(tab.id) } : updated
      }))
      setActive(state.active)
      setGroups(state.groups)
      setActiveGroup(state.activeGroup)
    }).catch(errorToast).finally(() => { if (alive) setLoading(false) })
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => { for (const x of xterms.values()) x.term.options.theme = theme() }
    query.addEventListener('change', onTheme)
    return () => {
      alive = false
      mounted.current = false
      offData(); offExit(); offError(); offInfo(); offCreated()
      query.removeEventListener('change', onTheme)
      for (const x of xterms.values()) { x.term.dispose(); x.host.remove() }
      xterms.clear(); pending.clear(); snapshots.clear()
    }
  }, [])

  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden' && document.hasFocus())
    const blur = () => setForeground(false)
    window.addEventListener('focus', update)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (!visible || view !== 'terms' || !foreground || editing || activeTab?.activity !== 'completed') return
    void api.termAcknowledge(activeTab.id, activeTab.activityRevision ?? 0).catch(errorToast)
  }, [visible, view, foreground, editing, activeTab?.id, activeTab?.activity, activeTab?.activityRevision])

  function fitTab(id: string) {
    const x = xterms.get(id)
    if (!x || x.host.offsetParent === null) return
    try {
      x.fit.fit()
      void api.termResize(id, x.term.cols, x.term.rows).catch(errorToast)
    } catch { /* 숨긴 영역은 크기가 정해진 뒤 맞춘다. */ }
  }

  useEffect(() => {
    // CLI는 모두 복원하지만 터미널 화면은 처음 보는 탭만 만든다.
    if (active && visible && view === 'terms') {
      const snapshot = snapshots.get(active)
      if (snapshot) attach(snapshot)
    }
    for (const [id, x] of xterms) x.host.style.display = id === active ? 'block' : 'none'
    if (visible && view === 'terms') tabList.current?.querySelector('.term-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (active && visible && !editing && view === 'terms') {
      const frame = requestAnimationFrame(() => { fitTab(active); xterms.get(active)?.term.focus() })
      return () => cancelAnimationFrame(frame)
    }
  }, [active, visible, tabs.length, editing, activeGroup, view, opening])

  useEffect(() => {
    if (!area.current) return
    const observer = new ResizeObserver(() => { if (active && visible) fitTab(active) })
    observer.observe(area.current)
    return () => observer.disconnect()
  }, [active, visible])

  async function open(kind: TerminalKind) {
    if (busy) return
    setView('terms')
    setOpening(true)
    try {
      const snapshot = await api.termCreate(kind)
      if (!mounted.current) return
      remember(snapshot)
      setTabs((all) => [...all, snapshot])
      setActive(snapshot.id)
    } catch (e) { errorToast(e) }
    finally { if (mounted.current) setOpening(false) }
  }

  async function close(id: string) {
    if (busy) return
    setUpdating(true)
    try {
      const layout = await api.termKill(id)
      if (!mounted.current) return
      const x = xterms.get(id)
      x?.term.dispose(); x?.host.remove()
      xterms.delete(id); pending.delete(id); snapshots.delete(id)
      applyLayout(layout)
    } catch (e) { errorToast(e) }
    finally { if (mounted.current) setUpdating(false) }
  }

  async function rename() {
    if (!editing || busy) return
    setUpdating(true)
    try {
      if (editing.kind === 'tab') {
        const renamed = await api.termRename(editing.id, name)
        if (mounted.current) setTabs((all) => all.map((tab) => tab.id === renamed.id ? mergeActivity(renamed, tab) : tab))
      } else {
        applyLayout(await (editing.kind === 'new-group' ? api.termCreateGroup(name) : api.termRenameGroup(editing.id, name)))
      }
      if (mounted.current) setEditing(null)
    } catch (e) { errorToast(e) }
    finally { if (mounted.current) setUpdating(false) }
  }

  async function restart(id: string) {
    if (busy) return
    setOpening(true)
    try {
      const snapshot = await api.termRestart(id)
      if (!mounted.current) return
      const old = xterms.get(id)
      old?.term.dispose(); old?.host.remove(); xterms.delete(id)
      snapshots.delete(id); pending.delete(id)
      remember(snapshot)
      if (visible && view === 'terms') attach(snapshot)
      setTabs((all) => all.map((tab) => tab.id === id ? mergeActivity(snapshot, tab) : tab))
      setActive(id)
    } catch (e) { errorToast(e) }
    finally { if (mounted.current) setOpening(false) }
  }

  return (
    <div className="page terminals" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row between">
        <div className="row">
          <h2>터미널</h2>
          <div className="seg small">
            <button className={view === 'terms' ? 'on' : ''} onClick={() => setView('terms')}>터미널</button>
            <button className={view === 'graph' ? 'on' : ''} onClick={() => setView('graph')}>작업 그래프</button>
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void open('claude')}>+ Claude Code</button>
          <button className="primary" disabled={busy} onClick={() => void open('codex')}>+ Codex</button>
          <button disabled={busy} onClick={() => void open('shell')}>+ 터미널</button>
        </div>
      </div>
      {view === 'graph' && <PipelineEditor tabs={tabs} onShowTerminal={(id) => { void changeLayout(() => api.termActivate(id)).then(() => { if (mounted.current) setView('terms') }) }} />}
      {view === 'terms' && <>
      <div className="term-group-bar" role="region" aria-label="터미널 그룹">
        <div className="term-groups">
          {[{ id: 'all', title: '전체' }, { id: 'ungrouped', title: '미분류' }, ...groups].map((group) => {
            const count = tabs.filter((tab) => group.id === 'all' || (group.id === 'ungrouped' ? !tab.groupId : tab.groupId === group.id)).length
            return <button key={group.id} className={`term-group ${activeGroup === group.id ? 'on' : ''}`} aria-pressed={activeGroup === group.id} aria-label={`${group.title} 그룹, 터미널 ${count}개`} disabled={busy}
              onClick={() => void changeLayout(() => api.termSelectGroup(group.id))}
              onDragOver={(event) => { if (!busy && group.id !== 'all' && event.dataTransfer.types.includes(TAB_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
              onDrop={(event) => { if (group.id !== 'all') dropTab(event, group.id === 'ungrouped' ? null : group.id) }}
              title={group.id === 'all' ? '모든 터미널 보기' : '이 그룹에 탭을 끌어 놓아 이동'}>
              <span>{group.title}</span><span className="term-group-count">{count}</span>
            </button>
          })}
          <button className="small ghost" disabled={busy} onClick={() => { setEditing({ kind: 'new-group' }); setName('') }}>+ 그룹</button>
        </div>
        {selectedGroup && <div className="term-group-actions">
          <button className="small ghost" disabled={busy} onClick={() => { setEditing({ kind: 'group', id: selectedGroup.id }); setName(selectedGroup.title) }}>그룹 이름 변경</button>
          <button className="small ghost" disabled={busy} title="터미널은 종료하지 않고 미분류로 옮깁니다" onClick={() => void changeLayout(() => api.termDeleteGroup(selectedGroup.id))}>그룹 해제</button>
        </div>}
      </div>
      <div className="term-group-tools">
        <span className="small muted">탭을 그룹 위로 끌어 옮길 수 있습니다.</span>
        {activeTab && <label className="small">선택한 터미널의 그룹
          <select aria-label="선택한 터미널의 그룹" value={activeTab.groupId ?? ''} disabled={busy} onChange={(event) => void changeLayout(() => api.termMoveToGroup(activeTab.id, event.target.value || null))}>
            <option value="">미분류</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        </label>}
      </div>
      {shownTabs.length > 0 && (
        <div ref={tabList} className="term-tabs" role="tablist" aria-label="터미널 탭">
          {shownTabs.map((tab) => (
            <div key={tab.id} className={`term-tab ${active === tab.id ? 'on' : ''} ${tab.exited !== undefined ? 'dim' : ''}`} draggable={!busy}
              onDragStart={(event) => { event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id); event.dataTransfer.effectAllowed = 'move' }}>
              <button className="term-tab-select" role="tab" aria-selected={active === tab.id} disabled={busy} onClick={() => void changeLayout(() => api.termActivate(tab.id))}>
                <span className={`dot ${tab.activity ?? 'idle'}`} role="img" aria-label={ACTIVITY_LABEL[tab.activity ?? 'idle']} title={ACTIVITY_LABEL[tab.activity ?? 'idle']} /><span>{tab.title}</span>
                {activeGroup === 'all' && tab.groupId && <span className="term-tab-group">{groups.find((g) => g.id === tab.groupId)?.title}</span>}
              </button>
              {tab.exited !== undefined && <button className="icon" disabled={busy} aria-label={`${tab.title} 다시 연결`} title="다시 연결" onClick={() => void restart(tab.id)}>↻</button>}
              <button className="icon" disabled={busy} aria-label={`${tab.title} 이름 변경`} title="이름 변경" onClick={() => { setEditing({ kind: 'tab', id: tab.id }); setName(tab.title) }}>✎</button>
              <button className="icon" disabled={busy} aria-label={`${tab.title} 닫기`} title="닫기 (프로세스 종료)" onClick={() => void close(tab.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      </>}
      {/* 그래프를 보는 동안에도 터미널은 살아 있어야 하므로 지우지 않고 숨긴다 */}
      <div ref={area} className="term-area" style={{ display: view === 'terms' ? undefined : 'none' }}>
        {loading ? <Empty>터미널 세션을 복원하는 중…</Empty> : shownTabs.length === 0 && <Empty>{activeGroup === 'all'
          ? '프로젝트 폴더에서 Claude Code·Codex·셸을 실행합니다. 앱을 다시 열면 그룹과 탭, 세션이 자동으로 복원됩니다. 여러 작업을 이어서 자동으로 돌리려면 위의 "작업 그래프"를 쓰세요.'
          : '이 그룹에는 터미널이 없습니다. 위에서 새 터미널을 열거나, 전체 보기에서 기존 탭을 이 그룹으로 옮기세요.'}</Empty>}
      </div>
      {editing && (
        <Modal title={editing.kind === 'tab' ? '터미널 이름 변경' : editing.kind === 'new-group' ? '터미널 그룹 만들기' : '그룹 이름 변경'} onClose={() => { if (!updating) setEditing(null) }}>
          <form onSubmit={(event) => { event.preventDefault(); void rename() }}>
            <div className="field"><label htmlFor="terminal-name">이름</label><input id="terminal-name" autoFocus maxLength={100} disabled={updating} placeholder={editing.kind === 'tab' ? undefined : '예: 서버 작업, 클라이언트 작업'} value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="row end"><button type="button" disabled={updating} onClick={() => setEditing(null)}>취소</button><button className="primary" disabled={!name.trim() || busy} type="submit">저장</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}
