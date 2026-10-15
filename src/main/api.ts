import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import * as ws from '../core/workspace'
import * as dm from '../core/domain'
import * as sp from '../core/spec'
import * as ds from '../core/design'
import * as ir from '../core/impact'
import * as tk from '../core/task'
import * as undo from '../core/undo'
import * as vr from '../core/verification'
import * as dr from '../core/drift'
import * as kn from '../core/knowledge'
import * as kg from '../core/graph'
import * as df from '../core/diff'
import { buildDomainMap, buildDomainScope } from '../core/domainmap'
import { checkAnchors } from '../core/codecheck'
import { ensureModelSection } from '../core/model'
import { listChanges, type ChangeInput, type ChangeSet } from '../core/changes'
import { exists, writeMd } from '../core/md'
import type { TerminalKind } from '../core/terminal'
import { TerminalWorkspace } from '../core/terminalWorkspace'

export interface ApiDeps {
  send: (channel: string, payload: unknown) => void
  pickFolder: () => Promise<string | null>
  recentFile: string
  onProjectOpened: (ctx: ws.Ctx) => void
}

export function createApi(deps: ApiDeps) {
  let ctx: ws.Ctx | null = null
  let testProc: ChildProcess | null = null
  let testBusy = false
  let testRevision = 0
  let testSession: { projectDir: string; state: vr.TestRunState } | null = null
  let terminals: TerminalWorkspace | null = null
  let loadingTerminals: Promise<TerminalWorkspace> | null = null

  /** node-pty는 필요할 때 불러온다. 이 OS용 바이너리가 없으면 터미널만 쓸 수 없고 나머지는 동작한다. */
  async function terms(): Promise<TerminalWorkspace> {
    const c = need()
    if (loadingTerminals) return loadingTerminals
    if (terminals) return terminals
    loadingTerminals ??= import('node-pty').then(async ({ spawn: spawnFn }) => {
      const settings = await ws.readSettings(c)
      if (ctx !== c) throw new Error('프로젝트가 변경되었습니다')
      const key = createHash('sha256').update(path.resolve(c.projectDir)).digest('hex')
      const workspace = new TerminalWorkspace(path.join(path.dirname(deps.recentFile), 'terminals', `${key}.json`), c, spawnFn, {
        onData: (id, data, sequence) => deps.send('term-data', { id, data, sequence }),
        onExit: (id, code) => deps.send('term-exit', { id, code }),
        onChange: (info) => deps.send('term-info', info),
        onError: (message) => deps.send('term-error', message)
      })
      terminals = workspace
      try { await workspace.restore(settings) } catch (e) { workspace.suspend(false); throw e }
      if (ctx !== c) { workspace.suspend(); throw new Error('프로젝트가 변경되었습니다') }
      return workspace
    }).catch((e: unknown) => {
      if (ctx === c) { loadingTerminals = null; terminals = null }
      throw new Error(`이 환경에서는 터미널을 열 수 없습니다: ${e instanceof Error ? e.message : String(e)}`)
    })
    return loadingTerminals
  }

  const need = (): ws.Ctx => {
    if (!ctx) throw new Error('프로젝트가 열려 있지 않습니다')
    return ctx
  }

  async function readRecent(): Promise<string[]> {
    try {
      return JSON.parse(await fs.readFile(deps.recentFile, 'utf8'))
    } catch {
      return []
    }
  }

  async function remember(dir: string) {
    const list = [dir, ...(await readRecent()).filter((d) => d !== dir)].slice(0, 10)
    await fs.mkdir(path.dirname(deps.recentFile), { recursive: true })
    await fs.writeFile(deps.recentFile, JSON.stringify(list), 'utf8')
  }

  async function opened(c: ws.Ctx) {
    if (ctx?.projectDir !== c.projectDir) {
      terminals?.suspend()
      terminals = null
      loadingTerminals = null
    }
    ctx = c
    await remember(c.projectDir)
    deps.onProjectOpened(c)
    return { ...c, settings: await ws.readSettings(c), isGit: await ws.isGitRepo(c.projectDir) }
  }

  /** 저장으로 생긴 큰 변경은 바로 영향 검토로 넘긴다 (system-design S6). */
  async function afterChange(change: ChangeSet | null) {
    if (!change) return null
    const links = change.target.startsWith('spec-') ? await vr.scanTestLinks(need().projectDir) : []
    return ir.openReview(need(), change, links)
  }

  /** 앱이 꺼져 있던 동안 생긴 큰 변경을 다시 처리한다. */
  async function replayChanges() {
    const c = need()
    const links = await vr.scanTestLinks(c.projectDir)
    for (const ch of await listChanges(c)) if (ch.size === 'major') await ir.openReview(c, ch, links)
  }

  return {
    // Workspace
    async recentProjects() {
      const out: string[] = []
      for (const d of await readRecent()) if (await exists(d)) out.push(d)
      return out
    },
    pickFolder: () => deps.pickFolder(),
    async createProject(dir: string, name?: string) {
      return opened(await ws.createProject(dir, name))
    },
    async openProject(dir: string) {
      const r = await opened(await ws.openProject(dir))
      await replayChanges()
      return r
    },
    async currentProject() {
      return ctx ? { ...ctx, settings: await ws.readSettings(ctx), isGit: await ws.isGitRepo(ctx.projectDir) } : null
    },
    closeProject() {
      terminals?.suspend()
      terminals = null
      loadingTerminals = null
      ctx = null
    },
    getSettings: () => ws.readSettings(need()),
    saveSettings: (s: ws.ProjectSettings) => ws.saveSettings(need(), s),

    async dashboard() {
      const c = need()
      const settings = await ws.readSettings(c)
      const [pending, inbox, tasks, changes, checks, requests, run] = await Promise.all([
        ir.pendingItems(c),
        tk.listInbox(c),
        tk.listTasks(c),
        listChanges(c),
        dr.listChecks(c),
        dr.listRequests(c),
        vr.loadLastRun(c)
      ])
      const sessionCount = await dr.pendingSessionCount(c).catch(() => 0)
      const specs = await sp.listSpecs(c)
      const stale = specs.filter((s) => sp.specStaleness(s, changes).length > 0).map((s) => s.id)
      return {
        settings,
        pendingReviews: pending.length,
        inbox: inbox.length,
        dueTasks: tk.dueTasks(tasks, changes),
        openTasks: tasks.filter((t) => t.status === '대기' || t.status === '진행').length,
        staleSpecs: stale,
        driftDue: dr.isDriftDue(checks, settings, sessionCount),
        pendingSessions: sessionCount,
        pendingRequests: requests.filter((r) => r.status === 'pending').length,
        lastRun: run ? { at: run.at, passed: run.passed, failed: run.failed, total: run.total } : null
      }
    },

    // Domain Modeling
    listDomains: () => dm.listDomains(need()),
    createDomain: (input: dm.CreateDomainInput) => dm.createDomain(need(), input),
    async saveDomain(id: string, patch: dm.DomainPatch, change: ChangeInput) {
      const r = await dm.saveDomain(need(), id, patch, change)
      return { ...r, review: await afterChange(r.change) }
    },
    async deleteDomain(id: string) {
      const c = need()
      const spec = (await sp.listSpecs(c)).find((s) => s.domainId === id)
      const live = spec ? spec.features.filter((f) => f.status !== '폐기').length : 0
      return dm.deleteDomain(c, id, live)
    },
    /** 도메인 지도: 상위 안에 하위를 묶고 도메인 사이 관계를 선으로 */
    domainMap: () => buildDomainMap(need()),
    /** 고른 도메인 하나의 그래프 (하위 도메인·개념·관계) */
    domainScope: (rootId: string) => buildDomainScope(need(), rootId),
    /** 모델 표의 코드 위치가 실제 코드에 있는지 */
    async checkAnchors(domainId?: string) {
      const c = need()
      const domains = await dm.listDomains(c)
      return checkAnchors(c, domainId ? domains.filter((d) => d.id === domainId) : domains)
    },
    /** 모델 섹션이 없는 도메인 문서 본문에 빈 모델 표를 붙인 결과 (저장은 하지 않음) */
    withModelSection: (content: string) => ensureModelSection(content),
    async history(target: string) {
      return (await listChanges(need())).filter((c) => c.target === target).reverse()
    },
    listRequests: () => dr.listRequests(need()),
    resolveRequest: (id: string) => dr.resolveRequest(need(), id),

    // Spec
    listSpecs: () => sp.listSpecs(need()),
    createSpec: (domainId: string) => sp.createSpec(need(), domainId),
    addFeature: (specId: string, input: { name: string; purpose?: string }) => sp.addFeature(need(), specId, input),
    async saveFeatures(specId: string, features: sp.Feature[], change?: ChangeInput | null) {
      const r = await sp.saveFeatures(need(), specId, features, change)
      return { ...r, review: await afterChange(r.change) }
    },
    reconfirmSpec: (specId: string, note: string) => sp.reconfirmSpec(need(), specId, note),
    async specStatus(specId: string) {
      const c = need()
      const spec = await sp.getSpec(c, specId)
      const changes = await listChanges(c)
      const links = await vr.scanTestLinks(c.projectDir)
      const run = await vr.loadLastRun(c)
      const pendingAcs = new Set(
        (await ir.pendingItems(c)).filter((p) => p.item.layer === 'test').map((p) => p.item.target.replace(/^test:/, ''))
      )
      return {
        stale: sp.specStaleness(spec, changes),
        acStatus: vr.acStatuses(spec.features, links, run, pendingAcs)
      }
    },
    /** 모든 명세의 AC 상태. 테스트 파일 훑기·실행 기록 읽기를 명세마다 반복하지 않고 한 번만 한다. */
    async allAcStatuses() {
      const c = need()
      const [specs, links, run, pending] = await Promise.all([sp.listSpecs(c), vr.scanTestLinks(c.projectDir), vr.loadLastRun(c), ir.pendingItems(c)])
      const pendingAcs = new Set(pending.filter((p) => p.item.layer === 'test').map((p) => p.item.target.replace(/^test:/, '')))
      return Object.fromEntries(specs.map((s) => [s.id, vr.acStatuses(s.features, links, run, pendingAcs)]))
    },

    // Design
    async listDesigns() {
      const c = need()
      const changes = await listChanges(c)
      return (await ds.listDesigns(c)).map((d) => ({ ...d, stale: ds.designStaleness(d, changes) }))
    },
    createDesign: (specId: string, featureId: string) => ds.createDesign(need(), specId, featureId),
    createSystemDesign: () => ds.createSystemDesign(need()),
    async saveDesign(id: string, content: string, change: ChangeInput, sections: string[] = []) {
      const r = await ds.saveDesign(need(), id, content, change, sections)
      return { ...r, review: await afterChange(r.change) }
    },

    // Impact Review
    listReviews: () => ir.listReviews(need()),
    pendingItems: () => ir.pendingItems(need()),
    decide: (reviewId: string, target: string, decision: ir.Decision, note?: string) =>
      ir.decide(need(), reviewId, target, decision, note),
    async changesById(ids: string[]) {
      return (await listChanges(need())).filter((c) => ids.includes(c.id))
    },
    /** IR-F03: 변경 전·후 비교. full이면 접지 않고 전체를 보여준다. */
    async changeDiff(changeId: string, full = false) {
      const c = need()
      const change = (await listChanges(c)).find((x) => x.id === changeId)
      if (!change) throw new Error(`변경 기록을 찾을 수 없습니다: ${changeId}`)
      const r = await df.changeDiff(c, change)
      if ('unavailable' in r) return { change, unavailable: r.unavailable }
      return { change, file: r.file, diff: df.lineDiff(r.before, r.after, full ? -1 : 3) }
    },
    /** 문서 id → 이름·종류·현재 버전·기준 (변경 검토에서 원인 → 영향을 보여줄 때 씀) */
    async docIndex() {
      const c = need()
      const domains = await dm.listDomains(c)
      const specs = await sp.listSpecs(c, domains)
      const designs = await ds.listDesigns(c)
      const out: Record<string, { kind: 'domain' | 'spec' | 'design'; title: string; version: number; domainId?: string; basedOn: { ref: string; version: number; feature?: string }[] }> = {}
      // 어느 도메인의 문서인지 바로 보이도록 이름 앞에 도메인 경로를 붙인다 (예: 앱 기반 › 프로젝트 › 기능 명세 표)
      const pathOfFolder = (folder?: string) => {
        const d = domains.find((x) => x.folder === folder)
        return d ? dm.domainPathLabel(domains, d.id) : ''
      }
      for (const d of domains) out[d.id] = { kind: 'domain', title: dm.domainPathLabel(domains, d.id), version: d.version, basedOn: [] }
      for (const s of specs) {
        const base = dm.domainPathLabel(domains, s.domainId)
        out[s.id] = { kind: 'spec', title: `${base} › ${sp.SPEC_LABEL[s.role]}`, version: s.version, domainId: s.domainId, basedOn: s.basedOn }
        // 테스트 항목(test:<AC ID>)도 어느 도메인의 수용 기준인지 보이게
        for (const f of s.features) for (const a of f.acs) out[`test:${a.id}`] = { kind: 'spec', title: `${base} › ${a.id}`, version: s.version, domainId: s.domainId, basedOn: [] }
      }
      for (const d of designs) {
        const title = d.system ? '시스템 공통 설계' : `${pathOfFolder(d.folder)} › 설계 · ${d.title}`
        out[d.id] = { kind: 'design', title, version: d.version, domainId: domains.find((x) => x.folder === d.folder)?.id, basedOn: [...d.basedOn, ...d.refs.map((r) => ({ ref: r.ref, version: r.version ?? 0, feature: r.section }))] }
      }
      return out
    },

    // Task
    listInbox: () => tk.listInbox(need()),
    addInbox: (title: string, source?: string) => tk.addInbox(need(), title, source),
    classifyInbox: (id: string, input: tk.ClassifyInput & { title?: string; body?: string }) => tk.classifyInbox(need(), id, input),
    discardInbox: (id: string) => tk.discardInbox(need(), id),
    listTasks: () => tk.listTasks(need()),
    createTask: (input: tk.ClassifyInput & { title: string; body?: string }) => tk.createTask(need(), input),
    updateTask: (id: string, patch: Partial<tk.Task>, expectedBody?: string) => tk.updateTask(need(), id, patch, expectedBody),
    deleteTask: (id: string) => tk.deleteTask(need(), id),
    reorderTasks: (ids: string[]) => tk.reorderTasks(need(), ids),

    // 되돌리기
    snapshotFiles: (files: string[]) => undo.snapshotFiles(need(), files),
    restoreFiles: (snaps: undo.FileSnap[]) => undo.restoreFiles(need(), snaps),
    async dueTasks() {
      const c = need()
      return tk.dueTasks(await tk.listTasks(c), await listChanges(c))
    },
    /** TK-F07 AC2: 완료 시 도메인 로직이 바뀌었다고 답하면 변경 요청을 만든다. */
    async requestDomainChange(domainId: string, note: string, source: string) {
      const c = need()
      const id = `req-${Date.now()}`
      await writeMd(
        path.join(c.dataRoot, 'requests', `${id}.md`),
        { id, kind: 'domain-request', domain: domainId, excerpt: note, source, status: 'pending', created: new Date().toISOString() },
        `${note}\n`
      )
    },

    // Verification
    scanTests: () => vr.scanTestLinks(need().projectDir),
    lastRun: () => vr.loadLastRun(need()),
    async testState(): Promise<vr.TestRunState> {
      const c = need()
      if (testSession?.projectDir === c.projectDir) return testSession.state
      const run = await vr.loadLastRun(c)
      // 파일을 읽는 사이 실행이 시작됐으면 현재 상태를 돌려준다.
      if (testSession?.projectDir === c.projectDir) return testSession.state
      return { revision: 0, running: false, log: run?.output ?? '', run }
    },
    async runTests(filter?: string) {
      const c = need()
      if (testBusy) throw new Error('테스트가 이미 실행 중입니다')
      testBusy = true
      try {
        const settings = await ws.readSettings(c)
        if (!settings.testCommand) throw new Error('프로젝트 설정에 테스트 명령을 먼저 등록하세요')
        const command = filter ? `${settings.testCommand} ${filter}` : settings.testCommand
        const junit = path.join(c.projectDir, settings.junitPath || 'test-results/junit.xml')
        const run = await vr.loadLastRun(c)
        const session = { projectDir: c.projectDir, state: { revision: ++testRevision, running: true, log: '', run } }
        testSession = session
        const send = (event: vr.TestRunEvent) => {
          if (ctx?.projectDir === c.projectDir) deps.send('test-state', event)
        }
        const output = (chunk: string) => {
          session.state = { ...session.state, revision: ++testRevision, log: (session.state.log + chunk).slice(-vr.TEST_OUTPUT_LIMIT) }
          send({ type: 'output', revision: session.state.revision, chunk })
        }
        send({ type: 'state', state: session.state })
        output(`$ ${command}\n`)
        let exitCode: number | null = null
        let results: vr.TestResult[] = []
        let error: string | undefined
        try {
          await fs.rm(junit, { force: true })
          exitCode = await new Promise<number | null>((resolve) => {
            const proc = spawn(command, { cwd: c.projectDir, shell: true, env: process.env })
            testProc = proc
            proc.stdout?.on('data', (d: Buffer) => output(d.toString()))
            proc.stderr?.on('data', (d: Buffer) => output(d.toString()))
            proc.on('error', (e) => output(`\n${e.message}\n`))
            proc.on('close', resolve)
          })
          if (!(await exists(junit))) throw new Error(`결과 파일을 찾을 수 없습니다: ${junit}`)
          results = vr.parseJUnit(await fs.readFile(junit, 'utf8'))
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
          output(`\n${error}\n`)
        }
        const summary = { ...vr.summarize(command, exitCode, results, error), output: session.state.log }
        try {
          await vr.saveRun(c, summary)
        } catch (e) {
          const message = `실행 기록을 저장할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`
          summary.error = [summary.error, message].filter(Boolean).join('\n')
          output(`\n${message}\n`)
          summary.output = session.state.log
        }
        session.state = { revision: ++testRevision, running: false, log: summary.output, run: summary }
        send({ type: 'state', state: session.state })
        if (ctx?.projectDir === c.projectDir) deps.send('test-done', summary)
        return summary
      } finally {
        testProc = null
        testBusy = false
      }
    },
    stopTests() {
      if (!testProc?.pid) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(testProc.pid), '/T', '/F'])
      else testProc.kill('SIGTERM')
    },

    // Knowledge
    listKnowledge: () => kn.listKnowledge(need()),
    saveKnowledge: (input: kn.KnowledgeInput) => kn.saveKnowledge(need(), input),

    // Knowledge Graph
    graph: () => kg.buildGraph(need()),

    // 연동: 내장 터미널 (IN-F09)
    async termCreate(kind: TerminalKind, cols?: number, rows?: number) {
      const c = need()
      const settings = await ws.readSettings(c)
      const manager = await terms()
      if (ctx !== c) throw new Error('프로젝트가 변경되었습니다')
      return manager.create(kind, settings, cols, rows)
    },
    async termState() {
      return (await terms()).state()
    },
    async termActivate(id: string) {
      ;(await terms()).activate(id)
    },
    async termRename(id: string, title: string) {
      return (await terms()).rename(id, title)
    },
    async termRestart(id: string) {
      const c = need()
      const settings = await ws.readSettings(c)
      const workspace = await terms()
      if (ctx !== c) throw new Error('프로젝트가 변경되었습니다')
      return workspace.restart(id, settings)
    },
    async termWrite(id: string, data: string) {
      ;(await terms()).write(id, data)
    },
    async termResize(id: string, cols: number, rows: number) {
      ;(await terms()).resize(id, cols, rows)
    },
    async termKill(id: string) {
      ;(await terms()).kill(id)
    },
    killAllTerminals() {
      terminals?.suspend()
    }
  }
}

export type Api = ReturnType<typeof createApi>
