// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import Start from '../src/renderer/src/pages/Start'

it('최근 프로젝트의 X는 프로젝트를 열지 않고 목록만 제거하며 다시 표시해도 제거된 상태를 유지한다', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.appendChild(host)
  const onOpen = vi.fn(), opened = vi.fn(), removed = vi.fn()
  let recent = ['C:/Projects/first', 'C:/Projects/second']
  window.orbit = {
    getPathForFile: (file) => file.name,
    async invoke(name, ...args) {
      if (name === 'recentProjects') return [...recent]
      if (name === 'removeRecentProject') { removed(args[0]); recent = recent.filter((p) => p !== args[0]); return }
      if (name === 'openProject') { opened(args[0]); return { projectDir: args[0] } }
      throw new Error(name)
    },
    on: () => () => {}
  }
  let root = createRoot(host)
  try {
    await act(async () => root.render(createElement(Start, { onOpen })))
    expect(host.querySelectorAll('.recent li')).toHaveLength(2)
    await act(async () => host.querySelector<HTMLButtonElement>('.recent-remove')!.click())
    expect(removed).toHaveBeenCalledWith('C:/Projects/first')
    expect(host.querySelectorAll('.recent li')).toHaveLength(1)
    expect(opened).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled()
    await act(async () => root.unmount()); root = createRoot(host)
    await act(async () => root.render(createElement(Start, { onOpen })))
    expect(host.querySelector('.recent')!.textContent).not.toContain('first')
    await act(async () => host.querySelector<HTMLButtonElement>('.recent-open')!.click())
    expect(opened).toHaveBeenCalledWith('C:/Projects/second')
    expect(onOpen).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
