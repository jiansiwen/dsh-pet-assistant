/**
 * M3-03/04/05 测试夹具：真实 SQLite、真实工具注册、真实桥接 HTTP、真实助理与日报可信审批服务、
 * 真实工作台服务。只有采集器换成内存替身（采样"原文"是一组片段，可以被删除、也可以被"备份还原"）。
 * 不启动采样进程、模型或桌面；不读 ~/.dsh。临时目录落在 petsBak 对应项目目录，用完即删。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { AssistantApprovalService } from '../../src/assistant-approval.ts'
import { SessionBridge } from '../../src/bridge.ts'
import type { ActivitySpan, DayRecord } from '../../src/domain.ts'
import { HelpContextStore } from '../../src/help-context.ts'
import { MaterialStore } from '../../src/materials.ts'
import { MemoryStore } from '../../src/memory.ts'
import { ObservationStore } from '../../src/observation.ts'
import { publishRevisionFile, ReportStore } from '../../src/report.ts'
import { ReportApprovalService } from '../../src/report-approval.ts'
import { openAssistantStore } from '../../src/store.ts'
import { localDateOf, startOfLocalDate } from '../../src/time.ts'
import { registerAssistantTools } from '../../src/tools.ts'
import type { ActivityTracker } from '../../src/tracker.ts'
import { WorkItemStore } from '../../src/work-items.ts'
import { mountReportWorkbench, type ReportWorkbench } from '../../src/workbench.ts'

export const scratch = path.resolve(import.meta.dirname, '../../../generated-videos/moved-from-assets/petsBak/dsh-personal-assistant')

/** 今天的几段合成活动，全部早于"现在"（凌晨跑测试也一样）。最后一段视为仍在延续，不入观察库。 */
export function timeline() {
  const date = localDateOf(Date.now())
  const start = Math.max(startOfLocalDate(date) + 1000, Date.now() - 90 * 60_000)
  const unit = Math.max(1000, Math.floor((Date.now() - start) / 10))
  const span = (from: number, to: number, app: string, category: string, title: string): ActivitySpan =>
    ({ start: start + from * unit, end: start + to * unit, app, category, title })
  return {
    date,
    spans: [
      span(0, 3, 'Code', 'dev', 'refund.ts - payment'),
      span(3, 6, 'WeChat', 'chat', '张三'),
      span(6, 7, 'Code', 'dev', '仍在延续'),
    ],
  }
}

/** 采集器替身：旧存储域的当天记录 + 可删可还原的采样片段。 */
export class FakeTracker {
  active = true
  capturing = false
  stops = 0
  failDayUpdate = false
  readonly days = new Map<string, DayRecord>()
  readonly spans = new Map<string, ActivitySpan[]>()

  private stored(date: string): DayRecord {
    return structuredClone(this.days.get(date) ?? { date, events: [], notes: [], interpretedUpto: 0 })
  }
  getDay(date: string) { return { ...this.stored(date), spans: [...(this.spans.get(date) ?? [])] } }
  async enqueueDayUpdate(date: string, mutate: (day: DayRecord) => DayRecord) {
    if (this.failDayUpdate) throw new Error('模拟旧存储写入失败')
    const next = mutate(this.stored(date))
    this.days.set(date, structuredClone(next))
    return next
  }
  async start() { this.active = true }
  async stop() { this.stops += 1; this.active = false; this.capturing = false }
  async setCaptureTitles() {}
  modeDescription() { return '测试' }
  deletionSnapshot(dates: readonly string[], from: number, to: number) {
    return dates.map(date => ({ date, samples: (this.spans.get(date) ?? []).filter(item => item.start < to && item.end > from) }))
  }
  deleteSampleRange(date: string, from: number, to: number) {
    const before = this.spans.get(date) ?? []
    const kept = before.filter(item => !(item.start < to && item.end > from))
    this.spans.set(date, kept)
    return before.length - kept.length
  }
  async pruneAutoEvents(date: string, from: number, to: number) {
    const day = this.stored(date)
    const kept = day.events.filter(event => !(event.source === 'auto' && event.start < to && event.end > from))
    this.days.set(date, { ...day, events: kept })
    return day.events.length - kept.length
  }
}

