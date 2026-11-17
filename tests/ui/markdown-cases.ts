/** CommonMark + GFM constructs supported by the shared live editor. */
export const markdownCases = [
  { name: 'ATX headings 1–6 and anchors', source: '# 제목 1 {#one}\n\n## 제목 2\n\n### 제목 3\n\n#### 제목 4\n\n##### 제목 5\n\n###### 제목 6', checks: [ ['.cm-md-heading', 6], ['.cm-md-h1', 1], ['.cm-md-h6', 1] ] },
  { name: 'Setext headings', source: '큰 제목\n=======\n\n작은 제목\n--------', checks: [ ['.cm-md-h1', 1], ['.cm-md-h2', 1] ] },
  { name: 'paragraphs, soft/hard breaks and blank lines', source: '첫 문단\n소프트 줄바꿈\n\n다음 문단  \n강제 줄바꿈\n\n\n빈 줄 보존', checks: [ ['.cm-line', 8] ] },
  { name: 'strong, emphasis, strike, inline code and nesting', source: '**굵게**와 __굵게도__\n\n*기울임*과 _기울임도_\n\n~~취소선~~과 `const x = 1`\n\n**굵은 *기울임***', checks: [ ['.cm-md-strong', 3], ['.cm-md-em', 3], ['.cm-md-strike', 1], ['.cm-md-inline-code', 1] ] },
  { name: 'unordered, ordered and nested lists', source: '- 항목 하나\n  - 중첩 항목\n    - 더 깊은 항목\n- 항목 둘\n\n1. 순서 하나\n2. 순서 둘\n   1. 중첩 순서', checks: [ ['.cm-md-bullet', 4] ] },
  { name: 'unchecked, checked and nested task lists', source: '- [ ] TODO\n- [x] 완료\n  - [ ] 중첩 조건\n  - [X] 중첩 완료', checks: [ ['.cm-md-task-box', 4], ['.cm-md-task-box:checked', 2] ] },
  { name: 'nested blockquotes', source: '> 인용문\n>\n> 두 번째 줄\n>> 중첩 인용\n\n일반 문단', checks: [ ['.cm-md-quote', 4] ] },
  { name: 'backtick fences, tilde fences and indented code', source: '```ts\nconst a = "[[literal]]"\n  const b = "**literal**"\n```\n\n~~~text\n- [ ] 코드 그대로\n~~~\n\n    indented code\n      preserved spaces', checks: [ ['.cm-md-code', 9], ['.cm-md-task-box', 0], ['[data-wiki]', 0] ] },
  { name: 'horizontal rules', source: '구분 전\n\n---\n\n구분 중\n\n***\n\n구분 후', checks: [ ['hr', 2] ] },
  { name: 'inline links, reference links, autolinks and wiki aliases', source: '[일반 링크](https://example.com)\n\n[참조 링크][ref]\n\n<https://example.com>\n\nhttps://example.com/bare\n\n[[도메인]]과 [[domain-id|별칭]]\n\n[ref]: https://example.com/reference', checks: [ ['.cm-md-link', 6], ['[data-wiki]', 2] ] },
  { name: 'GFM tables with escaped pipes, inline markup and line breaks', source: '표 앞\n\n| 이름 | 설명 |\n| --- | --- |\n| A\\|B | **강조**와 `코드` |\n| 다음 | 줄 하나<br>줄 둘 |\n\n표 뒤', checks: [ ['table', 1], ['th', 2], ['td', 4], ['td strong', 1], ['td code', 1], ['td br', 1] ] },
  { name: 'safe HTML blocks with details and preformatted text', source: '<details open>\n<summary>세부 설명</summary>\n<p>첫 줄<br>다음 줄</p>\n<pre>  들여쓴 코드\n    두 번째 줄</pre>\n</details>\n\n끝', checks: [ ['details[open]', 1], ['summary', 1], ['pre', 1] ] },
  { name: 'escaped syntax, literal brackets and Unicode', source: '\\*별표 그대로\\*와 \\[괄호\\]\n\n`[[위키 아님]]`\n\n한글 🙂 é 日本語\n\n\\# 제목 아님', checks: [ ['.cm-md-inline-code', 1], ['.cm-md-heading', 0], ['[data-wiki]', 0] ] }
] satisfies { name: string; source: string; checks: [string, number][] }[]

export const integrationSource = '# 문서 제목 {#document}\n\n수정 전 문단\n\n**강조**와 `코드`\n\n- [ ] TODO\n  - [x] 중첩 완료\n\n| 이름 | 설명 |\n| --- | --- |\n| 첫 셀 | 두 번째 셀 |\n| 한글 | A\\|B |\n\n```ts\nconst a = 1\n```\n\n![도식](assets/flow.svg)\n\n끝 문단'
