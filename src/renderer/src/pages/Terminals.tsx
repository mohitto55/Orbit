import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, on } from '../api'
import { Empty, Modal, errorToast } from '../ui'
import type { TerminalActivity, TerminalInfo, TerminalKind, TerminalSnapshot } from '../../../core/terminal'
import type { TerminalGroup, TerminalLayout, TerminalOrderPosition } from '../../../core/terminalWorkspace'
import { terminalFilePastes } from '../../../core/terminalFiles'
import { AgentOptionsFields } from '../AgentOptionsFields'
import type { AgentOptions } from '../../../core/agentModel'

interface Output { id: string; data: string; sequence: number }
type Editing = { kind: 'tab'; id: string } | { kind: 'new-group' } | { kind: 'group'; id: string }
const TAB_DRAG_TYPE = 'application/x-orbit-terminal'
const GROUP_DRAG_TYPE = 'application/x-orbit-terminal-group'
type DragItem = { kind: 'tab' | 'group'; id: string }
type DropTarget = DragItem & { position: TerminalOrderPosition | 'inside' }
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
export default function Terminals({ visible, focus, onGraphs }: { visible: boolean; focus?: string; onGraphs?: () => void }) {
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [groups, setGroups] = useState<TerminalGroup[]>([])
  const [activeGroup, setActiveGroup] = useState('all')
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [configuring, setConfiguring] = useState<{ id: string; title: string; kind: 'claude' | 'codex'; value: AgentOptions } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [name, setName] = useState('')
  const view = 'terms'
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())
  const area = useRef<HTMLDivElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const dragged = useRef<DragItem | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [fileDragging, setFileDragging] = useState(false)
  const mounted = useRef(false)
  const xterms = useRef(new Map<string, { term: Terminal; fit: FitAddon; host: HTMLDivElement; sequence: number; kind: TerminalKind }>()).current
  const pending = useRef(new Map<string, Output[]>()).current
  const snapshots = useRef(new Map<string, TerminalSnapshot>()).current
  const busy = loading || opening || updating
  const shownTabs = tabs.filter((tab) => activeGroup === 'all' || (activeGroup === 'ungrouped' ? !tab.groupId : tab.groupId === activeGroup))
  const selectedGroup = groups.find((g) => g.id === activeGroup)
  const activeTab = tabs.find((tab) => tab.id === active)
  const canDropFiles = visible && view === 'terms' && !busy && !editing && !configuring && !!activeTab && activeTab.exited === undefined

  useEffect(() => {
    if (visible && focus && !loading) void api.termActivate(focus).then(applyLayout).catch(errorToast)
  }, [focus, visible, loading])

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

  function startDrag(event: DragEvent<HTMLElement>, kind: DragItem['kind'], id: string) {
    if (busy || (event.target instanceof Element && event.target.closest('.icon'))) { event.preventDefault(); return }
    dragged.current = { kind, id }
    setDropTarget(null)
    event.dataTransfer.setData(kind === 'tab' ? TAB_DRAG_TYPE : GROUP_DRAG_TYPE, id)
    event.dataTransfer.effectAllowed = 'move'
  }

  function finishDrag() {
    dragged.current = null
    setDropTarget(null)
  }

  function dropAt(event: DragEvent<HTMLElement>, kind: DragItem['kind'], id: string): DropTarget | null {
    const source = dragged.current
    if (busy || !source) return null
    if (source.kind === 'tab' && kind === 'group') return id === 'all' ? null : { kind, id, position: 'inside' }
    if (source.kind !== kind || source.id === id || (kind === 'group' && !groups.some((group) => group.id === id))) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return { kind, id, position: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after' }
  }

  function dragOver(event: DragEvent<HTMLElement>, kind: DragItem['kind'], id: string) {
    const target = dropAt(event, kind, id)
    if (!target) { setDropTarget(null); return }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget((previous) => previous?.kind === target.kind && previous.id === target.id && previous.position === target.position ? previous : target)
  }

  function dragLeave(event: DragEvent<HTMLElement>) {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null)
  }

  function drop(event: DragEvent<HTMLElement>, kind: DragItem['kind'], id: string) {
    const source = dragged.current
    const target = dropAt(event, kind, id)
    finishDrag()
    if (!source || !target || event.dataTransfer.getData(source.kind === 'tab' ? TAB_DRAG_TYPE : GROUP_DRAG_TYPE) !== source.id) return
    event.preventDefault()
    if (target.position === 'inside') void changeLayout(() => api.termMoveToGroup(source.id, id === 'ungrouped' ? null : id))
    else {
      const position = target.position
      void changeLayout(() => source.kind === 'tab' ? api.termReorderTab(source.id, id, position) : api.termReorderGroup(source.id, id, position))
    }
  }

  const dropClass = (kind: DragItem['kind'], id: string) => dropTarget?.kind === kind && dropTarget.id === id ? ` drop-${dropTarget.position}` : ''

  function dragFiles(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = canDropFiles ? 'copy' : 'none'
    setFileDragging(canDropFiles)
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setFileDragging(false)
    if (!canDropFiles || !active) return
    const terminal = xterms.get(active)
    if (!terminal) return
    try {
      const paths = Array.from(event.dataTransfer.files, (file) => window.orbit.getPathForFile(file))
      const windows = navigator.platform.startsWith('Win')
      const pastes = terminalFilePastes(paths, terminal.kind, windows)
      for (const text of pastes) {
        terminal.term.paste(text)
        // ConPTY가 붙여넣기를 키 입력으로 전달하므로 이미지마다 버퍼를 확정한다. Enter는 보내지 않는다.
        if (terminal.kind === 'codex' && windows) void api.termWrite(active, '\x05').catch(errorToast)
      }
      terminal.term.focus()
    } catch (error) { errorToast(error) }
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
    // 파일을 화면 밖에 놓아도 Electron이 해당 파일로 이동해 작업 화면을 잃지 않게 한다.
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      if (event.type === 'drop') setFileDragging(false)
      else event.dataTransfer.dropEffect = 'none'
    }
    document.addEventListener('dragover', preventFileNavigation)
    document.addEventListener('drop', preventFileNavigation)
    return () => {
      document.removeEventListener('dragover', preventFileNavigation)
      document.removeEventListener('drop', preventFileNavigation)
    }
  }, [])

  useEffect(() => { setFileDragging(false) }, [active, visible, view, editing])

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

  async function saveAgentOptions() {
    if (!configuring || busy) return
    setUpdating(true)
    try {
      const snapshot = await api.termSetAgentOptions(configuring.id, configuring.value)
      if (!mounted.current) return
      setTabs((all) => all.map((tab) => tab.id === snapshot.id ? mergeActivity(snapshot, tab) : tab))
      setConfiguring(null)
    } catch (error) { errorToast(error) }
    finally { if (mounted.current) setUpdating(false) }
  }

  return (
    <div className="page terminals" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row between">
        <div className="row">
          <h2>터미널</h2>
          <div className="seg small">
            <button className="on">터미널</button>
            <button onClick={onGraphs}>작업 그래프 ↗</button>
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void open('claude')}>+ Claude Code</button>
          <button className="primary" disabled={busy} onClick={() => void open('codex')}>+ Codex</button>
          <button disabled={busy} onClick={() => void open('shell')}>+ 터미널</button>
        </div>
      </div>
      {view === 'terms' && <>
      <div className="term-group-bar" role="region" aria-label="터미널 그룹">
        <div className="term-groups">
          {[{ id: 'all', title: '전체' }, { id: 'ungrouped', title: '미분류' }, ...groups].map((group) => {
            const count = tabs.filter((tab) => group.id === 'all' || (group.id === 'ungrouped' ? !tab.groupId : tab.groupId === group.id)).length
            const custom = group.id !== 'all' && group.id !== 'ungrouped'
            return <div key={group.id} className={`term-group-wrap${dropClass('group', group.id)}`} draggable={custom && !busy}
              onDragStart={(event) => { if (custom) startDrag(event, 'group', group.id) }} onDragEnd={finishDrag}
              onDragOver={(event) => dragOver(event, 'group', group.id)} onDragLeave={dragLeave} onDrop={(event) => drop(event, 'group', group.id)}>
              <button className={`term-group ${activeGroup === group.id ? 'on' : ''}`} aria-pressed={activeGroup === group.id} aria-label={`${group.title} 그룹, 터미널 ${count}개`} disabled={busy}
                onClick={() => void changeLayout(() => api.termSelectGroup(group.id))}
                title={custom ? '드래그로 그룹 순서 변경 · 탭을 놓아 이 그룹으로 이동' : group.id === 'all' ? '모든 터미널 보기' : '탭을 놓아 미분류로 이동'}>
                <span>{group.title}</span><span className="term-group-count">{count}</span>
              </button>
              {custom && <button className="icon term-group-rename" disabled={busy} aria-label={`${group.title} 그룹 이름 변경`} title="그룹 이름 변경"
                onClick={() => { setEditing({ kind: 'group', id: group.id }); setName(group.title) }}>✎</button>}
            </div>
          })}
          <button className="small ghost" disabled={busy} onClick={() => { setEditing({ kind: 'new-group' }); setName('') }}>+ 그룹</button>
        </div>
        {selectedGroup && <div className="term-group-actions">
          <button className="small ghost" disabled={busy} title="터미널은 종료하지 않고 미분류로 옮깁니다" onClick={() => void changeLayout(() => api.termDeleteGroup(selectedGroup.id))}>그룹 해제</button>
        </div>}
      </div>
      <div className="term-group-tools">
        <span className="small muted">탭·그룹을 끌어 정리하세요. 사진·파일은 아래 터미널에 놓아 추가할 수 있습니다.</span>
        {activeTab && activeTab.kind !== 'shell' && <button disabled={busy} aria-label="세션 모델·Effort 설정" onClick={() => setConfiguring({ id: activeTab.id, title: activeTab.title, kind: activeTab.kind as 'claude' | 'codex', value: { model: activeTab.model, effort: activeTab.effort } })}>
          Model: {activeTab.model ?? '기본값'} · Effort: {activeTab.effort ?? '기본값'}
        </button>}
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
            <div key={tab.id} className={`term-tab ${active === tab.id ? 'on' : ''} ${tab.exited !== undefined ? 'dim' : ''}${dropClass('tab', tab.id)}`} draggable={!busy}
              onDragStart={(event) => startDrag(event, 'tab', tab.id)} onDragEnd={finishDrag}
              onDragOver={(event) => dragOver(event, 'tab', tab.id)} onDragLeave={dragLeave} onDrop={(event) => drop(event, 'tab', tab.id)}>
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
      <div ref={area} className={`term-area${fileDragging && canDropFiles ? ' file-dragging' : ''}`} style={{ display: view === 'terms' ? undefined : 'none' }}
        onDragOver={dragFiles} onDragEnter={dragFiles} onDrop={dropFiles}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFileDragging(false) }}>
        {fileDragging && canDropFiles && <div className="term-file-drop" role="status"><strong>사진·파일을 놓아 추가</strong><span>{activeTab?.title} 입력창에 추가됩니다</span></div>}
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
      {configuring && <Modal title={`${configuring.title} · Model / Effort`} onClose={() => { if (!updating) setConfiguring(null) }}>
        <form onSubmit={(event) => { event.preventDefault(); void saveAgentOptions() }}>
          <AgentOptionsFields kind={configuring.kind} value={configuring.value} disabled={updating} onChange={(patch) => setConfiguring({ ...configuring, value: { ...configuring.value, ...patch } })} />
          {tabs.find((tab) => tab.id === configuring.id)?.activity === 'working' && <p className="small muted">현재 작업이 끝나면 설정을 적용할 수 있습니다.</p>}
          <div className="row end"><button type="button" disabled={updating} onClick={() => setConfiguring(null)}>취소</button><button className="primary" type="submit" disabled={busy || tabs.find((tab) => tab.id === configuring.id)?.activity === 'working'}>{updating ? '적용 중…' : '적용'}</button></div>
        </form>
      </Modal>}
    </div>
  )
}