type Json = any

export interface FixtureOptions {
  unlinkFile?: (file: string) => Promise<void>
  publish?: typeof publishRevisionFile
  /** 写入方式：缺省 manual（逐条审批），auto 模拟用户在配置里打开的"自动记录"。 */
  approvalMode?: 'manual' | 'auto'
}

/** 一次"运行时"：同一个库文件上建出的全部服务。重启 = 关掉它，再在同一个库文件上建一个。 */
function openRuntime(dir: string, tracker: FakeTracker, options: FixtureOptions) {
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  const memories = new MemoryStore(db), observations = new ObservationStore(db), reports = new ReportStore(db)
  const workItems = new WorkItemStore(db), materials = new MaterialStore(db), helpContexts = new HelpContextStore(db)
  const reportDir = path.join(dir, 'reports')
  const bridge = new SessionBridge({ dshHome: dir })
  const assistantApprovals = new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: 120_000 })
  bridge.attachAssistantApprovals(assistantApprovals)
  const counters = { publishes: 0 }
  const reportApprovals = new ReportApprovalService(db, reports, {
    epoch: bridge.epoch, reportDir, ttlMs: 120_000,
    stop: () => tracker.stop(), active: () => tracker.active,
    publish: async (...args) => { counters.publishes += 1; return (options.publish ?? publishRevisionFile)(...args) },
  })
  bridge.attachReportApprovals(reportApprovals, options.approvalMode ?? 'manual')
  const tools = new Map<string, { execute(args: unknown, exec?: unknown): Promise<string> }>()
  const sections: string[] = []
  const variables = new Map<string, () => string | undefined>()
  registerAssistantTools({
    tools: { register(def: any) { tools.set(def.name, def); return () => {} } },
    systemPrompt: { section: s => { sections.push(s.text); return () => {} }, variable: (name, provider) => { variables.set(name, provider); return () => {} } },
  }, tracker as unknown as ActivityTracker, {
    reportDir, bridge, memories, reports, observations, workItems, helpContexts, materials,
    memoryApprovalSnapshot: () => ({
      records: db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY source_id, derived_id').all(),
    }),
    captureBlockedReason: () => null, maxInjectedMemories: 10, legacyCopiesRetained: false,
    enableTeamMode: () => ({ toolsRegistered: true }), disableTeamMode: async () => ({ ok: true }),
    approvalMode: () => options.approvalMode ?? 'manual',
  })
  const workbench: ReportWorkbench = mountReportWorkbench(bridge, {
    db, tracker, reports, memories, observations, workItems, materials, helpContexts, reportDir,
    legacyCopiesRetained: false, unlinkFile: options.unlinkFile,
    // 与插件装配同一套逻辑：手动模式提成待批卡，auto 模式直接改写。
    memoryWrites: {
      approvalMode: () => options.approvalMode ?? 'manual',
      proposeMemoryEdit: ({ memoryId, text, topic, before, scopeLabel: label }) => {
        const snapshot = { memoryId, before, after: { text, topic: topic ?? before.topic }, scope: label }
        const proposal = bridge.submitAssistant({
          subject: 'memories',
          tool: 'personal_assistant_edit_preference',
          summary: `把记忆「${before.text.slice(0, 30)}」改写为「${text.slice(0, 30)}」`,
          target: label === '全局' ? '本机全局记忆与未来会话模型' : `${label} 的记忆`,
          risk: 'high',
          snapshot,
          validate: () => {
            const current = memories.get(memoryId, Date.now())
            return current !== null && current.status !== 'expired'
              && current.text === before.text && current.topic === before.topic
          },
          execute: () => {
            const updated = memories.revise(memoryId,
              { text, ...(topic === undefined ? {} : { topic }), actor: { id: 'desktop-shell', isUser: true } }, Date.now())
            if (!updated) throw new Error('改写失败：这条记忆已不存在或已失效')
            return { edited: true, id: updated.id, revision: updated.revision }
          },
        })
        return proposal.proposalId
      },
    },
  })
  let port = 0
  let token = ''
  const runtime = {
    db, memories, observations, reports, workItems, materials, helpContexts, bridge, assistantApprovals, reportApprovals,
    workbench, reportDir, counters, sections, variables,
    async call(name: string, args: unknown = {}): Promise<Json> {
      return JSON.parse(await tools.get(`personal_assistant_${name}`)!.execute(args))
    },
    /** 可信审批窗口那一侧的批准：独立凭据 + 当前代次。 */
    decide(id: string, decision: 'approve' | 'reject' = 'approve') {
      return assistantApprovals.decide(id, decision, bridge.epoch, assistantApprovals.approvalCapabilityToken)
    },
    decideReport(id: string, decision: 'approve' | 'reject' = 'approve') {
      return reportApprovals.decide(id, decision, bridge.epoch, reportApprovals.approvalCapabilityToken)
    },
    /** 桌面壳的做法：先找到运行时（加载即监听），读 bridge.json 拿聊天令牌。 */
    async listen() {
      port = (await bridge.listen()).port
      token = JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge.json'), 'utf8')).token
    },
    async bind() {
      port = (await bridge.bind({ id: 'm3-测试会话', session: { events: [] }, followup: () => assert.fail('测试不得调用模型') } as never)).port
      token = JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge.json'), 'utf8')).token
    },
    get token() { return token },
    get port() { return port },
    approvalCredential(): Json {
      return JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge-approval.json'), 'utf8'))
    },
    async http(method: 'GET' | 'POST', pathname: string, body?: unknown, credential: { token?: string | null; approvalToken?: string } = {}): Promise<{ status: number; body: Json }> {
      const presented = credential.token === undefined ? token : credential.token
      const url = new URL(`http://127.0.0.1:${port}${pathname}`)
      if (presented) url.searchParams.set('token', presented)
      const response = await fetch(url, {
        method,
        headers: { connection: 'close', 'content-type': 'application/json', ...(credential.approvalToken ? { 'x-dsh-approval-token': credential.approvalToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      return { status: response.status, body: await response.json() }
    },
    async view(date: string): Promise<Json> {
      const result = await runtime.http('GET', `/workbench/report?date=${date}`)
      assert.equal(result.status, 200, JSON.stringify(result.body))
      return result.body
    },
    /** 工作台的一次逐条修改：基准取自用户正在看的视图。 */
    edit(view: Json, op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      return runtime.http('POST', '/workbench/report/edit', {
        date: view.date, baseRevision: view.current?.revision ?? 0, baseDigest: view.current?.digest ?? '', op, ...extra,
      })
    },
    async authorize(projectDir: string) {
      const pending = await runtime.call('help_context', { projectDir })
      assert.equal(pending.pending, true, JSON.stringify(pending))
      assert.equal((await runtime.decide(pending.proposalId)).ok, true)
    },
    /** 工作台改写一条记忆：页面只说"这一条改成什么"。 */
    editMemory(memoryId: string, text: string, topic?: string) {
      return runtime.http('POST', '/workbench/memories/edit', { memoryId, text, ...(topic === undefined ? {} : { topic }) })
    },
    close() {
      bridge.dispose()
      db.close()
    },
  }
  return runtime
}

export type Runtime = ReturnType<typeof openRuntime>

export function workbenchFixture(t: TestContext, options: FixtureOptions = {}) {
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(path.join(scratch, 'm3-workbench-'))
  const tracker = new FakeTracker()
  const line = timeline()
  tracker.spans.set(line.date, line.spans)
  let runtime = openRuntime(dir, tracker, options)
  const fixture = {
    dir, tracker, line,
    get rt() { return runtime },
    /** 同一个库文件、同一份旧存储与采样替身上重新装配一次（新运行时代次、新凭据）。 */
    async restart(bind = true) {
      runtime.close()
      runtime = openRuntime(dir, tracker, options)
      if (bind) await runtime.bind()
      return runtime
    },
  }
  t.after(() => {
    try { runtime.close() } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return fixture
}
