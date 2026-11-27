import { useEffect, useId, useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Annotation, Compartment, EditorState, Facet, StateEffect, StateField, Transaction, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { Markdown } from './Markdown'
import { api } from './api'
import { errorToast } from './ui'
import { addImageControls } from './imageControls'
import { resizeImageMarkup } from './markdownImages'

const focusChanged = StateEffect.define<boolean>()
const externalChange = Annotation.define<boolean>()
const wikiNavigation = Facet.define<(target: string) => void>()
const documentLocation = Facet.define<string, string>({ combine: (values) => values[0] ?? '' })
const attachmentAt = StateEffect.define<number | null>()
const attachmentPosition = StateField.define<number | null>({
  create: () => null,
  update: (position, tr) => {
    if (tr.annotation(externalChange)) return null
    const effect = tr.effects.find((item) => item.is(attachmentAt))
    return effect ? effect.value : position === null ? null : tr.changes.mapPos(position, 1)
  }
})

function followWiki(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-wiki]')?.dataset.wiki : undefined
  if (!target) return false
  event.preventDefault()
  view.state.facet(wikiNavigation)[0]?.(target)
  return true
}

class Bullet extends WidgetType {
  eq() { return true }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-bullet'
    span.textContent = '•'
    return span
  }
}

class TaskBox extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean, readonly label: string, readonly disabled: boolean) { super() }
  eq(other: TaskBox) { return this.from === other.from && this.checked === other.checked && this.label === other.label && this.disabled === other.disabled }
  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'cm-md-task-box'
    input.checked = this.checked
    input.disabled = this.disabled
    input.setAttribute('aria-label', `완료 조건: ${this.label}`)
    input.addEventListener('mousedown', (event) => event.preventDefault())
    input.addEventListener('click', (event) => {
      event.stopPropagation()
      if (view.state.readOnly) { event.preventDefault(); return }
      if (!/^\[[ xX]\]$/.test(view.state.doc.sliceString(this.from, this.from + 3))) return
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' },
        annotations: [Transaction.userEvent.of('input.check'), isolateHistory.of('full')]
      })
    })
    return input
  }
  ignoreEvent() { return true }
}

/** 표·이미지도 같은 문서 안에 표시하며 클릭한 위치에서 원문 편집으로 이어진다. */
class MarkdownBlock extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly source: string, readonly block: boolean, readonly cells: number[][], readonly documentPath: string, readonly references: string) { super() }
  eq(other: MarkdownBlock) {
    return this.from === other.from && this.to === other.to && this.source === other.source && this.block === other.block && this.documentPath === other.documentPath && this.references === other.references
      && this.cells.length === other.cells.length && this.cells.every((row, i) => row.length === other.cells[i].length && row.every((position, j) => position === other.cells[i][j]))
  }
  toDOM(view: EditorView) {
    const dom: HTMLElement = document.createElement(this.block ? 'div' : 'span')
    dom.className = this.block ? 'cm-md-block' : 'cm-md-image'
    // 기존 Markdown의 HTML·URL 정제를 그대로 사용한다. 원문은 이 HTML로 역변환하지 않는다.
    dom.innerHTML = renderToStaticMarkup(<Markdown source={this.source + this.references} documentPath={this.documentPath} />)
    dom.addEventListener('mousedown', (event) => {
      if (followWiki(event, view)) return
      if (event.button !== 0) return
      event.preventDefault()
      const cell = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td,th') : null
      const row = cell?.parentElement as HTMLTableRowElement | null
      const anchor = row && cell ? this.cells[row.rowIndex]?.[cell.cellIndex] ?? this.from : this.from
      view.dispatch({ selection: { anchor }, effects: focusChanged.of(true) })
      view.focus()
    })
    dom.addEventListener('click', (event) => event.preventDefault())
    let imageEnd = 0
    const original = view.state.doc.sliceString(this.from, this.to)
    for (const img of dom.querySelectorAll('img')) {
      const markup = img.dataset.markdownImage ?? '', offset = markup ? original.indexOf(markup, imageEnd) : -1
      const from = this.from + Math.max(0, offset), to = from + markup.length
      if (offset >= 0) imageEnd = offset + markup.length
      const edit = () => { view.dispatch({ selection: { anchor: from }, effects: focusChanged.of(true) }); view.focus() }
      const keepSelected = (action: () => void) => {
        const imageIndex = [...view.dom.querySelectorAll<HTMLImageElement>('img')].indexOf(img)
        action(); view.requestMeasure()
        const next = view.dom.querySelectorAll<HTMLImageElement>('img')[imageIndex]?.closest<HTMLElement>('.md-image-frame')
        next?.classList.add('selected'); next?.focus({ preventScroll: true })
      }
      const resize = offset < 0 || view.state.readOnly ? undefined : (width: number | null) => {
        if (view.state.readOnly || view.state.doc.sliceString(from, to) !== markup) return
        const insert = resizeImageMarkup(markup, width, this.cells.length > 0)
        if (insert === markup) return
        keepSelected(() => view.dispatch({ changes: { from, to, insert }, annotations: [Transaction.userEvent.of('input.resize'), isolateHistory.of('full')] }))
      }
      const frame = addImageControls(img, view.state.readOnly ? undefined : edit, resize, () => view.requestMeasure())
      frame.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || view.state.readOnly) return
        const key = event.key.toLowerCase()
        if (key !== 'z' && key !== 'y') return
        event.preventDefault(); event.stopPropagation()
        keepSelected(() => { (key === 'y' || event.shiftKey ? redo : undo)(view) })
      })
      img.addEventListener('load', () => view.requestMeasure(), { once: true })
      img.addEventListener('error', () => {
        const message = document.createElement('span')
        message.className = 'cm-md-image-error'
        message.textContent = `이미지를 불러올 수 없습니다${img.alt ? ` (${img.alt})` : ''} · 클릭해서 경로 수정`
        frame.replaceWith(message)
        view.requestMeasure()
      }, { once: true })
    }
    return dom
  }
  ignoreEvent() { return true }
}

