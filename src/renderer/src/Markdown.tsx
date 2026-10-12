import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { canSerialize, serializeBlock } from './mdSerialize'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

// md 안의 <br> 등 기본 HTML은 살리고, 스크립트 같은 위험한 요소는 걸러낸다.
// wiki: (위키링크), term: (Drift 용어 강조) 링크는 앱 내부 이동용으로 허용한다.
const schema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), 'wiki', 'term'] }
}

const INTERNAL = /^(wiki|term):/

function prepare(src: string, terms?: { title: string; id: string }[]): string {
  let s = src
    .replace(/[ \t]*\{#[\w-]+\}/g, '') // 헤딩의 {#s1} 앵커 표기는 숨긴다
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => `[${(label || target).trim()}](wiki:${encodeURIComponent(target.trim())})`)
  if (terms?.length) {
    const sorted = [...terms].filter((t) => t.title.length > 1).sort((a, b) => b.title.length - a.title.length)
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(${sorted.map((t) => esc(t.title)).join('|')})`, 'g')
    // 코드 블록 안은 건드리지 않는다
    s = s
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(re, (m) => `[${m}](term:${sorted.find((t) => t.title === m)!.id})`)))
      .join('')
  }
  return s
}

export interface MarkdownProps {
  source: string
  onWiki?: (target: string) => void
  onTerm?: (domainId: string) => void
  terms?: { title: string; id: string }[]
  className?: string
}

export function Markdown({ source, onWiki, onTerm, terms, className = '' }: MarkdownProps) {
  if (!source.trim()) return <div className={`md empty-md ${className}`}>(내용 없음)</div>
  return (
    <div className={`md ${className}`}>
      <MdContent source={source} onWiki={onWiki} onTerm={onTerm} terms={terms} />
    </div>
  )
}

/** 감싸는 .md 없이 렌더링만 한다. 블록 단위로 나눠 그릴 때 쓴다. */
export function MdContent({ source, onWiki, onTerm, terms }: Omit<MarkdownProps, 'className'>) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
      urlTransform={(url) => (INTERNAL.test(url) ? url : defaultUrlTransform(url))}
      components={{
        a: ({ href = '', children }) => {
          if (href.startsWith('wiki:')) {
            const target = decodeURIComponent(href.slice(5))
            return (
              <button className="wikilink" title={`[[${target}]]`} contentEditable={false} onClick={() => onWiki?.(target)}>
                {children}
              </button>
            )
          }
          if (href.startsWith('term:')) {
            return <mark onClick={() => onTerm?.(href.slice(5))}>{children}</mark>
          }
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        },
        table: ({ children }) => (
          <div className="md-table">
            <table>{children}</table>
          </div>
        )
      }}
    >
      {prepare(source, terms)}
    </ReactMarkdown>
  )
}

/** 원문을 빈 줄 기준 블록으로 나눈다. 코드 펜스 안의 빈 줄은 나누지 않는다. joinBlocks로 합치면 원문과 똑같다. */
export function splitBlocks(src: string): { text: string; sep: string }[] {
  // 각 줄의 [시작, 끝) 위치와, 블록을 끊는 빈 줄인지
  const lines: { start: number; end: number; brk: boolean }[] = []
  let fence: string | null = null
  let pos = 0
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    let brk = false
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
    } else if (!line.trim()) brk = true
    else if (m) fence = m[1]
    lines.push({ start: pos, end: pos + line.length, brk })
    pos += line.length + 1
  }
  const runs: { start: number; end: number }[] = []
  lines.forEach((l, i) => {
    if (l.brk) return
    const last = runs[runs.length - 1]
    if (last && i > 0 && !lines[i - 1].brk) last.end = l.end
    else runs.push({ start: l.start, end: l.end })
  })
  const out: { text: string; sep: string }[] = []
  if (!runs.length) return src ? [{ text: '', sep: src }] : []
  if (runs[0].start > 0) out.push({ text: '', sep: src.slice(0, runs[0].start) })
  runs.forEach((r, i) => out.push({ text: src.slice(r.start, r.end), sep: src.slice(r.end, runs[i + 1]?.start ?? src.length) }))
  return out
}

export function joinBlocks(blocks: { text: string; sep: string }[]): string {
  return blocks.map((b) => b.text + b.sep).join('')
}

/* ---------- 보기 모양 그대로 고치는 편집기 ---------- */

interface Item {
  id: number
  /** 지금 md */
  text: string
  /** 블록 뒤 빈 줄 */
  sep: string
  /** 화면에 그려 둔 md. 고치는 동안에는 바꾸지 않는다 (React가 사람이 고친 DOM을 건드리지 않게) */
  shown: string
}

let nextId = 1
const toItems = (src: string): Item[] => splitBlocks(src).map((b) => ({ id: nextId++, text: b.text, sep: b.sep, shown: b.text }))
const joinItems = (items: Item[]) => joinBlocks(items)

/** 그려 둔 md가 같으면 다시 그리지 않는다 */
const FrozenContent = memo(
  function FrozenContent({ source, onWiki }: { source: string; onWiki: (t: string) => void }) {
    return <MdContent source={source} onWiki={onWiki} />
  },
  (a, b) => a.source === b.source
)

/** 커서가 블록 맨 앞/맨 뒤에 있는가 (글자 기준) */
function caretAt(el: HTMLElement, where: 'start' | 'end'): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false
  const r = sel.getRangeAt(0)
  const probe = document.createRange()
  probe.selectNodeContents(el)
  if (where === 'start') probe.setEnd(r.startContainer, r.startOffset)
  else probe.setStart(r.endContainer, r.endOffset)
  return probe.toString().length === 0
}

function placeCaret(el: HTMLElement, where: 'start' | 'end') {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(where === 'start')
  sel.removeAllRanges()
  sel.addRange(r)
}

/**
 * 렌더링된 모양 그대로 글자를 고친다. 블록(빈 줄로 나뉜 md 덩어리)마다 고칠 수 있는 영역이고,
 * 고친 블록만 md로 되돌린다(mdSerialize). 되돌릴 수 없는 HTML 블록은 누르면 원문을 고친다.
 * Enter: 새 단락 · Shift+Enter: 줄바꿈 · ↑↓: 블록 이동 · Esc: 편집 끝.
 */
function LiveMarkdown({ value, onChange, onWiki }: { value: string; onChange: (v: string) => void; onWiki?: (t: string) => void }) {
  const [items, setItems] = useState<Item[]>(() => toItems(value))
  const emitted = useRef(value)
  const refs = useRef(new Map<number, HTMLDivElement>())
  const focusNext = useRef<{ id: number; where: 'start' | 'end' } | null>(null)
  const wikiRef = useRef(onWiki)
  wikiRef.current = onWiki
  const wiki = useCallback((t: string) => wikiRef.current?.(t), [])

  // 바깥에서 내용이 바뀌면(다른 문서를 열거나 저장 후 다시 읽음) 새로 나눈다
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value
      setItems(toItems(value))
    }
  }, [value])

  useLayoutEffect(() => {
    const f = focusNext.current
    if (!f) return
    focusNext.current = null
    const el = refs.current.get(f.id)
    if (el) placeCaret(el, f.where)
  })

  const commit = (next: Item[]) => {
    setItems(next)
    const joined = joinItems(next)
    if (joined !== emitted.current) {
      emitted.current = joined
      onChange(joined)
    }
  }
  const indexOf = (id: number) => items.findIndex((x) => x.id === id)

  /** 글자를 칠 때: 이 블록만 md로 되돌려 반영한다. 화면은 그대로 둔다. */
  const input = (id: number) => {
    const el = refs.current.get(id)
    const i = indexOf(id)
    if (!el || i < 0) return
    const text = serializeBlock(el, items[i].shown)
    if (text === null || text === items[i].text) return
    commit(items.map((x) => (x.id === id ? { ...x, text } : x)))
  }

  /** 블록을 떠날 때: 바뀐 블록은 새 md로 다시 그린다. 비었으면 지우고, 빈 줄이 생겼으면 블록을 나눈다. */
  const settle = (id: number) => {
    const i = indexOf(id)
    if (i < 0) return
    const it = items[i]
    if (it.text === it.shown) return
    const next = [...items]
    if (!it.text.trim()) {
      next.splice(i, 1)
      if (i === next.length && i > 0) next[i - 1] = { ...next[i - 1], sep: it.sep }
    } else {
      const parts = toItems(it.text)
      parts[parts.length - 1].sep = it.sep
      next.splice(i, 1, ...parts)
    }
    commit(next)
  }

  /** Enter: 커서 뒤 내용을 새 단락으로 떼어 낸다 */
  const split = (id: number) => {
    const el = refs.current.get(id)
    const sel = window.getSelection()
    const i = indexOf(id)
    if (!el || !sel || !sel.rangeCount || i < 0) return
    const r = sel.getRangeAt(0)
    r.deleteContents()
    const tail = document.createRange()
    tail.setStart(r.endContainer, r.endOffset)
    tail.setEnd(el, el.childNodes.length)
    const box = document.createElement('div')
    box.appendChild(tail.extractContents())
    // 제목 끝에서 Enter를 치면 다음 줄은 보통 단락이다
    const head = box.firstElementChild
    if (head && /^H[1-6]$/.test(head.tagName)) {
      const p = document.createElement('p')
      p.append(...Array.from(head.childNodes))
      head.replaceWith(p)
    }
    const before = serializeBlock(el, items[i].shown) ?? items[i].text
    const after = serializeBlock(box) ?? ''
    const created: Item = { id: nextId++, text: after, sep: items[i].sep, shown: after }
    const next = [...items]
    next.splice(i, 1, { id: nextId++, text: before, sep: '\n\n', shown: before }, created)
    focusNext.current = { id: created.id, where: 'start' }
    commit(next)
  }

  const remove = (id: number) => {
    const i = indexOf(id)
    if (i < 0) return
    const next = [...items]
    const [gone] = next.splice(i, 1)
    if (i === next.length && i > 0) next[i - 1] = { ...next[i - 1], sep: gone.sep }
    if (i > 0) focusNext.current = { id: next[i - 1].id, where: 'end' }
    commit(next)
  }

  const key = (e: React.KeyboardEvent<HTMLDivElement>, id: number) => {
    // 한글 조합 중의 Enter·화살표는 조합을 끝내는 키다
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const i = indexOf(id)
    const inside = (window.getSelection()?.anchorNode as Node | null)?.parentElement?.closest('li, td, th, pre, blockquote')
    if (e.key === 'Escape') {
      e.preventDefault()
      el.blur()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      document.execCommand('insertLineBreak')
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (inside?.matches('pre')) {
        e.preventDefault()
        document.execCommand('insertText', false, '\n')
      } else if (inside?.matches('td, th')) {
        e.preventDefault()
        document.execCommand('insertLineBreak')
      } else if (!inside) {
        e.preventDefault()
        split(id)
      }
      // 목록·인용 안에서는 브라우저 기본 동작(새 항목·새 줄)
    } else if (e.key === 'Backspace' && !(el.textContent ?? '').length && !el.querySelector('hr, img, table')) {
      e.preventDefault()
      remove(id)
    } else if (e.key === 'ArrowUp' && i > 0 && caretAt(el, 'start')) {
      e.preventDefault()
      refs.current.get(items[i - 1].id) && placeCaret(refs.current.get(items[i - 1].id)!, 'end')
    } else if (e.key === 'ArrowDown' && i < items.length - 1 && caretAt(el, 'end')) {
      e.preventDefault()
      refs.current.get(items[i + 1].id) && placeCaret(refs.current.get(items[i + 1].id)!, 'start')
    }
  }

  const append = () => {
    const next = [...items]
    const last = next[next.length - 1]
    if (last) next[next.length - 1] = { ...last, sep: last.sep.replace(/\n*$/, '') + '\n\n' }
    const created: Item = { id: nextId++, text: '', sep: value.endsWith('\n') ? '\n' : '', shown: '' }
    next.push(created)
    focusNext.current = { id: created.id, where: 'start' }
    setItems(next)
  }

  return (
    <div className="md live-md">
      {items.map((it) => (
        <Block
          key={it.id}
          item={it}
          setRef={(el) => (el ? refs.current.set(it.id, el) : refs.current.delete(it.id))}
          onWiki={wiki}
          onInput={() => input(it.id)}
          onSettle={() => settle(it.id)}
          onKey={(e) => key(e, it.id)}
          onRaw={(text) => commit(items.map((x) => (x.id === it.id ? { ...x, text } : x)))}
        />
      ))}
      <div className="md-add" onClick={append}>
        {value.trim() ? '+ 단락 추가' : '눌러서 작성'}
      </div>
    </div>
  )
}

function Block(props: {
  item: Item
  setRef: (el: HTMLDivElement | null) => void
  onWiki: (t: string) => void
  onInput: () => void
  onSettle: () => void
  onKey: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onRaw: (text: string) => void
}) {
  const { item } = props
  const ref = useRef<HTMLDivElement | null>(null)
  // 화면을 md로 되돌릴 수 있는 블록만 그 자리에서 고친다
  const [editable, setEditable] = useState(true)
  const [raw, setRaw] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (ref.current) setEditable(canSerialize(ref.current))
  }, [item.shown])
  useEffect(() => {
    const el = area.current
    if (!raw || !el) return
    el.focus()
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [raw])

  if (raw) {
    return (
      <textarea
        ref={area}
        className="mono md-live-input"
        value={item.text}
        spellCheck={false}
        onChange={(e) => {
          props.onRaw(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${e.target.scrollHeight + 2}px`
        }}
        onBlur={() => {
          setRaw(false)
          props.onSettle()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
    )
  }
  return (
    <div
      ref={(el) => {
        ref.current = el
        props.setRef(el)
      }}
      className={`md-block ${editable ? '' : 'raw-only'}`}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="여기에 입력"
      onInput={props.onInput}
      onBlur={props.onSettle}
      onKeyDown={props.onKey}
      onPaste={(e) => {
        // 서식 없는 글자로만 붙여 넣는다
        e.preventDefault()
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
      }}
      onClick={(e) => {
        if (editable || (e.target as HTMLElement).closest('a, button, mark, input') || window.getSelection()?.toString()) return
        setRaw(true)
      }}
    >
      <FrozenContent source={item.shown} onWiki={props.onWiki} />
    </div>
  )
}

/** md 편집기: 보기 모양 그대로 고친다. */
export function MdEditor({ value, onChange, onWiki, label }: { value: string; onChange: (v: string) => void; onWiki?: (t: string) => void; label?: string }) {
  return (
    <div className="md-editor">
      {label && <div className="md-editor-label muted small">{label}</div>}
      <div className="md-scroll">
        <LiveMarkdown value={value} onChange={onChange} onWiki={onWiki} />
      </div>
    </div>
  )
}

/** 읽기 전용: 렌더링 / 원문 전환. */
export function MdViewer({ source, onWiki }: { source: string; onWiki?: (t: string) => void }) {
  const [raw, setRaw] = useState(false)
  return (
    <div className="md-viewer">
      <div className="row end">
        <div className="seg small">
          <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>
            보기
          </button>
          <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
            원문
          </button>
        </div>
      </div>
      {raw ? <pre className="doc">{source}</pre> : <div className="md-scroll bordered"><Markdown source={source} onWiki={onWiki} /></div>}
    </div>
  )
}
