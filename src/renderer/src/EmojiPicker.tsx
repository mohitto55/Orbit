import { useState } from 'react'
import { normalizeEmoji } from '../../core/emoji'
import { Modal } from './ui'

const EMOJIS = ['📋', '✅', '⭐', '🎯', '🚀', '💡', '🔧', '⚙️', '🔍', '🔒', '🔑', '👤', '👥', '💬', '🔔', '📨', '🛒', '💳', '💰', '🎁', '📦', '📁', '📝', '📊', '📅', '⏱️', '🌐', '📱', '🎮', '❤️', '🔥', '🐛']

export function EmojiPicker({ title, value, onPick, onClose }: { title: string; value?: string; onPick: (emoji: string | undefined) => void; onClose: () => void }) {
  const [text, setText] = useState(value ?? '')
  const [error, setError] = useState('')
  const apply = (next: string) => {
    try { onPick(normalizeEmoji(next)); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <Modal title={title} onClose={onClose}>
    <div className="emoji-options" role="group" aria-label="이모지 선택">
      {EMOJIS.map((emoji) => <button type="button" key={emoji} aria-label={`${emoji} 아이콘`} aria-pressed={value === emoji} onClick={() => apply(emoji)}>{emoji}</button>)}
    </div>
    <form onSubmit={(e) => { e.preventDefault(); apply(text) }}>
      <div className="field"><label htmlFor="emoji-value">직접 입력</label>
        <input id="emoji-value" autoFocus value={text} maxLength={64} placeholder="이모지 한 개를 입력하거나 붙여넣으세요" onChange={(e) => { setText(e.target.value); setError('') }} />
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="row between">
        <button type="button" onClick={() => apply('')}>아이콘 없애기</button>
        <div className="row"><button type="button" onClick={onClose}>취소</button><button type="submit" className="primary">적용</button></div>
      </div>
    </form>
  </Modal>
}
