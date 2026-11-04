import { useEffect, useId, useRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Annotation, EditorState, StateEffect, StateField, Transaction, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { Markdown } from './Markdown'

const focusChanged = StateEffect.define<boolean>()
const externalChange = Annotation.define<boolean>()

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
  constructor(readonly from: number, readonly checked: boolean, readonly label: string) { super() }
  eq(other: TaskBox) { return this.from === other.from && this.checked === other.checked && this.label === other.label }
  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'cm-md-task-box'
    input.checked = this.checked
    input.setAttribute('aria-label', `완료 조건: ${this.label}`)
    input.addEventListener('mousedown', (event) => event.preventDefault())
    input.addEventListener('click', (event) => {
      event.stopPropagation()
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
  constructor(readonly from: number, readonly source: string, readonly block: boolean, readonly cells: number[][] = []) { super() }
  eq(other: MarkdownBlock) { return this.from === other.from && this.source === other.source && this.block === other.block }
  toDOM(view: EditorView) {
    const dom: HTMLElement = document.createElement(this.block ? 'div' : 'span')
    dom.className = this.block ? 'cm-md-block' : 'cm-md-image'
    // 기존 Markdown의 HTML·URL 정제를 그대로 사용한다. 원문은 이 HTML로 역변환하지 않는다.
    dom.innerHTML = renderToStaticMarkup(<Markdown source={this.source} />)
    dom.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const cell = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td,th') : null
      const row = cell?.parentElement as HTMLTableRowElement | null
      const anchor = row && cell ? this.cells[row.rowIndex]?.[cell.cellIndex] ?? this.from : this.from
      view.dispatch({ selection: { anchor }, effects: focusChanged.of(true) })
      view.focus()
    })
    dom.addEventListener('click', (event) => event.preventDefault())
    for (const img of dom.querySelectorAll('img')) img.addEventListener('load', () => view.requestMeasure(), { once: true })
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
  tree.iterate({ enter(ref) {
    const { from, to, name } = ref, node = ref.node, parent = node.parent
    const source = () => state.doc.sliceString(from, to)
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
    if (heading) line(from, `cm-md-heading cm-md-h${heading[1]}`)
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
        const cells: number[][] = []
        for (let row = node.firstChild; row; row = row.nextSibling) {
          if (row.name === 'TableHeader' || row.name === 'TableRow') cells.push(row.getChildren('TableCell').map((cell) => cell.from))
        }
        replace(from, to, new MarkdownBlock(from, source(), name !== 'Image', cells), name !== 'Image')
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
    if (name === 'Link') {
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
      if (!active(from, to)) replace(from, to, new TaskBox(from, checked, state.doc.sliceString(to, end).trim()))
      if (checked && parent) mark(to, parent.to, 'cm-md-checked')
    }
  } })
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true), focused }
}

const presentation = StateField.define<Presentation>({
  create: (state) => present(state, false),
  update(value, tr) {
    const focused = tr.effects.find((effect) => effect.is(focusChanged))?.value ?? value.focused
    return tr.docChanged || tr.selection || focused !== value.focused || syntaxTree(tr.state) !== syntaxTree(tr.startState)
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

export function LiveMarkdownEditor({ value, onChange, label = '세부 내용' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const id = useId(), host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null)
  const change = useRef(onChange); change.current = onChange
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: [
        liveMarkdown(),
        ...(value.includes('\r\n') ? [EditorState.lineSeparator.of('\r\n')] : []),
        placeholder('여기에 바로 작성하세요. 완료 조건은 - [ ] 항목으로 추가합니다.'),
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
  return <div className="live-markdown"><label htmlFor={id} className="small muted">{label}</label><div className="live-markdown-host" ref={host} /></div>
}