type Presentation = { decorations: DecorationSet; atomic: DecorationSet; focused: boolean }

function present(state: EditorState, focused: boolean): Presentation {
  const ranges: Range<Decoration>[] = [], atomic: Range<Decoration>[] = []
  const active = (from: number, to: number) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from)
  const mark = (from: number, to: number, className: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to))
  }
  const line = (from: number, className: string) => ranges.push(Decoration.line({ class: className }).range(state.doc.lineAt(from).from))
  const replace = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (from >= to) return
    const range = Decoration.replace({ widget, block }).range(from, to)
    ranges.push(range); atomic.push(range)
  }
  const tree = ensureSyntaxTree(state, state.doc.length, 30) ?? syntaxTree(state)
  const definitions: string[] = []
  tree.iterate({ enter(ref) { if (ref.name === 'LinkReference') { definitions.push(state.doc.sliceString(ref.from, ref.to)); return false } } })
  const references = definitions.length ? '\n\n' + definitions.join('\n') : ''
  tree.iterate({ enter(ref) {
    const { from, to, name } = ref, node = ref.node, parent = node.parent
    const source = () => state.doc.sliceString(from, to)
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
    if (heading) {
      line(from, `cm-md-heading cm-md-h${heading[1]}`)
      const anchor = /[ \t]*\{#[\w-]+\}$/.exec(source())
      if (anchor && !active(from, to)) replace(to - anchor[0].length, to)
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      const first = state.doc.lineAt(from), last = state.doc.lineAt(to)
      const closing = node.lastChild?.name === 'CodeMark' ? node.lastChild.from : -1
      for (let n = first.number; n <= last.number; n++) {
        const codeLine = state.doc.line(n)
        const fence = name === 'FencedCode' && (n === first.number || (closing >= 0 && n === state.doc.lineAt(closing).number))
        line(codeLine.from, `cm-md-code${fence ? ` cm-md-fence${active(from, to) ? '' : ' cm-md-fence-hidden'}` : ''}`)
      }
      return false
    }
    if (name === 'Table' || name === 'HTMLBlock' || name === 'HorizontalRule' || name === 'Image') {
      if (!active(from, to)) {
        const cells: number[][] = [], rows: string[] = []
        for (let row = node.firstChild; row; row = row.nextSibling) {
          if (row.name === 'TableHeader' || row.name === 'TableRow') cells.push(row.getChildren('TableCell').map((cell) => cell.from))
          // Each row starts after its quote/list prefix. Slicing the whole table
          // leaves later lines' `> ` prefixes inside the standalone Markdown.
          if (row.name === 'TableHeader' || row.name === 'TableDelimiter' || row.name === 'TableRow') rows.push(state.doc.sliceString(row.from, row.to))
        }
        replace(from, to, new MarkdownBlock(from, to, name === 'Table' ? rows.join('\n') : source(), name !== 'Image', cells, state.facet(documentLocation), references), name !== 'Image')
        return false
      }
      if (name === 'Table') {
        for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) line(state.doc.line(n).from, 'cm-md-table-source')
      }
    }
    const style: Record<string, string> = { StrongEmphasis: 'cm-md-strong', Emphasis: 'cm-md-em', Strikethrough: 'cm-md-strike', InlineCode: 'cm-md-inline-code' }
    if (style[name]) mark(from, to, style[name])
    if (name === 'HeaderMark' && parent) {
      if (active(parent.from, parent.to)) mark(from, to, 'cm-md-format')
      else replace(from, to + (state.doc.sliceString(to, to + 1) === ' ' ? 1 : 0))
    }
    if ((name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark') && parent) {
      if (active(parent.from, parent.to)) mark(from, to, 'cm-md-format')
      else replace(from, to)
    }
    if (name === 'Escape' && !active(from, to)) replace(from, from + 1)
    if (name === 'Autolink') {
      mark(from + 1, to - 1, 'cm-md-link')
      if (!active(from, to)) { replace(from, from + 1); replace(to - 1, to) }
      return false
    }
    if (name === 'URL' && parent && !['Link', 'Image', 'LinkReference'].includes(parent.name)) mark(from, to, 'cm-md-link')
    if (name === 'Link') {
      // Markdown 파서는 [[위키 링크]]의 안쪽 대괄호도 일반 Link로 읽는다.
      if (state.doc.sliceString(Math.max(0, from - 1), from) === '[' && state.doc.sliceString(to, to + 1) === ']') return false
      const marks = node.getChildren('LinkMark'), opening = marks[0]
      const closing = marks.find((m) => state.doc.sliceString(m.from, m.to) === ']')
      if (opening && closing) {
        mark(opening.to, closing.from, 'cm-md-link')
        if (!active(from, to)) { replace(opening.from, opening.to); replace(closing.from, to) }
      }
    }
    if (name === 'QuoteMark') {
      line(from, 'cm-md-quote')
      if (!active(from, to)) replace(from, to + (state.doc.sliceString(to, to + 1) === ' ' ? 1 : 0))
      else mark(from, to, 'cm-md-format')
    }
    if (name === 'ListMark' && parent) {
      if (parent.getChild('Task') && !active(from, to)) replace(from, to + 1)
      else if (parent.parent?.name === 'BulletList' && !active(from, to)) replace(from, to, new Bullet())
      else mark(from, to, 'cm-md-format')
    }
    if (name === 'TaskMarker') {
      const checked = /x/i.test(source()), end = state.doc.lineAt(to).to
      if (!active(from, to)) replace(from, to, new TaskBox(from, checked, state.doc.sliceString(to, end).trim(), state.readOnly))
      if (checked && parent) mark(to, parent.to, 'cm-md-checked')
    }
  } })
  for (const match of state.doc.toString().matchAll(/\[\[([^\[\]\n|]+)(?:\|([^\]\n]*))?\]\]/g)) {
    const from = match.index!, to = from + match[0].length
    let node = tree.resolveInner(from + 2, 1), inLiteral = false
    for (;;) {
      if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'HTMLBlock', 'Table'].includes(node.name) || (node.name === 'Link' && (node.from < from || node.to > to))) { inLiteral = true; break }
      if (!node.parent) break
      node = node.parent
    }
    if (inLiteral) continue
    const aliased = !!match[2], labelFrom = from + 2 + (aliased ? match[1].length + 1 : 0), labelTo = labelFrom + (aliased ? match[2].length : match[1].length)
    ranges.push(Decoration.mark({ class: 'cm-md-link', attributes: { 'data-wiki': match[1].trim(), title: 'Ctrl/⌘+클릭으로 문서 열기' } }).range(labelFrom, labelTo))
    if (!active(from, to)) { replace(from, labelFrom); replace(labelTo, to) }
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true), focused }
}

