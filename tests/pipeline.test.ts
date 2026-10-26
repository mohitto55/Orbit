import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'node-pty'
import { newProject, tempDir } from './helpers'
import {
  NODE_KINDS,
  PipelineRunner,
  dataItems,
  dataShape,
  dataValue,
  edgeProblem,
  expandPipeline,
  innerValues,
  newNodeId,
  pipelineProblems,
  uniqueName,
  type PipeNode,
  type Pipeline,
  type RunnerDeps,
  type RunState
} from '../src/core/pipeline'
import { deletePipeline, listPipelines, savePipeline } from '../src/core/pipelineStore'
import { TerminalManager, terminalCommand, type TerminalKind } from '../src/core/terminal'
import { prepareTerminalIntegration, takeAgentSignal } from '../src/core/terminalIntegration'
import { listSkills, skillId } from '../src/core/skills'

const node = (id: string, kind: PipeNode['kind'] = 'claude', terminal: PipeNode['terminal'] = 'new'): PipeNode => ({ id, kind, text: `${id} 할 일`, terminal })
const pipe = (nodes: PipeNode[], edges: [string, string][]): Pipeline => ({ id: 'p1', title: '테스트', nodes, edges: edges.map(([from, to]) => ({ from, to })), file: '' })

/** 가짜 터미널로 돌리는 실행기. 시계는 직접 넘긴다. */
function setup(overrides: Partial<RunnerDeps> = {}) {
  let clock = 0
  let seq = 0
  const opened: { id: string; kind: TerminalKind; session?: string }[] = []
  const sent: { termId: string; text: string; via: 'submit' | 'command' }[] = []
  const live = new Set<string>()
  let last: RunState | null = null
  const completed: string[] = []
  const runner = new PipelineRunner({
    createTerminal: async (kind, _label, session) => {
      const id = `term-${++seq}`
      opened.push({ id, kind, ...(session ? { session } : {}) })
      live.add(id)
      return { id, kind, title: kind, pid: 0 }
    },
    hasTerminal: (id) => live.has(id),
    getTerminal: (id) => {
      const terminal = opened.find((t) => t.id === id)
      return terminal && live.has(id) ? { id, kind: terminal.kind, title: id, pid: 1 } : undefined
    },
    whenReady: async () => {},
    submit: (termId, text) => sent.push({ termId, text, via: 'submit' }),
    runCommand: (termId, text) => sent.push({ termId, text, via: 'command' }),
    completeTasks: async (ids) => void completed.push(...ids),
    emit: (s) => (last = s),
    now: () => clock,
    ...overrides
  })
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { runner, opened, sent, live, completed, state: () => last!, tick: (ms = 5000) => (clock += ms), settle }
}

