import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, on } from '../api'
import { Empty, errorToast } from '../ui'

type Kind = 'shell' | 'claude' | 'codex'
interface Tab {
  id: string
  kind: Kind
  title: string
  exited?: number
}

// 화면을 옮겨도 터미널 내용이 사라지지 않도록 xterm 인스턴스를 컴포넌트 밖에 보관한다
const xterms = new Map<string, { term: Terminal; fit: FitAddon; host: HTMLDivElement }>()

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

  useEffect(() => {
    const offData = on('term-data', ({ id, data }: { id: string; data: string }) => xterms.get(id)?.term.write(data))
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
    }
  }, [])

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

  async function open(kind: Kind) {
    if (!area.current) return
    const host = document.createElement('div')
    host.className = 'term-host'
    area.current.appendChild(host)
    const term = new Terminal({ fontFamily: "'Cascadia Code', Consolas, 'D2Coding', monospace", fontSize: 13, cursorBlink: true, theme: theme(), scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    try {
      const info = await api.termCreate(kind, term.cols, term.rows)
      xterms.set(info.id, { term, fit, host })
      term.onData((d) => void api.termWrite(info.id, d))
      // Shift+Enter / Ctrl+Enter는 xterm이 그냥 Enter(\r)로 보내 입력이 바로 전송된다.
      // 에이전트가 줄바꿈으로 알아듣는 신호로 바꿔 보낸다: Claude Code는 Alt+Enter(ESC CR), Codex는 Ctrl+J(LF)
      const newline = kind === 'claude' ? '\x1b\r' : kind === 'codex' ? '\n' : null
      if (newline) {
        term.attachCustomKeyEventHandler((e) => {
          if (e.key !== 'Enter' || !(e.shiftKey || e.ctrlKey) || e.altKey || e.metaKey) return true
          if (e.type === 'keydown') void api.termWrite(info.id, newline)
          return false
        })
      }
      setTabs((t) => [...t, { id: info.id, kind, title: info.title }])
      setActive(info.id)
    } catch (e) {
      term.dispose()
      host.remove()
      errorToast(e)
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

  return (
    <div className="page terminals" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row between">
        <h2>터미널</h2>
        <div className="row">
          <button className="primary" onClick={() => open('claude')}>
            + Claude Code
          </button>
          <button className="primary" onClick={() => open('codex')}>
            + Codex
          </button>
          <button onClick={() => open('shell')}>+ 터미널</button>
        </div>
      </div>
      {tabs.length > 0 && (
        <div className="term-tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`term-tab ${active === t.id ? 'on' : ''} ${t.exited !== undefined ? 'dim' : ''}`} onClick={() => setActive(t.id)}>
              <span className={`dot ${t.kind}`} />
              {t.title}
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
            프로젝트 폴더에서 Claude Code·Codex·셸을 실행합니다. 여기서 나눈 대화는 도메인 점검에서 바로 검토할 수 있습니다.
          </Empty>
        )}
      </div>
    </div>
  )
}
