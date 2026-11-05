import { promises as fs } from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { CodexCaptureReader } from '../src/core/codexCapture'
import { beginOutputCapture, captureCodexResult, capturePromptHash, prepareTerminalIntegration, readAgentOutput } from '../src/core/terminalIntegration'
import { tempDir } from './helpers'

const row = (at: number, type: string, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n'
const started = (at: number, id: string) => row(at, 'event_msg', { type: 'task_started', turn_id: id, root_turn_id: id })
const input = (at: number, text: string) => row(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const done = (at: number, id: string, output: string) => row(at, 'event_msg', { type: 'task_complete', turn_id: id, root_turn_id: id, last_agent_message: output })

it('notify가 없어도 요청 뒤에 확정된 같은 턴만 읽고 한글이 조각난 줄·부분 쓰기를 보존한다', async () => {
  const dir = await tempDir('orbit-codex-capture-'), file = path.join(dir, 'session.jsonl')
  prepareTerminalIntegration(dir, 'codex', dir)
  const session = '11111111-2222-3333-4444-555555555555', prompt = beginOutputCapture(dir, '구현·검증…', session)
  const at = Date.now()
  const reader = new CodexCaptureReader(file, at)
  const text = started(at - 5000, 'old') + input(at - 5000, prompt) + done(at - 4000, 'old', '오래된 결과') + started(at + 1, 'current') + input(at + 2, prompt.replace(/[·…]/g, ''))
  await fs.writeFile(file, text)
  expect(await reader.read()).toMatchObject([{ activity: 'working', promptHash: capturePromptHash('구현·검증…') }])
  await fs.appendFile(file, done(at + 3, 'other-turn', '다른 턴'))
  expect(await reader.read()).toEqual([])
  const final = Buffer.from(done(at + 4, 'current', '정확한 최종 응답'))
  const split = final.indexOf(Buffer.from('최종')) + 1
  await fs.appendFile(file, final.subarray(0, split))
  expect(await reader.read()).toEqual([])
  await fs.appendFile(file, final.subarray(split))
  const events = await reader.read()
  expect(events).toMatchObject([{ activity: 'completed', output: '정확한 최종 응답' }])
  const event = events[0]
  expect(captureCodexResult(dir, 'other-session', event.promptHash, event.at, { output: event.output }, event.requestId)).toBe(false)
  expect(captureCodexResult(dir, session, event.promptHash, event.at, { output: event.output }, event.requestId)).toBe(true)
  expect(readAgentOutput(dir)).toBe('정확한 최종 응답')
  beginOutputCapture(dir, '구현·검증…', session)
  expect(captureCodexResult(dir, session, event.promptHash, event.at, { output: event.output }, event.requestId)).toBe(false)
  expect(await reader.read()).toEqual([])
})

it('중단된 턴과 본문 없는 완료는 오류로 마감하고 도구 출력이나 중간 답변으로 완료하지 않는다', async () => {
  const dir = await tempDir('orbit-codex-abort-'), file = path.join(dir, 'session.jsonl'), at = Date.now()
  const reader = new CodexCaptureReader(file, at)
  await fs.writeFile(file, started(at, 'one') + input(at, '첫 요청') + row(at, 'event_msg', { type: 'agent_message', message: '진행 중' }))
  expect(await reader.read()).toMatchObject([{ activity: 'working' }])
  await fs.appendFile(file, row(at + 1, 'event_msg', { type: 'turn_aborted', turn_id: 'one' }))
  expect(await reader.read()).toMatchObject([{ activity: 'idle', error: expect.stringContaining('취소') }])
  await fs.appendFile(file, started(at + 2, 'two') + input(at + 3, '둘째 요청') + row(at + 4, 'event_msg', { type: 'task_complete', turn_id: 'two', last_agent_message: null }))
  expect(await reader.read()).toMatchObject([{ activity: 'working' }, { activity: 'completed', error: expect.stringContaining('최종 응답') }])
})
