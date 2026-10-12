/**
 * 보기 모양 그대로 고친 화면(DOM)을 md로 되돌린다.
 * react-markdown이 그리는 요소(단락·헤딩·목록·인용·코드·표·구분선·강조·링크·위키링크)만 다룬다.
 * 그 밖의 요소(details 같은 HTML)가 있으면 null을 돌려준다 → 그 블록은 원문으로 편집한다.
 */

class Unsupported extends Error {}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'DIV'])

const isBlank = (n: Node) => n.nodeType === 3 && !(n.textContent ?? '').trim()
const tag = (n: Node) => (n.nodeType === 1 ? (n as Element).tagName : '')

/** 블록 하나(빈 줄 없이 이어진 md 덩어리)를 그린 요소 → md. original은 헤딩 앵커({#id})를 되살리는 데 쓴다. */
export function serializeBlock(root: Element, original = ''): string | null {
  const anchors = [...original.matchAll(/^#{1,6}\s.*?([ \t]*\{#[\w-]+\})\s*$/gm)].map((m) => m[1])
  try {
    return blocks(root, { anchors }).replace(/\n+$/, '')
  } catch (e) {
    if (e instanceof Unsupported) return null
    throw e
  }
}

/** 이 요소를 md로 되돌릴 수 있는가 */
export function canSerialize(root: Element): boolean {
  return serializeBlock(root) !== null
}

interface Ctx {
  anchors: string[]
}

/** 블록 요소들을 빈 줄로 잇는다. 블록 사이에 흩어진 글자(빈 블록에 바로 친 글)는 단락으로 본다. */
function blocks(parent: Node, ctx: Ctx): string {
  const out: string[] = []
  let loose = ''
  const flush = () => {
    const t = loose.replace(/^\n+|\s+$/g, '')
    if (t) out.push(t)
    loose = ''
  }
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCK_TAGS.has(tag(n)))) {
      loose += inline(n)
      continue
    }
    if (n.nodeType !== 1) continue
    flush()
    const s = block(n as Element, ctx)
    if (s.trim()) out.push(s)
  }
  flush()
  return out.join('\n\n')
}

function block(el: Element, ctx: Ctx): string {
  const t = el.tagName
  if (t === 'P') return inlineChildren(el).trim()
  if (/^H[1-6]$/.test(t)) {
    const text = inlineChildren(el).trim()
    if (!text) return ''
    return `${'#'.repeat(Number(t[1]))} ${text}${ctx.anchors.shift() ?? ''}`
  }
  if (t === 'UL' || t === 'OL') return list(el, ctx)
  if (t === 'BLOCKQUOTE') return blocks(el, ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
  if (t === 'PRE') return code(el)
  if (t === 'TABLE') return table(el)
  if (t === 'HR') return '---'
  if (t === 'DIV') {
    // 표를 감싼 div, 또는 편집하다 생긴 div(줄)
    const only = Array.from(el.childNodes).filter((n) => !isBlank(n))
    if (el.classList.contains('md-table') && only.length === 1 && tag(only[0]) === 'TABLE') return table(only[0] as Element)
    return Array.from(el.childNodes).some((n) => BLOCK_TAGS.has(tag(n))) ? blocks(el, ctx) : inlineChildren(el).trim()
  }
  throw new Unsupported(t)
}

function list(el: Element, ctx: Ctx): string {
  const ordered = el.tagName === 'OL'
  let num = Number(el.getAttribute('start') ?? '1') || 1
  const items: string[] = []
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') throw new Unsupported('list child ' + li.tagName)
    const marker = ordered ? `${num++}.` : '-'
    const pad = ' '.repeat(marker.length + 1)
    let check = ''
    const parts: string[] = []
    let text = ''
    const flushText = () => {
      if (text.trim()) parts.push(text.trim())
      text = ''
    }
    for (const n of Array.from(li.childNodes)) {
      if (n.nodeType === 1 && (n as Element).tagName === 'INPUT') {
        const input = n as HTMLInputElement
        if (input.type !== 'checkbox') throw new Unsupported('input')
        check = input.checked || input.hasAttribute('checked') ? '[x] ' : '[ ] '
      } else if (n.nodeType === 1 && BLOCK_TAGS.has(tag(n))) {
        flushText()
        parts.push(block(n as Element, ctx))
      } else text += inline(n)
    }
    flushText()
    // 느슨한 목록(항목 안에 단락)은 빈 줄, 아니면 줄바꿈으로 잇는다
    const sep = Array.from(li.children).some((c) => c.tagName === 'P') ? '\n\n' : '\n'
    const body = parts.join(sep).split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n')
    items.push(`${marker} ${check}${body}`)
  }
  return items.join('\n')
}

function code(pre: Element): string {
  const c = pre.querySelector('code')
  const lang = (c?.className.match(/language-([\w+-]+)/) ?? [])[1] ?? ''
  const body = (c ?? pre).textContent?.replace(/\n$/, '') ?? ''
  const fence = body.includes('```') ? '~~~' : '```'
  return `${fence}${lang}\n${body}\n${fence}`
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr'))
  if (!rows.length) return ''
  const cells = rows.map((r) => Array.from(r.children).map((c) => inlineChildren(c, true).trim().replace(/\|/g, '\\|')))
  const width = Math.max(...cells.map((r) => r.length))
  const align = Array.from(rows[0].children).map((c) => {
    const a = (c as HTMLElement).style?.textAlign || c.getAttribute('align') || ''
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
  })
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  return [line(cells[0]), `| ${Array.from({ length: width }, (_, i) => align[i] ?? '---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n')
}

function inlineChildren(el: Node, inCell = false): string {
  const kids = Array.from(el.childNodes)
  // 편집 중 끝에 생기는 자리 표시용 <br>은 버린다
  while (kids.length && tag(kids[kids.length - 1]) === 'BR') kids.pop()
  return kids.map((n) => inline(n, inCell)).join('')
}

function wrap(mark: string, inner: string): string {
  // 앞뒤 공백은 표시 밖으로 뺀다 (**굵게 ** 는 md에서 굵게가 안 된다)
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner
}

function inline(n: Node, inCell = false): string {
  if (n.nodeType === 3) return (n.textContent ?? '').replace(/ /g, ' ')
  if (n.nodeType !== 1) return ''
  const el = n as HTMLElement
  const kids = () => inlineChildren(el, inCell)
  switch (el.tagName) {
    case 'STRONG':
    case 'B':
      return wrap('**', kids())
    case 'EM':
    case 'I':
      return wrap('*', kids())
    case 'DEL':
    case 'S':
      return wrap('~~', kids())
    case 'CODE': {
      const t = el.textContent ?? ''
      return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``
    }
    case 'A': {
      const href = el.getAttribute('href') ?? ''
      const text = kids()
      return href ? `[${text}](${href})` : text
    }
    case 'BUTTON': {
      if (!el.classList.contains('wikilink')) throw new Unsupported('button')
      const target = (el.getAttribute('title') ?? '').replace(/^\[\[|\]\]$/g, '')
      const label = el.textContent ?? ''
      return !target || label === target ? `[[${target || label}]]` : `[[${target}|${label}]]`
    }
    case 'IMG':
      return `![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`
    case 'BR':
      return inCell ? '<br>' : '<br>\n'
    case 'MARK':
    case 'SPAN':
    case 'FONT':
    case 'U':
      return kids()
    case 'DIV':
    case 'P':
      // 편집 중 Enter로 생긴 줄
      return (inCell ? '<br>' : '\n') + kids()
    default:
      throw new Unsupported(el.tagName)
  }
}
