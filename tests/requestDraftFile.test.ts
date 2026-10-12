import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { writeMd, readMd } from '../src/core/md'
import { clearDraft, readDraft, writeDraft } from '../src/core/requestDraft'
import { listRequests } from '../src/core/drift'
import { newProject } from './helpers'

async function requestFile() {
  const ctx = await newProject()
  const file = path.join(ctx.dataRoot, 'requests', 'req-1.md')
  const body = '## 용어 추가\n\n시작일과 종료일을 용어 표에 넣는다.\n\n> "근거 인용"\n'
  await writeMd(file, { id: 'req-1', kind: 'domain-request', domain: 'dom-a', excerpt: '근거 인용', source: 'manual', status: 'pending', created: '2026-10-12T00:00:00Z' }, body)
  return { ctx, file, body }
}

describe('요청 파일의 AI 수정안', () => {
  it('저장하면 다시 읽을 수 있고, 목록에 수정안 시각이 보인다', async () => {
    const { ctx, file } = await requestFile()
    expect(await readDraft(file)).toBeNull()
    await writeDraft(file, { agent: 'claude', base: 3, content: '# 도메인 {#s1}\n\n```md\n코드\n```\n' })
    const d = await readDraft(file)
    expect(d).toMatchObject({ agent: 'claude', base: 3, content: '# 도메인 {#s1}\n\n```md\n코드\n```\n' })
    const [req] = await listRequests(ctx)
    expect(req.draftAt).toBe(d!.at)
    expect(await fs.readFile(file, 'utf8')).toContain('## AI 수정안')
  })

  it('다시 저장하면 수정안을 덮어쓰고 쌓이지 않는다', async () => {
    const { file } = await requestFile()
    await writeDraft(file, { agent: 'claude', base: 1, content: '첫 수정안\n' })
    await writeDraft(file, { agent: 'codex', base: 2, content: '둘째 수정안\n' })
    expect((await readDraft(file))?.content).toBe('둘째 수정안\n')
    const raw = await fs.readFile(file, 'utf8')
    expect(raw.match(/## AI 수정안/g)).toHaveLength(1)
    expect(raw).not.toContain('첫 수정안')
  })

  it('지우면 요청 원래 내용과 앞머리만 남는다', async () => {
    const { file, body } = await requestFile()
    await writeDraft(file, { agent: 'claude', base: 1, content: '수정안\n' })
    await clearDraft(file)
    const { data, content } = await readMd(file)
    expect(content.trim()).toBe(body.trim())
    expect(data.draftAt).toBeUndefined()
    expect(data.status).toBe('pending')
  })
})