describe('연동 · 터미널 작업 그래프', () => {
  it('[DM-F02-AC4] 새 탭 준비 중에는 중복 입력을 막고, 이후 재사용할 때는 준비를 다시 기다리지 않는다', async () => {
    let ready: () => void = () => {}
    let opened = false
    const whenReady = vi.fn(() => new Promise<void>((resolve) => { ready = resolve }))
    const { runner, sent, settle } = setup({
      createTerminal: async (kind) => {
        const reused = opened
        opened = true
        return { id: 'shared', kind, title: '기존 세션', pid: 1, reused }
      },
      whenReady
    })
    const first = runner.start(pipe([node('a', 'codex')], []))
    await settle()
    expect(runner.list()[0].nodes.a.status).toBe('starting')
    expect(sent).toEqual([])
    // 준비 중에 도착한 지난 응답의 끝 신호로 터미널 점유를 풀면 안 된다.
    expect(runner.agentDone('shared', true)).toBeNull()
    const other = runner.start({ ...pipe([node('b', 'codex')], []), id: 'p2' })
    await settle()
    expect(runner.list().find((r) => r.runId === other.runId)?.nodes.b.status).toBe('failed')
    expect(sent).toEqual([])
    ready()
    await settle()
    expect(sent.map((s) => s.text)).toEqual(['a 할 일'])
    runner.markDone(first.runId, 'a')
    runner.start({ ...pipe([node('c', 'codex')], []), id: 'p3' })
    await settle()
    expect(sent.map((s) => s.text)).toEqual(['a 할 일', 'c 할 일'])
    expect(whenReady).toHaveBeenCalledTimes(1)
  })

  it('[DM-F02-AC4] 새 탭 준비가 실패해도 터미널을 계속 점유하지 않는다', async () => {
    let reused = false
    const { runner, sent, settle } = setup({
      createTerminal: async (kind) => ({ id: 'shared', kind, title: '기존 세션', pid: 1, reused }),
      whenReady: async () => { throw new Error('준비 실패') }
    })
    runner.start(pipe([node('a', 'codex')], []))
    await settle()
    expect(runner.list()[0].status).toBe('failed')
    reused = true
    runner.start({ ...pipe([node('b', 'codex')], []), id: 'p2' })
    await settle()
    expect(sent.map((s) => s.text)).toEqual(['b 할 일'])
  })

  it('[IN-F11-AC1] 작업 그래프를 저장하고 다시 읽는다 (없는 노드를 잇는 선·자기 자신으로 가는 선은 버린다)', async () => {
    const ctx = await newProject()
    const saved = await savePipeline(ctx, {
      title: '구현 후 테스트',
      nodes: [node('n1'), node('n2', 'shell')],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n1', to: 'n9' },
        { from: 'n2', to: 'n2' }
      ]
    })
    expect(saved.edges).toEqual([{ from: 'n1', to: 'n2' }])
    expect((await listPipelines(ctx))[0]).toMatchObject({ title: '구현 후 테스트', nodes: [{ id: 'n1', kind: 'claude' }, { id: 'n2', kind: 'shell' }] })
    await deletePipeline(ctx, saved.id)
    expect(await listPipelines(ctx)).toEqual([])
  })

  it('[IN-F11-AC2] 고리, 빈 내용, 이어 쓸 앞 터미널이 없는 노드는 실행 전에 알려준다', () => {
    expect(pipelineProblems(pipe([node('a'), node('b')], [['a', 'b'], ['b', 'a']]))).toContain('실행 선이 고리를 이룹니다 (끝나지 않는 순환)')
    expect(pipelineProblems(pipe([{ ...node('a'), text: ' ' }], []))).toEqual(['a: 내용이 비어 있습니다'])
    expect(pipelineProblems(pipe([node('a', 'shell'), node('b', 'claude', 'continue')], [['a', 'b']]))[0]).toContain('같은 종류')
    expect(pipelineProblems(pipe([node('a'), node('b', 'claude', 'continue'), node('c', 'claude', 'continue')], [['a', 'b'], ['a', 'c']]))[0]).toContain('함께 이어 쓸 수 없습니다')
    expect(pipelineProblems(pipe([node('a'), node('b', 'claude', 'continue')], [['a', 'b']]))).toEqual([])
  })

  it('[IN-F11-AC3] 앞 작업이 끝나면 다음 작업을 실행하고, 갈래는 동시에, 모이는 곳은 모두 끝난 뒤에 실행한다', async () => {
    const { runner, opened, sent, state, tick, settle } = setup()
    // a → b, a → c, (b, c) → d
    runner.start(pipe([node('a'), node('b'), node('c', 'codex'), node('d', 'shell')], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]))
    await settle()
    expect(sent.map((s) => s.text)).toEqual(['a 할 일'])
    tick()
    runner.agentDone('term-1')
    await settle()
    expect(sent.map((s) => s.text)).toEqual(['a 할 일', 'b 할 일', 'c 할 일'])
    expect(opened.map((o) => o.kind)).toEqual(['claude', 'claude', 'codex'])
    tick()
    runner.agentDone('term-2')
    await settle()
    expect(state().nodes.d.status).toBe('waiting')
    tick()
    runner.agentDone('term-3')
    await settle()
    expect(sent.at(-1)).toMatchObject({ text: 'd 할 일', via: 'command' })
    runner.commandDone('term-4', 0)
    expect(state().status).toBe('done')
  })

  it('[IN-F11-AC4] "이어서" 노드는 앞 노드의 터미널에 프롬프트를 보낸다', async () => {
    const { runner, opened, sent, tick, settle } = setup()
    runner.start(pipe([node('a'), node('b', 'claude', 'continue')], [['a', 'b']]))
    await settle()
    // 보낸 직후 늦게 온 이전 응답의 끝 신호는 무시한다
    expect(runner.agentDone('term-1')).toBeNull()
    tick()
    runner.agentDone('term-1')
    await settle()
    expect(opened).toHaveLength(1)
    expect(sent.map((s) => s.termId)).toEqual(['term-1', 'term-1'])
  })

  it('[IN-F11-AC5] 셸 명령이 실패하거나 터미널이 닫히면 그 노드는 실패, 뒤 작업은 건너뛰고 다른 갈래는 계속한다', async () => {
    const { runner, state, tick, settle } = setup()
    // s(셸) → x, y는 따로
    runner.start(pipe([node('s', 'shell'), node('x'), node('y')], [['s', 'x']]))
    await settle()
    runner.commandDone('term-1', 2)
    await settle()
    expect(state().nodes.s).toMatchObject({ status: 'failed', code: 2 })
    expect(state().nodes.x.status).toBe('skipped')
    expect(state().status).toBe('running')
    tick()
    runner.terminalExit('term-2')
    expect(state().nodes.y.status).toBe('failed')
    expect(state().status).toBe('failed')
  })

  it('[IN-F11-AC6] 중지하면 남은 작업을 보내지 않고, 신호를 놓친 노드는 직접 끝남으로 넘길 수 있다', async () => {
    const { runner, sent, state, settle } = setup()
    const r = runner.start(pipe([node('a'), node('b'), node('c')], [['a', 'b'], ['b', 'c']]))
    await settle()
    runner.markDone(r.runId, 'a')
    await settle()
    expect(state().nodes.a.status).toBe('done')
    runner.stop(r.runId)
    expect(state()).toMatchObject({ status: 'stopped', nodes: { b: { status: 'skipped' }, c: { status: 'skipped' } } })
    runner.agentDone('term-2')
    expect(sent).toHaveLength(2)
  })
})

