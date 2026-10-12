import { nativeTheme } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { normalizeTheme, type ThemeMode } from '../core/theme'

/**
 * 화면 테마 설정. nativeTheme.themeSource를 바꾸면 화면의 prefers-color-scheme이 따라 바뀌므로
 * CSS·관계도·터미널은 지금처럼 그 값만 보면 된다.
 */
export function createTheme(deps: { userData: string }) {
  const file = path.join(deps.userData, 'theme.json')
  let mode: ThemeMode = 'system'

  return {
    /** 앱 시작 시 창을 만들기 전에 호출 */
    async load() {
      try {
        mode = normalizeTheme(JSON.parse(await fs.readFile(file, 'utf8')).mode)
      } catch {
        // 설정 파일이 없으면 시스템 설정을 따른다
      }
      nativeTheme.themeSource = mode
    },
    api: {
      themeMode: () => mode,
      async setThemeMode(next: ThemeMode) {
        mode = normalizeTheme(next)
        nativeTheme.themeSource = mode
        await fs.mkdir(deps.userData, { recursive: true })
        await fs.writeFile(file, JSON.stringify({ mode }, null, 2))
        return mode
      }
    }
  }
}

export type ThemeApi = ReturnType<typeof createTheme>['api']
