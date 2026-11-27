/** 문서 크기를 바꾸지 않고 원본을 확대한다. native dialog가 포커스와 Escape를 처리한다. */
export function showImagePreview(original: HTMLImageElement): void {
  if (!original.naturalWidth) return
  const previous = document.activeElement
  const dialog = document.createElement('dialog')
  dialog.className = 'image-preview'
  dialog.setAttribute('aria-label', '사진 크게 보기')
  const toolbar = document.createElement('header'), title = document.createElement('span'), percent = document.createElement('output')
  title.textContent = original.alt || '사진'
  toolbar.append(title)
  const viewport = document.createElement('div'), stage = document.createElement('div'), image = document.createElement('img')
  viewport.className = 'image-preview-viewport'; stage.className = 'image-preview-stage'
  image.src = original.currentSrc || original.src; image.alt = original.alt; image.draggable = false
  stage.append(image); viewport.append(stage)
  let scale = 1
  const setScale = (next: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) => {
    const beforeWidth = original.naturalWidth * scale, beforeHeight = original.naturalHeight * scale
    const px = (viewport.scrollLeft + x - Math.max(0, (viewport.clientWidth - beforeWidth) / 2)) / scale
    const py = (viewport.scrollTop + y - Math.max(0, (viewport.clientHeight - beforeHeight) / 2)) / scale
    scale = Math.max(0.05, Math.min(8, next))
    image.style.width = `${original.naturalWidth * scale}px`; image.style.height = `${original.naturalHeight * scale}px`
    stage.style.width = `${Math.max(viewport.clientWidth, original.naturalWidth * scale)}px`
    stage.style.height = `${Math.max(viewport.clientHeight, original.naturalHeight * scale)}px`
    viewport.scrollLeft = px * scale + Math.max(0, (viewport.clientWidth - original.naturalWidth * scale) / 2) - x
    viewport.scrollTop = py * scale + Math.max(0, (viewport.clientHeight - original.naturalHeight * scale) / 2) - y
    percent.textContent = `${Math.round(scale * 100)}%`
  }
  const fit = () => setScale(Math.min(1, viewport.clientWidth / original.naturalWidth, viewport.clientHeight / original.naturalHeight))
  const button = (label: string, run: () => void) => {
    const item = document.createElement('button'); item.type = 'button'; item.textContent = label
    item.addEventListener('click', run); toolbar.append(item)
  }
  button('축소', () => setScale(scale / 1.25)); toolbar.append(percent)
  button('확대', () => setScale(scale * 1.25)); button('원본 100%', () => setScale(1)); button('화면에 맞추기', fit)
  button('닫기', () => dialog.close())
  dialog.append(toolbar, viewport); document.body.append(dialog)
  const controller = new AbortController(), options = { signal: controller.signal }
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    setScale(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - rect.left, event.clientY - rect.top)
  }, { ...options, passive: false })
  let drag: { x: number; y: number; left: number; top: number } | undefined
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault(); viewport.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
    viewport.classList.add('panning')
  }, options)
  viewport.addEventListener('pointermove', (event) => {
    if (drag) { viewport.scrollLeft = drag.left + drag.x - event.clientX; viewport.scrollTop = drag.top + drag.y - event.clientY }
  }, options)
  const end = () => { drag = undefined; viewport.classList.remove('panning') }
  viewport.addEventListener('pointerup', end, options); viewport.addEventListener('pointercancel', end, options)
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.stopPropagation()
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); setScale(scale * 1.25) }
    else if (event.key === '-') { event.preventDefault(); setScale(scale / 1.25) }
    else if (event.key === '0') { event.preventDefault(); setScale(1) }
  }, options)
  window.addEventListener('resize', fit, options)
  dialog.addEventListener('close', () => { controller.abort(); dialog.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }, { once: true })
  dialog.showModal(); fit()
}