describe('연동 · 작업 그래프 데이터 노드와 템플릿', () => {
  const text = (id: string, t: string, y = 0): PipeNode => ({ id, kind: 'text', text: t, terminal: 'new', y })
  const lib = (id: string, title: string, nodes: PipeNode[], edges: [string, string][]) => ({ id, title, nodes, edges: edges.map(([from, to]) => ({ from, to })) })

  it('[IN-F12-AC1] 텍스트·합치기 노드의 글이 데이터 선을 따라 실행 노드의 프롬프트 뒤에 붙는다 (위에 있는 입력부터)', () => {
    const g = pipe(
      [{ ...node('a'), text: '기능을 구현해' }, text('t1', '규칙: 테스트 먼저', 10), text('t2', '규칙: 한국어 주석', 50), { id: 'j', kind: 'join', text: '', terminal: 'new' }],
      [['t2', 'j'], ['t1', 'j'], ['j', 'a']]
    )
    const flat = expandPipeline(g)
    expect(flat.nodes).toHaveLength(1)
    expect(flat.nodes[0].text).toBe('기능을 구현해\n\n규칙: 테스트 먼저\n\n규칙: 한국어 주석')
    // 실행 노드의 글이 비어 있어도 데이터로 채워지면 실행할 수 있다
    expect(pipelineProblems(pipe([{ ...node('a'), text: '' }, text('t', '할 일')], [['t', 'a']]))).toEqual([])
    expect(pipelineProblems(pipe([node('a'), text('t', 'x')], [['a', 't']]))[0]).toContain('데이터 노드로는 이을 수 없습니다')
  })

  it('[IN-F12-AC4] 텍스트 노드에 글이 들어오면 적어 둔 글 대신 들어온 글을 내보내고, 할 일 노드에는 입력을 이을 수 없다', () => {
    const g = pipe([text('src', '들어온 글'), text('t', '적어 둔 글'), node('a')], [['src', 't'], ['t', 'a']])
    expect(expandPipeline(g).nodes[0].text).toBe('a 할 일\n\n들어온 글')
    expect(expandPipeline(pipe([text('t', '적어 둔 글'), node('a')], [['t', 'a']])).nodes[0].text).toBe('a 할 일\n\n적어 둔 글')
    expect(pipelineProblems(pipe([node('a'), text('t', 'x'), { id: 'k', kind: 'task', ref: 'task-1', text: '', terminal: 'new' }], [['t', 'k'], ['t', 'a']]))[0]).toContain('입력이 없습니다')
  })

  it('[IN-F12-AC2] 템플릿 노드는 실행할 때 템플릿의 지금 내용으로 펼쳐지고, 입력은 {{입력}} 자리에 들어간다', () => {
    const review = lib('tpl-review', '리뷰', [{ ...node('r', 'claude', 'continue'), text: '코드 리뷰해. 관점: {{입력}}' }, { ...node('c'), text: '클라이언트 팀 수정 사항 정리' }], [['r', 'c']])
    const work = pipe([{ ...node('w'), text: '로그인 구현' }, { id: 't', kind: 'template', ref: 'tpl-review', text: '보안', terminal: 'new' }, node('after', 'shell')], [['w', 't'], ['t', 'after']])
    expect(pipelineProblems(work, { library: [review] })).toEqual([])
    const flat = expandPipeline(work, { library: [review] })
    expect(flat.nodes.map((n) => n.id)).toEqual(['w', 't/r', 't/c', 'after'])
    expect(flat.nodes[1].text).toBe('코드 리뷰해. 관점: 보안')
    expect(flat.edges).toEqual(expect.arrayContaining([
      { from: 't/r', to: 't/c' },
      { from: 'w', to: 't/r' },
      { from: 't/c', to: 'after' }
    ]))
    expect(flat.edges).toHaveLength(3)
    // 템플릿을 고치면 다음에 펼칠 때 바로 반영된다
    review.nodes[1].text = '클라이언트 팀 수정 사항을 표로 출력'
    expect(expandPipeline(work, { library: [review] }).nodes[2].text).toBe('클라이언트 팀 수정 사항을 표로 출력')
  })

  it('[IN-F12-AC3] 없는 템플릿, 자기 자신을 다시 쓰는 템플릿은 실행 전에 알려주고, 쓰고 있는 템플릿은 지우지 않는다', async () => {
    const self = lib('tpl-a', 'A', [{ id: 'x', kind: 'template', ref: 'tpl-a', text: '', terminal: 'new' }], [])
    expect(pipelineProblems(pipe([{ id: 't', kind: 'template', ref: 'tpl-a', text: '', terminal: 'new' }], []), { library: [self] })[0]).toContain('자기 자신')
    expect(pipelineProblems(pipe([{ id: 't', kind: 'template', ref: 'nope', text: '', terminal: 'new' }], []))[0]).toContain('찾을 수 없습니다')
    const ctx = await newProject()
    const tpl = await savePipeline(ctx, { title: '리뷰 템플릿', template: true, nodes: [node('r')], edges: [] })
    await savePipeline(ctx, { title: '작업', nodes: [{ id: 't', kind: 'template', ref: tpl.id, text: '', terminal: 'new' }], edges: [] })
    expect((await listPipelines(ctx)).find((p) => p.id === tpl.id)!.template).toBe(true)
    await expect(deletePipeline(ctx, tpl.id)).rejects.toThrow('작업')
  })
})

