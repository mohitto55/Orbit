import { useEffect, type RefObject } from 'react'
import type { Core } from 'cytoscape'

/**
 * 휠 줌: cytoscape 3.33+는 일반 마우스 휠(한 칸 deltaY=100)을 "부정확한 장치"로 보고 delta를 100으로 나눠
 * 한 칸에 3% 정도만 줌된다. 그래프를 감싼 요소에서 캡처 단계로 먼저 받아 직접 줌한다.
 */
export function useWheelZoom(ref: RefObject<HTMLDivElement>, cy: RefObject<Core | null>) {
  useEffect(() => {
    const wrap = ref.current?.parentElement
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      const c = cy.current
      if (!c || !ref.current || e.deltaY === 0) return
      // 그래프 위에 띄운 노드 추가 메뉴·정보 패널 등에서 굴린 휠은 그 UI를 스크롤하게 둔다
      if (!ref.current.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1)
      // 마우스 한 칸(100) ≈ 1.2배, 터치패드 핀치(ctrl+휠, 작은 delta)는 더 민감하게
      const k = e.ctrlKey ? 0.01 : 0.0018
      const rect = ref.current.getBoundingClientRect()
      c.zoom({
        level: c.zoom() * Math.exp(-delta * k),
        renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top }
      })
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true })
  }, [ref, cy])
}
