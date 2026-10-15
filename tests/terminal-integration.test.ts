import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { freezeTerminalIntegration, prepareTerminalIntegration, readCliLaunch, resumeOptions } from '../src/core/terminalIntegration'
import { tempDir } from './helpers'

it('[TE-F01-AC8] 수동 CLI 실행 인자와 Claude SessionStart의 ID만 기록하고 앱 종료 후 늦게 오는 종료 신호는 무시한다', async () => {
  const dir = await tempDir('orbit-integration-')
  const cwd = await fs.realpath(dir)
  const integration = prepareTerminalIntegration(dir, 'shell', dir)
  const run = (args: string[], input?: string) => execFileSync(process.execPath, [integration.env.ORBIT_BRIDGE, ...args], { cwd: dir, env: { ...process.env, ...integration.env }, input, encoding: 'utf8' })
  run(['start', 'claude', '--model', 'sonnet'])
  expect(readCliLaunch(dir)).toMatchObject({ kind: 'claude', args: ['--model', 'sonnet'], running: true })
  expect(await fs.realpath(readCliLaunch(dir)!.cwd)).toBe(cwd)
  run(['hook'], JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555', cwd: dir, transcript_path: 'do-not-read.jsonl', source: 'resume' }))
  expect(readCliLaunch(dir)?.sessionId).toBe('11111111-2222-3333-4444-555555555555')
  expect(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).not.toContain('transcript_path')
  freezeTerminalIntegration(dir)
  run(['stop'])
  expect(readCliLaunch(dir)?.running).toBe(true)
  prepareTerminalIntegration(dir, 'shell', dir)
  run(['stop']) // 이전 셸의 지연 콜백은 새 실행 상태도 덮어쓰지 못한다.
  expect(readCliLaunch(dir)).toBeUndefined()
})

it('재개 명령은 사용자 실행 옵션을 보존하되 프롬프트·이전 ID·중복 옵션을 다시 전달하지 않는다', () => {
  expect(resumeOptions(['resume', 'old-id', '--yolo', '--profile', 'work', 'a prompt [', '--model=gpt-test'])).toEqual(['--yolo', '--profile', 'work', '--model=gpt-test'])
  expect(resumeOptions(['--yolo', '--model', 'old-model'], 'codex --yolo --model new-model resume id')).toEqual([])
})
