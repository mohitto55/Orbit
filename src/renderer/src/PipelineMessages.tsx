import { useEffect, useState } from 'react'
import { api } from './api'
import type { RunState } from './types'
import type { SessionMessage } from '../../core/sessionMessages'

export function PipelineMessages({ run }: { run?: RunState }) {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    setMessages([]); setError('')
    if (!run) return
    let stopped = false, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try { const result = await api.pipelineMessages(run.runId); if (!stopped) { setMessages(result); setError('') } }
      catch (error) { if (!stopped) setError(String(error)) }
      finally { pending = false }
    }
    void refresh()
    const timer = run.status === 'running' ? setInterval(() => void refresh(), 1000) : undefined
    return () => { stopped = true; clearInterval(timer) }
  }, [run?.runId, run?.status])
  return <>
    {error && <p className="small" role="alert">대화를 불러오지 못했습니다: {error}</p>}
    {!messages.length && !error && <p className="small muted">연결한 세션이 주고받은 메시지가 여기에 표시됩니다.</p>}
    {messages.map((message) => <article key={message.id} className="pipe-console-entry">
      <div className="small muted">{new Date(message.sentAt).toLocaleTimeString()} · {message.fromName} → {message.toName} · {message.read ? '전달됨' : '수신 대기'}</div>
      <pre>{message.text}</pre>
    </article>)}
  </>
}
