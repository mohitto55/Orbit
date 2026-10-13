import { promises as fs } from 'fs'
import { describe, expect, it } from 'vitest'
import { createTask, listTasks, updateTask } from '../src/core/task'
import { restoreFiles, snapshotFiles } from '../src/core/undo'
import { readChecklist, setChecklistChecked } from '../src/renderer/src/checklistMarkdown'
import { newProject } from './helpers'

const body = `최신 앱·서버 구현을 확인한다.

완료 조건:
- [ ] 공개 댓글의 사용자 차단·해제 기능과 출시 범위를 확인한다.
- [x] 공개 댓글용 서버 사용자 차단·해제와 댓글 숨김을 구현한다.
- [ ] 앱에서 사용자 차단·해제 화면을 서버 API에 연결한다.
- [ ] 차단 사용자 콘텐츠의 숨김과 해제 후 동작을 실제 앱에서 검증한다.

근거:
- \\shared\\user_block\\application\\user_block_command_service.py

## 재확인 (2026-10-13)

회귀 93건 통과. 실제 앱 검증은 남긴다.`

describe('Task 완료 조건', () => {
  it('[TK-F12-AC1] 기존 본문의 완료 조건과 완료 개수를 읽는다', () => {
    const items = readChecklist(body)
    expect(items.map((item) => item.checked)).toEqual([false, true, false, false])
    expect(items[2].text).toBe('앱에서 사용자 차단·해제 화면을 서버 API에 연결한다.')
    expect(readChecklist('일반 메모\n\n- 일반 목록')).toEqual([])
  })

  it('[TK-F12-AC2] 코드·HTML 예제는 제외하고 번호·중첩·여러 줄 조건을 읽는다', () => {
    const md = '```md\n- [ ] 코드 예제\n```\n\n    - [x] 들여쓴 코드\n\n<!--\n- [ ] 주석\n-->\n\n1. [X] **서버** 완료\n   - [ ] `앱` 연결\n     후 검증\n\n> - [ ] 출시 확인'
    const items = readChecklist(md)
    expect(items.map((item) => [item.checked, item.text])).toEqual([
      [true, '서버 완료'],
      [false, '앱 연결\n후 검증'],
      [false, '출시 확인']
    ])
    expect(setChecklistChecked(md, items[1].offset, true)).toBe(md.replace('- [ ] `앱`', '- [x] `앱`'))
    expect(() => setChecklistChecked(md, md.indexOf('[ ]') + 1, true)).toThrow(/완료 조건/)
  })

  it('[TK-F12-AC2] 같은 문구의 조건도 구분하며 CRLF·서식·근거를 그대로 보존한다', () => {
    const md = '설명\r\n\r\n- [ ] **확인**\r\n- [ ] **확인**\r\n\r\n근거: [문서](./memo.md)\r\n'
    const items = readChecklist(md)
    const checked = setChecklistChecked(md, items[1].offset, true)
    expect(checked).toBe('설명\r\n\r\n- [ ] **확인**\r\n- [x] **확인**\r\n\r\n근거: [문서](./memo.md)\r\n')
    expect(setChecklistChecked(checked, items[1].offset, false)).toBe(md)
  })

  it('[TK-F12-AC3] 체크·해제가 파일에 저장되고 재조회·되돌리기 후에도 일치한다', async () => {
    const ctx = await newProject()
    const task = await createTask(ctx, { title: '공개 댓글 차단', type: 'feature', horizon: '지금', body })
    const snaps = await snapshotFiles(ctx, [task.file])
    const item = readChecklist(task.body)[2]
    const nextBody = setChecklistChecked(task.body, item.offset, true)
    await updateTask(ctx, task.id, { body: nextBody }, task.body)
    const [saved] = await listTasks(ctx)
    expect(saved.body).toBe(nextBody)
    expect(saved.status).toBe('대기')
    expect(await fs.readFile(task.file, 'utf8')).toContain('- [x] 앱에서 사용자 차단·해제 화면을 서버 API에 연결한다.')

    const unchecked = setChecklistChecked(saved.body, item.offset, false)
    await updateTask(ctx, task.id, { body: unchecked }, saved.body)
    expect((await listTasks(ctx))[0].body).toBe(task.body)
    await updateTask(ctx, task.id, { body: nextBody }, task.body)
    await restoreFiles(ctx, snaps)
    expect((await listTasks(ctx))[0]).toEqual(task)
  })

  it('[TK-F12-AC4] 조건을 모두 체크하거나 해제해도 Task 상태는 별도로 유지한다', async () => {
    const ctx = await newProject()
    const task = await createTask(ctx, { title: '검증', type: 'test', horizon: '지금', body: '- [ ] 실제 앱 확인' })
    const item = readChecklist(task.body)[0]
    const checked = await updateTask(ctx, task.id, { body: setChecklistChecked(task.body, item.offset, true) }, task.body)
    expect(checked.status).toBe('대기')
    await updateTask(ctx, task.id, { status: '완료' })
    const unchecked = await updateTask(ctx, task.id, { body: task.body }, checked.body)
    expect(unchecked.status).toBe('완료')
  })

  it('[TK-F12-AC5] 외부에서 바뀐 본문을 오래된 체크 상태로 덮어쓰지 않는다', async () => {
    const ctx = await newProject()
    const task = await createTask(ctx, { title: '차단', type: 'feature', horizon: '지금', body })
    const latest = body + '\n\n후속 검증 근거 추가'
    await updateTask(ctx, task.id, { body: latest, status: '진행' })
    const item = readChecklist(body)[0]
    await expect(updateTask(ctx, task.id, { body: setChecklistChecked(body, item.offset, true) }, body)).rejects.toThrow(/다른 곳에서/)
    expect((await listTasks(ctx))[0]).toMatchObject({ body: latest, status: '진행' })
    // 본문이 같다면 새 상태·메타데이터는 보존하면서 체크할 수 있다.
    const updated = await updateTask(ctx, task.id, { body: setChecklistChecked(latest, item.offset, true) }, latest)
    expect(updated.status).toBe('진행')
    expect(updated.body).toContain('후속 검증 근거 추가')
  })
})
