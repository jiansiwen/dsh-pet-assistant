/**
 * 活动跟踪器：管理托管采样子进程与模式状态；按需把采样日志聚合为活动片段。
 *
 * 采样器是插件的托管子进程，生命周期 = 助理模式生命周期。
 * 插件卸载前必须调用 {@link ActivityTracker.dispose}，否则会遗留孤儿进程。
 *
 * 旧存储域里这里只还写 days 表（当日活动与解释游标）。preferences 与 reports 已经
 * 搬到助理库，旧表只剩迁移会去只读访问——见 legacy.ts。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Classifier } from './classifier.ts'
import {
  describeTitleUnavailable,
  killSampler,
  launchSampler,
  pruneSampleRange,
  readLastSample,
  readSamples,
  sampleFileOf,
  type SamplerProcess,
} from './sampler.ts'
import { buildSpansFrom } from './spans.ts'
import { localDateOf } from './time.ts'
import type { ActivitySpan, DayRecord, PersonalAssistantDomainSpec } from './domain.ts'

export interface TrackerConfig {
  sampleIntervalMs: number
  minSpanMs: number
  /**
   * 是否授权采集窗口标题。关闭时采样脚本压根不读标题（Windows 不调 GetWindowText，
   * macOS 不碰 System Events），标题不进采样文件——这是采集侧的授权开关，不是事后的过滤器。
   */
  captureTitles: boolean
  excludedProcesses?: readonly string[]
  excludedTitleKeywords?: readonly string[]
  /**
   * 采集被拦住的原因，null 表示允许采集。
   * 装配时由入口给出（配置关掉了采集，或旧数据迁移没跑完）。
   */
  captureBlockedReason(): string | null
  captureScopeAuthorized?(titles: boolean): boolean
}

export function emptyDay(date: string): DayRecord {
  return { date, events: [], notes: [], interpretedUpto: 0 }
}

/** 标题采集实际取值：运行时覆盖优先于插件配置，两者都缺时才默认开启。 */
export function effectiveCaptureTitles(state: { captureTitles?: boolean }, configTitles: boolean): boolean {
  return state.captureTitles ?? configTitles
}

export class ActivityTracker {
  /** 进程内写串行链，避免并发读改写丢失数据。 */
  private writeChain: Promise<unknown> = Promise.resolve()
  /** 当前托管的采样子进程；未开启模式时为 null。 */
  private sampler: SamplerProcess | null = null
  private readonly domain: Domain<PersonalAssistantDomainSpec>
  private readonly classifier: Classifier
  private readonly scriptPath: string
  private readonly sampleDir: string
  private readonly config: TrackerConfig

  // 显式字段而不是参数属性：strip-only TypeScript 不改写语法，参数属性挡住 node --test 直接导入。
  constructor(
    domain: Domain<PersonalAssistantDomainSpec>,
    classifier: Classifier,
    scriptPath: string,
    sampleDir: string,
    config: TrackerConfig,
  ) {
    this.domain = domain
    this.classifier = classifier
    this.scriptPath = scriptPath
    this.sampleDir = sampleDir
    this.config = config
  }

  get active(): boolean {
    return this.domain.global.get().active
  }

  get captureTitles(): boolean { return effectiveCaptureTitles(this.domain.global.get(), this.config.captureTitles) }

  private scopeAuthorized(titles = this.captureTitles): boolean {
    return this.config.captureScopeAuthorized?.(titles) === true
  }

  get capturing(): boolean {
    return this.active && this.sampler?.alive === true && this.config.captureBlockedReason() === null && this.scopeAuthorized()
  }

  async start(): Promise<void> {
    const blocked = this.config.captureBlockedReason()
    if (blocked) throw new Error(`采集被拦住，未启动采样进程：${blocked}`)
    if (!this.scopeAuthorized()) throw new Error('采集范围尚未经可信摘要确认')
    if (this.sampler?.alive) return
    const state = this.domain.global.get()
    this.sampler = launchSampler(this.scriptPath, this.sampleDir, this.config.sampleIntervalMs, {
      captureTitles: effectiveCaptureTitles(state, this.config.captureTitles),
      excludedProcesses: this.config.excludedProcesses,
      excludedTitleKeywords: this.config.excludedTitleKeywords,
    })
    await this.domain.global.set({ ...state, active: true, startedAt: Date.now(), pid: this.sampler.pid })
  }

  /**
   * 单独交出或收回标题授权：持久化覆盖并重启采样进程。
   * 分级授权必须落在采集侧 —— 关掉之后新的采样不再读标题（两个平台同一条路径）。
   */
  async setCaptureTitles(enabled: boolean): Promise<void> {
    if (enabled && !this.scopeAuthorized(true)) throw new Error('窗口标题范围尚未经可信摘要确认')
    const state = this.domain.global.get()
    const wasCapturing = this.sampler?.alive === true
    this.killSamplerNow()
    await this.domain.global.set({ ...state, captureTitles: enabled })
    if (!wasCapturing || !this.scopeAuthorized(enabled) || this.config.captureBlockedReason() !== null) return
    this.sampler = launchSampler(this.scriptPath, this.sampleDir, this.config.sampleIntervalMs, {
      captureTitles: enabled,
      excludedProcesses: this.config.excludedProcesses,
      excludedTitleKeywords: this.config.excludedTitleKeywords,
    })
    await this.domain.global.set({ ...this.domain.global.get(), pid: this.sampler.pid })
  }

  async stop(): Promise<void> {
    this.killSamplerNow()
    await this.domain.global.set({ ...this.domain.global.get(), active: false, startedAt: 0, pid: undefined })
  }

