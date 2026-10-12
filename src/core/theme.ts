/** 앱 기반: 화면 테마. 시스템 설정을 따라가거나, 밝게·어둡게로 고정한다. 이 컴퓨터의 Orbit 전체에 적용된다. */

export type ThemeMode = 'system' | 'light' | 'dark'

export const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

/** 저장된 값이 없거나 알 수 없는 값이면 시스템 설정을 따른다 */
export function normalizeTheme(v: unknown): ThemeMode {
  return THEME_MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'system'
}
