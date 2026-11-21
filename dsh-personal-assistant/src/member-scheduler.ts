/**
 * 成员定时调度器：到点**自主跑成员真干活**，再把结果投递到桌面/企微。
 *
 * 为什么单独一套而不复用提醒（CompanionReminders）：提醒到点只发一条**固定通知**
 * （notification.send，执行器是 executor:reminder），不会跑成员去抓数据/整理日报。
 * 这里要的是"到点让成员用工具干活、拿真实结果再推"，所以走 memberRuntime.chat
 * （成员自己的持久会话，与渠道入站同一条自主路径），结果经桥接播报/企微主动送达。
 *
 * 结构照 MailWatcher：定时器 + tick + enabled 闸 + run（成员运行）+ deliver（投递）。
 * 本模块不直接碰模型/渠道/文件，全部经注入函数；状态显式持有，测试可注入 now/run/deliver。
 *
 * 调度语义复用 scheduler.ts 的 ReminderSchedule（daily/once/interval）：
 * - 认领即推进 nextRunAt（同步），下一拍不会重复触发同一条；
 * - once 跑完即停用；daily/interval 推进到下一次；
 * - 进程停机错过的触发按 coalesce 处理：重启后补跑一次再推进，不逐次回放历史。
 */
import { randomUUID } from 'node:crypto'
import { nextScheduleAt } from './scheduler.ts'
import { MemberWorkspaceUnavailable } from './member-runtime.ts'
import type { MemberScheduleRecord, TeamStore } from './team-domain.ts'

export interface MemberSchedulerDeliverInput {
  assistantId: string
  text: string
  channel: 'desktop' | 'wecom'
  recipientId: string | null
  runId: string
  sessionId?: string
}

export interface MemberSchedulerOptions {
  store: TeamStore
  /** 团队模式开着才跑（与 memberRuntime.enabled 同一闸）。 */
  enabled(): boolean
  /** 自主跑成员，返回回复文本（装配侧 = memberRuntime.chat）。 */
  run(memberId: string, prompt: string): Promise<string | { text: string; sessionId: string }>
  /** 投递结果；返回 true 才算实际送达（装配侧 = 企微 deliver / 桌面播报）。 */
  deliver(input: MemberSchedulerDeliverInput): Promise<boolean>
  log(message: string): void
  now?(): number
  /** 测试注入；生产缺省 30 秒一拍。 */
  tickIntervalMs?: number
}

const MAX_LAST_TEXT = 2000

export class MemberScheduler {
  private readonly options: MemberSchedulerOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly running = new Set<string>()

  constructor(options: MemberSchedulerOptions) { this.options = options }

  start(): void {
    if (this.timer) return
    const interval = Math.max(5_000, this.options.tickIntervalMs ?? 30_000)
    this.timer = setInterval(() => {
      try { this.tick() } catch (error) { this.options.log(`成员定时调度拍失败：${error instanceof Error ? error.message : String(error)}`) }
    }, interval)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  private now(): number { return this.options.now?.() ?? Date.now() }

  /**
   * 扫一拍：认领所有到期且启用的计划（同步推进 nextRunAt 防重触），异步触发执行。
   * 返回本拍认领了几条，供测试与诊断。
   */
  tick(): { fired: number } {
    if (!this.options.enabled()) return { fired: 0 }
    const now = this.now()
    let fired = 0
    for (const schedule of this.options.store.listMemberSchedules()) {
      if (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) continue
      if (this.running.has(schedule.scheduleId)) continue
      this.claimAndFire(schedule, now)
      fired += 1
    }
    return { fired }
  }

  /** 手动立即跑一次（测试/总助理"现在就去办"）；仍尊重启用状态与并发闸，不改 nextRunAt。 */
  async runNow(scheduleId: string): Promise<{ state: 'succeeded' | 'failed' | 'skipped'; text: string }> {
    const schedule = this.options.store.getMemberSchedule(scheduleId)
    if (!schedule) return { state: 'skipped', text: '定时任务不存在' }
    if (!schedule.enabled) return { state: 'skipped', text: '定时任务已停用' }
    if (!this.options.enabled()) return { state: 'skipped', text: '团队模式未开启，成员不能运行' }
    if (this.running.has(scheduleId)) return { state: 'skipped', text: '该定时任务正在执行' }
    this.running.add(scheduleId)
    try { return await this.fire(schedule, this.now()) } finally { this.running.delete(scheduleId) }
  }

  /** 认领：先把 nextRunAt 推进/停用落库，再异步执行——下一拍绝不会重复触发同一条。 */
  private claimAndFire(schedule: MemberScheduleRecord, now: number): void {
    const once = schedule.spec.kind === 'once'
    const next = once ? null : nextScheduleAt(schedule.spec, now)
    const claimed: MemberScheduleRecord = { ...schedule, nextRunAt: next, enabled: once ? false : schedule.enabled,
      generation: schedule.generation + 1, lastRunAt: now }
    this.options.store.saveMemberSchedule(claimed)
    this.running.add(schedule.scheduleId)
    void this.fire(claimed, now)
      .catch(error => this.options.log(`成员定时任务执行异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.running.delete(schedule.scheduleId))
  }

  private async fire(schedule: MemberScheduleRecord, triggerAt: number): Promise<{ state: 'succeeded' | 'failed'; text: string }> {
    const runId = randomUUID()
    this.options.store.insertMemberScheduleRun({ runId, scheduleId: schedule.scheduleId, assistantId: schedule.assistantId,
      generation: schedule.generation, triggerAt, state: 'running', text: null, startedAt: triggerAt, finishedAt: null })
    let state: 'succeeded' | 'failed' = 'failed'
    let text = ''
    let pauseWorkspace = false
    try {
      const reply = await this.options.run(schedule.assistantId, schedule.prompt)
      text = (typeof reply === 'string' ? reply : reply.text).trim()
      if (text === '') {
        text = '成员没有产出可推送的内容'
        state = 'failed'
      } else {
        const delivered = await this.options.deliver({ assistantId: schedule.assistantId, text, channel: schedule.channel,
          recipientId: schedule.recipientId, runId, ...(typeof reply === 'string' ? {} : { sessionId: reply.sessionId }) })
        state = delivered ? 'succeeded' : 'failed'
        if (!delivered) text = `${text}\n[投递失败：渠道不可达或未绑定收件会话]`
      }
    } catch (error) {
      state = 'failed'
      pauseWorkspace = error instanceof MemberWorkspaceUnavailable
      text = `${pauseWorkspace ? '定时任务已暂停' : '成员运行失败'}：${error instanceof Error ? error.message : String(error)}`
    }
    const finishedAt = this.now()
    this.options.store.finishMemberScheduleRun(runId, state, text.slice(0, MAX_LAST_TEXT), finishedAt)
    // 回读最新计划再写回 lastStatus：执行期间用户可能改了 prompt/启用状态，不能拿旧快照覆盖。
    const latest = this.options.store.getMemberSchedule(schedule.scheduleId)
    if (latest) this.options.store.saveMemberSchedule({ ...latest, lastStatus: state, lastText: text.slice(0, MAX_LAST_TEXT),
      ...(pauseWorkspace && latest.generation === schedule.generation ? { enabled: false, nextRunAt: null, generation: latest.generation + 1 } : {}) })
    this.options.log(`成员定时任务「${schedule.title}」${state === 'succeeded' ? '已推送' : '失败'}：${text.slice(0, 120)}`)
    return { state, text }
  }
}
