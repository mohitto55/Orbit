import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Ctx } from '../core/workspace'
import { cleanEnv } from '../core/terminal'
import { decideFinding, lastCheckAt, listAiChecks, runAiCheck, type AgentRunner, type CheckAgent } from '../core/aicheck'
import { resolveRequest } from '../core/drift'
import { lineDiff } from '../core/diff'
import { clearDraft, parseDraft, readDraft, requestDraftInput, writeDraft } from '../core/requestDraft'

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

/** 요청 파일의 수정안을 지금 도메인 문서와 비교한다. */
async function draftView(ctx: Ctx, id: string) {
  const { request, domain } = await requestDraftInput(ctx, id)
  const draft = await readDraft(request.file)
  if (!draft) return null
  // 문서 앞의 빈 줄(앞머리 다음 줄바꿈)은 원래대로 둬서 비교에 가짜 변경이 생기지 않게 한다
  const after = (domain.content.match(/^\s*/)?.[0] ?? '') + draft.content
  return {
    agent: draft.agent,
    at: draft.at,
    base: draft.base,
    currentVersion: domain.version,
    before: domain.content,
    after,
    diff: lineDiff(domain.content, after, 3),
    fullDiff: lineDiff(domain.content, after, -1)
  }
}

export function createAiCheckApi(deps: { send: (channel: string, payload: unknown) => void; getCtx: () => Promise<Ctx | null> }) {
  let running = false
  let drafting = false
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
    /** IR-F08: 변경 요청을 AI에게 넘겨 도메인 문서 수정안을 받고, 그 요청 파일에 저장한다. 도메인 문서는 고치지 않는다. */
    async requestAiDraft(id: string, agent: CheckAgent) {
      if (drafting) throw new Error('AI가 이미 수정안을 만드는 중입니다')
      drafting = true
      try {
        const ctx = await need()
        const { request, domain, prompt } = await requestDraftInput(ctx, id)
        const out = await runAgent(agent, prompt, ctx.projectDir, (chunk) => deps.send('request-draft-output', chunk))
        await writeDraft(request.file, { agent, base: domain.version, content: parseDraft(out) })
        return draftView(ctx, id)
      } finally {
        drafting = false
      }
    },
    /** IR-F08: 요청 파일에 저장된 수정안과 지금 도메인 문서의 비교. 없으면 null. */
    async requestDraft(id: string) {
      return draftView(await need(), id)
    },
    /** IR-F08: 사람이 다듬은 수정안을 요청 파일에 다시 저장한다. */
    async requestSaveDraft(id: string, content: string) {
      const ctx = await need()
      const { request } = await requestDraftInput(ctx, id)
      const cur = await readDraft(request.file)
      if (!cur) throw new Error('저장된 수정안이 없습니다')
      await writeDraft(request.file, { agent: cur.agent, base: cur.base, content: content.replace(/^\s+/, '') })
      return draftView(ctx, id)
    },
    /** IR-F08: 수정안을 요청 파일에서 지운다. 요청은 그대로 둔다. */
    async requestDiscardDraft(id: string) {
      const ctx = await need()
      const { request } = await requestDraftInput(ctx, id)
      await clearDraft(request.file)
    },
    /** DR-F08: 점검 항목을 받아들이거나 무시한다. */
    async aiDecide(checkId: string, findingId: string, accept: boolean) {
      return decideFinding(await need(), checkId, findingId, accept)
    }
  }
}

export type AiCheckApi = ReturnType<typeof createAiCheckApi>
