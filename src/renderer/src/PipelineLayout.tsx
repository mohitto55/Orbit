import { useEffect, useRef, useState, type CSSProperties } from 'react'

const KEY = 'orbit:pipeline-layout'
const DEFAULT = { list: 190, panel: 340, output: 220 }
const LIMITS = { list: [140, 480], panel: [240, 760], output: [100, 600] } as const
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export function usePipelineLayout() {
  const [sizes, setSizes] = useState(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
      if (!saved || typeof saved !== 'object') return DEFAULT
      const read = (key: keyof typeof DEFAULT) => {
        const value = (saved as Record<string, unknown>)[key]
        return typeof value === 'number' && Number.isFinite(value) ? clamp(value, LIMITS[key][0], LIMITS[key][1]) : DEFAULT[key]
      }
      return { list: read('list'), panel: read('panel'), output: read('output') }
    } catch { return DEFAULT }
  })
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(sizes)) } catch { /* 저장할 수 없어도 현재 화면은 조절한다. */ } }, [sizes])
  return {
    sizes, reset: () => setSizes(DEFAULT),
    resize: (key: keyof typeof DEFAULT, value: number) => setSizes((old) => ({ ...old, [key]: clamp(value, LIMITS[key][0], LIMITS[key][1]) })),
    style: { '--pipe-list-width': `${sizes.list}px`, '--pipe-panel-width': `${sizes.panel}px` } as CSSProperties
  }
}

export function PaneDivider({ axis = 'x', side, value, min, max, initial, label, onChange, className = '' }: {
  axis?: 'x' | 'y'; side: 'before' | 'after'; value: number; min: number; max: number; initial: number
  label: string; onChange: (value: number) => void; className?: string
}) {
  const drag = useRef<{ id: number; start: number; size: number; cursor: string; select: string } | null>(null)
  const latest = useRef({ onChange, min, max }); latest.current = { onChange, min, max }
  const direction = side === 'before' ? 1 : -1
  useEffect(() => {
    const finish = () => {
      if (!drag.current) return
      document.body.style.cursor = drag.current.cursor
      document.body.style.userSelect = drag.current.select
      drag.current = null
    }
    const move = (event: PointerEvent) => {
      const current = drag.current
      if (!current || current.id !== event.pointerId) return
      event.preventDefault()
      latest.current.onChange(clamp(current.size + ((axis === 'x' ? event.clientX : event.clientY) - current.start) * direction, latest.current.min, latest.current.max))
    }
    const end = (event: PointerEvent) => { if (drag.current?.id === event.pointerId) finish() }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', finish)
    return () => {
      finish()
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end); window.removeEventListener('blur', finish)
    }
  }, [axis, direction])
  return <div className={`pipe-divider ${axis === 'y' ? 'horizontal' : 'vertical'} ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    title={`${label} · 드래그로 조절, 더블클릭으로 초기화`}
    onDoubleClick={() => onChange(initial)}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return
      event.preventDefault(); event.currentTarget.focus()
      const element = side === 'before' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling
      const bounds = element?.getBoundingClientRect(), size = axis === 'x' ? bounds?.width : bounds?.height
      drag.current = { id: event.pointerId, start: axis === 'x' ? event.clientX : event.clientY, size: size || value, cursor: document.body.style.cursor, select: document.body.style.userSelect }
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'; document.body.style.userSelect = 'none'
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }}
    onKeyDown={(event) => {
      const delta = axis === 'x' ? ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[event.key] : ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[event.key]
      if (!delta) return
      event.preventDefault(); onChange(clamp(value + delta * direction * (event.shiftKey ? 50 : 10), min, max))
    }} />
}
