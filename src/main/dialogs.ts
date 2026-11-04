import { dialog, type BrowserWindow } from 'electron'

/** window.confirm은 Windows에서 닫힌 뒤 문자 입력을 막는다: electron/electron#41602. */
export function createDialogApi(getWindow: () => BrowserWindow | null) {
  return {
    async confirmAction(message: string): Promise<boolean> {
      const parent = getWindow()
      if (!parent || parent.isDestroyed()) return false
      const result = await dialog.showMessageBox(parent, {
        type: 'question', title: 'Orbit', message,
        buttons: ['취소', '확인'], defaultId: 0, cancelId: 0, noLink: true
      })
      return result.response === 1
    }
  }
}

export type DialogApi = ReturnType<typeof createDialogApi>
