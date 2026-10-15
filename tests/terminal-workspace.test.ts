import { promises as fs } from 'fs'
import path from 'path'
import { expect, it, vi } from 'vitest'
import { findCodexSession } from '../src/core/terminalWorkspace'
import { pendingSessionCount } from '../src/core/drift'
import { tempDir } from './helpers'

it('대화 본문 없이 탭 고유 메타데이터만으로 대화 ID를 찾고 다른 탭·프로젝트·하위 에이전트는 제외한다', async () => {
  const root = await tempDir('codex-metadata-')
  const dir = path.join(root, 'sessions')
  await fs.mkdir(dir)
  const write = async (name: string, id: string, cwd: string, originator: string, source: unknown = 'cli') => {
    const file = path.join(dir, name + '.jsonl')
    await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, originator, source } }) + '\n')
    return file
  }
  await write('other-tab', 'wrong-tab', root, 'orbit-term-other')
  await write('other-project', 'wrong-project', path.join(root, 'elsewhere'), 'orbit-term-mine')
  await write('subagent', 'wrong-agent', root, 'orbit-term-mine', { subagent: 'worker' })
  const file = await write('mine', 'native-id', root, 'orbit-term-mine')
  // 문자열 한도를 넘는 600MB 파일도 첫 줄만 읽는다. sparse file이므로 실제 디스크 사용량은 작다.
  const handle = await fs.open(file, 'r+')
  await handle.truncate(600 * 1024 * 1024)
  await handle.close()
  expect(await findCodexSession(root, 'term-mine', root)).toBe('native-id')
  expect(await findCodexSession(root, 'term-missing', root)).toBeUndefined()
  vi.stubEnv('CODEX_HOME', root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'))
  try {
    expect(await pendingSessionCount({ projectDir: root, dataRoot: path.join(root, 'data') }, root)).toBe(3)
  } finally { vi.unstubAllEnvs() }
  const newer = await write('newer', 'newer-id', root, 'orbit-term-mine')
  await fs.writeFile(newer, JSON.stringify({ type: 'session_meta', payload: { id: 'newer-id', cwd: root, originator: 'orbit-term-mine', timestamp: '2099-01-01T00:00:00Z', source: 'cli' } }) + '\n')
  expect(await findCodexSession(root, 'term-mine', root)).toBe('newer-id')
})
