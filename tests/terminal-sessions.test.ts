import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { encodeClaudeProjectDir } from '../src/core/drift'
import { listTerminalSessions, renameTerminalSession } from '../src/core/terminalSessions'
import { readSettings, saveSettings, openProject } from '../src/core/workspace'
import { newProject, tempDir } from './helpers'

describe('터미널 저장된 대화', () => {
  it('[TE-F01-AC3] 앱을 다시 열어도 프로젝트의 대화 ID와 변경한 이름을 읽고 원본은 보존한다 [TE-F01-AC4]', async () => {
    const ctx = await newProject()
    const other = await newProject()
    const home = await tempDir('terminal-home-')
    const claudeDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(ctx.projectDir))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '15')
    await fs.mkdir(claudeDir, { recursive: true })
    await fs.mkdir(codexDir, { recursive: true })
    const claude = JSON.stringify({ type: 'user', sessionId: 'claude-one', message: { content: '주문 취소' } }) + '\n'
    const codex = (id: string, cwd: string) => [
      { type: 'session_meta', payload: { id, cwd } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '결제 재시도' }] } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n'
    const claudeFile = path.join(claudeDir, 'claude-one.jsonl')
    const codexFile = path.join(codexDir, 'one.jsonl')
    await fs.writeFile(claudeFile, claude)
    await fs.writeFile(codexFile, codex('codex-one', ctx.projectDir))
    await fs.writeFile(path.join(codexDir, 'other.jsonl'), codex('codex-other', other.projectDir))

    const first = await listTerminalSessions(ctx, home)
    expect(first.errors).toEqual([])
    expect(first.sessions.map((s) => s.id).sort()).toEqual(['claude:claude-one', 'codex:codex-one'])
    await renameTerminalSession(ctx, 'codex:codex-one', '  결제 작업  ')
    const reopened = await openProject(ctx.projectDir)
    expect((await listTerminalSessions(reopened, home)).sessions).toContainEqual(expect.objectContaining({ id: 'codex:codex-one', sessionId: 'codex-one', title: '결제 작업' }))
    expect((await listTerminalSessions(other, home)).sessions).toEqual([expect.objectContaining({ id: 'codex:codex-other', title: '결제 재시도' })])
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(claude)
    expect(await fs.readFile(codexFile, 'utf8')).toBe(codex('codex-one', ctx.projectDir))
  })

  it('비어 있는 기록은 빈 목록으로, 한 에이전트의 읽기 실패는 오류로 반환한다', async () => {
    const ctx = await newProject()
    const home = await tempDir('terminal-home-')
    expect(await listTerminalSessions(ctx, home)).toEqual({ sessions: [], errors: [] })
    const brokenDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(ctx.projectDir))
    await fs.mkdir(path.dirname(brokenDir), { recursive: true })
    await fs.writeFile(brokenDir, 'not a directory')
    const result = await listTerminalSessions(ctx, home)
    expect(result.sessions).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('Claude Code')])
  })

  it('[TE-F01-AC2] 사용자 실행·재개 명령이 프로젝트 설정에 저장된다', async () => {
    const ctx = await newProject()
    const settings = { ...await readSettings(ctx), claudeCommand: 'claude --model sonnet', codexCommand: 'codex --profile work', claudeResumeCommand: 'my-claude --resume {sessionId}', codexResumeCommand: 'my-codex resume {sessionId}' }
    await saveSettings(ctx, settings)
    expect(await readSettings(await openProject(ctx.projectDir))).toEqual(settings)
    await expect(saveSettings(ctx, { ...settings, codexResumeCommand: 'codex resume --last' })).rejects.toThrow('{sessionId}')
    expect(await readSettings(ctx)).toEqual(settings)
  })

  it('이름과 대화 ID를 검증해 폴더 밖에 파일을 쓰지 않는다', async () => {
    const ctx = await newProject()
    await expect(renameTerminalSession(ctx, 'codex:../../outside', '이름')).rejects.toThrow('ID')
    await expect(renameTerminalSession(ctx, 'shell:session', '이름')).rejects.toThrow('ID')
    await expect(renameTerminalSession(ctx, 'codex:valid', '   ')).rejects.toThrow('1~100')
  })
})
