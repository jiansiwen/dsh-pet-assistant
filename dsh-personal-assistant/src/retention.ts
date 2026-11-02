import type { DatabaseSync } from 'node:sqlite'
import type { MemoryStore } from './memory.ts'
import type { ObservationStore } from './observation.ts'
import type { ReportStore } from './report.ts'
import { listSampleDates, pruneSampleFiles } from './sampler.ts'
import { inTransaction } from './store.ts'
import { localDateOf, retentionStartDate, startOfLocalDate } from './time.ts'
import type { WorkItemStore } from './work-items.ts'

export interface RetentionDeps {
  db: DatabaseSync
  sampleDir: string
  observations: ObservationStore
  memories: MemoryStore
  reports: Pick<ReportStore, 'invalidateActivityDates'>
  workItems: WorkItemStore
  retentionDays: number
  now: number
}

/** 先在一个库事务中标记边界并传播来源，再删除过期采样文件。 */
export function applyRetention(deps: RetentionDeps) {
  if (!Number.isFinite(deps.now) || !Number.isSafeInteger(deps.retentionDays) || deps.retentionDays < 1) throw new Error('保留期参数无效')
  const configuredBefore = startOfLocalDate(retentionStartDate(deps.now, deps.retentionDays))
  const before = Math.max(configuredBefore, deps.observations.retentionBoundary() ?? 0)
  if (!Number.isFinite(before) || before < 0 || before > deps.now) throw new Error('保留期边界无效')
  const keepFromDate = localDateOf(before)
  const expiredSamples = listSampleDates(deps.sampleDir).filter(date => date < keepFromDate)
  const expired = deps.observations.listBefore('activity_span', before)
  const dates = [...new Set([...expiredSamples, ...expired.flatMap(item => [localDateOf(item.startAt), localDateOf(item.endAt)])])]
  const reason = '活动采样已到保留期限'
  const stored = inTransaction(deps.db, () => {
    // 发布中或结果未知的日报先阻止整个清理，避免一边发布一边抹掉来源。
    deps.reports.invalidateActivityDates(dates, reason)
    deps.observations.recordRetentionBoundary(before, deps.now)
    for (const item of expired) deps.memories.deleteSource(item.id, reason, deps.now)
    deps.workItems.removeSources('activity_observation', expired.map(item => item.id), reason, deps.now)
    const prunedSpans = deps.observations.deleteRange('activity_span', before)
    const memoryRetention = deps.memories.applyRetention(deps.now)
    return { prunedSpans, expiredMemories: memoryRetention.expired, deletedMemories: memoryRetention.deleted }
  })
  const pruned = pruneSampleFiles(deps.sampleDir, keepFromDate)
  const remainingSampleDays = listSampleDates(deps.sampleDir).filter(date => date < keepFromDate)
  return { keepFromDate, prunedSampleDays: pruned.length, remainingSampleDays, ...stored }
}

type Timer = ReturnType<typeof setInterval> | number
interface TimerHooks {
  setInterval(callback: () => void, ms: number): Timer
  clearInterval(timer: Timer): void
}

/** 启动时由调用方先清理一次；此后每小时复查，异常不停止下一次复查。 */
export function scheduleRetention(run: () => void, onError: (error: unknown) => void, hooks?: TimerHooks): () => void {
  let active = true
  const timer = (hooks?.setInterval ?? ((callback, ms) => setInterval(callback, ms)))(() => {
    if (!active) return
    try { run() } catch (error) { onError(error) }
  }, 60 * 60_000)
  if (typeof timer === 'object') timer.unref?.()
  return () => { active = false; (hooks?.clearInterval ?? (value => clearInterval(value)))(timer) }
}

/** 没有明确开启时既不清理，也不安装定时器。 */
export function startRetention(enabled: boolean, run: () => void, onError: (error: unknown) => void, hooks?: TimerHooks): () => void {
  if (!enabled) return () => {}
  try { run() } catch (error) { onError(error) }
  return scheduleRetention(run, onError, hooks)
}
