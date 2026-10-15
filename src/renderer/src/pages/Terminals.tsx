import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, on } from '../api'
import { Empty, Modal, errorToast } from '../ui'
import type { TerminalInfo } from '../../../core/terminal'
import type { TerminalSession } from '../../../core/terminalSessions'

type Kind = 'shell' | 'claude' | 'codex'
interface Tab extends TerminalInfo {
  exited?: number
}

function theme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark
    ? { background: '#1c2026', foreground: '#e4e7ec', cursor: '#3fbfae', selectionBackground: '#24584f' }
    : { background: '#ffffff', foreground: '#1c2230', cursor: '#0b7a70', selectionBackground: '#cfe8e4' }
}

/** IN-F09: 프로젝트 폴더에서 Claude Code·Codex·셸을 탭으로 실행한다. 페이지를 떠나도 계속 살아 있다. */
export default function Terminals({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const area = useRef<HTMLDivElement>(null)
  // App이 화면 이동 중에도 이 컴포넌트를 유지하므로 인스턴스도 계속 살아 있다.
  const xterms = useRef(new Map<string, { term: Terminal; fit: FitAddon; host: HTMLDivElement }>()).current
  const pendingOutput = useRef(new Map<string, string>())
  const [history, setHistory] = useState(false)
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [sessionErrors, setSessionErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [editing, setEditing] = useState<{ id: string; title: string; saved: boolean } | null>(null)
  const [name, setName] = useState('')

  async function loadSessions() {
    setLoading(true)
    try {
      const result = await api.termSessions()
      setSessions(result.sessions)
      setSessionErrors(result.errors)
    } catch (e) {
      errorToast(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const offData = on('term-data', ({ id, data }: { id: string; data: string }) => {
      const x = xterms.get(id)
      if (x) x.term.write(data)
      else pendingOutput.current.set(id, ((pendingOutput.current.get(id) ?? '') + data).slice(-200000))
    })
    const offExit = on('term-exit', ({ id, code }: { id: string; code: number }) => {
      setTabs((t) => t.map((x) => (x.id === id ? { ...x, exited: code } : x)))
      xterms.get(id)?.term.write(`\r\n\x1b[90m[프로세스 종료: ${code}]\x1b[0m\r\n`)
    })
    // 테마를 바꾸면 열려 있는 터미널 색도 바꾼다
    const q = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => {
      for (const x of xterms.values()) x.term.options.theme = theme()
    }
    q.addEventListener('change', onTheme)
    return () => {
      offData()
      offExit()
      q.removeEventListener('change', onTheme)
      for (const x of xterms.values()) {
        x.term.dispose()
        x.host.remove()
      }
      xterms.clear()
    }
  }, [])

  useEffect(() => {
    if (history) void loadSessions()
  }, [history])

  // 보이는 탭만 DOM에 붙이고 크기를 맞춘다
  useEffect(() => {
    if (!area.current) return
    for (const [id, x] of xterms) x.host.style.display = id === active ? 'block' : 'none'
    const cur = active ? xterms.get(active) : undefined
    if (cur && visible) {
      requestAnimationFrame(() => {
        fitTab(active!)
        cur.term.focus()
      })
    }
  }, [active, visible, tabs.length])

  useEffect(() => {
    if (!area.current) return
    const ro = new ResizeObserver(() => active && visible && fitTab(active))
    ro.observe(area.current)
    return () => ro.disconnect()
  }, [active, visible])

  function fitTab(id: string) {
    const x = xterms.get(id)
    if (!x || x.host.offsetParent === null) return
    try {
      x.fit.fit()
      void api.termResize(id, x.term.cols, x.term.rows)
    } catch {
      // 크기가 0일 때(숨김 상태)는 무시
    }
  }

  async function open(kind: Kind, session?: TerminalSession) {
    if (!area.current || opening) return
    setOpening(true)
    const host = document.createElement('div')
    host.className = 'term-host'
    area.current.appendChild(host)
    const term = new Terminal({ fontFamily: "'Cascadia Code', Consolas, 'D2Coding', monospace", fontSize: 13, cursorBlink: true, theme: theme(), scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
      const info: TerminalInfo = session
        ? await api.termResume(session.id, term.cols, term.rows)
        : await api.termCreate(kind, term.cols, term.rows)
      // 같은 대화를 다시 누르면 실행 중인 탭으로 이동한다.
      if (xterms.has(info.id)) {
        term.dispose()
        host.remove()
        setActive(info.id)
        setHistory(false)
        return
      }
      xterms.set(info.id, { term, fit, host })
      const pending = pendingOutput.current.get(info.id)
      if (pending) term.write(pending)
      pendingOutput.current.delete(info.id)
      term.onData((d) => void api.termWrite(info.id, d))
      // Shift+Enter / Ctrl+Enter는 xterm이 그냥 Enter(\r)로 보내 입력이 바로 전송된다.
      // 에이전트가 줄바꿈으로 알아듣는 신호로 바꿔 보낸다: Claude Code는 Alt+Enter(ESC CR), Codex는 Ctrl+J(LF)
      const newline = kind === 'claude' ? '\x1b\r' : kind === 'codex' ? '\n' : null
      const isMac = navigator.platform.startsWith('Mac')
      term.attachCustomKeyEventHandler((e) => {
        // Ctrl+V를 제어 문자(\x16)로 보내면 브라우저의 paste 이벤트가 취소된다.
        // 기본 붙여넣기를 허용해 xterm이 텍스트·줄바꿈·bracketed paste를 처리하게 한다.
        const pasteModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
        if (pasteModifier && !e.altKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) {
          return false
        }
        if (!newline || e.key !== 'Enter' || !(e.shiftKey || e.ctrlKey) || e.altKey || e.metaKey) return true
        if (e.type === 'keydown') void api.termWrite(info.id, newline)
        return false
      })
      setTabs((t) => [...t, info])
      setActive(info.id)
      setHistory(false)
    } catch (e) {
      term.dispose()
      host.remove()
      errorToast(e)
    } finally {
      setOpening(false)
    }
  }

  async function close(id: string) {
    await api.termKill(id).catch(() => {})
    const x = xterms.get(id)
    x?.term.dispose()
    x?.host.remove()
    xterms.delete(id)
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id)
      if (active === id) setActive(rest[rest.length - 1]?.id ?? null)
      return rest
    })
  }

  function edit(id: string, title: string, saved: boolean) {
    setEditing({ id, title, saved })
    setName(title)
  }

  async function rename() {
    if (!editing) return
    try {
      if (editing.saved) {
        await api.termRenameSession(editing.id, name)
        setSessions((all) => all.map((s) => s.id === editing.id ? { ...s, title: name.trim() } : s))
        setTabs((all) => all.map((t) => `${t.kind}:${t.sessionId}` === editing.id ? { ...t, title: name.trim() } : t))
      } else {
        const renamed = await api.termRename(editing.id, name)
        setTabs((all) => all.map((t) => t.id === renamed.id ? { ...t, title: renamed.title } : t))
      }
      setEditing(null)
    } catch (e) {
      errorToast(e)
    }
  }

  return (
    <div className="page terminals" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row between">
        <h2>터미널</h2>
        <div className="row">
          <button onClick={() => setHistory(true)}>저장된 대화</button>
          <button className="primary" disabled={opening} onClick={() => open('claude')}>
            + Claude Code
          </button>
          <button className="primary" disabled={opening} onClick={() => open('codex')}>
            + Codex
          </button>
          <button disabled={opening} onClick={() => open('shell')}>+ 터미널</button>
        </div>
      </div>
      {tabs.length > 0 && (
        <div className="term-tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`term-tab ${active === t.id ? 'on' : ''} ${t.exited !== undefined ? 'dim' : ''}`} onClick={() => setActive(t.id)}>
              <span className={`dot ${t.kind}`} />
              {t.title}
              {t.exited === undefined && <button className="icon" aria-label={`${t.title} 이름 변경`} title="이름 변경" onClick={(e) => { e.stopPropagation(); edit(t.id, t.title, false) }}>✎</button>}
              <button
                className="icon"
                title="닫기 (프로세스 종료)"
                onClick={(e) => {
                  e.stopPropagation()
                  void close(t.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div ref={area} className="term-area">
        {tabs.length === 0 && (
          <Empty>
            프로젝트 폴더에서 Claude Code·Codex·셸을 실행합니다. 앱을 종료하면 작업은 중단됩니다. Claude Code·Codex의 이전 대화는 ‘저장된 대화’에서 재개할 수 있습니다.
          </Empty>
        )}
      </div>
      {history && (
        <Modal title="저장된 대화" wide onClose={() => setHistory(false)}>
          <div className="row between">
            <p className="muted small">현재 프로젝트의 Claude Code·Codex 대화입니다. 원본 대화가 이 컴퓨터에 남아 있어야 재개할 수 있습니다.</p>
            <button disabled={loading} onClick={() => void loadSessions()}>새로고침</button>
          </div>
          {sessionErrors.map((message) => <p key={message} role="alert">{message}</p>)}
          {loading ? <p>대화를 불러오는 중…</p> : sessions.length === 0 ? <Empty>저장된 대화가 없습니다. Claude Code·Codex에서 대화를 시작하면 여기에 표시됩니다.</Empty> : (
            <table className="table terminal-history">
              <thead><tr><th>이름</th><th>에이전트</th><th>최근 작업</th><th>작업</th></tr></thead>
              <tbody>{sessions.map((session) => (
                <tr key={session.id}>
                  <td><strong>{session.title}</strong><div className="muted small">{session.firstPrompt.slice(0, 120)}</div></td>
                  <td>{session.agent === 'claude' ? 'Claude Code' : 'Codex'}</td>
                  <td>{new Date(session.updatedAt).toLocaleString()}</td>
                  <td><div className="row">
                    <button onClick={() => edit(session.id, session.title, true)}>이름 변경</button>
                    <button className="primary" disabled={opening} onClick={() => void open(session.agent, session)}>재개</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Modal>
      )}
      {editing && (
        <Modal title="세션 이름 변경" onClose={() => setEditing(null)}>
          <form onSubmit={(e) => { e.preventDefault(); void rename() }}>
            <div className="field"><label htmlFor="terminal-name">이름</label><input id="terminal-name" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="row end"><button type="button" onClick={() => setEditing(null)}>취소</button><button className="primary" disabled={!name.trim()} type="submit">저장</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}
