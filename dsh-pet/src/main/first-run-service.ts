/**
 * 首次使用检查的**编排**（M5-06 的界面部分）。
 *
 * `first-run.ts` 是纯函数：给它事实，它算出清单。`model-resources.ts` 是检查、计划与执行。
 * 这个文件把三样东西接起来，并回答界面真正要问的三件事：
 *
 *   1. 现在缺什么？      → `snapshot()`：定位布局 → 检查模型 → 核对运行时 → 读权限 → `buildFirstRunReport`
 *   2. 下载要花多少、从哪来？ → `downloadPlan()`：只由**已缓存的检查结果**推出，绝不顺手去下载
 *   3. 用户点了确认，开始下 → `download()`：**重新出计划**再逐字比对确认，然后才执行
 *
 * 第 3 条的顺序是有意为之：确认里带的是用户当时看到的地址与去向。重新出计划再比对，
 * 等于把"用户确认的那一份"和"现在真的要下的那一份"当成两个东西来核对 —— 清单、镜像或
 * 模型状态在这中间变了（比如别处刚装好、或镜像前缀被改），就不执行，让界面重新确认。
 * `executeModelDownload` 自己也会校验，这里是第二道，因为计划是在主进程里现算的。
 *
 * 这个文件不碰 Electron：权限与取网络都靠注入。于是它能在 `node --test` 里跑完整的
 * "检查 → 计划 → 确认不符被拒"链路，不需要真的装 mac、也不需要真的联网。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  buildFirstRunReport,
  MODEL_CHECK_DEADLINE_MS,
  type FirstRunReport,
  type MediaAccessStatus,
  type PrivacyState,
} from './first-run.ts'
import type { MacPermission } from './desktop-actions.ts'
import {
  executeModelDownload,
  inspectModels,
  localModelRoot,
  planModelDownloads,
  type DownloadConfirmation,
  type DownloadDeps,
  type DownloadOutcome,
  type DownloadPlan,
  type DownloadPlanItem,
  type ModelCheck,
  type ModelId,
} from './model-resources.ts'
import type { SupportedPlatform } from './platform.ts'
import { planRuntimeLaunch, resolveCli, type AppLayout, type LaunchFailure, type RuntimePlan } from './runtime-launch.ts'

export interface FirstRunServiceOptions {
  readonly userDataDir: string
  readonly platform: SupportedPlatform
  readonly layout: AppLayout
  readonly dshHome: string
  /** 当前 profile；用户换过绑定之后要跟着变。 */
  readonly profile: () => string
  /** Electron 的 `systemPreferences.getMediaAccessStatus('microphone')`。 */
  readonly mediaAccess?: () => MediaAccessStatus
  /**
   * macOS 三项隐私权限的探测。默认按"读不到"处理 —— 与其猜一个，不如让界面显示 unknown，
   * 等真正要用的时候由系统给出结论（`first-run.ts` 对 unknown 的描述就是这么写的）。
   */
  readonly macPermissions?: () => Promise<Partial<Record<MacPermission, PrivacyState>>>
  /** 用户是否在设置里自配了语音识别 / 朗读服务。 */
  readonly voiceApi?: () => { asr: boolean; tts: boolean }
  /** 模型镜像前缀（设置项）。 */
  readonly mirror?: () => string | null
  /** 下载用的 fetch：主进程会传 Electron 的 `net.fetch`（走系统代理）。 */
  readonly fetchImpl?: DownloadDeps['fetch']
  /** 测试注入。 */
  readonly inspect?: typeof inspectModels
  readonly now?: () => number
}

export interface FirstRunSnapshot {
  readonly report: FirstRunReport
  readonly checks: readonly ModelCheck[]
  /** 模型检查是否已超时（界面据此提供"重试检查"）。 */
  readonly modelCheckTimedOut: boolean
  /** 下载计划；`ok:false` 时说明镜像前缀之类的输入不可用。 */
  readonly plan: DownloadPlan | null
  readonly planError: string | null
  readonly modelRoot: string
}

export class FirstRunService {
  private readonly options: FirstRunServiceOptions
  private checks: ModelCheck[] | null = null
  private modelCheckStartedAt: number | null = null
  private lastReport: FirstRunReport | null = null
  private lastPlan: DownloadPlan | null = null
  private lastPlanError: string | null = null

