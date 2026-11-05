import { promises as fs } from 'fs'
import { capturePromptHash } from './terminalIntegration'

interface Row {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    role?: string
    turn_id?: string
    root_turn_id?: string
    message?: string
    last_agent_message?: string | null
    content?: { type?: string; text?: string }[]
  }
}
export interface CodexCaptureEvent {
  at: number
  promptHash: string
  requestId?: string
  activity: 'working' | 'completed' | 'idle'
  output?: string
  error?: string
}

/** 자동화 요청 이후 추가된 JSONL만 읽는다. 전체 대화나 중간 도구 출력은 보관하지 않는다. */
export class CodexCaptureReader {
  private pending = Buffer.alloc(0)
  private turn?: string
  private promptHash?: string
  private requestId?: string
  constructor(readonly file: string, private since: number, private offset = 0) {}

  async read(): Promise<CodexCaptureEvent[]> {
    const events: CodexCaptureEvent[] = []
    let handle
    try {
      handle = await fs.open(this.file, 'r')
      const { size } = await handle.stat()
      if (size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); this.turn = this.promptHash = this.requestId = undefined }
      const buffer = Buffer.alloc(Math.min(1024 * 1024, size - this.offset))
      if (!buffer.length) return events
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
      this.offset += bytesRead
      const input = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)])
      let from = 0
      for (let end = input.indexOf(10); end >= 0; end = input.indexOf(10, from)) {
        try {
          const row = JSON.parse(input.subarray(from, end).toString('utf8')) as Row
          const at = Date.parse(row.timestamp ?? ''), p = row.payload
          if (p && at >= this.since) {
            const turn = p.root_turn_id ?? p.turn_id
            if (row.type === 'event_msg' && p.type === 'task_started' && turn && turn !== this.turn) {
              this.turn = turn; this.promptHash = this.requestId = undefined
            }
            const text = row.type === 'response_item' && p.type === 'message' && p.role === 'user'
              ? p.content?.filter((c) => c.type === 'input_text').map((c) => c.text ?? '').join('\n')
              : row.type === 'event_msg' && p.type === 'user_message' ? p.message : undefined
            if (this.turn && text !== undefined) {
              this.promptHash = capturePromptHash(text)
              this.requestId = /<!-- orbit-request:([\w-]+) -->\s*$/.exec(text)?.[1]
              events.push({ at, promptHash: this.promptHash, requestId: this.requestId, activity: 'working' })
            }
            if (row.type === 'event_msg' && this.promptHash && turn === this.turn && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
              const output = p.last_agent_message
              events.push({ at, promptHash: this.promptHash, requestId: this.requestId, activity: p.type === 'task_complete' ? 'completed' : 'idle',
                ...(p.type === 'turn_aborted' ? { error: '터미널에서 작업이 취소되었습니다' }
                  : typeof output === 'string' && output.length <= 4 * 1024 * 1024 ? { output }
                    : { error: '응답은 종료됐지만 최종 응답을 수집하지 못했습니다. CLI 출력을 확인하세요' }) })
              this.turn = this.promptHash = this.requestId = undefined
            }
          }
        } catch { /* 기록 중인 부분 줄은 다음 읽기에서, 손상된 완성 줄은 건너뛴다. */ }
        from = end + 1
      }
      this.pending = input.subarray(from)
      if (this.pending.length > 8 * 1024 * 1024) this.pending = Buffer.alloc(0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally { await handle?.close() }
    return events
  }
}
