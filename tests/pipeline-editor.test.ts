// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Core, CytoscapeOptions, NodeSingular } from 'cytoscape'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineEditor from '../src/renderer/src/pages/Pipelines'
import { ADD_PORT, AGENT_PORT as A, IF_PORT as I, LOOP_PORT as P, type PipeNode, type Pipeline, type RunState } from '../src/core/pipeline'
import type { TerminalInfo } from '../src/core/terminal'

// 캔버스만 끄고 실제 그래프 엔진·React 편집·저장과 포트 선택 이벤트를 검증한다.
vi.mock('cytoscape-edgehandles', () => ({ default: () => {} }))
vi.mock('cytoscape', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import('cytoscape') }>()
  return { default: Object.assign((options: CytoscapeOptions) => {
    const core = original.default({ ...options, container: undefined, headless: true, styleEnabled: true })
    return Object.assign(core, { edgehandles: () => ({ start: () => {} }) })
  }, { use: original.default.use }) }
})

const node = (id: string, kind: PipeNode['kind'], extra: Partial<PipeNode> = {}): PipeNode => ({ id, name: id, kind, text: '', terminal: 'new', ...extra })
let host: HTMLDivElement
let root: Root
let saved: Pipeline[]
let runs: RunState[]
const graph = () => (window as unknown as { __orbitPipe: Core }).__orbitPipe