  constructor(options: FirstRunServiceOptions) {
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * 重新检查一遍并出报告。
   *
   * 不并发：模型检查要读几百 MB 的 sha256，两次同时在跑只会互相拖慢，而且后一次的结果
   * 覆盖前一次会让界面看到闪烁的数字。
   */
  async snapshot(): Promise<FirstRunSnapshot> {
    const layout = this.options.layout
    const root = localModelRoot(this.options.userDataDir)
    const now = this.now()
    const startedAt = now
    this.modelCheckStartedAt = startedAt

    let checks: ModelCheck[]
    try {
      checks = await (this.options.inspect ?? inspectModels)(root)
      this.checks = checks
    } catch (error) {
      // 检查本身失败（权限、磁盘）：不把上次的结果当这次的结果用，如实让界面重试。
      this.checks = null
      this.modelCheckStartedAt = null
      this.lastPlan = null
      this.lastPlanError = null
      throw error
    }

    const plan = this.buildPlan(checks)
    this.lastPlan = plan.plan
    this.lastPlanError = plan.error

    // 运行时定位：安装版里 CLI 在 app.asar.unpacked，必须用 realAppDir。
    const profile = this.options.profile()
    const runtimePlan = planRuntimeLaunch({
      dshHome: this.options.dshHome,
      profile,
      appDir: layout.realAppDir,
      packaged: layout.packaged,
    })
    const cli = resolveCli(layout.realAppDir)

    const report = buildFirstRunReport({
      platform: this.options.platform,
      packaged: layout.packaged,
      models: checks,
      modelCheckStartedAt: startedAt,
      now: this.now(),
      permissions: {
        microphone: this.options.mediaAccess?.() ?? 'unknown',
        mac: await this.macPermissions(),
      },
      runtime: {
        profile,
        plan: runtimePlan,
        // 只有找到了才给：界面据此拼"安装插件"那条命令，指到不存在的目录比不显示更糟。
        cliPath: cli && existsSync(cli.cliPath) ? cli.cliPath : null,
        execPath: process.execPath,
      },
      voiceApi: this.options.voiceApi?.(),
    })
    this.lastReport = report

    return {
      report,
      checks,
      modelCheckTimedOut: this.isTimedOut(),
      plan: plan.plan,
      planError: plan.error,
      modelRoot: root,
    }
  }

  /** 模型检查是否已经超过截止时间（界面据此显示"检查超时，可重试"而不是一直转圈）。 */
  isTimedOut(): boolean {
    if (this.modelCheckStartedAt === null) return false
    return this.now() - this.modelCheckStartedAt > MODEL_CHECK_DEADLINE_MS
  }

  private async macPermissions(): Promise<Partial<Record<MacPermission, PrivacyState>>> {
    if (this.options.platform !== 'darwin') return {}
    if (!this.options.macPermissions) return {}
    try {
      return await this.options.macPermissions()
    } catch {
      // 探测失败不该让整份报告失败：三项按 unknown 显示，用户仍能看到模型与麦克风状态。
      return {}
    }
  }

  private buildPlan(checks: readonly ModelCheck[]): { plan: DownloadPlan | null; error: string | null } {
    const result = planModelDownloads(checks, {
      root: localModelRoot(this.options.userDataDir),
      mirror: this.options.mirror?.() ?? null,
    })
    return result.ok ? { plan: result.plan, error: null } : { plan: null, error: result.error }
  }

  /**
   * 现在的下载计划。只读缓存：没检查过就先检查。
   *
   * 界面在渲染"需要下载 X（约 Y MB）"时调它，**不应该**顺带发任何网络请求。
   */
  async downloadPlan(): Promise<{ plan: DownloadPlan | null; error: string | null }> {
    if (this.checks === null) {
      await this.snapshot()
      return { plan: this.lastPlan, error: this.lastPlanError }
    }
    return this.buildPlan(this.checks)
  }

  /**
   * 执行一项下载。`confirmation` 必须是用户在看到的那份计划上点下的那一条。
   *
   * 重新出计划再比对：中间模型被别处装好、镜像改了、清单更新了，都会让"确认的那一项"
   * 与"现在的这一项"对不上 —— 那就退回 `unconfirmed`，让界面重新问一次，而不是照着旧地址下。
   */
  async download(confirmation: DownloadConfirmation): Promise<DownloadOutcome> {
    const checks = this.checks ?? (await this.snapshot().then(() => this.checks))
    if (checks === null) {
      return {
        ok: false,
        modelId: confirmation.modelId,
        stage: 'unconfirmed',
        error: '还没有完成模型检查，不能下载',
        attempts: 0,
        retryable: false,
      }
    }
    const { plan, error } = this.buildPlan(checks)
    if (plan === null) {
      return {
        ok: false,
        modelId: confirmation.modelId,
        stage: 'unconfirmed',
        error: error ?? '下载计划不可用',
        attempts: 0,
        retryable: false,
      }
    }
    const item = plan.items.find(entry => entry.modelId === confirmation.modelId)
    if (!item) {
      return {
        ok: false,
        modelId: confirmation.modelId,
        stage: 'unconfirmed',
        error: '这一项现在不需要下载了（模型已经完整），没有执行',
        attempts: 0,
        retryable: false,
      }
    }
    const outcome = await executeModelDownload(item, confirmation, {
      ...(this.options.fetchImpl ? { fetch: this.options.fetchImpl } : {}),
    })
    // 论成功与否都重查：装好了界面要显示"已就绪"，失败时也要显示当前真实状态
    // （比如校验不过的文件仍在原处，不是"消失了"）。
    this.checks = null
    return outcome
  }
}

/** 给界面用的下载项摘要：不含本地绝对路径之外的实现细节，但保留确认所需的三个字段。 */
export interface DownloadPlanItemView {
  readonly modelId: ModelId
  readonly title: string
  readonly purpose: string
  readonly whenMissing: string
  readonly optional: boolean
  readonly reason: DownloadPlanItem['reason']
  readonly url: string
  readonly upstreamUrl: string
  readonly mirror: string | null
  readonly downloadBytes: number
  readonly installBytes: number
  readonly license: string
  readonly licenseUrl: string
  readonly destinationDir: string
  readonly requiresConfirmation: true
}

/** `DownloadPlanItem` → 界面标签。绝对路径只保留目录，文件清单不进 IPC（太长且没用）。 */
export function toPlanItemView(item: DownloadPlanItem): DownloadPlanItemView {
  return {
    modelId: item.modelId,
    title: item.title,
    purpose: item.purpose,
    whenMissing: item.whenMissing,
    optional: item.optional,
    reason: item.reason,
    url: item.url,
    upstreamUrl: item.upstreamUrl,
    mirror: item.mirror,
    downloadBytes: item.downloadBytes,
    installBytes: item.installBytes,
    license: item.license,
    licenseUrl: item.licenseUrl,
    destinationDir: item.destinationDir,
    requiresConfirmation: true,
  }
}

/** 下载计划 → 界面视图。`notes` 原样带过去：那些是"要花多少磁盘、会不会动已有文件"的说明。 */
export type DownloadPlanView = {
  root: string
  items: readonly DownloadPlanItemView[]
  totalDownloadBytes: number
  totalInstallBytes: number
  notes: readonly string[]
}

export function toPlanView(plan: DownloadPlan): DownloadPlanView {
  return {
    root: plan.root,
    items: plan.items.map(toPlanItemView),
    totalDownloadBytes: plan.totalDownloadBytes,
    totalInstallBytes: plan.totalInstallBytes,
    notes: plan.notes,
  }
}

/** 便于界面显示"检查超时，可重试"时把原因说清楚。 */
export function describePlanError(error: string | null): string | null {
  if (!error) return null
  return `${error}（可在设置里改镜像前缀，或改用 scripts/setup-local-asr 安装）`
}

/**
 * `first-run-report` 通道的返回。
 *
 * 用 ok 区分"查到了"和"没查成"：把异常吞成一份空报告，界面会显示"环境就绪"——
 * 那是最坏的一种谎，用户会以为一切正常，直到语音不响应。
 */
export type FirstRunReportResult =
  | {
      readonly ok: true
      readonly report: FirstRunReport
      readonly plan: DownloadPlanView | null
      readonly planError: string | null
      readonly modelRoot: string
      readonly modelCheckTimedOut: boolean
    }
  | { readonly ok: false; readonly error: string }

/**
 * `first-run-download` 通道的返回。
 *
 * 与 `DownloadOutcome` 分开一层：外层表达"这次调用有没有走完"，内层表达"下载成功没有"。
 * 合并成一个的话，主进程抛异常时界面只能看到"下载失败"，分不清是"没下成"还是"根本没执行"。
 */
export type FirstRunDownloadResult =
  | { readonly ok: true; readonly outcome: DownloadOutcome }
  | { readonly ok: false; readonly error: string }

/** 运行时定位失败时，报告里那条 item 的 stage 对界面有用（"缺插件"和"缺 CLI"下一步不同）。 */
export type RuntimeLocation = RuntimePlan | LaunchFailure | null

/** 供测试断言模型根在预期位置。 */
export function modelRootOf(userDataDir: string): string {
  return path.join(userDataDir, 'local-asr')
}
