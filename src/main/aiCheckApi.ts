import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Ctx } from '../core/workspace'
import { cleanEnv } from '../core/terminal'
import { decideFinding, lastCheckAt, listAiChecks, runAiCheck, type AgentRunner, type CheckAgent } from '../core/aicheck'
import { resolveRequest } from '../core/drift'

const TIMEOUT_MS = 10 * 60 * 1000

/**
 * Claude Code / Codex를 비대화 모드로 실행해 최종 응답을 받는다.
 * 요청문은 길어서 명령줄 인자가 아니라 표준 입력으로 넘긴다.
 */
export const runAgent: AgentRunner = (agent, prompt, cwd, onOutput) =>
  new Promise((resolve, reject) => {
    const env = cleanEnv(process.env)
    const lastMsg = path.join(os.tmpdir(), `girsktop-codex-${Date.now()}.txt`)
    const [cmd, args] =
      agent === 'claude'
        ? ['claude', ['-p', '--output-format', 'text']]
        : ['codex', ['exec', '--skip-git-repo-check', '--output-last-message', lastMsg, '-']]
    // codex는 npm 셸 스크립트(.cmd)라 Windows에서는 셸을 거쳐야 실행된다
    const proc = spawn(cmd, args as string[], { cwd, env, shell: process.platform === 'win32' && agent === 'codex' })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('AI 점검이 10분 안에 끝나지 않았습니다'))
    }, TIMEOUT_MS)
    proc.stdout.on('data', (d) => {
      out += d.toString()
      onOutput(d.toString())
    })
    proc.stderr.on('data', (d) => {
      err += d.toString()
      onOutput(d.toString())
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${agent === 'claude' ? 'Claude Code' : 'Codex'}를 실행할 수 없습니다: ${e.message}`))
    })
    proc.on('close', async (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`${agent} 종료 코드 ${code}: ${(err || out).slice(-500)}`))
      if (agent === 'codex') {
        try {
          out = await fs.readFile(lastMsg, 'utf8')
          await fs.rm(lastMsg, { force: true })
        } catch {
          // 마지막 메시지 파일이 없으면 표준 출력 전체에서 결과를 찾는다
        }
      }
      resolve(out)
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })

export function createAiCheckApi(deps: { send: (channel: string, payload: unknown) => void; getCtx: () => Promise<Ctx | null> }) {
  let running = false
  const need = async () => {
    const ctx = await deps.getCtx()
    if (!ctx) throw new Error('프로젝트가 열려 있지 않습니다')
    return ctx
  }
  return {
    /** DR-F07: AI에게 지난 점검 이후를 점검시킨다. */
    async aiCheckRun(agent: CheckAgent) {
      if (running) throw new Error('점검이 이미 진행 중입니다')
      running = true
      try {
        const ctx = await need()
        return await runAiCheck(ctx, agent, runAgent, (chunk) => deps.send('aicheck-output', chunk))
      } finally {
        running = false
      }
    },
    aiCheckRunning: () => running,
    async aiChecks() {
      return listAiChecks(await need())
    },
    async aiLastCheckAt() {
      return lastCheckAt(await need())
    },
    /** IR-F08: 변경 요청을 반영 완료 또는 반려로 닫는다. */
    async requestResolve(id: string, status: 'done' | 'rejected', note?: string) {
      return resolveRequest(await need(), id, status, note)
    },
    /** DR-F08: 점검 항목을 받아들이거나 무시한다. */
    async aiDecide(checkId: string, findingId: string, accept: boolean) {
      return decideFinding(await need(), checkId, findingId, accept)
    }
  }
}

export type AiCheckApi = ReturnType<typeof createAiCheckApi>
