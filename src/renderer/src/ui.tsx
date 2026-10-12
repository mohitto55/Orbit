import { useEffect, useState, type ReactNode } from 'react'
import type { ChangeInput, ChangeSize } from './types'

/* ---------- 알림 ---------- */

type Toast = { id: number; text: string; kind: 'ok' | 'error'; leaving?: boolean }
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {}

export function toast(text: string, kind: Toast['kind'] = 'ok') {
  pushToast({ text, kind })
}

export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error')
}

const LEAVE_MS = 260

/** 우측 위 알림. 들어올 때와 나갈 때 모두 미끄러지듯 움직인다. */
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    let n = 0
    const dismiss = (id: number) => {
      setItems((s) => s.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), LEAVE_MS)
    }
    pushToast = (t) => {
      const id = ++n
      setItems((s) => [...s.slice(-4), { ...t, id }])
      setTimeout(() => dismiss(id), t.kind === 'error' ? 6000 : 2800)
    }
    dismissToast = dismiss
  }, [])
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${t.leaving ? 'leaving' : ''}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
let dismissToast: (id: number) => void = () => {}

/* ---------- 되돌리기 ---------- */

type UndoOffer = { id: number; text: string; undo: () => Promise<void>; leaving?: boolean; done?: boolean }
let pushUndo: (o: Omit<UndoOffer, 'id'>) => void = () => {}
const UNDO_MS = 7000
/** 되돌린 뒤 "취소됨"을 보여 주는 시간 */
const DONE_MS = 1400

/** 좌측 아래에 "되돌리기"를 띄운다. 새 제안이 오면 이전 것은 사라진다. Ctrl+Z로도 실행된다. */
export function offerUndo(text: string, undo: () => Promise<void>) {
  pushUndo({ text, undo })
}

export function UndoBar() {
  const [offer, setOffer] = useState<UndoOffer | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let n = 0
    pushUndo = (o) => setOffer({ ...o, id: ++n })
  }, [])

  const close = (id: number) => {
    setOffer((o) => (o && o.id === id ? { ...o, leaving: true } : o))
    setTimeout(() => setOffer((o) => (o && o.id === id ? null : o)), LEAVE_MS)
  }

  const run = async () => {
    if (!offer || offer.leaving || offer.done || busy) return
    setBusy(true)
    try {
      await offer.undo()
      // 결과는 누른 자리에서 보여 준다: 문구에 줄을 긋고 잠깐 "취소됨"
      setOffer((o) => (o && o.id === offer.id ? { ...o, done: true } : o))
      setTimeout(() => close(offer.id), DONE_MS)
    } catch (e) {
      errorToast(e)
      close(offer.id)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!offer || offer.leaving || offer.done) return
    const timer = setTimeout(() => close(offer.id), UNDO_MS)
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"], .xterm')) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  })

  if (!offer) return null
  return (
    <div key={offer.id} className={`undo-bar ${offer.leaving ? 'leaving' : ''} ${offer.done ? 'done' : ''}`}>
      <span className="grow undo-text">{offer.text}</span>
      {offer.done ? (
        <span className="undo-done">취소됨</span>
      ) : (
        <>
          <button className="undo-btn" disabled={busy} onClick={run} title="Ctrl+Z">
            되돌리기
          </button>
          <button className="icon" onClick={() => close(offer.id)} title="닫기">
            ✕
          </button>
          <div className="undo-timer" style={{ animationDuration: `${UNDO_MS}ms` }} />
        </>
      )}
    </div>
  )
}

/* ---------- 변경 기록 입력 (DM-F03, SP-F04, DS-F05) ---------- */

type ChangeRequest = { title: string; defaultSize: ChangeSize; resolve: (c: ChangeInput | null) => void }
let openChange: (r: ChangeRequest) => void = () => {}

export function askChange(title: string, defaultSize: ChangeSize = 'minor'): Promise<ChangeInput | null> {
  return new Promise((resolve) => openChange({ title, defaultSize, resolve }))
}

export function ChangeDialog() {
  const [req, setReq] = useState<ChangeRequest | null>(null)
  const [size, setSize] = useState<ChangeSize>('minor')
  const [summary, setSummary] = useState('')
  useEffect(() => {
    openChange = (r) => {
      setReq(r)
      setSize(r.defaultSize)
      setSummary('')
    }
  }, [])
  if (!req) return null
  const close = (v: ChangeInput | null) => {
    req.resolve(v)
    setReq(null)
  }
  return (
    <Modal title={req.title} onClose={() => close(null)}>
      <div className="field">
        <label>변경 크기</label>
        <div className="seg">
          <button className={size === 'major' ? 'on' : ''} onClick={() => setSize('major')}>
            큰 변경 <small>규칙·구조 변경 → 아래 층에 확인표시</small>
          </button>
          <button className={size === 'minor' ? 'on' : ''} onClick={() => setSize('minor')}>
            작은 변경 <small>설명 보강, 오타</small>
          </button>
        </div>
      </div>
      <div className="field">
        <label>변경 요약</label>
        <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="무엇이 왜 바뀌었나" onKeyDown={(e) => e.key === 'Enter' && summary.trim() && close({ size, summary })} />
      </div>
      <div className="row end">
        <button onClick={() => close(null)}>취소</button>
        <button className="primary" disabled={!summary.trim()} onClick={() => close({ size, summary })}>
          저장
        </button>
      </div>
    </Modal>
  )
}

/* ---------- 공통 조각 ---------- */

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className={`modal-back ${wide ? 'wide' : ''}`} onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Badge({ children, kind = '' }: { children: ReactNode; kind?: string }) {
  return <span className={`badge ${kind}`}>{children}</span>
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

/** 지금 어두운 화면인가. 설정에서 테마를 바꾸거나 시스템 설정이 바뀌면 다시 그린다. */
export function useDark(): boolean {
  const [dark, setDark] = useState(() => darkQuery().matches)
  useEffect(() => {
    const q = darkQuery()
    const onChange = () => setDark(q.matches)
    q.addEventListener('change', onChange)
    return () => q.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    fn()
      .then((d) => alive && setData(d))
      .catch(errorToast)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return [data, () => setTick((t) => t + 1)]
}

export const AC_LABEL: Record<string, string> = {
  pass: '통과',
  fail: '실패',
  none: '테스트 없음',
  notrun: '미실행',
  review: '확인 필요'
}
