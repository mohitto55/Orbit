import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { beginOutputCapture, endOutputCapture, freezeTerminalIntegration, prepareTerminalIntegration, readAgentOutput, takeAgentSignals } from '../src/core/terminalIntegration'
import { tempDir } from './helpers'

it.each(['claude', 'codex'] as const)('%s의 실제 완료 스크립트는 최종 응답을 그대로 받고 요청한 실행에만 보관한다', async (kind) => {
  const dir = await tempDir('orbit-response-')
  const integration = prepareTerminalIntegration(dir, kind, dir)
  const output = JSON.stringify({ people: '한글 이름', quote: '"인용"\n두 줄', literal: '$(throw "실행되면 안 됨") & | < > %PATH% ` ;', detail: { empty: '', ok: false, count: 0, list: [1, null] } })
  const payload = JSON.stringify(kind === 'codex' ? { type: 'agent-turn-complete', 'last-assistant-message': output } : { hook_event_name: 'Stop', last_assistant_message: output })
  const options = { env: { ...process.env, ...integration.env }, cwd: dir, encoding: 'utf8' as const, stdio: 'pipe' as const }
  const complete = async () => {
    if (kind === 'codex') {
      const [command, ...args] = JSON.parse(integration.codexNotify.slice('notify='.length)) as string[]
      execFileSync(command, [...args, payload], options)
    } else {
      const settings = JSON.parse(await fs.readFile(integration.claudeSettings, 'utf8')) as { hooks: { Stop: { hooks: { command: string }[] }[] } }
      const command = settings.hooks.Stop[0].hooks[0].command
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command.split('-EncodedCommand ')[1]], { ...options, input: payload })
      else execFileSync('/bin/sh', ['-c', command], { ...options, input: payload })
    }
  }
  await complete()
  expect(takeAgentSignals(dir)).toEqual(['done'])
  expect(readAgentOutput(dir)).toBeUndefined()
  expect(await fs.readdir(dir)).not.toContain('agent-output.json')
  beginOutputCapture(dir)
  await complete()
  expect(readAgentOutput(dir)).toBe(output)
  expect(takeAgentSignals(dir)).toEqual(['done'])
  beginOutputCapture(dir)
  expect(readAgentOutput(dir)).toBeUndefined()
  expect(takeAgentSignals(dir)).toEqual([])
  endOutputCapture(dir)
  await complete()
  expect(readAgentOutput(dir)).toBeUndefined()
  takeAgentSignals(dir)
  freezeTerminalIntegration(dir)
  await complete()
  expect(takeAgentSignals(dir)).toEqual([])
})
