import { expect, it } from 'vitest'
import { resizeImageMarkup } from '../src/renderer/src/markdownImages'

it('너비 변경은 이미지의 경로·제목·참조·이스케이프와 HTML 속성을 보존한다', () => {
  for (const [source, expected] of [
    ['![설명](assets/한글%20사진.png "제목")', '![설명|360](assets/한글%20사진.png "제목")'],
    ['![설명|100][사진]', '![설명|360][사진]'],
    ['![설명\\|100][사진]', '![설명|360][사진]'],
    ['![사진]', '![사진|360][사진]'],
    ['![사진][]', '![사진|360][사진]'],
    ['![설명 [괄호] \\]](url(a).png)', '![설명 [괄호] \\]|360](url(a).png)'],
    ['<img alt=\'width="50"\' src="a.png" width="120" height="60" title="한글">', '<img width="360" alt=\'width="50"\' src="a.png" title="한글">']
  ]) expect(resizeImageMarkup(source, 360)).toBe(expected)
  expect(resizeImageMarkup('![설명](a.png)', 360, true)).toBe('![설명\\|360](a.png)')
  expect(resizeImageMarkup('![설명\\|360](a.png)', null, true)).toBe('![설명](a.png)')
  expect(resizeImageMarkup('<img width="360" src="a.png" alt="설명">', null)).toBe('<img src="a.png" alt="설명">')
})
