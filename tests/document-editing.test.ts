// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import path from 'path'
import { promises as fs } from 'node:fs'
import Domains from '../src/renderer/src/pages/Domains'
import { ChangeDialog } from '../src/renderer/src/ui'
import { createDomain, listDomains, saveDomain } from '../src/core/domain'
import { createSystemDesign, listDesigns, saveDesign } from '../src/core/design'
import { buildDomainMapFrom } from '../src/core/domainmap'
import { writeMd } from '../src/core/md'
import { newProject } from './helpers'
import { documentImageResponse } from '../src/main/documentImages'

const source = '\n# 결제 문서 {#payment}\n\n## 책임\n\n**승인**을 처리한다.\n줄바꿈을 보존한다.\n\n\n- [ ] 중복 결제 확인\n\n| 입력 | 처리 |\n|---|---|\n| 요청 | 검증 |\n\n```ts\nconst amount = 100\n```\n\n![설계 흐름](assets/flow.svg)\n'
let host: HTMLDivElement, root: Root, ctx: Awaited<ReturnType<typeof newProject>>, domainId: string
let pending: Promise<unknown>[]
const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-content')!)!
async function settle() {
  while (pending.length) {
    const calls = pending.splice(0)
    await act(async () => { await Promise.all(calls) })
  }
}
async function click(text: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`버튼 없음: ${text}`)
  await act(async () => button.click())
}
async function mount(kind: 'role' | 'design' | 'system') {
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(ChangeDialog), createElement(Domains, { refreshKey: 0, focus: `${domainId}#${kind === 'design' ? 'design' : 'role'}`, reloadBadges() {}, go() {} })))
  })
  await settle()
  if (kind === 'system') {
    await click('공통 설계')
    await settle()
  }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  pending = []
  ctx = await newProject()
  const domain = await createDomain(ctx, { title: '결제', folder: 'payment' })
  domainId = domain.id
  await saveDomain(ctx, domainId, { content: source }, { size: 'minor', summary: '테스트 본문' })
  const system = await createSystemDesign(ctx)
  await saveDesign(ctx, system.id, source, { size: 'minor', summary: '테스트 본문' })
  await writeMd(path.join(ctx.dataRoot, 'domains/payment/design/payment.md'), { id: 'payment-design', title: '결제 설계', version: 1, basedOn: [], refs: [] }, source)
  for (const folder of [ctx.dataRoot, path.join(ctx.dataRoot, 'domains/payment'), path.join(ctx.dataRoot, 'domains/payment/design')]) {
    await fs.mkdir(path.join(folder, 'assets'), { recursive: true })
    await fs.writeFile(path.join(folder, 'assets/flow.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await fs.writeFile(path.join(folder, 'assets/updated.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32"/>')
  }
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  window.orbit = {
    getPathForFile: (file: File) => file.name,
    invoke(name: string, ...args: unknown[]) {
      const response = (async () => {
      if (name === 'listDomains') return listDomains(ctx)
      if (name === 'domainMap') return buildDomainMapFrom(await listDomains(ctx))
      if (name === 'listDesigns') return (await listDesigns(ctx)).map((d) => ({ ...d, stale: [] }))
      if (name === 'saveDomain') return saveDomain(ctx, args[0] as string, args[1] as Parameters<typeof saveDomain>[2], args[2] as Parameters<typeof saveDomain>[3])
      if (name === 'saveDesign') return saveDesign(ctx, args[0] as string, args[1] as string, args[2] as Parameters<typeof saveDesign>[3], args[3] as string[])
      if (name === 'listRequests' || name === 'listSpecs') return []
      if (name === 'allAcStatuses') return {}
      throw new Error(`지원하지 않는 API: ${name}`)
      })()
      pending.push(response)
      return response
    },
    on() { return () => {} }
  }
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it.each(['role', 'design', 'system'] as const)('%s 문서는 서식 안에서 바로 수정하고 실제 파일 저장·재열기에서 원문을 보존한다', async (kind) => {
  await mount(kind)
  expect(host.querySelector('textarea')).toBeNull()
  expect(host.textContent).not.toContain('미리보기')
  expect(host.querySelector('.cm-md-h1')?.textContent).toBe('결제 문서')
  expect(host.querySelector('.cm-md-strong')?.textContent).toBe('승인')
  expect(host.querySelector('table')?.textContent).toContain('검증')
  const view = editor()
  expect(view.state.sliceDoc()).toBe(source)
  const readImage = () => documentImageResponse(host.querySelector<HTMLImageElement>('.md img')!.src, ctx, [ctx.projectDir])
  expect((await readImage()).status).toBe(200)
  const at = source.indexOf('승인')
  await act(async () => view.dispatch({ changes: { from: at, to: at + 2, insert: '승인과 취소' } }))
  await act(async () => host.querySelector<HTMLInputElement>('.cm-md-task-box')!.click())
  const imageAt = view.state.sliceDoc().indexOf('flow.svg')
  await act(async () => view.dispatch({ changes: { from: imageAt, to: imageAt + 8, insert: 'updated.svg' } }))
  const expected = source.replace('**승인**', '**승인과 취소**').replace('- [ ]', '- [x]').replace('flow.svg', 'updated.svg')
  expect(editor()).toBe(view)
  expect(view.state.sliceDoc()).toBe(expected)
  await click('저장')
  const dialog = host.querySelector('.modal')!, summary = dialog.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(summary, '승인 취소 책임과 검증 상태 반영')
    summary.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('저장', dialog)
  await settle()
  const read = async () => kind === 'role' ? (await listDomains(ctx)).find((d) => d.id === domainId)!.content : (await listDesigns(ctx)).find((d) => d.id === (kind === 'system' ? 'system-design' : 'payment-design'))!.content
  expect(await read()).toBe(expected)
  await act(async () => root.unmount())
  root = createRoot(host)
  await mount(kind)
  expect(editor().state.sliceDoc()).toBe(expected)
  expect(host.querySelector('.cm-md-strong')?.textContent).toBe('승인과 취소')
  expect(host.querySelector<HTMLInputElement>('.cm-md-task-box')?.checked).toBe(true)
  expect(await (await readImage()).text()).toContain('width="32"')
})
