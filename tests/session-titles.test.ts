import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeClaudeProjectDir } from '../src/core/drift'
import { readSessionTitle } from '../src/core/sessionTitles'
import { tempDir } from './helpers'

afterEach(() => vi.unstubAllEnvs())

it('[TE-F01-AC10] Codex의 같은 세션에 저장된 최신 name을 읽고 원본을 변경하지 않는다', async () => {
  const home = await tempDir('codex-names-')
  const file = path.join(home, 'session_index.jsonl')
  const raw = [
    JSON.stringify({ id: 'mine', thread_name: '예전 이름' }),
    'broken json',
    JSON.stringify({ id: 'other', thread_name: '다른 세션' }),
    JSON.stringify({ id: 'mine', thread_name: '결제 재시도 수정' }),
    '{"id":"mine","thread_name":'
  ].join('\n')
  await fs.writeFile(file, raw)
  vi.stubEnv('CODEX_HOME', home)
  expect(await readSessionTitle('codex', 'mine', home)).toBe('결제 재시도 수정')
  expect(await readSessionTitle('codex', 'missing', home)).toBeUndefined()
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
  await fs.appendFile(file, '"최종 세션 이름"}\n')
  expect(await readSessionTitle('codex', 'mine', home)).toBe('최종 세션 이름')
})

it('[TE-F01-AC10] Claude의 사용자 제목을 자동 제목보다 우선하며 큰 대화도 앞뒤 메타데이터만 읽는다', async () => {
  const home = await tempDir('claude-names-')
  const dir = path.join(home, 'projects', encodeClaudeProjectDir(home))
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'mine.jsonl')
  const head = JSON.stringify({ type: 'custom-title', sessionId: 'mine', customTitle: '사용자가 붙인 세션 이름' }) + '\n'
  await fs.writeFile(file, head)
  const handle = await fs.open(file, 'r+')
  try { await handle.truncate(600 * 1024 * 1024) } finally { await handle.close() }
  const tail = '\n' + JSON.stringify({ type: 'ai-title', sessionId: 'mine', aiTitle: '자동 제목' }) + '\n'
  await fs.appendFile(file, tail)
  const before = await fs.stat(file)
  expect(await readSessionTitle('claude', 'mine', home, home)).toBe('사용자가 붙인 세션 이름')
  expect((await fs.stat(file)).size).toBe(before.size)
  expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  await fs.appendFile(file, JSON.stringify({ type: 'custom-title', sessionId: 'mine', customTitle: '새 이름' }) + '\n')
  expect(await readSessionTitle('claude', 'mine', home, home)).toBe('새 이름')
})

it('[TE-F01-AC10] Claude의 자동 제목·구버전 색인을 읽고 이름 없는 세션과 손상된 색인은 건너뛴다', async () => {
  const home = await tempDir('claude-name-fallback-')
  const dir = path.join(home, 'projects', encodeClaudeProjectDir(home))
  await fs.mkdir(dir, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
  await fs.writeFile(path.join(dir, 'auto.jsonl'), JSON.stringify({ type: 'ai-title', sessionId: 'auto', aiTitle: '자동 세션 이름' }))
  expect(await readSessionTitle('claude', 'auto', home)).toBe('자동 세션 이름')
  const index = path.join(dir, 'sessions-index.json')
  await fs.writeFile(index, JSON.stringify({ entries: [{ sessionId: 'legacy', summary: '기존 세션 제목', firstPrompt: '첫 메시지는 이름이 아니다' }] }))
  expect(await readSessionTitle('claude', 'legacy', home)).toBe('기존 세션 제목')
  expect(await readSessionTitle('claude', 'missing', home)).toBeUndefined()
  await fs.writeFile(index, '{"entries":')
  expect(await readSessionTitle('claude', 'legacy', home)).toBeUndefined()
})
