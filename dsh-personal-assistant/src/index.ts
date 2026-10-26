/**
 * dsh-personal-assistant 插件入口。
 */
import { mkdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ApprovalService } from './approval.ts'
import { AssistantApprovalService, snapshotDigest } from './assistant-approval.ts'
import { SessionBridge, type HostAgents, type SessionHost } from './bridge.ts'
import { Classifier } from './classifier.ts'
import type { Config as ConfigType } from './config.ts'
import { personalAssistantDomainSpec, type ActivitySpan, type PersonalAssistantDomainSpec } from './domain.ts'
import { createLegacySource, purgeLegacyData, type LegacyTables } from './legacy.ts'
import { HelpContextStore, HelpEpisodeStore, registerHelpEpisodeTools } from './help-context.ts'
import { MemoryStore } from './memory.ts'
import { MigrationStore, runMigration } from './migrate.ts'
import { ObservationStore } from './observation.ts'
import { resolvePetDir } from './pet-dir.ts'
import { reconcilePublishedFile, ReportStore } from './report.ts'
import { ReportApprovalService } from './report-approval.ts'
import { platformCaptureBlockedReason, pruneSampleFiles, readLastSample, readSamples, sampleFileOf, samplerScriptName } from './sampler.ts'
import { buildSpansFrom } from './spans.ts'
import { ProactiveHelpFlow, type ProactiveConfig } from './proactive.ts'
import { ASSISTANT_SCHEMA_VERSION, getUserFlag, openAssistantStore, setUserFlag } from './store.ts'
import { TeamService, type TeamLogger } from './team.ts'
import { TeamStore } from './team-domain.ts'
import { registerTeamTools } from './team-tools.ts'
import { localDateOf, retentionStartDate, startOfLocalDate } from './time.ts'
import { registerAssistantTools } from './tools.ts'
import { ActivityTracker } from './tracker.ts'
import { WorkItemStore } from './work-items.ts'
import { MaterialStore } from './materials.ts'
import { intakeEvidence, type IntakeResult } from './evidence-intake.ts'
import { mountReportWorkbench } from './workbench.ts'

export { Config } from './config.ts'

export const name = 'personal-assistant'
/**
 * 只声明必需服务。cordis 4 里 inject 的每一项都是**必需**依赖（对象形式的值是拦截配置，不表示可选；
 * cordis 3 的 `{ required, optional }` 写法在这里会被当成两个叫 required / optional 的服务，插件永远起不来）。
 * agents 若写进来，没有它的宿主里整个插件会停在 pending。所以 agents 不声明，用到时经 ctx.get 现取，
 * 见 {@link hostAgents}。
 */
export const inject = ['tools', 'storageDomain', 'systemPrompt']

/** 插件上次经 /session/start 自建的会话 id；桌面再开始会话时据此恢复。 */
const OWNED_SESSION_FLAG = 'bridge_owned_session_id'

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 主动提醒的评估周期。比采样间隔粗一个量级：空闲提醒不需要秒级反应。 */
const PROACTIVE_EVALUATE_MS = 30_000

interface PluginLogger {
  info(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

interface PluginContext {
  storageDomain: { open(spec: unknown): Promise<Domain<PersonalAssistantDomainSpec>> }
  effect(execute: () => () => void, label?: string): unknown
  on(event: 'agent/status' | 'agent/disposed', listener: (payload: { agent: unknown; status?: string }) => void): unknown
  logger?(name: string): PluginLogger
  /** cordis 的「不经 inject 读服务」：没有提供时返回 undefined。假宿主可能连这个方法都没有。 */
  get?(name: string): unknown
  /** cordis 的动态依赖：服务可用后再执行回调。无 UI 宿主可能没有这个方法。 */
  inject?(deps: string[], callback: (scope: PluginContext) => void): unknown
}

/**
 * 可选读取宿主的会话服务 ctx.agents。每次调用现取：宿主可能根本没有它、晚于本插件装上或中途卸载。
 * 经 ctx.get 拿到的服务按调用方追踪，create/resume 的所有权因此落在本插件的 fiber 上——
 * 插件卸载时宿主也会把它们一并回收（桥接仍会先按所有权主动释放）。
 */
function hostAgents(ctx: PluginContext): HostAgents | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const value = ctx.get('agents') as Partial<HostAgents> | undefined
  if (!value || typeof value.create !== 'function' || typeof value.resume !== 'function') return undefined
  return value as HostAgents
}

/** 宿主命令面：交互式 UI 才有；headless/ACP 宿主没有这个服务。 */
interface HostCommandInvocation {
  agent?: unknown
  rawInput?: string
}

interface HostCommandResult {
  kind: 'success' | 'error'
  text: string
}

interface HostCommands {
  register(definition: {
    name: string
    description: string
    /** 面板按钮触发的命令不该在会话里留下重复输入。 */
    recordInput?: boolean
    handler: (invocation: HostCommandInvocation) => Promise<HostCommandResult> | HostCommandResult
  }): () => void
}

function hostCommands(ctx: PluginContext): HostCommands | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const value = ctx.get('commands') as Partial<HostCommands> | undefined
  if (!value || typeof value.register !== 'function') return undefined
  return value as HostCommands
}

