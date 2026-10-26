import { expect, it } from 'vitest'
import { terminalFilePastes } from '../src/core/terminalFiles'

it('[TE-F01-AC12] CLI에 여러 이미지·문서를 각각 붙여 넣고 한글·공백·따옴표 경로를 보존한다', () => {
  const paths = ["C:\\작업 폴더\\첫 사진.png", "C:\\작업 폴더\\second's photo.png", 'C:\\문서\\설계.md']
  const pastes = terminalFilePastes(paths, 'codex', true)
  expect(pastes).toHaveLength(3)
  expect(pastes.map((text) => JSON.parse(text))).toEqual(paths.map((path) => path.replaceAll('\\', '/')))
  expect(terminalFilePastes(paths, 'claude', true)).toEqual(pastes)
  const unixPath = '/tmp/사진 "원본"과 \\ 사본.png'
  expect(JSON.parse(terminalFilePastes([unixPath], 'codex', false)[0])).toBe(unixPath)
  expect(pastes.every((text) => text.endsWith(' ') && !/[\r\n]/.test(text))).toBe(true)
})

it('[TE-F01-AC12] 셸에서는 경로를 하나씩 인용하고 명령을 실행하지 않는다', () => {
  expect(terminalFilePastes(["C:\\a'b\\한 글.png", 'C:\\$(echo unexpected);file.txt'], 'shell', true))
    .toEqual(["'C:\\a''b\\한 글.png' 'C:\\$(echo unexpected);file.txt' "])
  expect(terminalFilePastes(["/tmp/a'b.png", '/tmp/$(echo unexpected);file.txt'], 'shell', false))
    .toEqual(["'/tmp/a'\\''b.png' '/tmp/$(echo unexpected);file.txt' "])
})

it('[TE-F01-AC12] 경로 없는 파일이나 제어 문자가 섞인 드롭은 전체를 거절한다', () => {
  for (const kind of ['codex', 'claude', 'shell'] as const) {
    for (const paths of [[], ['ok.png', ''], ['ok.png', '/tmp/line\nbreak'], ['/tmp/\renter'], ['/tmp/\x1b[201~'], ['/tmp/\0'], ['/tmp/\x7f']]) {
      expect(() => terminalFilePastes(paths, kind, true)).toThrow()
    }
  }
})
