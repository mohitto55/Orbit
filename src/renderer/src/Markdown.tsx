import { useEffect, useRef, useState } from 'react'
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
function MdContent({ source, onWiki, onTerm, terms }: Omit<MarkdownProps, 'className'>) {
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
              <button className="wikilink" title={`[[${target}]]`} onClick={() => onWiki?.(target)}>
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

/** 렌더링된 상태 그대로 블록을 눌러 그 자리에서 고친다. */
function LiveMarkdown({ value, onChange, onWiki }: { value: string; onChange: (v: string) => void; onWiki?: (t: string) => void }) {
  // 편집 중에는 시작 시점의 블록 목록을 고정해, 빈 줄을 쳐도 블록이 쪼개져 커서가 튀지 않게 한다.
  const [editing, setEditing] = useState<{ index: number; blocks: { text: string; sep: string }[]; orig: string; fresh: boolean } | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const blocks = editing?.blocks ?? splitBlocks(value)

  const fit = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }
  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (el && document.activeElement !== el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
    fit()
  }, [editing])

  const start = (index: number, list = splitBlocks(value), fresh = false) => setEditing({ index, blocks: list, orig: value, fresh })
  const finish = () => {
    if (!editing) return
    // 비운 블록은 지운다. 새로 추가했다가 비워 둔 단락이면 원래대로 돌린다.
    const next = editing.blocks.filter((b, i) => i !== editing.index || b.text.trim())
    const joined = editing.fresh && next.length < editing.blocks.length ? editing.orig : joinBlocks(next)
    if (joined !== value) onChange(joined)
    setEditing(null)
  }
  const edit = (text: string) => {
    if (!editing) return
    const next = editing.blocks.map((b, i) => (i === editing.index ? { ...b, text } : b))
    setEditing({ ...editing, blocks: next })
    onChange(joinBlocks(next))
  }
  const append = () => {
    const list = splitBlocks(value)
    if (list.length) list[list.length - 1] = { ...list[list.length - 1], sep: list[list.length - 1].sep.replace(/\n*$/, '') + '\n\n' }
    list.push({ text: '', sep: value.endsWith('\n') ? '\n' : '' })
    start(list.length - 1, list, true)
  }
  const clickBlock = (e: React.MouseEvent, i: number) => {
    // 링크·위키링크·용어 강조를 누른 것은 편집이 아니라 이동이다
    if ((e.target as HTMLElement).closest('a, button, mark, input')) return
    if (window.getSelection()?.toString()) return
    if (editing) finish()
    start(i)
  }

  const visible = blocks.map((b, i) => ({ ...b, i })).filter((b) => b.text || editing?.index === b.i)
  return (
    <div className="md live-md">
      {visible.map((b) =>
        editing?.index === b.i ? (
          <textarea
            key={`e${b.i}`}
            ref={ref}
            className="mono md-live-input"
            value={b.text}
            spellCheck={false}
            onChange={(e) => {
              edit(e.target.value)
              fit()
            }}
            onBlur={finish}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                e.preventDefault()
                finish()
              }
            }}
          />
        ) : (
          <div key={b.i} className="md-block" onClick={(e) => clickBlock(e, b.i)}>
            <MdContent source={b.text} onWiki={onWiki} />
          </div>
        )
      )}
      {!editing && (
        <div className="md-add" onClick={append}>
          {value.trim() ? '+ 단락 추가' : '눌러서 작성'}
        </div>
      )}
    </div>
  )
}

type Mode = 'view' | 'edit' | 'split'

/** md 편집기: 보기(기본, 블록을 눌러 그 자리에서 편집) / 편집 / 나란히. */
export function MdEditor({ value, onChange, onWiki, label }: { value: string; onChange: (v: string) => void; onWiki?: (t: string) => void; label?: string }) {
  const [mode, setMode] = useState<Mode>('view')
  return (
    <div className="md-editor">
      <div className="row between">
        {label ? <span className="muted small">{label}</span> : <span />}
        <div className="seg small">
          {(
            [
              ['view', '보기'],
              ['edit', '편집'],
              ['split', '나란히']
            ] as [Mode, string][]
          ).map(([m, l]) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className={`md-editor-body ${mode}`}>
        {mode !== 'view' && <textarea className="mono" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />}
        {mode !== 'edit' && (
          <div className="md-scroll">{mode === 'view' ? <LiveMarkdown value={value} onChange={onChange} onWiki={onWiki} /> : <Markdown source={value} onWiki={onWiki} />}</div>
        )}
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
