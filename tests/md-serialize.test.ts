// @vitest-environment happy-dom
import { promises as fs } from 'fs'
import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MdContent, splitBlocks } from '../src/renderer/src/Markdown'
import { serializeBlock } from '../src/renderer/src/mdSerialize'

const render = (md: string) => renderToStaticMarkup(createElement(MdContent, { source: md }))
const norm = (html: string) => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
function dom(html: string) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}
/** md → 화면 → md → 화면: 두 화면이 같아야 한다 */
function roundTrip(md: string) {
  const html = render(md)
  const back = serializeBlock(dom(html), md)
  return { back, same: back !== null && norm(render(back)) === norm(html) }
}

async function mdFiles(dir: string, out: string[] = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await mdFiles(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

describe('md 편집 · 보기 모양 그대로 고치기', () => {
  it.each([
    ['단락·강조', '이건 **굵게**, *기울임*, ~~취소~~, `코드` 그리고 [링크](https://x.dev)'],
    ['헤딩 앵커 유지', '## 역할 {#s1}'],
    ['위키링크', '[[도메인]]과 [[task|할 일]]을 본다'],
    ['목록', '- 하나\n- 둘\n  - 둘의 하위\n- 셋'],
    ['번호 목록', '3. 셋\n4. 넷'],
    ['할 일 목록', '- [ ] 안 함\n- [x] 함'],
    ['인용', '> 해결 문제: P1\n> 두 번째 줄'],
    ['코드 블록', '```ts\nconst a = 1\n\nconst b = 2\n```'],
    ['표', '| 용어 | 뜻 | 비고 |\n|---|---|---|\n| 도메인 | 업무 영역<br>두 줄 | |\n| a \| b | x | y |'],
    ['구분선', '---']
  ])('%s', (_name, md) => {
    expect(roundTrip(md).same).toBe(true)
  })

  it('화면에서 글자를 고치면 그 부분만 md에 반영된다', () => {
    const md = '## 역할 {#s1}'
    const el = dom(render(md))
    el.querySelector('h2')!.textContent = '맡은 일'
    expect(serializeBlock(el, md)).toBe('## 맡은 일 {#s1}')

    const t = '| 용어 | 뜻 |\n|---|---|\n| 도메인 | 업무 영역 |'
    const tel = dom(render(t))
    tel.querySelectorAll('td')[1].textContent = '역할과 경계'
    expect(serializeBlock(tel, t)).toBe('| 용어 | 뜻 |\n| --- | --- |\n| 도메인 | 역할과 경계 |')
  })

  it('빈 블록에 친 md 기호는 그대로 md가 된다 (제목·목록을 원문 모드 없이 만든다)', () => {
    const el = dom('')
    el.textContent = '## 새 제목'
    expect(serializeBlock(el)).toBe('## 새 제목')
  })

  it('되돌릴 수 없는 HTML은 null (그 블록은 원문으로 편집)', () => {
    expect(roundTrip('<details><summary>더보기</summary>내용</details>').back).toBeNull()
  })

  it('프로젝트의 실제 md 문서 블록이 모두 같은 모양으로 되돌아온다', async () => {
    const files = await mdFiles(path.join(__dirname, '..', 'docs'))
    const bad: string[] = []
    let n = 0
    for (const f of files) {
      const body = (await fs.readFile(f, 'utf8')).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '')
      for (const b of splitBlocks(body)) {
        if (!b.text.trim()) continue
        n++
        const r = roundTrip(b.text)
        if (r.back !== null && !r.same) bad.push(`${path.relative(process.cwd(), f)}\n${b.text}\n→\n${r.back}`)
      }
    }
    expect(n).toBeGreaterThan(100)
    expect(bad.slice(0, 5).join('\n\n=====\n\n')).toBe('')
  })
})