describe('연동 · 작업 그래프 스킬 노드', () => {
  it('[IN-F15-AC1] 프로젝트와 내 홈의 스킬을 읽는다 (폴더/SKILL.md와 바로 놓인 .md, frontmatter는 뺀 본문)', async () => {
    const proj = await tempDir('skill-proj-')
    const home = await tempDir('skill-home-')
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'local-update'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'local-update', 'SKILL.md'), '---\nname: local-update\ndescription: 로컬 설치\n---\n\n# 순서\n1. 버전 올리기\n')
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'never-do.md'), '# 하지 말 것\n')
    await fs.mkdir(path.join(home, '.claude', 'skills', 'mine'), { recursive: true })
    await fs.writeFile(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n내 스킬\n')
    const skills = await listSkills(proj, home)
    expect(skills.map((s) => [skillId(s), s.description])).toEqual([
      ['project:local-update', '로컬 설치'],
      ['project:never-do', ''],
      ['user:mine', '']
    ])
    expect(skills[0].body).toBe('# 순서\n1. 버전 올리기')
  })

  it('[IN-F15-AC2] 스킬 노드는 스킬 본문을 글로 내보내 프롬프트에 붙이고, 입력은 받지 않는다', () => {
    const skills = [{ id: 'project:local-update', name: 'local-update', body: '# 순서\n1. 버전 올리기' }]
    const g = pipe([{ ...node('a'), text: '이 스킬대로 해' }, { id: 'k', kind: 'skill', ref: 'project:local-update', text: '', terminal: 'new' }], [['k', 'a']])
    expect(expandPipeline(g, { skills }).nodes[0].text).toBe('이 스킬대로 해\n\n# 순서\n1. 버전 올리기')
    expect(pipelineProblems(pipe([node('a'), { id: 'k', kind: 'skill', ref: 'project:none', text: '', terminal: 'new' }], [['k', 'a']]), { skills })[0]).toContain('스킬을 찾을 수 없습니다')
    const t: PipeNode = { id: 't', kind: 'text', text: 'x', terminal: 'new' }
    expect(pipelineProblems(pipe([node('a'), t, { id: 'k', kind: 'skill', ref: 'project:local-update', text: '', terminal: 'new' }], [['t', 'k'], ['k', 'a']]), { skills })[0]).toContain('입력이 없습니다')
  })
})

