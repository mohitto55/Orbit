import { test as base, expect, _electron, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProject, type Ctx } from '../../src/core/workspace'
import { createTask, type Task } from '../../src/core/task'
import { readMd } from '../../src/core/md'

export type Orbit = { app: ElectronApplication; page: Page; ctx: Ctx; directory: string; isolatedHome: string }

export const test = base.extend<{ orbit: Orbit; accountState: unknown }>({
  accountState: [undefined, { option: true }],
  orbit: async ({ accountState }, use, testInfo) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-ui-'))
    const profile = path.join(directory, 'profile')
    const isolatedHome = path.join(directory, 'home')
    await fs.mkdir(profile)
    await fs.mkdir(isolatedHome)
    if (accountState) { await fs.mkdir(path.join(profile, 'agent-accounts')); await fs.writeFile(path.join(profile, 'agent-accounts/accounts.json'), JSON.stringify(accountState)) }
    const ctx = await createProject(path.join(directory, 'project'), 'Markdown UI QA')
    const bootstrap = path.join(directory, 'launch.cjs')
    // Only the test process receives this profile. Launch the production entry point,
    // preload, renderer and IPC without exposing a test API in the shipped app.
    await fs.writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('appData', ${JSON.stringify(profile)});\napp.setPath('userData', ${JSON.stringify(profile)});\napp.setPath('home', ${JSON.stringify(isolatedHome)});\nrequire(${JSON.stringify(path.resolve('out/main/index.js'))});\n`)
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[0] !== 'ELECTRON_RENDERER_URL'))
    const app = await _electron.launch({ args: [bootstrap, '--no-sandbox'], env: { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: path.join(isolatedHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(isolatedHome, '.claude'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' } })
    const page = await app.firstWindow()
    const errors: string[] = []
    const captureErrors = (window: Page) => {
      window.on('pageerror', (error) => errors.push(error.stack ?? error.message))
      window.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()) })
    }
    captureErrors(page); app.on('window', captureErrors)
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    try {
      await page.evaluate((dir) => window.orbit.invoke('openProject', dir), ctx.projectDir)
      await page.reload()
      await expect(page.locator('.brand-name')).toContainText('Markdown UI QA')
      await use({ app, page, ctx, directory, isolatedHome })
      expect(errors, 'Renderer errors').toEqual([])
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0
      if (!page.isClosed()) {
        const screenshot = testInfo.outputPath('screen.png')
        await page.screenshot({ path: screenshot })
        await testInfo.attach('screen', { path: screenshot, contentType: 'image/png' })
      }
      if (failed) {
        const trace = testInfo.outputPath('trace.zip')
        await app.context().tracing.stop({ path: trace })
        await testInfo.attach('trace', { path: trace, contentType: 'application/zip' })
      } else await app.context().tracing.stop()
      await app.close()
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
})

export { expect }

export async function openTask(orbit: Orbit, source: string): Promise<{ editor: Locator; task: Task }> {
  const task = await createTask(orbit.ctx, { title: 'Markdown QA 문서', body: source, type: 'test', horizon: '언젠가' })
  await orbit.page.reload()
  await orbit.page.locator('nav').getByRole('button', { name: '할 일', exact: true }).click()
  await orbit.page.getByText(task.title, { exact: true }).click()
  const editor = orbit.page.locator('.modal .live-markdown')
  await expect(editor.locator('.cm-content')).toBeVisible()
  // The title is a real focus target outside CodeMirror, so all blocks render.
  await orbit.page.locator('.modal input').first().focus()
  return { editor, task }
}

export async function blurEditor(page: Page) {
  await page.locator('.live-markdown:visible .cm-content').evaluate((element) => (element as HTMLElement).blur())
}

export async function replaceDocument(page: Page, editor: Locator, source: string) {
  await editor.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(source)
  await blurEditor(page)
}

export async function expectNoOverflow(editor: Locator) {
  const dimensions = await editor.locator('.cm-scroller').evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }))
  expect(dimensions.scroll, 'The document must fit; wide tables scroll inside their own wrapper').toBeLessThanOrEqual(dimensions.width + 2)
}

export async function saveTaskAndReopen(orbit: Orbit, task: Task, expected: string) {
  await orbit.page.locator('.modal').getByRole('button', { name: '저장', exact: true }).click()
  await expect(orbit.page.locator('.modal')).toHaveCount(0)
  await expect.poll(async () => (await readMd(task.file)).content.trim()).toBe(expected.trim())
  await orbit.page.reload()
  await orbit.page.getByText(task.title, { exact: true }).click()
  const editor = orbit.page.locator('.modal .live-markdown')
  await expect(editor.locator('.cm-content')).toBeVisible()
  await orbit.page.locator('.modal input').first().focus()
  return editor
}