const presentation = StateField.define<Presentation>({
  create: (state) => present(state, false),
  update(value, tr) {
    const focused = tr.effects.find((effect) => effect.is(focusChanged))?.value ?? value.focused
    return tr.docChanged || tr.selection || tr.reconfigured || focused !== value.focused || syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? present(tr.state, focused) : value
  },
  provide: (field) => [EditorView.decorations.from(field, (value) => value.decorations), EditorView.atomicRanges.of((view) => view.state.field(field).atomic)]
})

/** HTML로 재직렬화하지 않고 Markdown 원문을 편집하므로 빈 줄·표·코드·체크 위치를 보존한다. */
function liveMarkdown() {
  return [
    markdown({ extensions: GFM, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
    history(), keymap.of([
      { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      { key: 'Backspace', run: deleteMarkupBackward },
      ...historyKeymap, ...defaultKeymap, indentWithTab
    ]),
    EditorView.lineWrapping, presentation,
    EditorView.focusChangeEffect.of((_state, focused) => focusChanged.of(focused))
  ]
}

export function LiveMarkdownEditor({ value, onChange, onWiki, documentPath = '', label = '본문', disabled = false, onAttachmentBusyChange }: { value: string; onChange: (value: string) => void; onWiki?: (target: string) => void; documentPath?: string; label?: string; disabled?: boolean; onAttachmentBusyChange?: (busy: boolean) => void }) {
  const id = useId(), host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null)
  const change = useRef(onChange); change.current = onChange
  const wiki = useRef(onWiki); wiki.current = onWiki
  const editability = useRef(new Compartment())
  const location = useRef(new Compartment())
  const [dragging, setDragging] = useState(false), [attaching, setAttaching] = useState(false)
  const uploading = useRef(false), busyChange = useRef(onAttachmentBusyChange); busyChange.current = onAttachmentBusyChange
  const attach = async (files: File[], at?: number) => {
    const view = editor.current
    if (!view || view.state.readOnly || uploading.current) return
    const document = view.state.facet(documentLocation)
    uploading.current = true; setAttaching(true); busyChange.current?.(true)
    view.dispatch({ effects: attachmentAt.of(at ?? view.state.selection.main.head) })
    try {
      if (files.length > 20 || files.some((file) => file.size > 20 * 1024 * 1024) || files.reduce((size, file) => size + file.size, 0) > 100 * 1024 * 1024) throw new Error('사진은 한 번에 20개, 한 장 20MB, 합계 100MB까지 첨부할 수 있습니다')
      const images = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })))
      const markdown = await api.importDocumentImages(images, document)
      if (editor.current !== view || view.state.readOnly || view.state.facet(documentLocation) !== document) return
      const from = view.state.field(attachmentPosition)
      if (from === null) return
      const before = view.state.doc.sliceString(0, from), after = view.state.doc.sliceString(from)
      const insert = (before ? before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n' : '') + markdown + (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n')
      view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length }, effects: attachmentAt.of(null), annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')] })
      view.focus()
    } catch (e) { if (editor.current === view) errorToast(e) }
    finally { uploading.current = false; busyChange.current?.(false); if (editor.current === view) { setAttaching(false); view.dispatch({ effects: attachmentAt.of(null) }) } }
  }
  const drop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    const at = editor.current?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined
    void attach(Array.from(event.dataTransfer.files), at)
  }
  const paste = (event: ClipboardEvent) => {
    if (!event.clipboardData.files.length) return
    event.preventDefault(); event.stopPropagation()
    void attach(Array.from(event.clipboardData.files))
  }
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: [
        liveMarkdown(), attachmentPosition,
        editability.current.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
        location.current.of(documentLocation.of(documentPath)),
        wikiNavigation.of((target) => wiki.current?.(target)),
        EditorView.domEventHandlers({ mousedown: followWiki }),
        ...(value.includes('\r\n') ? [EditorState.lineSeparator.of('\r\n')] : []),
        placeholder('여기에 바로 작성하세요.'),
        EditorView.contentAttributes.of({ id, 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(externalChange))) change.current(update.state.sliceDoc())
        })
      ] })
    })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
    // 같은 편집기를 유지해 커서·한글 조합·실행 취소 기록이 React 재렌더링에도 이어진다.
  }, [])
  useEffect(() => {
    const view = editor.current
    if (view && view.state.sliceDoc() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] })
  }, [value])
  useEffect(() => {
    editor.current?.dispatch({ effects: editability.current.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
  }, [disabled])
  useEffect(() => {
    editor.current?.dispatch({ effects: location.current.reconfigure(documentLocation.of(documentPath)) })
  }, [documentPath])
  return <div className={`live-markdown${dragging ? ' image-drop' : ''}`} aria-disabled={disabled || undefined} aria-busy={attaching}
    onDropCapture={drop} onPasteCapture={paste}
    onDragOverCapture={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled || attaching ? 'none' : 'copy'; setDragging(!disabled && !attaching) } }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}>
    <label htmlFor={id} className="small muted">{label}</label><div className="live-markdown-host" ref={host} />
    {!disabled && <div className="small muted" role={attaching ? 'status' : undefined}>{attaching ? '사진 첨부 중…' : documentPath ? '사진을 끌어 놓거나 붙여넣으세요.' : '사진을 첨부하려면 먼저 문서를 저장하세요.'}</div>}
  </div>
}
