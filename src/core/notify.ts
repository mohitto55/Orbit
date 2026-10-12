/** 앱 기반: 알림 규칙. 같은 종류의 알림은 하루에 한 번만 보낸다. */
export class NotifyLog {
  private sent = new Map<string, string>()

  /** 보내도 되면 기록하고 true. 오늘 이미 보낸 종류면 false. */
  take(kind: string, now = new Date()): boolean {
    const today = now.toDateString()
    if (this.sent.get(kind) === today) return false
    this.sent.set(kind, today)
    return true
  }
}

/** Inbox 정리 알림은 설정한 시각(HH:MM) 이후에만 보낸다. */
export function afterTime(reminderTime: string, now = new Date()): boolean {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return hhmm >= reminderTime
}
