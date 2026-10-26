import type { TerminalKind } from './terminal'

/** 파일 드롭은 입력만 추가한다. CLI가 이미지 경로를 인식하도록 파일마다 따로 붙여 넣는다. */
export function terminalFilePastes(paths: string[], kind: TerminalKind, windows: boolean): string[] {
  if (!paths.length || paths.some((path) => !path)) throw new Error('파일 경로를 읽을 수 없습니다. 컴퓨터에 저장한 파일을 끌어 놓아 주세요.')
  if (paths.some((path) => /[\x00-\x1f\x7f]/.test(path))) throw new Error('파일 경로에 입력할 수 없는 제어 문자가 포함되어 있습니다.')
  if (kind === 'shell') {
    const quoted = paths.map((path) => `'${path.replaceAll("'", windows ? "''" : "'\\''")}'`)
    return [quoted.join(' ') + ' ']
  }
  return paths.map((path) => JSON.stringify(windows ? path.replaceAll('\\', '/') : path) + ' ')
}
