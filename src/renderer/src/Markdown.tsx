import { useId, useRef, useState } from 'react'
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
        input: ({ node: _node, checked, ...props }) => <input {...props} checked={checked ?? false} readOnly />,
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

/** 마크다운 원문을 직접 편집한다. 줄바꿈·선택·붙여넣기·실행 취소는 기본 텍스트 입력을 사용한다. */
export function MdEditor({ value, onChange, onWiki, label }: { value: string; onChange: (v: string) => void; onWiki?: (t: string) => void; label?: string }) {
  const [preview, setPreview] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  return (
    <div className="md-editor">
      <div className="row between md-editor-toolbar">
        <label htmlFor={id} className="small muted">{label ?? 'Markdown'}</label>
        <div className="seg small" aria-label={`${label ?? 'Markdown'} 편집 방식`}>
          <button type="button" className={!preview ? 'on' : ''} aria-pressed={!preview} onClick={() => {
            setPreview(false)
            requestAnimationFrame(() => area.current?.focus({ preventScroll: true }))
          }}>편집</button>
          <button type="button" className={preview ? 'on' : ''} aria-pressed={preview} onClick={() => setPreview(true)}>미리보기</button>
        </div>
      </div>
      {/* 미리보기 중에도 입력 요소를 유지해 커서와 기본 실행 취소 기록을 보존한다. */}
      <textarea ref={area} id={id} className="md-source" aria-label={`${label ?? '본문'} Markdown 원문`}
        value={value} onChange={(event) => onChange(event.target.value)} rows={16} spellCheck={false}
        autoCapitalize="off" autoCorrect="off" placeholder="마크다운으로 작성하세요. Enter로 줄을 바꿀 수 있습니다."
        style={{ display: preview ? 'none' : undefined }} />
      {preview && <div className="md-scroll"><Markdown source={value} onWiki={onWiki} /></div>}
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
