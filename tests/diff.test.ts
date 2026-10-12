import { describe, expect, it } from 'vitest'
import { lineDiff, changeDiff } from '../src/core/diff'
import { createDomain, saveDomain } from '../src/core/domain'
import { newProject } from './helpers'

describe('변경 검토 · 비교', () => {
  it('[IR-F03-AC3] 이전/이후를 줄 단위로 비교해 추가·삭제를 구분한다', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
    const d = lineDiff(before, after, 1)
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    // 바뀐 곳 주변 1줄만 남기고 접는다
    expect(d.hunks[0].skippedBefore).toBe(3)
    expect(d.hunks[0].lines.map((l) => `${l.type}:${l.text}`)).toEqual(['ctx:d', 'del:e', 'add:E', 'ctx:f'])
    expect(d.hunks[1].lines.at(-1)).toMatchObject({ type: 'add', text: 'k', newNo: 11 })
  })

  it('[IR-F03-AC1] 저장할 때 남긴 스냅샷으로 변경 전·후를 볼 수 있다', async () => {
    const ctx = await newProject()
    const d = await createDomain(ctx, { title: '주문', folder: 'order', role: '주문을 받는다' })
    const { change } = await saveDomain(ctx, d.id, { content: d.content.replace('주문을 받는다', '주문을 받고 취소한다') }, { size: 'major', summary: '취소 추가' })
    const r = await changeDiff(ctx, change)
    expect('unavailable' in r).toBe(false)
    if ('unavailable' in r) return
    expect(r.file).toBe('domains/order/domain.md')
    const diff = lineDiff(r.before, r.after)
    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'ctx').map((l) => `${l.type}:${l.text}`)
    expect(changed).toContain('del:주문을 받는다')
    expect(changed).toContain('add:주문을 받고 취소한다')
  })
})