export interface UserCommandDeps {
  bridge: SessionBridge
  tracker: ActivityTracker
  captureBlockedReason: () => string | null
  captureScopeAuthorized: () => boolean
  log?: (message: string) => void
}

/**
 * 用户在聊天框里直接点到的一键入口（输入框 + 菜单 / 斜杠命令）。
 *
 * 与工具调用的区别只在入口：召唤仍走同一条 bind，开关仍走同一个 tracker，
 * 不经模型、不产生消息，点一下就执行。宿主没有 commands 服务时静默跳过。
 */
export function registerUserCommands(ctx: PluginContext, deps: UserCommandDeps): void {
  if (mountUserCommands(ctx, deps)) return
  // commands 由 dsh-base 提供，但插件激活顺序不保证它已经就绪；
  // 直接放弃会让命令在部分启动顺序下静默消失，所以等它出现再挂。
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['commands'], scope => {
    if (!mountUserCommands(scope, deps)) {
      deps.log?.('commands 服务已出现，但仍拿不到注册表，一键命令未挂载')
    }
  })
}

function mountUserCommands(ctx: PluginContext, deps: UserCommandDeps): boolean {
  const commands = hostCommands(ctx)
  if (!commands) return false
  const { bridge, tracker } = deps
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const register = (definition: Parameters<HostCommands['register']>[0]): void => {
      disposers.push(commands.register(definition))
    }

    register({
      name: 'summon-pet',
      description: '召唤桌面宠物并绑定到当前会话',
      recordInput: false,
      async handler(invocation) {
        const agent = invocation.agent
        if (!agent) {
          // 没有会话也能先把宠物叫出来；绑定留到用户打开会话后的下一次点击。
          const launched = bridge.teamEnabled ? false : bridge.launchPet()
          return launched
            ? { kind: 'success', text: '桌面宠物已启动；打开一个会话后再点一次即可绑定' }
            : { kind: 'error', text: '没有可绑定的会话，也没能启动桌宠；请在 dsh-pet 目录运行 pnpm start' }
        }
        try {
          const { port } = await bridge.bind(agent as Parameters<SessionBridge['bind']>[0])
          const launched = bridge.teamEnabled ? false : bridge.launchPet()
          return {
            kind: 'success',
            text: bridge.teamEnabled
              ? `会话已绑定（桥接端口 ${port}）；团队模式的桌面角色由桌面壳负责`
              : launched
                ? '桌面宠物已召唤并绑定到当前会话'
                : `会话已绑定（桥接端口 ${port}），但没能拉起桌宠；请在 dsh-pet 目录运行 pnpm start`,
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    register({
      name: 'bind-pet',
      description: '把桌面宠物绑定到当前会话（不启动宠物）',
      recordInput: false,
      async handler(invocation) {
        const agent = invocation.agent
        if (!agent) return { kind: 'error', text: '当前命令没有可绑定的会话' }
        try {
          const { port } = await bridge.bind(agent as Parameters<SessionBridge['bind']>[0])
          return { kind: 'success', text: `当前会话已绑定到桌面宠物（桥接端口 ${port}）` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    register({
      name: 'assistant-on',
      description: '开启个人助理模式，开始记录电脑活动',
      recordInput: false,
      async handler() {
        const blocked = deps.captureBlockedReason()
        if (blocked) return { kind: 'error', text: `未开启活动记录：${blocked}` }
        if (!deps.captureScopeAuthorized()) {
          return { kind: 'error', text: '采集范围还没确认：先在对话里说一次「开启个人助理模式」完成确认' }
        }
        if (tracker.capturing) return { kind: 'success', text: '个人助理模式已经在运行' }
        try {
          await tracker.start()
          return { kind: 'success', text: '个人助理模式已开启，开始记录电脑活动' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    register({
      name: 'assistant-off',
      description: '关闭个人助理模式，停止记录电脑活动',
      recordInput: false,
      async handler() {
        try {
          await tracker.stop()
          return { kind: 'success', text: '个人助理模式已关闭，已停止记录' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'personal-assistant:commands')
  deps.log?.('一键命令已注册：summon-pet / assistant-on / assistant-off')
  return true
}

export async function apply(ctx: PluginContext, config: ConfigType): Promise<void> {
  const home = dshHome()
  const logger = ctx.logger?.('personal-assistant')
  const log = (message: string): void => {
    logger?.info(message)
  }

  const domain = await ctx.storageDomain.open(personalAssistantDomainSpec)
  ctx.effect(() => () => void domain.close(), 'personal-assistant:domain')

  // 每个平台一份采样脚本（Windows: sampler.ps1，macOS: sampler-macos.js）；没有实现的平台
  // 由下面的采集闸门如实拦住，路径只是占位，永远不会被拉起。
  const scriptPath = fileURLToPath(new URL(`../assets/${samplerScriptName(process.platform) ?? 'sampler.ps1'}`, import.meta.url))
  const sampleDir = path.join(home, 'personal-assistant', 'samples')
  mkdirSync(sampleDir, { recursive: true })

  // 助理库：记忆 / 观察 / 日报版本。刻意独立于 desktop-team/team.sqlite——
  // 团队是可选功能（teamEnabled 默认关闭），记忆不是。混在一个库里，
  // 关掉团队就得连带决定记忆放哪。
  const storePath = config.storePath || path.join(home, 'personal-assistant', 'assistant.sqlite')
  const db = openAssistantStore(storePath)
  const memories = new MemoryStore(db)
  const observations = new ObservationStore(db)
  const reports = new ReportStore(db)
  const migrations = new MigrationStore(db)
  ctx.effect(() => () => db.close(), 'personal-assistant:store')

  const classifier = new Classifier(config.customRules)
  // 迁移与跟踪器必须用同一套聚合口径，否则搬进来的历史和当天看到的对不上。
  const spansOf = (date: string): ActivitySpan[] =>
    buildSpansFrom(readSamples(sampleFileOf(sampleDir, date)), classifier, config.minSpanMs, config.sampleIntervalMs)

  // 上次进程崩在发布中途的日报作业先核对清楚：它可能其实已经写成功了，
  // 也可能留下一个和内容对不上的文件。这一步必须在任何新的发布之前。
  await reconcilePublishJobs(reports, log)

  const legacyTables: LegacyTables = {
    preferences: domain.table('preferences'),
    days: domain.table('days'),
    reports: domain.table('reports'),
  }

  const migration = config.migrateLegacy
    ? runMigration(
        {
          db,
          memories,
          observations,
          reports,
          migrations,
          source: createLegacySource({ tables: legacyTables, sampleDir, buildSpans: spansOf }),
          targetVersion: ASSISTANT_SCHEMA_VERSION,
          runId: `run-${Date.now().toString(36)}`,
          now: () => Date.now(),
        },
        {
          fromDate: null,
          // 当天的采样文件还在长，片段会随新采样重新合并，导进来也对不上，所以排除今天。
          toDate: localDateOf(Date.now()),
          timezone: systemTimezone(),
        },
      )
    : null

  if (migration) {
    for (const batch of migration.batches) {
      log(`migration ${batch.id}: ${batch.state}，导入 ${batch.imported} 条、跳过 ${batch.skippedRows} 条；${batch.message}`)
    }
  }

  // 旧数据清理只在迁移确实跑完、且用户显式打开开关时才做。半迁移状态下删旧数据
  // 等于把没搬过去的那部分直接扔掉。
  if (migration?.complete && config.deleteLegacyAfterMigration) {
    const outcome = await purgeLegacyData(legacyTables)
    log(`legacy purge: ${JSON.stringify(outcome)}`)
  }

  // 采集闸门。三个来源：用户关掉了采集、旧数据没搬完、或者这个平台上压根没有采集实现。
  // 迁移没跑完就继续采样，新旧两套记录会搅在一起，之后再也分不清哪条是哪来的。
  //
  // 平台这一条是**能力**而不是**授权**：采样实现只有 Windows（PowerShell + user32）与
  // macOS（osascript JXA）两份。其余平台（如 Linux）如实拦住，而不是拉一个必然失败的子进程 ——
  // 后者每三秒重试一次，日志刷满而用户只看到"助理坏了"。
  const captureBlockedReason = (): string | null => {
    if (!config.captureActivity) return '配置里 captureActivity 已关闭，不采集前台活动'
    const unsupported = platformCaptureBlockedReason(process.platform)
    if (unsupported) return unsupported
    if (migration && !migration.complete) return `旧数据迁移未完成：${migration.failures.join('；')}`
    return null
  }

  const describeCaptureScope = (titles: boolean): Record<string, unknown> => ({
    captureActivity: config.captureActivity, captureWindowTitles: titles,
    sampleIntervalMs: Math.max(1000, config.sampleIntervalMs),
    excludedProcesses: config.excludedProcesses, excludedTitleKeywords: config.excludedTitleKeywords,
    retentionActivityDays: config.retentionActivityDays,
    destination: '本机采样文件；活动证据会按需发送当前会话模型服务商用于解释及日报',
    note: '仅前台应用、可选标题与空闲指标；不截图、不读聊天正文、不记键鼠内容',
  })
  const captureScopeAuthorized = (titles: boolean): boolean =>
    getUserFlag(db, 'capture_scope_digest') === snapshotDigest(describeCaptureScope(titles))
  const tracker = new ActivityTracker(domain, classifier, scriptPath, sampleDir, {
    sampleIntervalMs: Math.max(1000, config.sampleIntervalMs),
    minSpanMs: config.minSpanMs,
    captureTitles: config.captureWindowTitles,
    excludedProcesses: config.excludedProcesses,
    excludedTitleKeywords: config.excludedTitleKeywords,
    captureBlockedReason,
    captureScopeAuthorized,
  })

  // 保留期清理排在迁移之后：先搬再删，反过来会把还没搬进新库的原文直接删掉。
  const retention = applyRetention({
    sampleDir,
    observations,
    memories,
    retentionDays: Math.max(1, Math.floor(config.retentionActivityDays)),
    now: Date.now(),
  })
  if (retention.prunedSampleDays > 0 || retention.prunedSpans > 0 || retention.expiredMemories > 0) {
    log(
      `retention（保留 ${retention.keepFromDate} 起）：采样原文删除 ${retention.prunedSampleDays} 天、`
      + `活动片段 ${retention.prunedSpans} 条、过期记忆 ${retention.expiredMemories} 条失效 / ${retention.deletedMemories} 条删除`,
    )
  }

  // 会话桥接：宠物消息经 agent.followup 注入召唤它的那个会话，
  // 历史与模型与主会话一致，凭据直接复用，宠物端无需配置 API key。
  // 桌面也可以经 POST /session/start 自己开始会话：恢复或新建的会话归本插件所有，id 记在 user_flags。
  const sessionHost: SessionHost = {
    agents: () => hostAgents(ctx),
    readOwnedSessionId: () => getUserFlag(db, OWNED_SESSION_FLAG),
    writeOwnedSessionId: sessionId => setUserFlag(db, OWNED_SESSION_FLAG, sessionId),
    cwd: () => process.cwd(),
  }
  /**
   * 证据收件的处理器。资料库要等下面的装配段才建好，而桥接在这里就要构造 ——
   * 所以先留一个转发器，资料库建好后立刻补上。请求只会在插件装载完成后到达，
   * 那时这个变量一定已经有值；万一没有，如实回"还没准备好"，不假装收下。
   */
  let evidenceIntakeHandler: ((request: unknown) => IntakeResult) | null = null
  // 桌面宠物目录：显式配置 > DSH_PET_DIR > 插件同级的 dsh-pet（从同一仓库克隆的人天然满足）。
  // 解析不到时召唤只绑定会话，工具会提示用户手动启动，不把作者本机路径写死。
  const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const petDirResolution = resolvePetDir({
    configured: config.petDir,
    env: process.env.DSH_PET_DIR,
    pluginDir,
    exists: dir => {
      try { return statSync(dir).isDirectory() } catch { return false }
    },
  })
  const bridge = new SessionBridge({
    dshHome: home,
    petDir: petDirResolution.dir ?? undefined,
    activityState: () => ({ active: tracker.active, capturing: tracker.capturing, titles: tracker.captureTitles }),
    logger,
    sessionHost,
    evidenceIntake: request => evidenceIntakeHandler?.(request)
      ?? { ok: false, error: '证据库还在初始化，请稍后重试' },
  })

  // 帮助授权与主动帮助 episode 各只有一份：工具、团队执行器与主动提醒共用，授权与追溯落在同一处。
  const helpContexts = new HelpContextStore(db)
  const helpEpisodes = new HelpEpisodeStore(db)

  // 主动提醒（design.md §2.7）：策略在 proactive.ts，这里只做三件事 ——
  // 周期性评估、把候选推给宠物、把用户的点选记回状态机（ProactiveHelpFlow 负责落 user_flags 与 episode）。
  // 「关闭提醒」是用户意愿：重启不能把它悄悄复活。拒绝与不回应两条路上不生成候选、不读任何东西。
  if (config.proactiveEnabled) {
    const proactiveConfig: ProactiveConfig = {
      enabled: true,
      idleMs: Math.max(60_000, config.proactiveIdleMs),
      cooldownMs: Math.max(60_000, config.proactiveCooldownMs),
    }
    const proactive = new ProactiveHelpFlow({
      flags: { get: key => getUserFlag(db, key), set: (key, value) => setUserFlag(db, key, value) },
      config: proactiveConfig,
      episodes: helpEpisodes,
      // 只在用户点「好」之后调用：候选取自已采集的数据，不额外读取。标题只在授权采集标题时才给。
      facts: () => {
        const sample = readLastSample(sampleFileOf(sampleDir, localDateOf(Date.now())))
        return {
          sessionCwd: bridge.boundSessionCwd(),
          foreground: sample && !sample.idle && !sample.excluded
            ? { process: sample.proc ?? '', title: tracker.captureTitles ? (sample.title ?? null) : null }
            : null,
          authorized: helpContexts.list(),
        }
      },
    })
    bridge.onProactiveFeedback(kind => {
      proactive.feedback(kind, Date.now())
      if (kind === 'disable') log('proactive：用户关闭了主动提醒，重启后也不会再弹')
    })
    const evaluateProactiveOnce = (): void => {
      const sample = readLastSample(sampleFileOf(sampleDir, localDateOf(Date.now())))
      const pet = bridge.getPetState()
      const decision = proactive.evaluate({
        now: Date.now(),
        idleMs: typeof sample?.idleMs === 'number' ? sample.idleMs : null,
        focusMode: pet.focus,
        stageVisible: pet.visible,
        meetingActive: pet.meeting,
        captureActive: tracker.capturing,
        sampleAt: sample?.ts ?? null,
        sampleIntervalMs: Math.max(1000, config.sampleIntervalMs),
        developmentApp: !sample?.idle && !sample?.excluded && classifier.classify(sample?.proc ?? '', sample?.title ?? '').category === 'dev',
        taskRunning: (teamRuntime?.team.runningCount() ?? 0) > 0,
      })
      if (decision.kind !== 'none') {
        bridge.pushProactive(decision.message, decision.kind === 'suggest-disable')
        log(`proactive：${decision.kind}（idle ${Math.round((sample?.idleMs ?? 0) / 1000)}s）`)
      }
    }
    const proactiveTimer = setInterval(() => {
      try {
        evaluateProactiveOnce()
      } catch {
        // 一拍失败（文件正被写、句柄异常）不影响下一拍；提醒是锦上添花，不值得让它抛
      }
    }, PROACTIVE_EVALUATE_MS)
    ctx.effect(() => () => clearInterval(proactiveTimer), 'personal-assistant:proactive')
  }

  bridge.attachAssistantApprovals(new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: Math.max(10_000, config.approvalTtlMs) }))
  const reportDir = config.reportDir || path.join(home, 'personal-assistant', 'reports')
  bridge.attachReportApprovals(new ReportApprovalService(db, reports, {
    epoch: bridge.epoch,
    reportDir,
    ttlMs: Math.max(10_000, config.approvalTtlMs),
    stop: () => tracker.stop(),
    active: () => tracker.active,
  }), config.approvalMode)
  // 桌面专家助理团：默认关闭，由 desktop-team profile 显式打开；
  // 也允许用户在会话里说「开启团队模式」动态挂载（personal_assistant_set_team_mode），
  // 选择记在 user_flags，重启后不丢。团队委派与审批都挂在桥接的运行时代次上，
  // 代次变化后旧批准一律失效。
  let teamRuntime: TeamRuntime | null = null
  const teamFlagOn = (): boolean => getUserFlag(db, 'team_mode_enabled') === 'true'
  const enableTeamMode = (): { toolsRegistered: boolean } => {
    if (teamRuntime) return { toolsRegistered: teamRuntime.toolsRegistered }
    teamRuntime = mountTeam(ctx, config, { home, bridge, logger, log, helpContexts, helpEpisodes })
    setUserFlag(db, 'team_mode_enabled', 'true')
    return { toolsRegistered: teamRuntime.toolsRegistered }
  }
  const disableTeamMode = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const runtime = teamRuntime
    const running = runtime?.team.runningCount() ?? 0
    if (running > 0) {
      return { ok: false, error: `还有 ${running} 个团队任务在执行，等它们结束再关闭团队模式` }
    }
    if (runtime) {
      bridge.detachTeam()
      // 释放失败（子代理没能静止）时如实报错并保持团队开启：账目还没对清就把模式
      // 标成已关、把库关掉，等于把结果不明的副作用弄丢。teamRuntime 留着供重试，
      // dispose 内部只重试释放、不重发任务。
      try {
        await runtime.dispose()
      } catch (error) {
        return {
          ok: false,
          error: `关闭团队模式失败，团队保持开启以便重试：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    teamRuntime = null
    setUserFlag(db, 'team_mode_enabled', 'false')
    return { ok: true }
  }
  if (config.teamEnabled || teamFlagOn()) {
    enableTeamMode()
    log(`team runtime mounted (profile: ${config.teamEnabled}, flag: ${teamFlagOn()})`)
  }
  // 清理顺序与注册顺序相反：先等自有子代理静止，再关库，最后才是桥接。
  // 卸载钩子是同步的，等不了异步收尾；但释放失败必须出声且不关库——dispose 链路里
  // 关库排在最后，前面抛错时团队库保持打开，结果不明的账目留给下次启动对账。
  ctx.effect(() => () => {
    teamRuntime?.dispose().catch(error => {
      const message = `团队释放失败，团队库保持打开待核查：${error instanceof Error ? error.message : String(error)}`
      if (logger?.error) logger.error(message)
      else log(`[error] ${message}`)
    })
  }, 'personal-assistant:team')

  // 工作事项与导入材料各一份：对话工具、日报工作台和删除传播读写同一处，不各自建一份副本。
  const workItems = new WorkItemStore(db)
  const materials = new MaterialStore(db)
  // 外部证据收件（会议纪要 / 窗口文本）：桌面壳经 POST /evidence/intake 送进来。
  // 校验与入库都在 `intakeEvidence` 里，这里只把资料库与时钟接上。
  evidenceIntakeHandler = request => intakeEvidence(request, { materials, now: () => Date.now() })
  registerAssistantTools(ctx as never, tracker, {
    reportDir,
    bridge,
    memories,
    memoryApprovalSnapshot: () => ({
      records: db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY source_id, derived_id').all(),
    }),
    reports,
    observations,
    workItems,
    materials,
    helpContexts,
    captureScope: {
      acked: () => captureScopeAuthorized(tracker.captureTitles),
      ack: scope => setUserFlag(db, 'capture_scope_digest', snapshotDigest(scope ?? describeCaptureScope(tracker.captureTitles))),
      describe: titles => describeCaptureScope(titles ?? tracker.captureTitles),
    },
    maxInjectedMemories: Math.max(0, Math.floor(config.maxInjectedMemories)),
    captureBlockedReason,
    legacyCopiesRetained: config.migrateLegacy && !config.deleteLegacyAfterMigration,
    enableTeamMode,
    disableTeamMode,
    approvalMode: () => config.approvalMode,
  })
  // 一键入口：输入框「+ → 指令」里的召唤与开关，不经过模型、不产生消息。
  registerUserCommands(ctx, {
    bridge,
    tracker,
    captureBlockedReason,
    captureScopeAuthorized: () => captureScopeAuthorized(tracker.captureTitles),
    log,
  })
  // 日报工作台：桌面逐条修订、按看到的那一版请求发布、分类删除。发布与删除只经桌面可信审批生效。
  mountReportWorkbench(bridge, {
    db, tracker, reports, memories, observations, workItems, materials, helpContexts, reportDir,
    legacyCopiesRetained: config.migrateLegacy && !config.deleteLegacyAfterMigration,
    // 记忆改写：工作台自己不能改，只能把"改成什么"提成可信待批，由用户在审批窗口看新旧全文后点头。
    memoryWrites: {
      approvalMode: () => config.approvalMode,
      proposeMemoryEdit: ({ memoryId, text, topic, before, scopeLabel: label }) => {
        const snapshot = { memoryId, before, after: { text, topic: topic ?? before.topic }, scope: label }
        const digest = snapshotDigest(snapshot)
        const reload = () => memories.get(memoryId, Date.now())
        const proposal = bridge.submitAssistant({
          subject: 'memories',
          tool: 'personal_assistant_edit_preference',
          summary: `把记忆「${before.text.slice(0, 30)}」改写为「${text.slice(0, 30)}」：编号不变，版本号 +1。批准后立即影响当前及未来会话的模型提示词。`,
          target: label === '全局' ? '本机全局记忆与未来会话模型' : `${label} 的记忆`,
          risk: 'high',
          snapshot,
          // 期间记忆被删、被改或换了状态，这张卡就作废：批的必须是用户看到的那一份。
          validate: () => {
            const current = reload()
            return current !== null && current.status !== 'expired'
              && current.text === before.text && current.topic === before.topic
              && snapshotDigest(snapshot) === digest
          },
          execute: () => {
            const updated = memories.revise(memoryId, { text, ...(topic === undefined ? {} : { topic }), actor: { id: 'desktop-shell', isUser: true } }, Date.now())
            if (!updated) throw new Error('改写失败：这条记忆已不存在或已失效')
            return { edited: true, id: updated.id, text: updated.text, topic: updated.topic, revision: updated.revision }
          },
        })
        return proposal.proposalId
      },
    },
  })
  // 主动帮助的候选与选定：选定的读取范围只经桌面可信审批生效，模型自报的范围无效。
  ctx.effect(() => registerHelpEpisodeTools(ctx as never, {
    episodes: helpEpisodes,
    helpContexts,
    submit: submission => bridge.submitAssistant(submission),
  }), 'personal-assistant:help-episodes')

  // 会话运行态全量转发；idle 同时驱动原有因果回复结算。
  ctx.on('agent/status', payload => {
    bridge.onAgentStatus(payload.agent, payload.status)
  })
  ctx.on('agent/disposed', payload => {
    bridge.onAgentDisposed(payload.agent)
  })
  // 插件卸载：通知宠物退场、关闭桥接服务，并按所有权释放桥接自建的会话（返回的 Promise 交给宿主等）。
  ctx.effect(() => () => bridge.dispose(), 'personal-assistant:bridge')

  // 采样器是插件的托管子进程：插件卸载时（web 服务停止 / profile 卸载）必须回收，
  // 否则会遗留孤儿进程。清理钩子早于任何可能抛错的初始化注册，保证一定生效。
  ctx.effect(() => () => tracker.dispose(), 'personal-assistant:sampler')

  // 插件加载即监听（未绑定）：桌面壳不必等网页召唤就能找到运行时并经 /session/start 开始会话；
  // 未绑定时对话与审批如实拒绝。起不来不拖垮插件——召唤宠物时 bind 会再试一次。
  try {
    const listening = await bridge.listen()
    log(listening.advertised
      ? `bridge listening (unbound) on 127.0.0.1:${listening.port}`
      : `bridge listening on 127.0.0.1:${listening.port}; bridge.json is still served by runtime pid ${listening.incumbentPid ?? '?'}`)
  } catch (error) {
    const message = `bridge failed to listen at load (a summon will retry): ${error instanceof Error ? error.message : String(error)}`
    if (logger?.warn) logger.warn(message)
    else log(`[warn] ${message}`)
  }

  // 模式开启但采样进程已死（插件重载/进程崩溃）时重新拉起；采集被拦住时不拉。
  await tracker.ensureSamplerAlive()
  log(`loaded (store: ${storePath}, sampleDir: ${sampleDir}, reportDir: ${reportDir}, team: ${config.teamEnabled})`)
}

interface RetentionDeps {
  sampleDir: string
  observations: ObservationStore
  memories: MemoryStore
  retentionDays: number
  now: number
}

/**
 * 一次团队挂载的全部运行时所有物。
 * dispose 按「先子代理静止 → 对账未完成态 → 关库」的顺序释放；前面任何一步失败
 * 都会抛给调用方并且不关库，结果不明的账目留给下次启动对账。
 */
interface TeamRuntime {
  team: TeamService
  approvals: ApprovalService
  /** 团队委派工具是否注册成功；false 时团队服务仍在，只是模型缺委派入口。 */
  toolsRegistered: boolean
  dispose(): Promise<void>
}

interface MountTeamDeps {
  home: string
  bridge: SessionBridge
  logger?: PluginLogger
  log(message: string): void
  /** 帮助任务的读取授权与主动帮助 episode：与工具、主动提醒共用同一份。 */
  helpContexts: HelpContextStore
  helpEpisodes: HelpEpisodeStore
}

/**
 * 创建团队服务、注册团队工具并挂上桥接。装配期与运行时开关共用这一条路径，
 * 保证两种入口挂出来的是同一种东西。
 */
function mountTeam(ctx: PluginContext, config: ConfigType, deps: MountTeamDeps): TeamRuntime {
  const teamStorePath = config.teamStorePath || path.join(deps.home, 'desktop-team', 'team.sqlite')
  const store = new TeamStore(teamStorePath)
  const teamLogger: TeamLogger = {
    info: (message, meta) => deps.log(meta === undefined ? message : `${message} ${JSON.stringify(meta)}`),
    warn: (message, meta) => {
      const text = meta === undefined ? message : `${message} ${JSON.stringify(meta)}`
      if (deps.logger?.warn) deps.logger.warn(text)
      else deps.log(`[warn] ${text}`)
    },
    error: (message, meta) => {
      const text = meta === undefined ? message : `${message} ${JSON.stringify(meta)}`
      if (deps.logger?.error) deps.logger.error(text)
      else deps.log(`[error] ${text}`)
    },
  }
  const inferenceSlots = Math.max(1, Math.floor(config.maxConcurrentInference))
  const approvals = new ApprovalService(store, {
    ttlMs: Math.max(10_000, config.approvalTtlMs),
    runtimeEpoch: deps.bridge.epoch,
  })
  const team = new TeamService(ctx as never, store, {
    teamId: config.teamId,
    provider: config.teamProvider,
    maxConcurrentInference: inferenceSlots,
    maxConcurrentSideEffect: Math.max(1, Math.min(Math.floor(config.maxConcurrentSideEffect), inferenceSlots)),
    taskTimeoutMs: Math.max(10_000, config.taskTimeoutMs),
    defaultBudgetTokens: Math.max(0, Math.floor(config.defaultBudgetTokens)),
    seats: config.teamSeats,
    denyExpertTools: config.denyExpertTools,
    approvals,
    logger: teamLogger,
    helpScopes: deps.helpContexts,
    episodes: deps.helpEpisodes,
  })
  team.ensureRoster()
  // 挂载后立即对账上次进程中断的任务：还挂着 running 的任务/运行/副作用一律记成
  // unknown，只对账、不重发。对账失败就让挂载失败并释放刚开的库句柄——
  // 带着没对过的账上岗，恢复流程就可能重发已经发生过的副作用。
  try {
    team.recoverInterruptedTasks()
  } catch (error) {
    store.close()
    throw error
  }
  // 装配完成后再注册工具，宿主可能不接受：尽力注册，失败时团队服务照常工作
  //（快照、审批卡片、宠物团队页），只是模型缺委派入口，重启后必然可用。
  let toolsRegistered = true
  let unregisterTools: (() => void) | undefined
  try {
    unregisterTools = registerTeamTools(ctx as never, { team, approvals, bridge: deps.bridge })
  } catch (error) {
    toolsRegistered = false
    deps.log(`team tools registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  deps.bridge.attachTeam(team, approvals)
  return {
    team,
    approvals,
    toolsRegistered,
    dispose: async () => {
      // 先等自有子代理全部静止；释放失败必须抛给调用方，并且不走到关库——
      // 还有结果不明的运行就把库关掉，等于把副作用账目撕掉。
      await team.dispose()
      // 关库前把仍未完成的状态对账成 unknown：卸载或关闭团队模式都不丢账，
      // 下次启动的恢复流程据此拒绝盲重试。
      team.recoverInterruptedTasks()
      unregisterTools?.()
      store.close()
    },
  }
}

interface RetentionOutcome {
  keepFromDate: string
  prunedSampleDays: number
  prunedSpans: number
  expiredMemories: number
  deletedMemories: number
}

/**
 * 按保留期清理原始活动。
 *
 * 只对 activity_span 生效：旧记录里的语义事项和用户笔记是已经确认过的成果，
 * 按 design.md 的保留期限候选，它们留到用户自己删为止，不该被保留期悄悄抹掉。
 *
 * 采样原文必须真删文件。原始活动里最敏感的就是窗口标题，只删库里的派生观察、
 * 把 JSONL 留在磁盘上，"保留 N 天"就是一句空话。磁盘上的日期边界和库里的时间戳
 * 边界由同一个 keepFromDate 推出来，两边不会差出一天。
 */
function applyRetention(deps: RetentionDeps): RetentionOutcome {
  const keepFromDate = retentionStartDate(deps.now, deps.retentionDays)
  const prunedSamples = pruneSampleFiles(deps.sampleDir, keepFromDate)
  const prunedSpans = deps.observations.deleteRange('activity_span', startOfLocalDate(keepFromDate))
  const memoryRetention = deps.memories.applyRetention(deps.now)
  return {
    keepFromDate,
    prunedSampleDays: prunedSamples.length,
    prunedSpans,
    expiredMemories: memoryRetention.expired,
    deletedMemories: memoryRetention.deleted,
  }
}

/**
 * 上次崩在发布中途的日报作业，逐个核对目标文件。
 *
 * 核对而不是重发：内容对得上就说明那次其实成功了，补记已归档即可；文件不在就退回
 * 草稿并要求重新可信审批；文件在但内容对不上，说明有人或有别的进程动过它——这时候重发
 * 会覆盖掉用户的东西，所以把该版本标成已撤销，让人来决定怎么办。
 */
async function reconcilePublishJobs(reports: ReportStore, log: (message: string) => void): Promise<void> {
  for (const job of reports.openJobs()) {
    const state = await reconcilePublishedFile(job.targetPath, job.digest)
    if (state === 'matches') {
      reports.finishJob(job.operationId, 'succeeded', Date.now())
      reports.setReportState(job.reportId, job.revision, 'archived')
      log(`publish job ${job.operationId}：目标文件内容与确认时的摘要一致，补记为已归档`)
      continue
    }
    if (state === 'missing') {
      reports.finishJob(job.operationId, 'failed', Date.now())
      reports.setReportState(job.reportId, job.revision, 'draft')
      log(`publish job ${job.operationId}：${job.targetPath} 不存在，已退回草稿；需重新提交并由用户批准，不自动重发`)
      continue
    }
    reports.finishJob(job.operationId, 'unknown', Date.now())
    reports.markRevoked(
      job.reportId,
      job.revision,
      '上次发布中断，目标文件已存在但内容与确认时的摘要不一致，没有覆盖它；请人工核对后重新出草稿',
    )
    log(`publish job ${job.operationId}：${job.targetPath} 的内容和确认时的摘要不一致，没有覆盖它，该版本已撤销`)
  }
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}
