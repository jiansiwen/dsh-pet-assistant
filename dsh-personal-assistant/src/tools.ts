/**
 * 个人助理工具注册与系统提示词编排。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import type { SessionBridge } from './bridge.ts'
import type { SemanticEvent } from './domain.ts'
import { readProjectEvidence, type HelpContextStore } from './help-context.ts'
import type { ObservationStore } from './observation.ts'
import {
  deletionReport,
  describeConflict,
  renderMemorySection,
  type MemoryActor,
  type MemoryContext,
  type MemoryStore,
} from './memory.ts'
import {
  makeReportId,
  type ReportStore,
} from './report.ts'
import { localDateOf, startOfLocalDate } from './time.ts'
import type { ActivityTracker } from './tracker.ts'

interface AssistantHost {
  tools: { register(definition: unknown): () => void }
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
    variable(name: string, provider: () => string | undefined): () => void
  }
}

export interface ToolOptions {
  reportDir: string
  bridge: SessionBridge
  memories: MemoryStore
  reports: ReportStore
  /** 注入系统提示词的记忆条数上限。 */
  maxInjectedMemories: number
  /** 采集闸门：旧数据迁移没跑完时返回原因，开启助理模式的工具据此拒绝启动采集。 */
  captureBlockedReason(): string | null
  /** 采集范围首次确认；未装配时沿用旧行为并在回执里明示范围。 */
  captureScope?: {
    acked(): boolean
    ack(): void
    describe(): Record<string, unknown>
  }
  /** 旧存储域里是否还留着已导入的副本。删除偏好时必须如实告诉用户。 */
  legacyCopiesRetained: boolean
  /** 主动帮助的工作上下文授权；未装配时相关工具明确拒绝，不降级读任意目录。 */
  helpContexts?: HelpContextStore
  /** 观察库；删除某时间段原始记录时需要，未装配时该工具明确拒绝。 */
  observations?: ObservationStore
  /** 运行时挂载团队服务（团队模式开关的「开」）；已挂载时幂等。 */
  enableTeamMode(): { toolsRegistered: boolean }
  /** 运行时卸载团队服务（团队模式开关的「关」）；有运行中任务时拒绝。 */
  disableTeamMode(): Promise<{ ok: true } | { ok: false; error: string }>
}

/** 仅沿用偏好工具的现有身份语义；日报批准不接受模型自报的用户身份。 */
const USER_ACTOR: MemoryActor = { id: 'user', isUser: true }

/**
 * 当前可见的记忆范围。插件上下文没有暴露项目 id，所以只有全局范围生效。
 * 等宿主能把项目标识传进来，在这里填 projectId 就行——优先级排序已经会
 * 让项目范围的记忆压过全局旧记忆，不用再改别处。
 */
const MEMORY_CONTEXT: MemoryContext = {}

const textOutput = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface CategoryStat {
  category: string
  minutes: number
}

function categoryStats(spans: readonly { category: string; start: number; end: number }[]): CategoryStat[] {
  const totals = new Map<string, number>()
  for (const span of spans) {
    totals.set(span.category, (totals.get(span.category) ?? 0) + (span.end - span.start))
  }
  return [...totals.entries()]
    .map(([category, ms]) => ({ category, minutes: Math.round(ms / 60000) }))
    .sort((a, b) => b.minutes - a.minutes)
}

