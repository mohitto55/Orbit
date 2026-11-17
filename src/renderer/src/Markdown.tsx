import { useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Nodes } from 'hast'
import { readChecklist, type ChecklistItem } from './checklistMarkdown'

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
  onChecklistToggle?: (item: ChecklistItem, checked: boolean) => void
}

export function Markdown({ source, onWiki, onTerm, terms, className = '', onChecklistToggle }: MarkdownProps) {
  if (!source.trim()) return <div className={`md empty-md ${className}`}>(내용 없음)</div>
  return (
    <div className={`md ${className}`}>
      <MdContent source={source} onWiki={onWiki} onTerm={onTerm} terms={terms} onChecklistToggle={onChecklistToggle} />
    </div>
  )
}

/** 마크다운이 만든 체크박스만 연결한다. HTML 예제의 input은 읽기 전용으로 둔다. */
function bindChecklist(items: ChecklistItem[]) {
  const indexes = new Map(items.map((item, index) => [item.start, index]))
  return () => (tree: Nodes) => {
    const visit = (node: Nodes) => {
      if (node.type === 'element' && node.tagName === 'li') {
        const index = indexes.get(node.position?.start.offset ?? -1)
        const first = node.children.find((child) => child.type === 'element')
        const input = first?.type === 'element' && first.tagName === 'p' ? first.children.find((child) => child.type === 'element') : first
        if (index !== undefined && input?.type === 'element' && input.tagName === 'input' && input.properties.type === 'checkbox') input.properties['data-checklist-index'] = index
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

/** 감싸는 .md 없이 렌더링만 한다. 블록 단위로 나눠 그릴 때 쓴다. */
export function MdContent({ source, onWiki, onTerm, terms, onChecklistToggle }: Omit<MarkdownProps, 'className'>) {
  const rendered = prepare(source, terms)
  const items = onChecklistToggle ? readChecklist(source) : []
  const renderedItems = onChecklistToggle ? readChecklist(rendered) : []
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], ...(onChecklistToggle ? [bindChecklist(items.length === renderedItems.length ? renderedItems : [])] : [])]}
      urlTransform={(url) => (INTERNAL.test(url) ? url : defaultUrlTransform(url))}
      components={{
        input: ({ node, checked, ...props }) => {
          const index = node?.properties['data-checklist-index']
          const item = typeof index === 'number' ? items[index] : undefined
          return <input {...props} checked={checked ?? false} disabled={item ? false : props.disabled} readOnly={!item}
            aria-label={item?.text || props['aria-label']}
            onChange={item ? (event) => onChecklistToggle?.(item, event.target.checked) : undefined} />
        },
        a: ({ href = '', children }) => {
          if (href.startsWith('wiki:')) {
            const target = decodeURIComponent(href.slice(5))
            return (
              <button className="wikilink" data-wiki={target} title={`[[${target}]]`} contentEditable={false} onClick={() => onWiki?.(target)}>
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
      {rendered}
    </ReactMarkdown>
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
