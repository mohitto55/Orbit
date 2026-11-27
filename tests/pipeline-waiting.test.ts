import { expect, it, vi } from 'vitest'
import { PipelineRunner } from '../src/core/pipeline'

it('새 탭 준비와 권한 승인을 기다리는 동안 노드에 이유를 보여주고, 다시 일하면 지운다', async () => {
  let ready!: () => void
  const states: string[] = []
  const runner = new PipelineRunner({
    createTerminal: async (kind) => ({ id: 't1', kind, title: '', pid: 1 }), hasTerminal: () => true, getTerminal: (id) => ({ id, kind: 'claude', title: '', pid: 1 }),
    whenReady: () => new Promise<void>((resolve) => { ready = resolve }), submit: vi.fn(), runCommand: vi.fn(), completeTasks: async () => {},
    emit: (st) => states.push(st.nodes.a.message ?? '')
  })
  runner.start({ id: 'g', title: 'g', file: '', nodes: [{ id: 'a', kind: 'claude', text: '작업', terminal: 'new' }], edges: [] })
  await vi.waitFor(() => expect(states.at(-1)).toContain('입력 준비'))
  ready()
  await vi.waitFor(() => expect(runner.list()[0].nodes.a.status).toBe('running'))
  expect(runner.list()[0].nodes.a.message).toBeUndefined()
  expect(runner.agentWaiting('t1', true)?.nodes.a.message).toContain('권한 승인')
  expect(runner.agentWaiting('t1', false)?.nodes.a.message).toBeUndefined()
  // 다른 이유의 메시지는 승인 해제 신호로 지우지 않는다
  expect(runner.agentWaiting('t1', false)).toBeNull()
  expect(runner.agentWaiting('other', true)).toBeNull()
})
