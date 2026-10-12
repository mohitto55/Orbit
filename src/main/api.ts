import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import * as ws from '../core/workspace'
import * as dm from '../core/domain'
import * as sp from '../core/spec'
import * as ds from '../core/design'
import * as ir from '../core/impact'
import * as tk from '../core/task'
import * as vr from '../core/verification'
import * as dr from '../core/drift'
import * as kn from '../core/knowledge'
import * as kg from '../core/graph'
import { listChanges, type ChangeInput, type ChangeSet } from '../core/changes'
import { exists, writeMd } from '../core/md'

export interface ApiDeps {
  send: (channel: string, payload: unknown) => void
  pickFolder: () => Promise<string | null>
  recentFile: string
  onProjectOpened: (ctx: ws.Ctx) => void
}

export function createApi(deps: ApiDeps) {
  let ctx: ws.Ctx | null = null
  let testProc: ChildProcess | null = null

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
      const sessions = await dr.pendingSessions(c).catch(() => [])
      const specs = await sp.listSpecs(c)
      const stale = specs.filter((s) => sp.specStaleness(s, changes).length > 0).map((s) => s.id)
      return {
        settings,
        pendingReviews: pending.length,
        inbox: inbox.length,
        dueTasks: tk.dueTasks(tasks, changes),
        openTasks: tasks.filter((t) => t.status === '대기' || t.status === '진행').length,
        staleSpecs: stale,
        driftDue: dr.isDriftDue(checks, settings, sessions.length),
        pendingSessions: sessions.length,
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

    // Task
    listInbox: () => tk.listInbox(need()),
    addInbox: (title: string, source?: string) => tk.addInbox(need(), title, source),
    classifyInbox: (id: string, input: tk.ClassifyInput) => tk.classifyInbox(need(), id, input),
    discardInbox: (id: string) => tk.discardInbox(need(), id),
    listTasks: () => tk.listTasks(need()),
    createTask: (input: tk.ClassifyInput & { title: string; body?: string }) => tk.createTask(need(), input),
    updateTask: (id: string, patch: Partial<tk.Task>) => tk.updateTask(need(), id, patch),
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
    async runTests(filter?: string) {
      const c = need()
      const settings = await ws.readSettings(c)
      if (!settings.testCommand) throw new Error('프로젝트 설정에 테스트 명령을 먼저 등록하세요')
      if (testProc) throw new Error('테스트가 이미 실행 중입니다')
      const command = filter ? `${settings.testCommand} ${filter}` : settings.testCommand
      const junit = path.join(c.projectDir, settings.junitPath || 'test-results/junit.xml')
      await fs.rm(junit, { force: true })
      deps.send('test-output', `$ ${command}\n`)
      const exitCode: number | null = await new Promise((resolve) => {
        const proc = spawn(command, { cwd: c.projectDir, shell: true, env: process.env })
        testProc = proc
        proc.stdout?.on('data', (d) => deps.send('test-output', d.toString()))
        proc.stderr?.on('data', (d) => deps.send('test-output', d.toString()))
        proc.on('error', (e) => deps.send('test-output', `\n${e.message}\n`))
        proc.on('close', (code) => resolve(code))
      })
      testProc = null
      let summary: vr.RunSummary
      if (await exists(junit)) summary = vr.summarize(command, exitCode, vr.parseJUnit(await fs.readFile(junit, 'utf8')))
      else summary = vr.summarize(command, exitCode, [], `결과 파일을 찾을 수 없습니다: ${junit}`)
      await vr.saveRun(c, summary)
      deps.send('test-done', summary)
      return summary
    },
    stopTests() {
      if (!testProc?.pid) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(testProc.pid), '/T', '/F'])
      else testProc.kill('SIGTERM')
    },

    // Drift
    pendingSessions: () => dr.pendingSessions(need()),
    readSession: (file: string, agent: dr.Agent) => dr.readSessionMessages(file, agent),
    listChecks: () => dr.listChecks(need()),
    finishCheck: (input: { sessionIds: string[]; marks: dr.Mark[]; startedAt?: string }) => dr.finishCheck(need(), input),

    // Knowledge
    listKnowledge: () => kn.listKnowledge(need()),
    saveKnowledge: (input: kn.KnowledgeInput) => kn.saveKnowledge(need(), input),

    // Knowledge Graph
    graph: () => kg.buildGraph(need())
  }
}

export type Api = ReturnType<typeof createApi>
