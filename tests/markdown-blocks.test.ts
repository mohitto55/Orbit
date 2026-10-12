import { describe, expect, it } from 'vitest'
import { joinBlocks, splitBlocks } from '../src/renderer/src/Markdown'

describe('splitBlocks', () => {
  const cases = [
    '',
    '# 제목',
    '# 제목\n\n본문 한 줄\n둘째 줄\n',
    '\n\n앞에 빈 줄\n\n\n\n뒤에 여러 빈 줄\n\n',
    '- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |',
    '글\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n끝'
  ]
  it.each(cases)('합치면 원문과 같다: %j', (src) => {
    expect(joinBlocks(splitBlocks(src))).toBe(src)
  })
  it('빈 줄로 나누고 코드 펜스 안은 나누지 않는다', () => {
    const texts = splitBlocks(cases[5]).map((b) => b.text)
    expect(texts).toEqual(['글', '```ts\nconst a = 1\n\nconst b = 2\n```', '끝'])
  })
})
