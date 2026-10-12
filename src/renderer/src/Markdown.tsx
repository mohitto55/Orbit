import { useState } from 'react'
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
    </div>
  )
}

type Mode = 'view' | 'edit' | 'split'

/** md 편집기: 보기(기본) / 편집 / 나란히. */
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
          <div className="md-scroll" onDoubleClick={() => mode === 'view' && setMode('split')} title={mode === 'view' ? '더블클릭하면 편집' : undefined}>
            <Markdown source={value} onWiki={onWiki} />
          </div>
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
