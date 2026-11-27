import { showImagePreview } from './imagePreview'

export function addImageControls(image: HTMLImageElement, edit: (() => void) | undefined, resize: ((width: number | null) => void) | undefined, measure: () => void): HTMLElement {
  const frame = document.createElement('span'), toolbar = document.createElement('span'), surface = document.createElement('span')
  frame.className = 'md-image-frame'; frame.contentEditable = 'false'; frame.tabIndex = 0
  frame.setAttribute('role', 'group'); frame.setAttribute('aria-label', `사진: ${image.alt || '이미지'}`)
  const originalWidth = image.getAttribute('width')
  if (originalWidth && /^\d+$/.test(originalWidth)) frame.style.width = `${originalWidth}px`
  image.before(frame); surface.className = 'md-image-surface'; surface.append(image); frame.append(surface); image.tabIndex = -1; image.draggable = false
  image.title = '모서리를 끌어 크기 조절 · 더블클릭해서 크게 보기'
  toolbar.className = 'md-image-tools'; frame.append(toolbar)
  const button = (label: string, run: () => void) => {
    const item = document.createElement('button'); item.type = 'button'; item.textContent = label
    item.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); run() }); toolbar.append(item)
  }
  button('크게 보기', () => showImagePreview(image))
  if (edit) button('설명·경로 편집', edit)
  if (resize) button('크기 초기화', () => resize(null))
  const select = () => {
    frame.closest('.cm-content')?.querySelectorAll('.md-image-frame.selected').forEach((other) => other.classList.remove('selected'))
    frame.classList.add('selected'); frame.focus({ preventScroll: true }); measure()
  }
  frame.addEventListener('mousedown', (event) => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); select() } })
  image.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); showImagePreview(image) })
  frame.addEventListener('keydown', (event) => {
    if (event.target === frame && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showImagePreview(image) }
  })
  if (!resize) return frame
  let drag: { id: number; x: number; y: number; width: number; ratio: number; sx: number; sy: number; previous: string; next: number } | undefined
  const clamp = (width: number) => Math.round(Math.max(24, Math.min(10000, frame.closest('.cm-content')?.clientWidth ?? 10000, width)))
  const cancel = () => { if (drag) { frame.style.width = drag.previous; drag = undefined; frame.classList.remove('resizing'); measure() } }
  for (const [corner, sx, sy] of [['nw', -1, -1], ['ne', 1, -1], ['sw', -1, 1], ['se', 1, 1]] as const) {
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = `md-image-handle ${corner}`
    handle.setAttribute('aria-label', `사진 크기 조절 ${corner}`)
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !image.naturalWidth) return
      event.preventDefault(); event.stopPropagation(); select(); frame.setPointerCapture(event.pointerId)
      const rect = image.getBoundingClientRect()
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, ratio: rect.width / rect.height, sx, sy, previous: frame.style.width, next: rect.width }
      frame.classList.add('resizing')
    })
    handle.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(clamp(image.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 10 : -10))) }
    })
    surface.append(handle)
  }
  frame.addEventListener('pointermove', (event) => {
    if (!drag) return
    const x = (event.clientX - drag.x) * drag.sx, y = (event.clientY - drag.y) * drag.sy * drag.ratio
    drag.next = clamp(drag.width + (Math.abs(x) >= Math.abs(y) ? x : y)); frame.style.width = `${drag.next}px`; measure()
  })
  frame.addEventListener('pointerup', (event) => {
    if (!drag) return
    const { next, width } = drag; drag = undefined; frame.classList.remove('resizing'); frame.releasePointerCapture(event.pointerId)
    if (Math.abs(next - width) >= 1) resize(next)
  })
  frame.addEventListener('pointercancel', cancel)
  frame.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancel() } })
  return frame
}