  /** 固定删除影响范围，不能只用聚合片段代替原始样本校验。 */
  deletionSnapshot(dates: readonly string[], from: number, to: number): unknown {
    return dates.map(date => ({
      date,
      samples: readSamples(sampleFileOf(this.sampleDir, date)).filter(sample => sample.ts >= from && sample.ts < to),
      day: this.getDay(date),
    }))
  }

  /** 删除某一天采样原文中落在区间内的样本；调用方须先停止采样。 */
  deleteSampleRange(date: string, from: number, to: number): number {
    return pruneSampleRange(sampleFileOf(this.sampleDir, date), from, to)
  }

  /** 删除某一天里来源为 auto 且与区间重叠的语义事项，返回删除条数。 */
  async pruneAutoEvents(date: string, from: number, to: number): Promise<number> {
    let removed = 0
    await this.enqueueDayUpdate(date, day => {
      const kept = day.events.filter(event => !(event.source === 'auto' && event.start < to && event.end > from))
      removed = day.events.length - kept.length
      return { ...day, events: kept }
    })
    return removed
  }

  /**
   * 暂停采样进程执行一段必须独占采样文件的操作（如删除某时间段原文），结束后按原状态恢复。
   * 边重写 JSONL 边追加会丢样本或留半行，所以删除类操作必须走这里。
   */
  async withCapturePaused<T>(fn: () => Promise<T>): Promise<T> {
    const wasCapturing = this.sampler?.alive === true
    if (wasCapturing) this.killSamplerNow()
    try {
      return await fn()
    } finally {
      if (wasCapturing && this.domain.global.get().active && this.config.captureBlockedReason() === null && this.scopeAuthorized()) {
        const state = this.domain.global.get()
        this.sampler = launchSampler(this.scriptPath, this.sampleDir, this.config.sampleIntervalMs, {
          captureTitles: effectiveCaptureTitles(state, this.config.captureTitles),
          excludedProcesses: this.config.excludedProcesses,
          excludedTitleKeywords: this.config.excludedTitleKeywords,
        })
        await this.domain.global.set({ ...state, pid: this.sampler.pid })
      }
    }
  }

  /**
   * 插件卸载时调用：回收采样子进程，避免遗留孤儿进程。
   * 同步执行且不写存储——卸载路径上不应再触发异步 IO。
   */
  dispose(): void {
    this.killSamplerNow()
  }

  /** 模式开启但采样进程已死（崩溃）时重新拉起。每次插件激活时调用。 */
  async ensureSamplerAlive(): Promise<void> {
    const state = this.domain.global.get()
    if (!state.active) return
    if (this.sampler?.alive) return
    // 采集被拦住时不恢复。这里是恢复路径不是用户动作，不抛错；
    // 用户看到的解释由 modeDescription 给出。
    if (this.config.captureBlockedReason() !== null || !this.scopeAuthorized()) return
    this.sampler = launchSampler(this.scriptPath, this.sampleDir, this.config.sampleIntervalMs, {
      captureTitles: effectiveCaptureTitles(state, this.config.captureTitles),
      excludedProcesses: this.config.excludedProcesses,
      excludedTitleKeywords: this.config.excludedTitleKeywords,
    })
    await this.domain.global.set({ ...state, pid: this.sampler.pid })
  }

  modeDescription(): string {
    const state = this.domain.global.get()
    if (!state.active) return '个人助理模式未开启'
    const started = new Date(state.startedAt).toLocaleString('zh-CN')
    if (this.sampler?.alive) return `个人助理模式已开启（开始于 ${started}）${this.titleNote()}`
    const blocked = this.config.captureBlockedReason()
    if (blocked) return `个人助理模式标记为开启，但没有在记录活动：${blocked}`
    return `个人助理模式已开启（开始于 ${started}）；注意：采样进程未在运行，正在尝试恢复`
  }

  /**
   * 标题已授权、最近一次采样却没读到时如实提示原因（macOS 缺辅助功能或自动化权限时会这样）：
   * 否则用户看到的是"标题开着"，日报却说不出在写哪份文档。
   */
  private titleNote(): string {
    if (!this.captureTitles) return ''
    const note = describeTitleUnavailable(readLastSample(sampleFileOf(this.sampleDir, localDateOf(Date.now())))?.titleUnavailable)
    return note ? `；注意：${note}` : ''
  }

  /** 终止采样进程：优先用进程内句柄，句柄丢失时（插件重载）按持久化的 pid 兜底。 */
  private killSamplerNow(): void {
    if (this.sampler) {
      this.sampler.kill()
      this.sampler = null
      return
    }
    const state = this.domain.global.get()
    if (state.pid) killSampler(state.pid)
  }

  /** 从采样日志聚合指定日期的活动片段。 */
  buildSpans(date: string): ActivitySpan[] {
    const samples = readSamples(sampleFileOf(this.sampleDir, date))
    return buildSpansFrom(samples, this.classifier, this.config.minSpanMs, this.config.sampleIntervalMs)
  }

  /** 一天的完整视图：文件聚合的活动片段 + 持久化的事项/笔记/游标。 */
  getDay(date: string): DayRecord & { spans: ActivitySpan[] } {
    const stored = this.domain.table('days').get(date) ?? emptyDay(date)
    return { ...stored, spans: this.buildSpans(date) }
  }

  enqueueDayUpdate(date: string, mutate: (day: DayRecord) => DayRecord): Promise<DayRecord> {
    return this.enqueue(async () => {
      const days = this.domain.table('days')
      const current = days.get(date) ?? emptyDay(date)
      const next = mutate(current)
      await days.put(date, next)
      return next
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
  }
}
