import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, on } from '../api'
import { Empty, Modal, errorToast } from '../ui'
import type { TerminalInfo, TerminalKind, TerminalSnapshot } from '../../../core/terminal'

interface Output { id: string; data: string; sequence: number }

function theme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? { background: '#1c2026', foreground: '#e4e7ec', cursor: '#3fbfae', selectionBackground: '#24584f' }
    : { background: '#ffffff', foreground: '#1c2230', cursor: '#0b7a70', selectionBackground: '#cfe8e4' }
}

/** TE-F01: 프로젝트를 열면 이전 탭과 세션을 자동으로 복원한다. */
export default function Terminals({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const area = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const xterms = useRef(new Map<string, { term: Terminal; fit: FitAddon; host: HTMLDivElement; sequence: number }>()).current
  const pending = useRef(new Map<string, Output[]>()).current

  function write(event: Output) {
    const x = xterms.get(event.id)
    if (x) {
      if (event.sequence <= x.sequence) return
      x.term.write(event.data)
      x.sequence = event.sequence
    } else pending.set(event.id, [...(pending.get(event.id) ?? []), event].slice(-200))
  }

  function attach(snapshot: TerminalSnapshot) {
    if (!area.current || xterms.has(snapshot.id)) return
    const { id, kind } = snapshot
    const host = document.createElement('div')
    host.className = 'term-host'
    area.current.appendChild(host)
    const term = new Terminal({ fontFamily: "'Cascadia Code', Consolas, 'D2Coding', monospace", fontSize: 13, cursorBlink: true, theme: theme(), scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    xterms.set(id, { term, fit, host, sequence: snapshot.sequence })
    term.write(snapshot.output)
    for (const event of pending.get(id) ?? []) write(event)
    pending.delete(id)
    term.onData((data) => void api.termWrite(id, data).catch(errorToast))
    const newline = kind === 'claude' ? '\x1b\r' : kind === 'codex' ? '\n' : null
    const isMac = navigator.platform.startsWith('Mac')
    term.attachCustomKeyEventHandler((event) => {
      const pasteModifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (pasteModifier && !event.altKey && (event.code === 'KeyV' || event.key.toLowerCase() === 'v')) return false
      if (!newline || event.key !== 'Enter' || !(event.shiftKey || event.ctrlKey) || event.altKey || event.metaKey) return true
      if (event.type === 'keydown') void api.termWrite(id, newline).catch(errorToast)
      return false
    })
  }

  useEffect(() => {
    let alive = true
    mounted.current = true
    const exits = new Map<string, number>()
    const offData = on('term-data', write)
    const offError = on('term-error', (message: string) => errorToast(new Error(message)))
    const offExit = on('term-exit', ({ id, code }: { id: string; code: number }) => {
      exits.set(id, code)
      setTabs((all) => all.map((tab) => tab.id === id ? { ...tab, exited: code } : tab))
      xterms.get(id)?.term.write(`\r\n\x1b[90m[프로세스 종료: ${code}]\x1b[0m\r\n`)
    })
    void api.termState().then((state) => {
      if (!alive) return
      for (const tab of state.tabs) attach(tab)
      setTabs(state.tabs.map((tab) => exits.has(tab.id) ? { ...tab, exited: exits.get(tab.id) } : tab))
      setActive(state.active)
    }).catch(errorToast).finally(() => { if (alive) setLoading(false) })
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => { for (const x of xterms.values()) x.term.options.theme = theme() }
    query.addEventListener('change', onTheme)
    return () => {
      alive = false
      mounted.current = false
      offData(); offExit(); offError()
      query.removeEventListener('change', onTheme)
      for (const x of xterms.values()) { x.term.dispose(); x.host.remove() }
      xterms.clear(); pending.clear()
    }
  }, [])

  function fitTab(id: string) {
    const x = xterms.get(id)
    if (!x || x.host.offsetParent === null) return
    try {
      x.fit.fit()
      void api.termResize(id, x.term.cols, x.term.rows).catch(errorToast)
    } catch { /* 숨긴 영역은 크기가 정해진 뒤 맞춘다. */ }
  }

  useEffect(() => {
    for (const [id, x] of xterms) x.host.style.display = id === active ? 'block' : 'none'
    if (active && visible && !editing) requestAnimationFrame(() => { fitTab(active); xterms.get(active)?.term.focus() })
  }, [active, visible, tabs.length, editing])

  useEffect(() => {
    if (!area.current) return
    const observer = new ResizeObserver(() => { if (active && visible) fitTab(active) })
    observer.observe(area.current)
    return () => observer.disconnect()
  }, [active, visible])

  async function open(kind: TerminalKind) {
    if (opening || loading) return
    setOpening(true)
    try {
      const snapshot = await api.termCreate(kind)
      if (!mounted.current) return
      attach(snapshot)
      setTabs((all) => [...all, snapshot])
      setActive(snapshot.id)
    } catch (e) { errorToast(e) }
    finally { if (mounted.current) setOpening(false) }
  }

  async function close(id: string) {
    try {
      await api.termKill(id)
      const x = xterms.get(id)
      x?.term.dispose(); x?.host.remove()
      xterms.delete(id); pending.delete(id)
      setTabs((all) => {
        const rest = all.filter((tab) => tab.id !== id)
        if (active === id) setActive(rest.at(-1)?.id ?? null)
        return rest
      })
    } catch (e) { errorToast(e) }
  }

  async function rename() {
    if (!editing) return
    try {
      const renamed = await api.termRename(editing, name)
      setTabs((all) => all.map((tab) => tab.id === renamed.id ? renamed : tab))
      setEditing(null)
    } catch (e) { errorToast(e) }
  }

  async function restart(id: string) {
    setOpening(true)
    try {
      const snapshot = await api.termRestart(id)
      const old = xterms.get(id)
      old?.term.dispose(); old?.host.remove(); xterms.delete(id)
      attach(snapshot)
      setTabs((all) => all.map((tab) => tab.id === id ? snapshot : tab))
      setActive(id)
    } catch (e) { errorToast(e) }
    finally { setOpening(false) }
  }

  return (
    <div className="page terminals" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row between">
        <h2>터미널</h2>
        <div className="row">
          <button className="primary" disabled={opening || loading} onClick={() => void open('claude')}>+ Claude Code</button>
          <button className="primary" disabled={opening || loading} onClick={() => void open('codex')}>+ Codex</button>
          <button disabled={opening || loading} onClick={() => void open('shell')}>+ 터미널</button>
        </div>
      </div>
      {tabs.length > 0 && (
        <div className="term-tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={`term-tab ${active === tab.id ? 'on' : ''} ${tab.exited !== undefined ? 'dim' : ''}`} onClick={() => { setActive(tab.id); void api.termActivate(tab.id).catch(errorToast) }}>
              <span className={`dot ${tab.kind}`} />{tab.title}
              {tab.exited !== undefined && <button className="icon" disabled={opening} aria-label={`${tab.title} 다시 연결`} title="다시 연결" onClick={(event) => { event.stopPropagation(); void restart(tab.id) }}>↻</button>}
              <button className="icon" aria-label={`${tab.title} 이름 변경`} title="이름 변경" onClick={(event) => { event.stopPropagation(); setEditing(tab.id); setName(tab.title) }}>✎</button>
              <button className="icon" title="닫기 (프로세스 종료)" onClick={(event) => { event.stopPropagation(); void close(tab.id) }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div ref={area} className="term-area">
        {loading ? <Empty>터미널 세션을 복원하는 중…</Empty> : tabs.length === 0 && <Empty>프로젝트 폴더에서 Claude Code·Codex·셸을 실행합니다. 앱을 다시 열면 열어 두었던 탭과 세션이 자동으로 복원됩니다.</Empty>}
      </div>
      {editing && (
        <Modal title="세션 이름 변경" onClose={() => setEditing(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void rename() }}>
            <div className="field"><label htmlFor="terminal-name">이름</label><input id="terminal-name" autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="row end"><button type="button" onClick={() => setEditing(null)}>취소</button><button className="primary" disabled={!name.trim()} type="submit">저장</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}