export function registerAssistantTools(ctx: AssistantHost, tracker: ActivityTracker, options: ToolOptions): void {
  const textRender = textOutput.render

  ctx.tools.register(defineTool({
    name: 'personal_assistant_summon_pet',
    description: '召唤桌面宠物：把桌面宠物绑定到当前会话（宠物的对话会写入本会话历史，使用相同的模型与凭据，宠物端无需任何 API key）。用户说"召唤宠物"、"打开桌面宠物"、"把宠物叫出来"、"开启个人助理"等想通过桌面宠物交流的表达时调用。成功后告知用户宠物已出现在桌面。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args: unknown, exec: unknown) {
      // ToolRunContext.agent 由 agent loop 设置——这是绑定"发起召唤的那个会话"的关键。
      const agent = (exec as { agent?: unknown }).agent
      if (!agent) {
        return json({ ok: false, error: '当前执行上下文没有可绑定的会话 agent，无法召唤宠物' })
      }
      const { port } = await options.bridge.bind(agent as Parameters<SessionBridge['bind']>[0])
      // 团队模式下启动所有权归桌面壳（companion-host）：插件再 spawn 一个 `pnpm start`，
      // 桌面上就会出现两支互相不知道对方存在的角色队伍，还会抢同一份 bridge.json。
      const teamMode = options.bridge.teamEnabled
      const launched = teamMode ? false : options.bridge.launchPet()
      return json({
        ok: true,
        bridgePort: port,
        petLaunched: launched,
        teamMode,
        message: teamMode
          ? '会话已绑定到桥接，团队模式已开启；桌面角色由桌面壳负责启动与附着，本插件不会反向拉起它'
          : launched
            ? '桌面宠物已召唤并绑定到本会话'
            : '会话已绑定到桥接；宠物工程未配置自动启动（petDir），请在 dsh-pet 目录手动运行 pnpm start',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_set_team_mode',
    description: '开启或关闭桌面专家助理团（团队模式）。开启后宠物「团队」页出现成员与任务，可以把任务委派给专家（副作用需用户审批）；关闭后桌面退回单助理形态。用户说"开启团队模式"、"关闭团队模式"或询问能否多人协作时调用。开启是即时生效的；关闭在有团队任务执行中会被拒绝。',
    parameters: {
      enabled: { type: 'boolean', required: true, description: 'true=开启团队模式，false=关闭团队模式' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { enabled: boolean }) {
      const current = options.bridge.teamEnabled
      if (args.enabled === current) {
        return json({ ok: true, teamMode: current, message: args.enabled ? '团队模式已经是开启的' : '团队模式已经是关闭的' })
      }
      if (!args.enabled) {
        const outcome = await options.disableTeamMode()
        if (!outcome.ok) return json({ ok: false, error: outcome.error })
        return json({ ok: true, teamMode: false, message: '团队模式已关闭，桌面退回单助理形态' })
      }
      const mounted = options.enableTeamMode()
      return json({
        ok: true,
        teamMode: true,
        toolsRegistered: mounted.toolsRegistered,
        message: mounted.toolsRegistered
          ? '团队模式已开启：成员、任务与审批已就绪。若本轮对话里还没出现团队委派工具，下一条消息再试或重启 dsh 后一定可用'
          : '团队模式已开启：成员、任务与审批已就绪；但委派工具这次没能注册上，重启 dsh 后才会出现',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_start',
    description: '开启个人助理模式：开始后台记录用户当天的电脑活动（前台应用、文档、网页、聊天对象等）。当用户说"开启个人助理模式"或类似表达时调用。若同时想通过桌面宠物交流，可再调用 personal_assistant_summon_pet。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const blocked = options.captureBlockedReason()
      if (blocked) return json({ status: 'refused', message: `未开启活动记录：${blocked}` })
      if (tracker.active) return json({ status: 'already_active', message: '个人助理模式已经在运行中' })
      if (options.captureScope && !options.captureScope.acked()) {
        return json({
          status: 'scope-confirmation-required',
          scope: options.captureScope.describe(),
          message: '首次开启需要用户确认采集范围：请把 scope 原样展示给用户，用户明确同意后调用 personal_assistant_ack_capture_scope，再重新开启。',
        })
      }
      await tracker.start()
      return json({
        status: 'started',
        scope: options.captureScope?.describe() ?? null,
        pet: options.bridge.teamEnabled ? 'desktop-shell-owned' : 'needs-summon',
        message: '个人助理模式已开启，开始记录电脑活动；桌面角色需另调用 personal_assistant_summon_pet。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_ack_capture_scope',
    description: '用户明确同意采集范围后调用一次，记录确认；之后开启助理模式不再重复询问。不能替用户确认，不能在用户未表态时调用。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      if (!options.captureScope) return json({ acked: false, message: '采集范围确认未装配' })
      options.captureScope.ack()
      return json({ acked: true, scope: options.captureScope.describe() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_revoke_report',
    description: '用户要求撤销某版已归档或已批准的日报状态时调用：只改状态标记，不删除已导出文件。删除导出文件必须另外取得用户明确同意并说明不可追回。',
    parameters: {
      revision: { type: 'integer', required: true, description: '要撤销的版本号（来自 personal_assistant_get_draft 的 history）' },
      reason: { type: 'string', required: true, description: '用户给出的撤销原因' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { revision: number; reason: string }) {
      const reportId = makeReportId('daily', localDateOf(Date.now()))
      const record = options.reports.revision(reportId, args.revision)
      if (!record) return json({ revoked: false, message: `找不到第 ${args.revision} 版日报` })
      if (record.state !== 'archived' && record.state !== 'approved') {
        return json({ revoked: false, message: `第 ${args.revision} 版当前状态是 ${record.state}，不需要撤销归档` })
      }
      options.reports.markRevoked(reportId, args.revision, args.reason)
      return json({
        revoked: true,
        revision: args.revision,
        note: '状态已标记为撤销；已导出的文件仍在磁盘上，删除它需要用户另外明确同意',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_delete_activity',
    description: '用户要求删除某段时间的原始活动记录时调用：停采样后删除该时段的采样原文、观察与自动解释事项，并沿来源失效派生记忆。用户笔记与导入记录不删；已发给模型的提示词与已导出文件追不回，必须如实说明。删除前先把影响范围告诉用户并取得明确同意。',
    parameters: {
      startMs: { type: 'number', required: true, description: '区间开始（epoch 毫秒）' },
      endMs: { type: 'number', required: true, description: '区间结束（epoch 毫秒，不含）' },
      reason: { type: 'string', description: '用户给出的删除原因' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { startMs: number; endMs: number; reason?: string }) {
      const observations = options.observations
      if (!observations) return json({ deleted: false, message: '观察库未装配，不能删除原始记录' })
      const from = Number(args.startMs)
      const to = Number(args.endMs)
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return json({ deleted: false, message: '删除区间无效：开始必须早于结束' })
      }
      const dates: string[] = []
      for (let cursor = localDateOf(from); cursor <= localDateOf(to - 1); cursor = localDateOf(startOfLocalDate(cursor) + 86_400_000)) {
        dates.push(cursor)
      }
      const retained = dates.map(date => {
        const day = tracker.getDay(date)
        return {
          date,
          userEvents: day.events.filter(event => event.source !== 'auto' && event.start < to && event.end > from).length,
          notes: day.notes.length,
        }
      }).filter(item => item.userEvents > 0 || item.notes > 0)
      const overlaps = observations.listOverlap('activity_span', from, to)
      const outcome = await tracker.withCapturePaused(async () => {
        let samples = 0
        let autoEvents = 0
        for (const date of dates) {
          samples += tracker.deleteSampleRange(date, from, to)
          autoEvents += await tracker.pruneAutoEvents(date, from, to)
        }
        const memoryOutcomes = overlaps.map(obs => options.memories.delete(obs.id, args.reason ?? '用户要求删除该时段原始记录', Date.now()))
        const obsDeleted = observations.deleteOverlap('activity_span', from, to)
        return { samples, autoEvents, obsDeleted, memoryOutcomes }
      })
      const deletedMemories = outcome.memoryOutcomes.reduce((total, item) => total + item.deleted.length, 0)
      const invalidated = outcome.memoryOutcomes.reduce((total, item) => total + item.weakened.length, 0)
      return json({
        deleted: true,
        deletedCounts: { samples: outcome.samples, observations: outcome.obsDeleted, autoEvents: outcome.autoEvents, derivedMemories: deletedMemories },
        invalidated,
        retained,
        uncontrolled: ['删除前已注入模型提示词的内容无法撤回', '已导出的日报文件与任何外部副本不在本次删除范围'],
        message: '已删除该时段的采样原文、观察与自动事项；用户笔记与导入记录保留。派生记忆按来源传播失效。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_set_capture_titles',
    description: '用户单独交出或收回"窗口标题"采集授权。关闭后新的采样不再读取窗口标题，日报只能说到应用类别；开启后恢复。立即重启采样进程生效，跨重启保留。',
    parameters: { enabled: { type: 'boolean', required: true, description: 'true=允许采集窗口标题，false=只采集应用与空闲指标' } },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { enabled: boolean }) {
      await tracker.setCaptureTitles(args.enabled)
      return json({
        ok: true,
        captureTitles: args.enabled,
        mode: tracker.modeDescription(),
        message: args.enabled ? '已恢复窗口标题采集' : '已停止窗口标题采集，之后的采样只记录应用与空闲指标',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_stop',
    description: '手动关闭个人助理模式，停止活动记录（不生成日报）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      if (!tracker.active) return json({ status: 'already_inactive', message: '个人助理模式未在运行' })
      await tracker.stop()
      return json({ status: 'stopped', message: '个人助理模式已关闭' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_status',
    description: '查询个人助理模式当前状态与今日记录概览。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const day = tracker.getDay(localDateOf(Date.now()))
      return json({
        mode: tracker.modeDescription(),
        today: {
          date: day.date,
          spanCount: day.spans.length,
          eventCount: day.events.length,
          noteCount: day.notes.length,
          categoryStats: categoryStats(day.spans),
        },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_today',
    description: '获取今日记录：已解释的工作事项、尚未解释的活动片段、用户导入的笔记与分类时长统计。回答"我今天干了啥"或生成日报前调用；对返回的未解释片段应先解释并通过 personal_assistant_commit_events 保存。',
    parameters: {
      detail: {
        type: 'string',
        enum: ['brief', 'full'],
        description: 'brief 只返回事项、未解释片段与统计；full 额外返回全部原始活动片段',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { detail?: string }) {
      const day = tracker.getDay(localDateOf(Date.now()))
      const uninterpreted = day.spans.filter(span => span.end > day.interpretedUpto
        && span.category !== 'idle' && span.category !== 'excluded')
      const result: Record<string, unknown> = {
        date: day.date,
        mode: tracker.modeDescription(),
        events: day.events,
        uninterpretedSpans: uninterpreted,
        evidenceLimits: '窗口标题只证明使用线索，不证明聊天正文、对象身份或工作完成。no-input表示长时间无键鼠输入，可能在阅读，不自动计为工作成果；excluded表示隐私排除，禁止推断其内容。',
        notes: day.notes,
        categoryStats: categoryStats(day.spans),
        interpretedUpto: day.interpretedUpto,
      }
      if (args.detail === 'full') result.allSpans = day.spans
      return json(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_commit_events',
    description: '提交对未解释活动片段的语义解释（工作事项），保存后不再重复解释。解释时结合时间顺序与相邻活动推断，例如微信与某人聊天后紧接打开某文档可解释为与该人讨论该文档事务，此类推断的 confidence 用 medium。',
    parameters: {
      events: {
        type: 'array',
        required: true,
        description: '工作事项列表',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: { type: 'integer', required: true, description: '事项开始时间（epoch 毫秒，取自所解释的片段）' },
            end: { type: 'integer', required: true, description: '事项结束时间（epoch 毫秒）' },
            summary: { type: 'string', required: true, description: '一句话概括这个工作事项' },
            evidence: { type: 'array', items: { type: 'string' }, description: '支撑结论的证据（应用名/窗口标题）' },
            confidence: { type: 'string', enum: ['high', 'medium'], required: true, description: 'high=证据直接支持；medium=基于相邻活动的推断' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { events: { start: number; end: number; summary: string; evidence?: string[]; confidence: 'high' | 'medium' }[] }) {
      const date = localDateOf(Date.now())
      const now = Date.now()
      const events: SemanticEvent[] = args.events.map(item => ({
        id: makeId('evt'),
        start: item.start,
        end: item.end,
        summary: item.summary,
        evidence: item.evidence ?? [],
        source: 'auto',
        confidence: item.confidence,
        createdAt: now,
      }))
      const maxEnd = events.reduce((max, event) => Math.max(max, event.end), 0)
      await tracker.enqueueDayUpdate(date, day => ({
        ...day,
        events: [...day.events, ...events],
        interpretedUpto: Math.max(day.interpretedUpto, maxEnd),
      }))
      return json({ committed: events.length, date })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_import_records',
    description: '导入用户提供的聊天记录导出、随手记或任何补充信息到今日记录。用户粘贴聊天导出内容或说"记一下：…"时调用。',
    parameters: {
      content: { type: 'string', required: true, description: '要记录的完整内容' },
      source: { type: 'string', description: '来源标识，如 manual / wechat_export / wxwork_export / feishu_export' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { content: string; source?: string }) {
      const date = localDateOf(Date.now())
      const now = Date.now()
      const isQuickNote = args.content.length <= 100
      const noteId = makeId('note')
      const event: SemanticEvent = {
        id: makeId('evt'),
        start: now,
        end: now,
        summary: isQuickNote ? args.content : `${args.content.slice(0, 80)}…（完整内容见导入记录 ${noteId}）`,
        evidence: [],
        source: args.source && args.source !== 'manual' ? 'import' : 'user',
        confidence: 'high',
        createdAt: now,
      }
      await tracker.enqueueDayUpdate(date, day => ({
        ...day,
        notes: [...day.notes, { id: noteId, content: args.content, source: args.source ?? 'manual', createdAt: now }],
        events: [...day.events, event],
      }))
      return json({ imported: true, noteId, date })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_save_draft',
    description: '保存日报草稿，产生一个新版本；旧版本上的待确认/已确认状态随之作废。生成或修改草稿后必须调用，并把返回的 revision 与 digest 一并展示给用户。',
    parameters: {
      content: { type: 'string', required: true, description: '日报草稿全文（Markdown 格式）' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { content: string }) {
      const date = localDateOf(Date.now())
      const reportId = makeReportId('daily', date)
      let record
      try {
        record = options.reports.saveDraftIfChanged(reportId, args.content, Date.now())
      } catch (error) {
        return json({ savedDraft: false, message: error instanceof Error ? error.message : String(error) })
      }
      options.bridge.notifyApprovalSnapshot()
      return json({
        savedDraft: true,
        date,
        reportId,
        revision: record.revision,
        digest: record.digest,
        state: record.state,
        note: '内容一改，之前那一版的确认就作废了，定稿前需要用户对这一版重新确认',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_get_draft',
    description: '读取今天最新的日报草稿版本与历史版本清单。用户要求修改日报而当前对话没有草稿内容时，必须先调用本工具取回上次草稿。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const date = localDateOf(Date.now())
      const reportId = makeReportId('daily', date)
      const record = options.reports.current(reportId)
      if (!record) return json({ hasDraft: false, date })
      return json({
        hasDraft: true,
        date,
        reportId,
        revision: record.revision,
        digest: record.digest,
        state: record.state,
        draft: record.content,
        filePath: record.targetPath,
        history: options.reports.history(reportId).map(item => ({
          revision: item.revision,
          state: item.state,
          createdAt: item.createdAt,
          revokedReason: item.revokedReason,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_submit_report',
    description: '把当前草稿版本提交到桌面壳的可信审批待办，绑定版本、全文摘要、目标和有效期。只提交不发布；用户须在专用审批窗口阅读全文并批准，无桌面壳时保持待批，聊天中的确认不能发布。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const date = localDateOf(Date.now())
      const reportId = makeReportId('daily', date)
      const current = options.reports.current(reportId)
      if (!current) {
        return json({ submitted: false, message: '还没有草稿可提交，先调用 personal_assistant_save_draft' })
      }
      try {
        const proposal = options.bridge.submitReport(reportId)
        return json({
          submitted: true, date, reportId, proposalId: proposal.proposalId,
          revision: proposal.revision, digest: proposal.digest, targetPath: proposal.target,
          expiresAt: proposal.expiresAt, epoch: proposal.epoch,
          message: '等待用户在桌面专用审批窗口阅读全文并批准；尚未发布，无壳时不会降级自批',
        })
      } catch (error) {
        return json({ submitted: false, message: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_confirm_report',
    description: '只读查询日报待批状态并引导用户打开桌面专用审批窗口。本工具不批准、不发布、不停止采集；即使用户在聊天中说确认，也必须由可信窗口批准。保留 revision/digest 参数仅兼容旧调用。',
    parameters: {
      revision: { type: 'integer', required: true, description: '用户确认的那一版的版本号' },
      digest: { type: 'string', required: true, description: '用户确认的那一版的内容摘要' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args: { revision: number; digest: string }) {
      const reportId = makeReportId('daily', localDateOf(Date.now()))
      const record = options.reports.current(reportId)
      const pending = options.bridge.pendingReportApprovals().find(item => item.reportId === reportId)
      return json({
        confirmed: false, reason: 'trusted_approval_required', reportId,
        state: record?.state, revision: record?.revision,
        proposalId: pending?.proposalId, expiresAt: pending?.expiresAt,
        message: record?.state === 'archived'
          ? '该版本已由可信通道发布，本工具不会重复发布；保存路径请读取日报草稿状态'
          : pending
            ? '日报仍在待批，请在桌面专用审批窗口阅读全文后批准；聊天确认不能发布'
            : '没有可用的日报待批，请先提交当前草稿；没有桌面壳时不能发布',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_remember_preference',
    description: '记录用户明确说出的长期偏好。同主题可以有多条兼容规则，不自动互斥。只有用户明确要求替换旧规则时才填写 replaceIds；单次日报修改不自动成为长期偏好。',
    parameters: {
      text: { type: 'string', required: true, description: '偏好规则的完整描述，照用户的意思写，不要替他扩充' },
      topic: { type: 'string', required: true, description: '这条偏好管的是哪件事，如：日报口径 / 回复语言 / 提交规范' },
      replaceIds: { type: 'array', items: { type: 'string' }, description: '用户明确要求替换的旧规则编号；未点名替换时省略' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { text: string; topic: string; replaceIds?: string[] }) {
      const result = options.memories.put({
        kind: 'user_preference',
        scopeKind: 'global',
        scopeId: '',
        topic: args.topic,
        text: args.text,
        replaceIds: args.replaceIds,
        sensitivity: 'normal',
        sourceRefs: [],
        actor: USER_ACTOR,
      }, Date.now())
      if (!result.ok) {
        return json({ remembered: false, reason: result.rejection, message: result.message })
      }
      return json({
        remembered: true,
        id: result.record.id,
        revision: result.record.revision,
        status: result.record.status,
        superseded: result.superseded.map(item => ({ id: item.id, text: item.text })),
        conflicts: result.conflicts.map(item => ({ id: item.id, text: item.text })),
        message: result.conflicts.length > 0
          ? '同一件事上出现了互相矛盾的说法，这几条都已停下、不再注入提示词，请让用户挑一条'
          : undefined,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_resolve_preference',
    description: '用户明确选择某条历史冲突或候选规则后，使该规则生效；仅将用户点名的 replaceIds 旧规则失效，其余同主题兼容规则不变。先展示规则并取得用户选择，不替用户裁决。',
    parameters: {
      id: { type: 'string', required: true, description: '用户选择生效的记忆编号' },
      replaceIds: { type: 'array', items: { type: 'string' }, description: '用户明确要求被替换的旧规则编号' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { id: string; replaceIds?: string[] }) {
      const record = options.memories.confirm(args.id, USER_ACTOR, Date.now(), args.replaceIds ?? [])
      return record
        ? json({ resolved: true, id: record.id, status: record.status, revision: record.revision })
        : json({ resolved: false, message: '规则不存在、已失效或替换范围不匹配，请重新查看并让用户选择' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_list_preferences',
    description: '列出全部记忆（偏好、项目事实等）及其状态，用于向用户展示或核对。注意：已确认的记忆已自动注入系统提示词，生成日报时无需调用本工具读取。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const now = Date.now()
      return json({
        memories: options.memories.list(MEMORY_CONTEXT, now).map(item => ({
          id: item.id,
          kind: item.kind,
          topic: item.topic,
          text: item.text,
          status: item.status,
          revision: item.revision,
          updatedAt: item.updatedAt,
          imported: item.importBatch !== null,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_forget_preference',
    description: '删除指定的记忆，并返回四类删除结果（已删除 / 已失效 / 仍保留 / 无法控制）。用户要求不再记住某条规则时调用，然后必须把这四类如实转告用户，不能只说"已经忘了"。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的记忆 id（来自 personal_assistant_list_preferences）' },
      reason: { type: 'string', description: '用户给出的删除原因，留空则记为"用户要求不再记住"' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { id: string; reason?: string }) {
      const outcome = options.memories.delete(args.id, args.reason ?? '用户要求不再记住这条', Date.now())
      if (outcome.deleted.length === 0) {
        return json({ removed: false, message: `记忆库里没有 ${args.id} 这条，或者它已经被删过了` })
      }
      const report = deletionReport(outcome, {
        // 只有从旧库导入过的记忆，旧存储域里才可能还留着同一条。
        legacyDomain: options.legacyCopiesRetained && outcome.deleted.some(item => item.importBatch !== null),
        sampleFiles: [],
        exportedFiles: [],
        // 偏好一旦注入过系统提示词就已经发给过模型。没法逐条查"注入过没有"，
        // 这里宁可多说一份追不回的副本，也不替用户猜"应该没发过吧"。
        sentToProvider: true,
      })
      return json({ removed: true, ...report })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_help_context',
    description: '用户同意接受帮助并给出范围后调用：记录本次帮助授权的项目目录、当前文件和补充说明。未记录的目录之后不能读取证据。目录必须是用户明确说出的绝对路径。',
    parameters: {
      projectDir: { type: 'string', required: true, description: '用户授权查看的项目目录绝对路径' },
      currentFile: { type: 'string', description: '用户当前关注的文件绝对路径，须位于项目目录内' },
      note: { type: 'string', description: '用户描述的问题或目标原文' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { projectDir: string; currentFile?: string; note?: string }) {
      const store = options.helpContexts
      if (!store) return json({ recorded: false, message: '帮助上下文未装配，不能记录授权范围' })
      const dir = path.resolve(args.projectDir)
      if (!path.isAbsolute(args.projectDir)) return json({ recorded: false, message: '项目目录必须是绝对路径' })
      const file = args.currentFile ? path.resolve(args.currentFile) : null
      if (file !== null && !file.startsWith(dir + path.sep)) {
        return json({ recorded: false, message: '当前文件不在授权项目目录内，请让用户确认范围' })
      }
      const record = store.add(makeId('help'), dir, file, args.note ?? null, Date.now())
      return json({ recorded: true, id: record.id, projectDir: record.projectDir, currentFile: record.currentFile })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_list_help_contexts',
    description: '列出用户已授权的帮助上下文范围，用于核对或提醒用户撤销。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const store = options.helpContexts
      if (!store) return json({ contexts: [] })
      return json({ contexts: store.list() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_forget_help_context',
    description: '用户要求收回某个帮助范围时调用，删除对应授权记录。',
    parameters: { id: { type: 'string', required: true, description: 'personal_assistant_list_help_contexts 返回的编号' } },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { id: string }) {
      const store = options.helpContexts
      if (!store) return json({ removed: false, message: '帮助上下文未装配' })
      return json({ removed: store.remove(args.id) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_assistant_read_project_evidence',
    description: '只读读取已授权项目的工作证据：Git 分支、变更文件、差异统计、最近提交或非 Git 目录顶层条目。只能用于用户已授权且与当前帮助相关的目录；不得修改文件、不得运行构建或测试、不得联网。需要改代码时改用团队提案与用户审批。',
    parameters: { projectDir: { type: 'string', required: true, description: '已授权的项目目录绝对路径' } },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: { projectDir: string }) {
      const store = options.helpContexts
      if (!store) return json({ ok: false, error: '帮助上下文未装配，不能读取项目证据' })
      if (!store.isAuthorized(args.projectDir)) {
        return json({ ok: false, error: '该目录没有被用户授权为帮助上下文，请先确认范围' })
      }
      const evidence = await readProjectEvidence(args.projectDir)
      return json({ ok: true, ...evidence, readOnly: true })
    },
  }))

  ctx.systemPrompt.section({
    name: 'personal-assistant',
    order: 150,
    text: [
      '## 个人电脑助理',
      '',
      '本环境装有"个人电脑助理"插件，提供 personal_assistant_* 工具，用于记录用户当天的电脑活动并生成工作日报。',
      '状态（模式、活动记录、草稿版本、记忆）必须通过工具读写，不要假设记得之前的对话。',
      '',
      '## 已确认的记忆（默认遵守，无需用户重复说明）',
      '每条都标了类型与适用范围，按标注判断该在什么场合用；标了"导入"的来自旧版本，内容仍是用户当时亲口说过的：',
      '{{personal_assistant_preferences}}',
      '',
      '## 需要用户裁决的矛盾记忆',
      '{{personal_assistant_memory_conflicts}}',
      '',
      '触发与流程规则：',
      '- 用户说"召唤宠物"、"打开桌面宠物"、"把宠物叫出来"，或在开启助理的同时想通过桌面宠物交流：调用 personal_assistant_summon_pet；宠物消息会直接进入当前会话。',
      '- 用户说"开启个人助理模式"或类似表达：调用 personal_assistant_start。若返回 scope-confirmation-required，把 scope 原样展示并询问用户是否同意该采集范围；用户明确同意后调用 personal_assistant_ack_capture_scope 再重新调用 personal_assistant_start。若返回 refused，把 message 原样告诉用户（通常是配置关掉了采集，或旧数据迁移没跑完），不要反复重试。返回 started 且 pet=needs-summon 时，询问用户是否要桌面角色，需要则调用 personal_assistant_summon_pet。',
      '- 用户说"关闭助理模式"：调用 personal_assistant_stop。',
      '- 用户要求删除某段时间的原始记录：先说明将删除采样原文/观察/自动事项、保留用户笔记与导入、已发提示词追不回，取得明确同意后调用 personal_assistant_delete_activity，并把返回的四类结果如实转告。',
      '- 用户要求停止或恢复窗口标题采集（如"别记窗口标题了"）：调用 personal_assistant_set_capture_titles；这只影响标题，不影响应用与空闲指标，也不删除已记录的历史。',
      '- 用户点「好」或同意一起排查后：先询问遇到的问题、项目目录或文件范围；用户给出范围后调用 personal_assistant_help_context 记录授权，再调用 personal_assistant_read_project_evidence 只读分析。分析结论先给用户确认；任何修改、命令或外发都必须走团队提案与桌面审批，不能因为用户同意"看一下"就获得写权限。',
      '- 用户说"开启团队模式"或"关闭团队模式"：调用 personal_assistant_set_team_mode（enabled 分别为 true/false）。返回 ok=false 时把 error 原样告诉用户（最常见是有团队任务还在执行，等它结束再试）。',
      '- 用户问"我今天干了啥"或询问当天活动：调用 personal_assistant_today；对返回的未解释片段（uninterpretedSpans），结合时间顺序与相邻活动解释成工作事项，调用 personal_assistant_commit_events 保存，再以工作事项视角回答。',
      '- 解释原则：只依据返回的数据。推断性结论（如根据聊天后打开的文档推断讨论内容）的 confidence 用 medium 并在回答中标注"（推断）"。不得编造聊天内容等无法获知的信息。窗口标题只是使用线索；截图、UI Automation、聊天正文读取当前未接入，用户要求时如实说明并改用粘贴/导出内容。',
      '- 用户粘贴聊天记录、导出内容，或说"记一下：…"：调用 personal_assistant_import_records。',
      '- 用户说"总结今日工作内容"或"生成日报"：按上方"已确认的记忆"撰写（记忆已在提示词中，不必再调用工具读取），调用 personal_assistant_today（detail 用 full），据此撰写中文日报草稿（按工作类别组织，标注时长与具体内容），调用 personal_assistant_save_draft 保存，再调用 personal_assistant_submit_report 提交确认，然后把草稿全文连同返回的 revision、digest、targetPath 一起展示给用户请求确认。',
      '- 用户对日报提出修改：若当前对话没有草稿内容，先调用 personal_assistant_get_draft 取回最新版本；按用户要求调整后，再次调用 personal_assistant_save_draft（内容一改就是新版本，旧版本的确认自动作废），重新调用 personal_assistant_submit_report，并展示新草稿。只有用户明确表示"以后"、"今后"或长期有效，才调用 personal_assistant_remember_preference 记录；单次修改只改当前草稿。用户明确替换旧规则时填写 replaceIds，不能因主题相同自动替换。',
      '- 用户在聊天中确认定稿（如"可以了"、"确认"）：只能查询 personal_assistant_confirm_report 的待批状态，并引导用户在桌面专用审批窗口阅读全文、核对版本和目标后批准。模型工具不能发布，不能把聊天确认当作授权；未连接桌面壳时保持待批，不得降级。只有可信通道实际发布后才能说已保存，停止采集失败要如实转述。',
      '- 用户表达对日报或助理行为的长期喜好：主动调用 personal_assistant_remember_preference。',
      '- 用户要求删除某条记忆：调用 personal_assistant_forget_preference，然后把返回的四类结果（deleted / invalidated / retained / uncontrolled）如实转告用户，不能只说"已经忘了"。',
      '- "需要用户裁决的矛盾记忆"非空时：在合适的时机把这几条互相矛盾的说法摆给用户，请用户选择应生效的规则，再调用 personal_assistant_resolve_preference；只有用户明确点名不要的规则才填 replaceIds，兼容规则可逐条保留，不自动删除。',
      '',
      '当前状态：{{personal_assistant_mode}}',
    ].join('\n'),
  })

  ctx.systemPrompt.variable('personal_assistant_mode', () => tracker.modeDescription())

  // 记忆直接渲染进系统提示词：任何新会话一启动就自带偏好，不依赖模型记不记得调
  // personal_assistant_list_preferences。记忆存在助理库（全局范围），跨会话、跨天始终生效
  // ——这是"下次开新会话不用重新交代"的保证。
  //
  // 条数要有上限：记忆是只增不减的，全塞进提示词迟早把上下文挤爆，
  // 挤爆之后连当前任务的材料都放不下，那就本末倒置了。按优先级取前 N 条，
  // 剩下的仍然在库里，用户问起时 list_preferences 能看到全部。
  ctx.systemPrompt.variable('personal_assistant_preferences', () => {
    const records = options.memories
      .injectable(MEMORY_CONTEXT, Date.now())
      .slice(0, Math.max(0, options.maxInjectedMemories))
    // 空态必须给字符串而不是 undefined：宿主把"变量没有值"当成装配错误直接炸
    // （真机实测：新库无记忆时报 "prompt variable … has no value"）。空态的话告诉
    // 模型记忆机制存在，别让"已确认的记忆"标题下面空着让模型猜。
    return (
      renderMemorySection(records, MEMORY_CONTEXT)
      ?? '（暂无已确认的记忆。用户表达长期偏好后会自动出现在这里。）'
    )
  })

  // 矛盾的记忆一律不注入（isInjectable 只放 confirmed）。但"不注入"不等于"没这回事"：
  // 用户需要知道有两条互相打架的说法停在那里，否则助理看起来像是把他教过的东西忘了。
  ctx.systemPrompt.variable('personal_assistant_memory_conflicts', () => {
    const now = Date.now()
    const conflicting = options.memories.list(MEMORY_CONTEXT, now).filter(item => item.status === 'conflicting')
    if (conflicting.length === 0) return ''
    const lines: string[] = []
    const used = new Set<string>()
    for (const record of conflicting) {
      if (used.has(record.id)) continue
      const rivals = conflicting.filter(item => !used.has(item.id) && item.id !== record.id && item.topic === record.topic)
      for (const rival of rivals) used.add(rival.id)
      used.add(record.id)
      lines.push(`- ${describeConflict(record, rivals)}`)
    }
    return lines.join('\n')
  })
}
