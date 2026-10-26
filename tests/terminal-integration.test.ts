import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { freezeTerminalIntegration, prepareTerminalIntegration, readCliLaunch, resumeOptions, shellQuote, takeAgentSignals } from '../src/core/terminalIntegration'
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

it.skipIf(process.platform !== 'win32').each(['plain', "한글 폴더's"])('[DM-F02-AC15] Windows PowerShell에서 %s 경로의 notify 배열을 큰따옴표 손실 없이 전달한다', async (folder) => {
  const root = await tempDir('orbit-codex-arguments-')
  const dir = path.join(root, folder), bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  const integration = prepareTerminalIntegration(dir, 'shell', root)
  const capture = path.join(root, 'capture.cjs'), result = path.join(root, 'args.json')
  await fs.writeFile(capture, "require('fs').writeFileSync(process.env.ORBIT_ARG_RESULT, JSON.stringify(process.argv.slice(2)))")
  // npm의 codex.ps1처럼 네이티브 실행 파일로 인자를 넘기는 경로를 실제 PowerShell로 검증한다.
  await fs.writeFile(path.join(bin, 'codex.ps1'), '& $env:ORBIT_NODE $env:ORBIT_ARG_CAPTURE @args')
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const env = { ...process.env, ...integration.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`, ORBIT_ARG_CAPTURE: capture, ORBIT_ARG_RESULT: result }
  const script = `${integration.init}\ncodex --no-daemon -c ${shellQuote(integration.codexNotify)}`
  // Windows CI에서 첫 PowerShell 기동은 기본 테스트 제한(5초)보다 오래 걸릴 수 있다.
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, cwd: root, stdio: 'pipe', timeout: 15000 })
  const args = JSON.parse(await fs.readFile(result, 'utf8')) as string[]
  expect(args.filter((arg) => arg.startsWith('notify='))).toEqual([integration.codexNotify, integration.codexNotify])
}, 20000)

it('[TE-F03-AC1] 한 번의 폴링 사이에 끝난 작업과 다음 작업의 시작 신호를 시간순으로 받는다', async () => {
  const dir = await tempDir('orbit-activity-signals-')
  const integration = prepareTerminalIntegration(dir, 'claude', dir)
  const settings = JSON.parse(await fs.readFile(integration.claudeSettings, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('agent.working')
  expect(settings.hooks.StopFailure[0].hooks[0].command).toContain('agent.idle')
  await fs.writeFile(path.join(dir, 'agent.done'), 'done')
  await fs.writeFile(path.join(dir, 'agent.working'), 'working')
  await fs.utimes(path.join(dir, 'agent.done'), 1, 1)
  await fs.utimes(path.join(dir, 'agent.working'), 2, 2)
  expect(takeAgentSignals(dir)).toEqual(['done', 'working'])
  expect(takeAgentSignals(dir)).toEqual([])
})