beforeEach(() => {
  localStorage.removeItem('orbit:pipeline-layout')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  saved = [{ id: 'g', title: '그래프', file: '', nodes: [node('list', 'list', { items: ['하나', '둘'], x: 0, y: 0 })], edges: [] }]
  runs = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.orbit = {
    getPathForFile: (file: File) => file.name,
    async invoke(name, ...args) {
      if (name === 'listPipelines') return saved
      if (name === 'pipelineRuns') return runs
      if (['listTasks', 'listSkills', 'listSpecs', 'agentSessions'].includes(name)) return []
      if (name === 'agentModels') return [{ id: 'model-a', name: 'Model A' }]
      if (name === 'savePipeline') {
        const input = args[0] as Omit<Pipeline, 'file' | 'id'> & { id?: string }
        const result: Pipeline = { ...structuredClone(input), id: input.id ?? 'new-function', file: '' }
        saved = [...saved.filter((p) => p.id !== result.id), result]
        return result
      }
      throw new Error(`지원하지 않는 API: ${name}`)
    },
    on: () => () => {}
  }
})
afterEach(async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(550) })
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const mount = (tabs: TerminalInfo[] = []) => act(async () => root.render(createElement(PipelineEditor, { tabs, onShowTerminal: () => {} })))
const select = (id: string) => act(async () => { graph().getElementById(id).emit('tap') })
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}
async function change(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('함수와 리스트 항목 편집 화면', () => {
  it.each(['claude', 'codex'] as const)('[DM-F02-AC22] %s 터미널 액션의 모델을 고르거나 직접 입력하고 다시 열어도 유지한다', async (kind) => {
    saved[0].nodes = [node('tab', 'terminal', { ref: 'live' }), node('ai', kind, { text: '작업' })]
    saved[0].edges = [{ from: 'tab', to: 'ai', toPort: A.terminal }]
    await mount([{ id: 'live', kind, title: '내 세션', pid: 1 }]); await select('ai')
    expect(host.querySelector('[aria-label="터미널 실행 방식"]')?.getAttribute('disabled')).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>('[aria-label="Model"]')?.disabled).toBe(false)
    expect(host.querySelector('datalist option')?.getAttribute('value')).toBe('model-a')
    await change(host.querySelector<HTMLInputElement>('[aria-label="Model"]')!, 'custom-model')
    await act(async () => { await vi.advanceTimersByTimeAsync(550); root.unmount() })
    root = createRoot(host); await mount(); await select('ai')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe('custom-model')
    expect(saved[0].nodes.find((n) => n.id === 'ai')?.model).toBe('custom-model')
    await change(host.querySelector<HTMLInputElement>('[aria-label="Model"]')!, '')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].nodes.find((n) => n.id === 'ai')?.model).toBeUndefined()
  })

  it('[DM-F02-AC18] Object Properties가 비면 자유형 안내를 보이고, 추가·삭제에 따라 실제 출력 계약을 바꾼다', async () => {
    saved[0].nodes = [node('ai', 'codex', { text: '현재 작업중인 내용', fields: [{ name: 'works', type: 'array', description: '클라이언트가 하는 일들 나열하기', items: { type: 'object', description: '', fields: [] } }] })]
    await mount(); await select('ai')
    const schema = () => {
      const prompt = host.querySelector('.pipe-preview pre')!.textContent!
      return JSON.parse(prompt.slice(prompt.indexOf('{')))
    }
    expect(host.textContent).toContain('Any properties are allowed until fields are added.')
    expect(schema().properties.works.items).toEqual({ type: 'object', description: '' })
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add property to works[]"]')!.click())
    await change(host.querySelector<HTMLInputElement>('[aria-label="works[] Field name"]')!, 'title')
    expect(schema().properties.works.items).toMatchObject({ properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false })
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Delete works[].title"]')!.click())
    expect(schema().properties.works.items).toEqual({ type: 'object', description: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(550); root.unmount() })
    root = createRoot(host)
    await mount(); await select('ai')
    expect(host.textContent).toContain('Any properties are allowed until fields are added.')
    expect(schema().properties.works.items).toEqual({ type: 'object', description: '' })
  })

  it('[DM-F02-AC19] 세 경계를 드래그하고 크기를 다시 열 때 복원하며 그래프 좌표는 유지한다', async () => {
    await mount()
    const positions = saved[0].nodes.map(({ id, x, y }) => ({ id, x, y }))
    const drag = async (label: string, dx: number, dy: number) => {
      const divider = host.querySelector<HTMLElement>(`[role="separator"][aria-label="${label}"]`)!
      await act(async () => {
        divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 500, clientY: 500 }))
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 500 + dx, clientY: 500 + dy }))
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      })
    }
    await drag('그래프 목록 너비', 80, 0)
    await drag('속성 패널 너비', -120, 0)
    await drag('출력 로그 높이', 0, -90)
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!)).toEqual({ list: 270, panel: 460, output: 310 })
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(saved[0].nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(positions)
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    expect(host.querySelector('.pipe-layout')?.getAttribute('style')).toContain('--pipe-list-width: 270px')
    expect(host.querySelector<HTMLElement>('.pipe-console')?.style.height).toBe('310px')
    await drag('그래프 목록 너비', -10000, 0)
    await drag('속성 패널 너비', -10000, 0)
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!)).toMatchObject({ list: 140, panel: 760 })
    await act(async () => host.querySelector('[aria-label="속성 패널 너비"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!).panel).toBe(340)
    await click('레이아웃 초기화')
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!)).toEqual({ list: 190, panel: 340, output: 220 })
  })

  it('드래그 중 창을 벗어나거나 편집기를 닫으면 크기 조절을 끝내고 커서를 복원한다', async () => {
    localStorage.setItem('orbit:pipeline-layout', '{invalid')
    await mount()
    const divider = host.querySelector('[aria-label="그래프 목록 너비"]')!
    await act(async () => {
      divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 190 }))
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 400 }))
    })
    expect(document.body.style.cursor).toBe('')
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!).list).toBe(190)
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', shiftKey: true })))
    expect(JSON.parse(localStorage.getItem('orbit:pipeline-layout')!).list).toBe(240)
    await act(async () => divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0 })))
    await act(async () => root.render(null))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('[DM-F02-AC18] 기본 result를 Array<Object>와 중첩 Number Array로 편집하고 다시 연다', async () => {
    saved[0].nodes = [node('ai', 'codex', { text: '결과' })]
    await mount()
    await select('ai')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="출력 형식"]')!, 'json')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Field name"]')?.value).toBe('result')
    const types = host.querySelector<HTMLSelectElement>('[aria-label="result Type"]')!
    expect([...types.options].map((o) => o.textContent)).toEqual(['String', 'Number', 'Boolean', 'Object', 'Array', 'Null'])
    await change(types, 'array')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="result[] Type"]')!, 'object')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add property to result[]"]')!.click())
    await change(host.querySelector<HTMLInputElement>('[aria-label="result[] Field name"]')!, 'scores')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="result[].scores Type"]')!, 'array')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="result[].scores[] Type"]')!, 'number')
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="result[].scores[] Description"]')!, '각 평가 점수')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].nodes[0].fields).toEqual([{ name: 'result', type: 'array', description: '', items: { type: 'object', description: '', fields: [
      { name: 'scores', type: 'array', description: '', items: { type: 'number', description: '각 평가 점수' } }
    ] } }])
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount(); await select('ai')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="result[].scores[] Type"]')?.value).toBe('number')
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="result[].scores[] Description"]')?.value).toBe('각 평가 점수')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toContain('각 평가 점수')
  })

  it('[DM-F02-AC17] Print를 추가하고 출력 로그에서 발생 순서·빈 문자열·원본 노드 선택을 확인한다', async () => {
    saved[0].nodes = [node('ai', 'codex'), node('p', 'print', { text: '값' })]
    runs = [{ runId: 'r', pipelineId: 'g', title: '그래프', status: 'done', started: new Date().toISOString(), nodes: {
      p: { kind: 'print', name: 'Print 결과', status: 'done', output: '', outputOrder: 2 },
      ai: { kind: 'codex', name: 'AI 결과', status: 'done', output: '<img src=x onerror=alert(1)>', outputOrder: 1 }
    } }]
    await mount()
    const entries = () => [...host.querySelectorAll('.pipe-console-entry pre')].map((el) => el.textContent)
    expect(entries()).toEqual(['<img src=x onerror=alert(1)>', '(빈 문자열)'])
    expect(host.querySelector('.pipe-console img')).toBeNull()
    await click('Print 결과')
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Print 출력할 값"]')?.value).toBe('값')
    await act(async () => host.querySelector<HTMLInputElement>('.pipe-console input[type="checkbox"]')!.click())
    expect(entries()).toEqual(['(빈 문자열)'])
    await click('Print')
    const added = graph().nodes('[kind = "print"]').filter((n) => n.id() !== 'p').first()
    expect(added.data('pins')).toMatchObject([{ side: 'in', type: 'exec' }, { side: 'out', type: 'exec' }, { side: 'in', type: 'data' }])
    expect(host.querySelector('[aria-label="터미널 실행 방식"]')).toBeNull()
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="Print 출력할 값"]')!, '직접 출력')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].nodes.find((n) => n.id === added.id())?.text).toBe('직접 출력')
  })

  it.each([1, 0.25])('[DM-F02-AC16] 줌 %s에서 비교 Bool→If, True·False 핀을 구분해 연결한다', async (zoom) => {
    saved[0].nodes = [node('s', 'start', { x: 0, y: 0 }), node('if', 'if', { x: 500, y: 0 }), node('yes', 'shell', { text: 'yes', x: 900, y: -120 }), node('no', 'shell', { text: 'no', x: 900, y: 120 })]
    saved[0].edges = [{ from: 's', to: 'if' }]
    await mount()
    await change(host.querySelector<HTMLSelectElement>('[aria-label="비교 노드 추가"]')!, 'gt')
    const c = graph(), cmp = c.nodes('[kind = "compare"]').first()
    await change(host.querySelector<HTMLInputElement>('[aria-label="A 기본값"]')!, '10')
    await change(host.querySelector<HTMLInputElement>('[aria-label="B 기본값"]')!, '2')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('true')
    await act(async () => { cmp.position({ x: 0, y: 160 }); cmp.emit('dragfree') })
    c.zoom(zoom); c.pan({ x: 0, y: 0 })
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    type TestPin = { side: string; id?: string; type: string; dy: number; shape?: string }
    for (const [from, to, fromPort, toPort] of [[cmp.id(), 'if', undefined, I.condition], ['if', 'yes', I.yes, undefined], ['if', 'no', I.no, undefined]] as const) {
      const source = c.getElementById(from) as NodeSingular, target = c.getElementById(to) as NodeSingular
      const out = (source.data('pins') as TestPin[]).find((p) => p.side === 'out' && p.id === fromPort)!
      const input = (target.data('pins') as TestPin[]).find((p) => p.side === 'in' && (toPort ? p.id === toPort : p.type === 'exec'))!
      await act(async () => {
        emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y + out.dy * zoom } })
        const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: from, target: to } })
        emit({ type: 'ehcomplete', position: { x: target.position().x - target.width() / 2, y: target.position().y + input.dy } }, [source, target, temporary])
        c.emit('tapend')
      })
    }
    await select('if')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="조건 기본값"]')?.disabled).toBe(true)
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('true')
    expect(host.querySelector('[aria-label="터미널 실행 방식"]')).toBeNull()
    const boolEdge = c.edges().filter((e) => e.data('toPort') === I.condition)
    expect(boolEdge.hasClass('boolean')).toBe(true)
    const trueEdge = c.edges().filter((e) => e.data('fromPort') === I.yes), falseEdge = c.edges().filter((e) => e.data('fromPort') === I.no)
    expect(trueEdge.hasClass('data')).toBe(false)
    expect(falseEdge.hasClass('data')).toBe(false)
    expect(trueEdge.style('source-endpoint')).not.toBe(falseEdge.style('source-endpoint'))
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toEqual(expect.arrayContaining([{ from: cmp.id(), to: 'if', toPort: I.condition }, { from: 'if', to: 'yes', fromPort: I.yes }, { from: 'if', to: 'no', fromPort: I.no }]))
    expect(saved[0].nodes.find((n) => n.id === cmp.id())).toMatchObject({ operation: 'gt', values: { [ADD_PORT.a]: '10', [ADD_PORT.b]: '2' } })
  })

  it('비교 타입과 논리 기본값을 편집하고 함수 Bool·숫자 타입을 고른다', async () => {
    saved[0].template = true
    saved[0].nodes = [node('in', 'function-input', { params: [{ id: 'flag', name: '조건', type: 'boolean' }, { id: 'count', name: '개수', type: 'number' }] }), node('out', 'function-output', { params: [{ id: 'result', name: '결과', type: 'boolean' }] })]
    saved[0].edges = [{ from: 'in', to: 'out' }]
    await mount()
    await select('in')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="조건 타입"]')?.value).toBe('boolean')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="개수 타입"]')?.value).toBe('number')
    await select('out')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="결과 기본값"]')!, 'true')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="비교 노드 추가"]')!, 'gte')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="비교 타입"]')!, 'boolean')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="비교 연산"]')?.value).toBe('eq')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="비교 연산"]')?.options.length).toBe(2)
    await change(host.querySelector<HTMLSelectElement>('[aria-label="A 기본값"]')!, 'true')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('false')
    await click('NOT')
    expect(host.querySelector('[aria-label="B 기본값"]')).toBeNull()
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('true')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="A 기본값"]')!, 'true')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('false')
  })

  it.each([1, 0.25])('줌 %s에서 텍스트 Add의 A/B와 결과 핀을 연결하고 저장·재열기 후에도 유지한다', async (zoom) => {
    saved[0].nodes = [node('a', 'text', { text: '안녕', x: 0, y: 120 }), node('b', 'text', { text: ' Orbit\n', x: 0, y: -120 }),
      node('result', 'text', { x: 900, y: 0 })]
    await mount()
    await click('텍스트 Add')
    const c = graph(), add = c.nodes('[kind = "add"]').first()
    await act(async () => { add.position({ x: 450, y: 0 }); add.emit('dragfree') })
    c.zoom(zoom); c.pan({ x: 0, y: 0 })
    expect(add.data('pins')).toMatchObject([
      { side: 'in', type: 'data', id: ADD_PORT.a }, { side: 'in', type: 'data', id: ADD_PORT.b }, { side: 'out', type: 'data' }
    ])
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="A 기본값"]')!, '기본')
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="B 기본값"]')!, '!')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('기본!')
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    for (const [from, to, port] of [['b', add.id(), ADD_PORT.b], ['a', add.id(), ADD_PORT.a], [add.id(), 'result', undefined]] as const) {
      const source = c.getElementById(from) as NodeSingular, target = c.getElementById(to) as NodeSingular
      const fromPin = source.data('pins').find((p: { side: string }) => p.side === 'out') as { dy: number }
      const toPin = target.data('pins').find((p: { side: string; id?: string }) => p.side === 'in' && p.id === port) as { dy: number }
      const drop = { x: target.position().x - target.width() / 2, y: target.position().y + toPin.dy }
      await act(async () => {
        emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y + fromPin.dy * c.zoom() } })
        const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: from, target: to } })
        emit({ type: 'ehcomplete', position: drop }, [source, target, temporary])
        c.emit('tapend')
      })
    }
    await select(add.id())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="A 기본값"]')?.disabled).toBe(true)
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="B 기본값"]')?.disabled).toBe(true)
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('안녕 Orbit\n')
    await act(async () => { c.getElementById('a').position({ x: 0, y: -250 }).emit('dragfree') })
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('안녕 Orbit\n')
    await select('result')
    expect(host.querySelector<HTMLTextAreaElement>('textarea.task-body')?.value).toBe('안녕 Orbit\n')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toEqual([{ from: 'b', to: add.id(), toPort: ADD_PORT.b }, { from: 'a', to: add.id(), toPort: ADD_PORT.a }, { from: add.id(), to: 'result' }])
    const id = add.id()
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    await select(id)
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('안녕 Orbit\n')
    expect(saved[0].nodes.find((n) => n.id === id)?.values).toEqual({ [ADD_PORT.a]: '기본', [ADD_PORT.b]: '!' })
  })

  it('텍스트 출력에서 add를 검색해 만들면 A 입력에 자동 연결한다', async () => {
    saved[0].nodes = [node('text', 'text', { text: '연결된 글', x: 0, y: 0 })]
    await mount()
    const c = graph(), source = c.getElementById('text') as NodeSingular
    c.zoom(1); c.pan({ x: 0, y: 0 })
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    await act(async () => {
      emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y } })
      emit({ type: 'ehcancel', position: { x: 450, y: 0 } }, [source])
      c.emit('tapend')
    })
    await change(host.querySelector<HTMLInputElement>('.pipe-menu input')!, 'add')
    const option = host.querySelector('.pipe-menu-item')!
    expect(option.textContent).toContain('텍스트 Add')
    await act(async () => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    const add = c.nodes('[kind = "add"]').first()
    expect(c.edges().map((e) => [e.data('source'), e.data('target'), e.data('toPort')])).toEqual([['text', add.id(), ADD_PORT.a]])
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="A 기본값"]')?.disabled).toBe(true)
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="B 기본값"]')?.disabled).toBe(false)
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('연결된 글')
  })

  it('구조화 출력 필드·규칙을 편집하고 결과 Dictionary와 필드를 원본에 연결한다', async () => {
    saved[0].nodes.push(node('ai', 'codex', { text: '결과를 정리하세요' }))
    await mount()
    await select('ai')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="출력 형식"]')!, 'json')
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="result Description"]')!, '결과가 없으면 빈 문자열')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toContain('결과가 없으면 빈 문자열')
    await click('+ 결과 Dictionary')
    const dict = graph().nodes('[kind = "dictionary"]').first()
    expect(graph().edges().some((e) => e.data('source') === 'ai' && e.data('target') === dict.id() && e.data('fromPort') === A.output)).toBe(true)
    await click('+ result')
    const field = graph().nodes('[kind = "property"]').first()
    expect(host.querySelector<HTMLInputElement>('[aria-label="JSON 필드 경로"]')?.value).toBe('/result')
    expect(graph().edges().some((e) => e.data('source') === dict.id() && e.data('target') === field.id())).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].nodes.find((n) => n.id === 'ai')?.fields).toEqual([{ name: 'result', type: 'string', description: '결과가 없으면 빈 문자열' }])
    expect(saved[0].nodes.find((n) => n.id === field.id())?.pointer).toBe('/result')
  })

  it('실행한 JSON 응답을 UI에서 펼치고 중첩 필드를 꺼내며 다시 저장해도 연결을 유지한다', async () => {
    const result = { people: { name: '민수', active: false, count: 0 } }
    saved[0].nodes = [node('ai', 'claude', { fields: [{ name: 'people', type: 'object', description: '' }] }), node('d', 'dictionary')]
    saved[0].edges = [{ from: 'ai', to: 'd', pin: 'data', fromPort: A.output }]
    runs = [{ runId: 'r', pipelineId: 'g', title: '그래프', started: new Date().toISOString(), status: 'done', nodes: { ai: { status: 'done', output: JSON.stringify(result), structuredOutput: result } } }]
    await mount()
    await select('d')
    expect(host.querySelector('.pipe-json-result')?.textContent).toContain('민수')
    expect(host.querySelector('.pipe-json-result')?.textContent).toContain('false')
    const extract = host.querySelector<HTMLButtonElement>('button[title="people / name을 데이터 노드로 꺼내기"]')!
    await act(async () => extract.click())
    expect(host.querySelector<HTMLInputElement>('[aria-label="JSON 필드 경로"]')?.value).toBe('/people/name')
    expect(host.querySelector('.pipe-json-result')?.textContent).toContain('민수')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].nodes.find((n) => n.kind === 'property')?.pointer).toBe('/people/name')
  })

  it('출력 구조 핀은 프롬프트와 분리되어 있고 연결한 구조의 편집은 원본에서 한다', async () => {
    saved[0].nodes = [node('s', 'schema', { fields: [{ name: 'people', type: 'string', description: '요약 규칙' }] }), node('a', 'codex', { text: '참여자' })]
    saved[0].edges = [{ from: 's', to: 'a', toPort: A.schema }]
    await mount()
    await select('a')
    expect(graph().getElementById('a').data('pins')).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: 'in', id: A.schema, label: '출력 구조' }),
      expect.objectContaining({ side: 'out', id: A.output, label: '응답' })
    ]))
    expect(host.querySelector<HTMLSelectElement>('[aria-label="출력 형식"]')?.disabled).toBe(true)
    expect(host.querySelector('.pipe-preview pre')?.textContent).toContain('요약 규칙')
    await select('s')
    await change(host.querySelector<HTMLInputElement>('[aria-label="Field name"]')!, 'person')
    await select('a')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toContain('person')
  })

  it.each(['claude', 'codex'] as const)('[DM-F02-AC15] %s 노드의 터미널 입력 핀에 선택한 탭을 연결하고 프롬프트와 구분한다', async (kind) => {
    saved[0].nodes = [node('start', 'start'), node('work', kind, { x: 500, y: 0, text: '처리할 프롬프트' })]
    saved[0].edges = [{ from: 'start', to: 'work' }]
    await mount([{ id: 'tab', kind, title: '유저가 정한 작업 이름', pid: 1 }, { id: 'shell', kind: 'shell', title: '일반 셸', pid: 2 }])
    await click('터미널')
    const c = graph(), source = c.nodes('[kind = "terminal"]').first(), target = c.getElementById('work') as NodeSingular
    const field = host.querySelector<HTMLSelectElement>('[aria-label="사용할 터미널"]')!
    expect(field.textContent).toContain('유저가 정한 작업 이름')
    expect(field.textContent).not.toContain('일반 셸')
    await change(field, 'tab')
    expect(source.data('label')).toContain('유저가 정한 작업 이름')
    source.position({ x: 0, y: 0 }); c.zoom(0.25); c.pan({ x: 0, y: 0 })
    const pin = target.data('pins').find((p: { side: string; id?: string }) => p.side === 'in' && p.id === A.terminal) as { dy: number }
    const drop = { x: target.position().x - target.width() / 2, y: target.position().y + pin.dy }
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    await act(async () => {
      emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y } })
      const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: source.id(), target: target.id() } })
      emit({ type: 'ehcomplete', position: drop }, [source, target, temporary]); c.emit('tapend')
    })
    const edge = c.edges().filter((e) => e.data('toPort') === A.terminal).first()
    expect(edge.hasClass('terminal')).toBe(true)
    expect(edge.style('target-endpoint')).toContain(`${pin.dy}px`)
    await select('work')
    const mode = host.querySelector<HTMLSelectElement>('[aria-label="터미널 실행 방식"]')!
    expect(mode.disabled).toBe(true)
    expect(mode.value).toBe('input')
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('처리할 프롬프트')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toContainEqual({ from: source.id(), to: 'work', toPort: A.terminal })
    expect(saved[0].nodes.find((n) => n.id === source.id())?.ref).toBe('tab')
    expect(target.data('pins').filter((p: { terminal?: boolean }) => p.terminal)).toMatchObject([{ side: 'in', id: A.terminal }, { side: 'out', id: A.terminal }])
    // 탭이 닫힌 갱신을 받으면 실행을 막고 선택한 참조를 임의로 바꾸지 않는다.
    await mount([])
    expect(host.querySelector('.pipe-problems')?.textContent).toContain('닫혔습니다')
  })

  it('[DM-F02-AC15] 함수 변수에 터미널 타입을 지정하고 호출 기본값을 탭 이름으로 선택한다', async () => {
    const tabs: TerminalInfo[] = [{ id: 'existing', kind: 'codex', title: '기존 코덱스 작업', pid: 1 }]
    await mount(tabs)
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="새 함수"]')!.click())
    const input = graph().nodes('[kind = "function-input"]').first()
    await select(input.id())
    await change(host.querySelector<HTMLSelectElement>('[aria-label="입력 타입"]')!, 'terminal')
    const port = input.data('pins').find((p: { type: string }) => p.type === 'data') as { id: string; terminal: boolean }
    expect(port.terminal).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved.find((p) => p.id === 'new-function')?.nodes[0].params?.[0].type).toBe('terminal')
    await act(async () => root.unmount())
    root = createRoot(host)
    saved[0].nodes.push(node('call', 'template', { ref: 'new-function' }))
    await mount(tabs)
    await select('call')
    const field = host.querySelector<HTMLSelectElement>('[aria-label="입력 기본값"]')!
    expect(field.textContent).toContain('기존 코덱스 작업')
    await change(field, 'existing')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved.find((p) => p.id === 'g')?.nodes.find((n) => n.id === 'call')?.values).toEqual({ [port.id]: 'existing' })
  })

  it('[DM-F02-AC12] 꺼내기 버튼은 원본 출력과 새 항목 입력을 연결하고 변경된 값을 보여 준다', async () => {
    await mount()
    await select('list')
    await click('+ 둘')
    const item = graph().nodes('[kind = "item"]').first()
    expect(item.nonempty()).toBe(true)
    expect(graph().edges().map((e) => [e.source().id(), e.target().id()])).toEqual([['list', item.id()]])
    await select('list')
    await change(host.querySelectorAll<HTMLTextAreaElement>('.pipe-list-items textarea')[1], '변경된 둘')
    await select(item.id())
    expect(host.querySelector('.pipe-preview pre')?.textContent).toBe('변경된 둘')
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toEqual([{ from: 'list', to: item.id() }])
    expect(saved[0].nodes.find((n) => n.id === item.id())).toMatchObject({ kind: 'item', index: 1 })
  })

  it('[DM-F02-AC13] 새 함수에는 삭제할 수 없는 Input·Output과 변수 이름·타입 편집기가 있다', async () => {
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="새 함수"]')!.click())
    expect(graph().nodes().map((n) => n.data('kind'))).toEqual(['function-input', 'function-output'])
    const input = graph().nodes('[kind = "function-input"]').first()
    expect(input.data('label')).toBe('')
    await select(input.id())
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === '노드 삭제')?.disabled).toBe(true)
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    expect(graph().nodes()).toHaveLength(2)
    await change(host.querySelector<HTMLInputElement>('[aria-label="입력 변수 이름"]')!, '작업 목록')
    await change(host.querySelector<HTMLSelectElement>('[aria-label="작업 목록 타입"]')!, 'list')
    await click('+ 입력 변수')
    expect(input.data('pins').filter((p: { type: string }) => p.type === 'data')).toMatchObject([{ list: true, label: '작업 목록 · 텍스트 리스트' }, { list: false }])
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved.find((p) => p.id === 'new-function')?.nodes[0].params).toMatchObject([{ name: '작업 목록', type: 'list' }, { name: '입력', type: 'single' }])
  })

  it.each([1, 0.25])('[DM-F02-AC13] 줌 %s에서 두 번째 리스트 핀을 정확히 연결하고 이름 변경·삭제를 해당 포트에만 반영한다', async (zoom) => {
    saved = [{ id: 'f', title: '함수', file: '', template: true, nodes: [
      node('in', 'function-input', { x: 0, y: 0, params: [{ id: 'a', name: '첫째', type: 'single' }, { id: 'b', name: '둘째', type: 'list' }] }),
      node('out', 'function-output', { x: 600, y: 0, params: [{ id: 'x', name: '첫 결과', type: 'single' }, { id: 'y', name: '둘째 결과', type: 'list' }], values: { y: '' } })
    ], edges: [{ from: 'in', to: 'out' }, { from: 'in', to: 'out', pin: 'data', fromPort: 'a', toPort: 'x' }] }]
    await mount()
    const c = graph()
    c.zoom(zoom); c.pan({ x: 0, y: 0 })
    const source = c.getElementById('in') as NodeSingular, target = c.getElementById('out') as NodeSingular
    const fromPin = source.data('pins').find((p: { id?: string }) => p.id === 'b') as { dy: number }
    const toPin = target.data('pins').find((p: { id?: string }) => p.id === 'y') as { dy: number }
    const drop = { x: target.position().x - target.width() / 2, y: target.position().y + toPin.dy }
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    await act(async () => {
      emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y + fromPin.dy * zoom } })
      emit({ type: 'tapdrag', position: drop })
      const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: 'in', target: 'out' } })
      emit({ type: 'ehcomplete', position: drop }, [source, target, temporary])
      c.emit('tapend')
    })
    const edge = c.edges().filter((e) => e.data('fromPort') === 'b').first()
    expect(edge.data('toPort')).toBe('y')
    expect(edge.style('target-endpoint')).toContain(`${toPin.dy}px`)
    await select('in')
    await change(host.querySelectorAll<HTMLInputElement>('[aria-label="입력 변수 이름"]')[1], '바뀐 이름')
    expect(edge.data('fromPort')).toBe('b')
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="첫째 변수 삭제"]')!.click())
    expect(c.edges().filter((e) => e.data('fromPort') === 'a')).toHaveLength(0)
    expect(c.edges().filter((e) => e.data('fromPort') === 'b')).toHaveLength(1)
  })

  it('[DM-F02-AC13] 리스트 핀에서 함수 생성 메뉴를 열면 두 번째 리스트 인자로 연결한다', async () => {
    saved.push({ id: 'f', title: '목록 함수', file: '', template: true, nodes: [
      node('in', 'function-input', { params: [{ id: 'text', name: '이름', type: 'single' }, { id: 'items', name: '목록', type: 'list' }] }),
      node('out', 'function-output', { params: [] })
    ], edges: [{ from: 'in', to: 'out' }] })
    await mount()
    const c = graph(), source = c.getElementById('list') as NodeSingular
    c.zoom(1); c.pan({ x: 0, y: 0 })
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    await act(async () => {
      emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y } })
      emit({ type: 'ehcancel', position: { x: 600, y: 0 } }, [source])
      c.emit('tapend')
    })
    const option = [...host.querySelectorAll('.pipe-menu-item')].find((e) => e.textContent?.includes('목록 함수'))
    expect(option).toBeDefined()
    await act(async () => option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    const call = c.nodes('[kind = "template"]').first()
    expect(c.edges().map((e) => [e.data('source'), e.data('target'), e.data('toPort')])).toEqual([['list', call.id(), 'items']])
    await select(call.id())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="목록 기본값"]')?.disabled).toBe(true)
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="이름 기본값"]')?.disabled).toBe(false)
  })

  it('[DM-F02-AC14] 유틸리티에서 For Each를 만들고 본문·완료 핀을 별도 실행 선으로 잇는다', async () => {
    saved[0].nodes.push(node('body', 'shell', { x: 700, y: -100, text: '본문' }), node('after', 'shell', { x: 700, y: 150, text: '완료' }))
    await mount()
    await click('For Each')
    const c = graph(), source = c.nodes('[kind = "foreach"]').first()
    source.position({ x: 300, y: 0 })
    c.zoom(0.25); c.pan({ x: 0, y: 0 })
    expect(source.data('pins')).toMatchObject([
      { side: 'in', type: 'exec' }, { side: 'in', type: 'data', id: P.list, list: true },
      { side: 'out', type: 'exec', id: P.body }, { side: 'out', type: 'data', id: P.item },
      { side: 'out', type: 'data', id: P.index }, { side: 'out', type: 'exec', id: P.done }
    ])
    await select(source.id())
    await change(host.querySelector<HTMLTextAreaElement>('[aria-label="리스트 기본값"]')!, '하나\n둘')
    const emit = c.emit.bind(c) as unknown as (event: { type: string; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } }, args?: unknown[]) => void
    for (const [port, to] of [[P.body, 'body'], [P.done, 'after']]) {
      const pin = source.data('pins').find((p: { id?: string }) => p.id === port) as { dy: number }
      const target = c.getElementById(to) as NodeSingular
      const drop = { x: target.position().x - target.width() / 2, y: target.position().y - 13 }
      await act(async () => {
        emit({ type: 'tapstart', renderedPosition: { x: source.renderedPosition().x + source.renderedWidth() / 2, y: source.renderedPosition().y + pin.dy * c.zoom() } })
        const temporary = c.add({ group: 'edges', data: { id: 'temporary', source: source.id(), target: to } })
        emit({ type: 'ehcomplete', position: drop }, [source, target, temporary])
        c.emit('tapend')
      })
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(saved[0].edges).toEqual([{ from: source.id(), to: 'body', fromPort: P.body }, { from: source.id(), to: 'after', fromPort: P.done }])
    expect(saved[0].nodes.find((n) => n.id === source.id())?.values).toEqual({ [P.list]: '하나\n둘' })
  })

  it('[DM-F02-AC14] 반복과 본문 노드에 실행 상태를 표시하고 항목별 결과는 이름으로 보여 준다', async () => {
    saved[0].nodes.push(node('loop', 'foreach'), node('work', 'shell', { name: '항목 처리' }))
    saved[0].edges = [{ from: 'list', to: 'loop', toPort: P.list }, { from: 'loop', to: 'work', fromPort: P.body }, { from: 'loop', to: 'work', pin: 'data', fromPort: P.item }]
    runs = [{ runId: 'r', pipelineId: 'g', title: '그래프', status: 'done', started: new Date().toISOString(), nodes: {
      'loop/0/work': { status: 'done', name: 'For Each[0]/항목 처리', sourceIds: ['work', 'loop'], output: '첫 결과' },
      'loop/1/work': { status: 'done', name: 'For Each[1]/항목 처리', sourceIds: ['work', 'loop'], output: '둘째 결과' }
    } }]
    await mount()
    expect(graph().getElementById('loop').hasClass('done')).toBe(true)
    expect(graph().getElementById('work').hasClass('done')).toBe(true)
    await select('work')
    expect(host.querySelector('.pipe-runs')?.textContent).toContain('For Each[1]/항목 처리')
    expect(host.querySelector('.pipe-runs')?.textContent).toContain('둘째 결과')
    expect(host.querySelector('.pipe-runs')?.textContent).not.toContain('loop/1/work')
  })
})
