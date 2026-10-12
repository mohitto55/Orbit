import { describe, expect, it } from 'vitest'
import { buildDraftPrompt, parseDraft } from '../src/core/requestDraft'

describe('parseDraft', () => {
  it('표시 사이의 본문만 꺼낸다', () => {
    const out = '설명 몇 줄\n<<<DOMAIN_MD\n# 제목 {#s1}\n\n본문\n\nDOMAIN_MD>>>\n끝 인사'
    expect(parseDraft(out)).toBe('# 제목 {#s1}\n\n본문\n')
  })
  it('CRLF 응답도 읽는다', () => {
    expect(parseDraft('<<<DOMAIN_MD\r\n본문\r\nDOMAIN_MD>>>')).toBe('본문\n')
  })
  it('표시가 없으면 응답 전체를 감싼 코드 블록을 쓴다', () => {
    expect(parseDraft('```markdown\n# 제목\n본문\n```')).toBe('# 제목\n본문\n')
  })
  it('끝 표시를 DOMAIN_MD로만 써도 읽는다 (Codex)', () => {
    expect(parseDraft('<<<DOMAIN_MD\n# 할 일\n\n본문\nDOMAIN_MD\n')).toBe('# 할 일\n\n본문\n')
  })
  it('끝 표시를 빼먹어도 끝까지 읽는다', () => {
    expect(parseDraft('<<<DOMAIN_MD\n# 할 일\n본문\n')).toBe('# 할 일\n본문\n')
  })
  it('표시 안쪽을 코드 블록으로 감싸도 벗긴다', () => {
    expect(parseDraft('<<<DOMAIN_MD\n```markdown\n# 할 일\n```\nDOMAIN_MD>>>')).toBe('# 할 일\n')
  })
  it('요청문을 함께 출력해도 마지막 응답의 수정안을 쓴다', () => {
    const prompt = buildDraftPrompt({ domainLabel: 'a', content: '옛 본문', request: { note: 'n', excerpt: 'e', source: 's' } })
    expect(parseDraft(`${prompt}\ncodex\n<<<DOMAIN_MD\n새 본문\nDOMAIN_MD`)).toBe('새 본문\n')
    expect(() => parseDraft(`${prompt}\ncodex\n수정할 게 없습니다`)).toThrow('수정안')
  })
  it('수정안이 없으면 오류', () => {
    expect(() => parseDraft('고칠 게 없어 보입니다')).toThrow('수정안')
  })
})

describe('buildDraftPrompt', () => {
  it('문서, 제안, 근거를 모두 담는다', () => {
    const p = buildDraftPrompt({ domainLabel: '앱 기반 / 관계도', content: '# 관계도\n역할', request: { note: '필터 설명 추가', excerpt: '대화 인용', source: 'ai-check:1' } })
    expect(p).toContain('앱 기반 / 관계도')
    expect(p).toContain('# 관계도\n역할')
    expect(p).toContain('필터 설명 추가')
    expect(p).toContain('대화 인용')
    expect(p).toContain('<<<DOMAIN_MD')
  })
})
