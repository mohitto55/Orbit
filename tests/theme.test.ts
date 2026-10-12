import { describe, expect, it } from 'vitest'
import { normalizeTheme } from '../src/core/theme'

describe('앱 기반 · 화면 테마', () => {
  it('시스템 / 밝게 / 어둡게 중 하나로 저장하고, 모르는 값은 시스템 설정을 따른다', () => {
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('system')).toBe('system')
    expect(normalizeTheme(undefined)).toBe('system')
    expect(normalizeTheme('blue')).toBe('system')
  })
})
