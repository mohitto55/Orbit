import { beforeEach, expect, it, vi } from 'vitest'
import { dialog, type BrowserWindow } from 'electron'
import { createDialogApi } from '../src/main/dialogs'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))
const parent = { isDestroyed: () => false } as BrowserWindow

beforeEach(() => vi.mocked(dialog.showMessageBox).mockReset())

it('[PL-F01-AC4] 확인창 응답을 비동기로 기다리고 확인한 경우에만 진행한다', async () => {
  let answer!: (result: { response: number; checkboxChecked: boolean }) => void
  vi.mocked(dialog.showMessageBox).mockReturnValue(new Promise((resolve) => { answer = resolve }))
  const completed = vi.fn()
  const result = createDialogApi(() => parent).confirmAction('변경할까요?').then(completed)
  await Promise.resolve()
  expect(completed).not.toHaveBeenCalled()
  expect(dialog.showMessageBox).toHaveBeenCalledWith(parent, expect.objectContaining({
    message: '변경할까요?', buttons: ['취소', '확인'], defaultId: 0, cancelId: 0
  }))
  answer({ response: 1, checkboxChecked: false })
  await result
  expect(completed).toHaveBeenCalledWith(true)
})

it('취소나 창 닫기는 작업을 승인하지 않는다', async () => {
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
  expect(await createDialogApi(() => parent).confirmAction('삭제할까요?')).toBe(false)
})

it('부모 창이 없거나 종료됐다면 확인창 없이 취소한다', async () => {
  expect(await createDialogApi(() => null).confirmAction('삭제할까요?')).toBe(false)
  expect(await createDialogApi(() => ({ isDestroyed: () => true }) as BrowserWindow).confirmAction('삭제할까요?')).toBe(false)
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
})
