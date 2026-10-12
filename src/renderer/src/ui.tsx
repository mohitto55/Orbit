import { useEffect, useState, type ReactNode } from 'react'
import type { ChangeInput, ChangeSize } from './types'

/* ---------- 알림 ---------- */

type Toast = { id: number; text: string; kind: 'ok' | 'error' }
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {}

export function toast(text: string, kind: Toast['kind'] = 'ok') {
  pushToast({ text, kind })
}

export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error')
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    let n = 0
    pushToast = (t) => {
      const id = ++n
      setItems((s) => [...s, { ...t, id }])
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.kind === 'error' ? 6000 : 3000)
    }
  }, [])
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
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

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
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