describe('연동 · 작업 그래프 시작 노드', () => {
  const start = (id = 's'): PipeNode => ({ id, kind: 'start', text: '', terminal: 'new' })

  it('[IN-F14-AC1] 직접 실행하는 그래프는 시작 노드가 있어야 하고, 템플릿은 없어도 된다', () => {
    const g = pipe([node('a')], [])
    expect(pipelineProblems(g, {}, { requireStart: true })[0]).toContain('시작 노드가 없습니다')
    expect(pipelineProblems(g)).toEqual([])
    expect(pipelineProblems(pipe([start(), node('a')], []), {}, { requireStart: true })[0]).toContain('시작 노드에 이어진 실행 노드가 없습니다')
    expect(pipelineProblems(pipe([start(), node('a')], [['s', 'a']]), {}, { requireStart: true })).toEqual([])
  })

  it('[IN-F14-AC2] 시작에서 실행 선으로 닿는 노드만 실행하고, 닿지 않는 노드는 비어 있어도 실행을 막지 않는다', () => {
    const rule: PipeNode = { id: 't', kind: 'text', text: '규칙', terminal: 'new' }
    const g = pipe([start(), node('a'), node('b'), { ...node('lost'), text: '' }, rule], [['s', 'a'], ['a', 'b'], ['t', 'a']])
    expect(pipelineProblems(g, {}, { requireStart: true })).toEqual([])
    const flat = expandPipeline(g)
    expect(flat.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(flat.edges).toEqual([{ from: 'a', to: 'b' }])
    expect(flat.nodes[0].text).toBe('a 할 일\n\n규칙')
    // 시작 노드에는 입력을 이을 수 없다
    expect(pipelineProblems(pipe([start(), node('a')], [['s', 'a'], ['a', 's']]))[0]).toContain('입력이 없습니다')
  })

  it('[IN-F14-AC3] 템플릿 안에 시작 노드가 있으면 거기서부터 펼친다', () => {
    const tpl = { id: 'tpl', title: 'T', nodes: [start(), node('x'), node('unused')], edges: [{ from: 's', to: 'x' }] }
    const flat = expandPipeline(pipe([start('s0'), node('w'), { id: 't', kind: 'template', ref: 'tpl', text: '', terminal: 'new' }], [['s0', 'w'], ['w', 't']]), { library: [tpl] })
    expect(flat.nodes.map((n) => n.id)).toEqual(['w', 't/x'])
    expect(flat.edges).toEqual([{ from: 'w', to: 't/x' }])
  })
})

describe('연동 · 작업 그래프 할 일 노드', () => {
  it('[IN-F13-AC1] 할 일 노드는 할 일의 제목·내용을 글로 내보내 프롬프트에 붙인다', () => {
    const g = pipe([{ ...node('a'), text: '이 할 일을 처리해' }, { id: 'k', kind: 'task', ref: 'task-0007', text: '', terminal: 'new' }], [['k', 'a']])
    const tasks = [{ id: 'task-0007', title: '로그인 버그', body: '세션이 만료되면 튕긴다', status: '대기' }]
    expect(expandPipeline(g, { tasks }).nodes[0].text).toBe('이 할 일을 처리해\n\n할 일 task-0007: 로그인 버그\n\n세션이 만료되면 튕긴다')
    expect(pipelineProblems(pipe([node('a'), { id: 'k', kind: 'task', ref: 'task-0099', text: '', terminal: 'new' }], [['k', 'a']]), { tasks })[0]).toContain('찾을 수 없습니다')
  })

  it('[IN-F13-AC3] 모든 종류의 노드와 고른 대상(ref)이 저장 후 그대로 읽힌다', async () => {
    const ctx = await newProject()
    const nodes: PipeNode[] = NODE_KINDS.map((kind, i) => ({ id: `n${i}`, kind, text: '', terminal: 'new', ...(['template', 'task', 'complete'].includes(kind) ? { ref: `r${i}` } : {}) }))
    const saved = await savePipeline(ctx, { title: '모든 노드', nodes, edges: [] })
    expect(saved.nodes.map((n) => [n.kind, n.ref])).toEqual(nodes.map((n) => [n.kind, n.ref]))
  })

  it('[IN-F13-AC2] "할 일 완료" 노드는 차례가 오면 이어진 할 일을 완료로 바꾸고 다음으로 넘어간다', async () => {
    const { runner, completed, state, tick, settle } = setup()
    const g = pipe(
      [node('a'), { id: 'k', kind: 'task', ref: 'task-0007', text: '', terminal: 'new' }, { id: 'done', kind: 'complete', text: '', terminal: 'new' }, node('b', 'shell')],
      [['a', 'done'], ['k', 'done'], ['done', 'b']]
    )
    expect(pipelineProblems(g)).toEqual([])
    expect(pipelineProblems(pipe([node('a'), { id: 'done', kind: 'complete', text: '', terminal: 'new' }], [['a', 'done']]))[0]).toContain('완료할 할 일')
    runner.start({ ...g, ...expandPipeline(g) })
    await settle()
    expect(completed).toEqual([])
    tick()
    runner.agentDone('term-1')
    await settle()
    expect(completed).toEqual(['task-0007'])
    expect(state().nodes.done.status).toBe('done')
    expect(state().nodes.b.status).toBe('running')
  })
})

describe('터미널 그래프 · 노드 이름과 기능 명세 데이터 노드', () => {
  const specs = [
    {
      id: 'spec-t',
      title: '터미널 기능 명세',
      features: [
        { id: 'DM-F01', name: '기본 터미널 오픈', purpose: '', acs: [] },
        {
          id: 'DM-F02',
          name: '터미널 그래프',
          purpose: '작업을<br>노드로 잇는다',
          acs: [
            { id: 'DM-F02-AC1', num: 1, text: '노드는 두 종류다.\n액션과 데이터' },
            { id: 'DM-F02-AC2', num: 2, text: '단일과 리스트' }
          ]
        }
      ]
    }
  ]

  it('[DM-F02-AC1] 이름은 기본으로 노드 종류 이름이고, 겹치면 뒤에 1씩 늘어나는 숫자가 붙는다', async () => {
    expect(uniqueName('텍스트', [])).toBe('텍스트')
    expect(uniqueName('텍스트', ['텍스트'])).toBe('텍스트 1')
    expect(uniqueName('텍스트', ['텍스트', '텍스트 1'])).toBe('텍스트 2')
    expect(uniqueName('텍스트 1', ['텍스트', '텍스트 1'])).toBe('텍스트 2')
    const ctx = await newProject()
    const a = newNodeId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const saved = await savePipeline(ctx, {
      title: 'g',
      nodes: [{ ...node(a, 'text'), name: '' }, node('n2', 'text'), { ...node('n3', 'claude'), name: '텍스트' }],
      edges: []
    })
    // 이름이 없던 노드는 종류 이름을 갖고, 겹치는 이름은 숫자로 가른다. id는 그대로다
    expect(saved.nodes.map((n) => [n.id, n.name])).toEqual([
      [a, '텍스트'],
      ['n2', '텍스트 1'],
      ['n3', '텍스트 2']
    ])
  })

  it('[DM-F02-AC1] 실행 전 문제는 노드 id가 아니라 이름으로 알려준다', () => {
    const g = pipe([{ ...node('s', 'start'), name: '시작' }, { ...node('x'), text: '', name: '리뷰' }], [['s', 'x']])
    expect(pipelineProblems(g)).toContain('리뷰: 내용이 비어 있습니다')
  })

  it('[DM-F02-AC1] 기능 명세 노드는 명세 전체를, 기능·수용 기준 노드는 그 부분만 글로 내보낸다', () => {
    const g = pipe(
      [
        node('s', 'start'),
        { ...node('sp', 'spec'), ref: 'spec-t' },
        { ...node('f', 'feature'), ref: 'spec-t#DM-F02' },
        { ...node('ac', 'ac'), ref: 'spec-t#DM-F02-AC1' },
        { ...node('c'), text: '구현해' }
      ],
      [['s', 'c'], ['ac', 'c']]
    )
    const env = { specs }
    expect(dataValue(g, 'sp', env)).toBe('# 터미널 기능 명세\n\n기능 DM-F01 기본 터미널 오픈\n\n기능 DM-F02 터미널 그래프\n목적: 작업을\n노드로 잇는다\n수용 기준:\nAC1: 노드는 두 종류다.\n액션과 데이터\nAC2: 단일과 리스트')
    expect(dataValue(g, 'f', env)).toContain('AC2: 단일과 리스트')
    expect(expandPipeline(g, env).nodes[0].text).toBe('구현해\n\n기능 DM-F02 터미널 그래프의 수용 기준 AC1: 노드는 두 종류다.\n액션과 데이터')
    expect(edgeProblem(g, 'c', 'sp')).toBeTruthy()
  })

  it('[DM-F02-AC1] 기능 명세에서 기능을, 기능에서 수용 기준을 꺼낼 수 있고, 없는 대상은 실행 전에 알려준다', () => {
    const env = { specs }
    expect(innerValues({ kind: 'spec', ref: 'spec-t' }, env).map((v) => [v.kind, v.ref])).toEqual([
      ['feature', 'spec-t#DM-F01'],
      ['feature', 'spec-t#DM-F02']
    ])
    expect(innerValues({ kind: 'feature', ref: 'spec-t#DM-F02' }, env).map((v) => v.ref)).toEqual(['spec-t#DM-F02-AC1', 'spec-t#DM-F02-AC2'])
    expect(innerValues({ kind: 'ac', ref: 'spec-t#DM-F02-AC1' }, env)).toEqual([])
    const g = pipe(
      [node('s', 'start'), { ...node('a', 'ac'), name: 'AC', ref: 'spec-t#DM-F02-AC9' }, node('c')],
      [['s', 'c'], ['a', 'c']]
    )
    expect(pipelineProblems(g, env)).toContain('AC: 수용 기준을(를) 찾을 수 없습니다 (spec-t#DM-F02-AC9)')
  })

  it('[DM-F02-AC1] 리스트 노드에서는 적어 둔 항목을 하나씩 단일 텍스트 노드로 꺼낼 수 있다', () => {
    expect(innerValues({ kind: 'list', items: ['첫째\n둘째 줄', ' ', '셋째'] }, {})).toEqual([
      { kind: 'item', index: 0, label: '첫째' },
      { kind: 'item', index: 1, label: '셋째' }
    ])
  })

  it('[DM-F02-AC2] 데이터 노드는 단일 또는 리스트이고, 리스트는 실행 노드에 항목을 한 번에 이어 붙인다', () => {
    expect(dataShape({ kind: 'text' })).toBe('single')
    expect(dataShape({ kind: 'list' })).toBe('list')
    expect(dataShape({ kind: 'spec' })).toBe('list')
    const env = { specs }
    const list: PipeNode = { ...node('l', 'list'), items: ['첫째', ' ', '둘째'] }
    const g = pipe([node('s', 'start'), list, { ...node('c'), text: '차례로 해' }], [['s', 'c'], ['l', 'c']])
    expect(dataItems(g, 'l')).toEqual(['첫째', '둘째'])
    expect(expandPipeline(g).nodes[0].text).toBe('차례로 해\n\n첫째\n\n둘째')
    // 리스트에 데이터가 들어오면 적어 둔 항목 대신 들어온 것을 항목으로 모은다 (리스트 입력은 펼쳐서)
    const g2 = pipe(
      [{ ...node('t', 'text'), text: '하나', y: 0 }, { ...node('sp', 'spec'), ref: 'spec-t', y: 10 }, list, { ...node('j', 'join'), text: ' | ' }],
      [['t', 'l'], ['sp', 'l'], ['l', 'j']]
    )
    expect(dataItems(g2, 'l', env)).toHaveLength(3)
    expect(dataItems(g2, 'l', env)[0]).toBe('하나')
    expect(dataItems(g2, 'l', env)[2]).toContain('기능 DM-F02 터미널 그래프')
    // 합치기는 리스트의 항목을 구분자로 잇는다
    expect(dataValue(pipe([list, { ...node('j', 'join'), text: ' | ' }], [['l', 'j']]), 'j')).toBe('첫째 | 둘째')
  })

  it('[DM-F02-AC1] 셸 노드의 데이터 출력은 명령 출력을 뒤 노드에 넘기고, 실행 선으로 먼저 실행되어야 한다', async () => {
    const sh: PipeNode = { ...node('sh', 'shell'), name: '셸', text: 'git diff' }
    const c: PipeNode = { ...node('c'), name: '리뷰', text: '이 변경을 리뷰해' }
    const t: PipeNode = { ...node('t', 'text'), text: '' }
    const g: Pipeline = {
      ...pipe([node('s', 'start'), sh, t, c], [['s', 'sh'], ['sh', 'c'], ['t', 'c']]),
      edges: [
        { from: 's', to: 'sh' },
        { from: 'sh', to: 'c' },
        { from: 'sh', to: 't', pin: 'data' },
        { from: 't', to: 'c' }
      ]
    }
    expect(edgeProblem(g, 'sh', 't')).toContain('데이터 노드로는 이을 수 없습니다')
    expect(edgeProblem(g, 'sh', 't', 'data')).toBeNull()
    expect(edgeProblem(g, 'c', 't', 'data')).toContain('터미널 타입의 입력 핀')
    expect(pipelineProblems(g, {}, { requireStart: true })).toEqual([])
    // 실행 선 없이 출력만 쓰면 실행 전에 알려준다
    const late = { ...g, edges: [{ from: 's', to: 'c' }, { from: 'sh', to: 'c', pin: 'data' as const }] }
    expect(pipelineProblems(late)).toContain('리뷰: 셸의 출력을 쓰려면 셸이(가) 실행 선으로 먼저 실행되어야 합니다')

    const { runner, sent, settle } = setup()
    runner.start({ ...g, ...expandPipeline(g) })
    await settle()
    expect(sent).toEqual([{ termId: 'term-1', text: 'git diff', via: 'command' }])
    runner.commandDone('term-1', 0, '+ 새 줄')
    await settle()
    expect(sent[1]).toMatchObject({ termId: 'term-2', text: '이 변경을 리뷰해\n\n+ 새 줄', via: 'submit' })
  })

  it('[DM-F02-AC1] 리스트 항목과 데이터 출력 선이 저장 후 그대로 읽힌다', async () => {
    const ctx = await newProject()
    const saved = await savePipeline(ctx, {
      title: 'g',
      nodes: [{ ...node('l', 'list'), items: ['a', 'b'] }, node('sh', 'shell'), node('c')],
      edges: [
        { from: 'sh', to: 'c' },
        { from: 'sh', to: 'c', pin: 'data' },
        { from: 'sh', to: 'c', pin: 'data' }
      ]
    })
    expect(saved.nodes[0].items).toEqual(['a', 'b'])
    expect(saved.edges).toEqual([{ from: 'sh', to: 'c' }, { from: 'sh', to: 'c', pin: 'data' }])
  })

  it('[DM-F02-AC4] Claude Code·Codex 노드에 불러온 세션은 새 터미널을 그 세션으로 열고, "이어서" 노드는 앞 터미널을 쓴다', async () => {
    const { runner, opened, sent, tick, settle } = setup()
    runner.start(pipe([{ ...node('a'), session: 's-1' }, node('b', 'claude', 'continue'), { ...node('c', 'codex'), session: 'x-2' }], [['a', 'b'], ['b', 'c']]))
    await settle()
    tick()
    runner.agentDone('term-1')
    await settle()
    tick()
    runner.agentDone('term-1')
    await settle()
    expect(opened).toEqual([
      { id: 'term-1', kind: 'claude', session: 's-1' },
      { id: 'term-2', kind: 'codex', session: 'x-2' }
    ])
    expect(sent.map((s) => s.termId)).toEqual(['term-1', 'term-1', 'term-2'])
  })

  it('[DM-F02-AC4] 세션 id는 Claude Code는 --resume, Codex는 resume 하위 명령으로 넘기고, 셸에 위험한 글자는 막는다', async () => {
    expect(terminalCommand('claude', {}, 'abc-123')).toBe('claude --resume abc-123')
    expect(terminalCommand('codex', {}, 'u-1')).toBe('codex resume u-1')
    expect(terminalCommand('claude', {})).toBe('claude')
    expect(() => terminalCommand('claude', {}, 'a; rm -rf /')).toThrow()
  })

  it('[DM-F02-AC4] 불러온 세션은 Claude Code·Codex 노드에서만 저장된다', async () => {
    const ctx = await newProject()
    const saved = await savePipeline(ctx, { title: 'g', nodes: [{ ...node('a'), session: 's-1' }, { ...node('b', 'shell'), session: 's-2' }], edges: [] })
    expect(saved.nodes[0].session).toBe('s-1')
    expect(saved.nodes[1].session).toBeUndefined()
  })
})

describe('연동 · 터미널 작업 끝 감지', () => {
  it('[IN-F10-AC1] Claude Code는 Stop 훅(준비는 SessionStart), Codex는 notify로 신호 파일을 남기게 실행한다', async () => {
    const dir = await tempDir('sig-')
    const integration = prepareTerminalIntegration(dir, 'claude', dir, 'linux')
    const { hooks } = JSON.parse(await fs.readFile(integration.claudeSettings, 'utf8'))
    expect(hooks.Stop[0].hooks[0].command).toContain('bridge.cjs')
    expect(hooks.Stop[0].hooks[0].command).toMatch(/ done$/)
    // 세션 ID를 기록하는 기존 SessionStart 훅은 그대로 두고 준비 신호를 더한다
    expect(hooks.SessionStart[0].hooks).toHaveLength(2)
    expect(hooks.SessionStart[0].hooks[1].command).toMatch(/agent\.ready"$/)
    expect(JSON.parse(integration.codexNotify.slice('notify='.length))).toEqual([path.join(dir, 'notify.sh').replace(/\\/g, '/')])
    expect(await fs.readFile(path.join(dir, 'notify.sh'), 'utf8')).toContain('"$ORBIT_BRIDGE" notify')
  })

  it('[IN-F10-AC2] 신호 파일이 생기면 그 터미널의 응답 끝으로 알린다', async () => {
    const dir = await tempDir('sig-')
    prepareTerminalIntegration(dir, 'claude', dir)
    expect(takeAgentSignal(dir, 'done')).toBe(false)
    await fs.writeFile(path.join(dir, 'agent.done'), 'done\n')
    // 한 번 읽은 신호는 지워 같은 응답을 두 번 알리지 않는다
    expect(takeAgentSignal(dir, 'done')).toBe(true)
    expect(takeAgentSignal(dir, 'done')).toBe(false)
    // 새로 실행하면 지난 실행에서 남은 신호는 지운다
    await fs.writeFile(path.join(dir, 'agent.ready'), 'done\n')
    prepareTerminalIntegration(dir, 'claude', dir)
    expect(takeAgentSignal(dir, 'ready')).toBe(false)
  })

  it('[IN-F10-AC3] 셸 명령이 끝나면 종료 코드와 함께 알린다', async () => {
    const codes: number[] = []
    const outputs: string[] = []
    const mgr = new TerminalManager(spawn, {
      onData: () => {},
      onExit: () => {},
      onCommandDone: (_id, code, output) => {
        codes.push(code)
        outputs.push(output)
      }
    })
    const term = mgr.create('shell', await tempDir('term-'))
    await mgr.whenReady(term.id, 800, 15000)
    const wait = async (n: number) => {
      const start = Date.now()
      while (codes.length < n && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 50))
    }
    mgr.runCommand(term.id, 'echo orbit-ok')
    await wait(1)
    mgr.runCommand(term.id, process.platform === 'win32' ? 'cmd /c exit 3' : 'sh -c "exit 3"')
    await wait(2)
    expect(codes).toEqual([0, 3])
    // 명령 출력만 잘라 낸다 (되비친 명령 줄·표시는 빼고)
    expect(outputs[0]).toBe('orbit-ok')
    mgr.killAll()
  }, 40000)
})
