import type { Nodes } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

export interface ChecklistItem {
  /** 원문에서 [ ] 또는 [x]의 가운데 글자 위치 */
  offset: number
  text: string
  checked: boolean
}

const parser = unified().use(remarkParse).use(remarkGfm)

function labelText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if (node.type === 'break') return '\n'
  return 'children' in node ? node.children.map(labelText).join('') : ''
}

/** 실제 마크다운 체크 항목만 읽는다. 코드 예제와 일반 목록은 제외한다. */
export function readChecklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const start = node.position?.start.offset
      const marker = start === undefined ? null : body.slice(start).match(/^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/)
      if (start !== undefined && marker) {
        items.push({
          offset: start + marker[0].length - 2,
          text: node.children.filter((child) => child.type === 'paragraph').map(labelText).join('\n').trim(),
          checked: node.checked
        })
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(parser.parse(body))
  return items
}

/** 문서 전체를 다시 직렬화하지 않고 선택한 체크 표시 한 글자만 바꾼다. */
export function setChecklistChecked(body: string, offset: number, checked: boolean): string {
  const item = readChecklist(body).find((entry) => entry.offset === offset)
  if (!item) throw new Error('완료 조건을 찾을 수 없습니다. 최신 내용을 확인하세요')
  if (item.checked === checked) return body
  return body.slice(0, offset) + (checked ? 'x' : ' ') + body.slice(offset + 1)
}
