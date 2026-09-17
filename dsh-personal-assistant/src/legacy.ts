/**
 * 旧数据的真实适配器：把 personal_assistant 存储域的三张表与采样目录组装成 {@link LegacySource}，
 * 以及——只在用户显式打开开关时——清理已经搬走的旧数据。
 *
 * 依赖刻意收窄成 {@link LegacyTables} 而不是整个 cordis Domain：一来把"迁移到底用了旧库的哪些能力"
 * 写在类型上（只有 entries 和 delete，没有 put），二来不需要真的开一个存储域就能测。
 *
 * 活动片段的聚合函数也是注入进来的，不在这里 import tracker：tracker 用了构造函数参数属性，
 * Node 的 strip-only TypeScript 模式解析不了，拖进来这个模块就没法被 node --test 导入。
 */
import { readFileSync } from 'node:fs'
import type { ActivitySpan, DayRecord, Preference, ReportMeta } from './domain.ts'
import type { LegacySource } from './migrate.ts'
import { listSampleDates, sampleFileOf as sampleFilePath } from './sampler.ts'

/** 一张旧表里迁移真正会用到的能力。没有 put：迁移对旧数据只读。 */
export interface LegacyTable<V> {
  entries(): Iterable<readonly [string, V]>
}

/** 可删除的旧表，只给清理用。 */
export interface PurgeableLegacyTable<V> extends LegacyTable<V> {
  delete(key: string): Promise<unknown>
}

export interface LegacyTables {
  preferences: PurgeableLegacyTable<Preference>
  days: LegacyTable<DayRecord>
  reports: PurgeableLegacyTable<ReportMeta>
}

export interface LegacySourceDeps {
  tables: LegacyTables
  /** 采样原文目录。 */
  sampleDir: string
  /** 某天聚合后的活动片段。 */
  buildSpans(date: string): ActivitySpan[]
}

function byDate(a: { date: string }, b: { date: string }): number {
  if (a.date < b.date) return -1
  if (a.date > b.date) return 1
  return 0
}

export function createLegacySource(deps: LegacySourceDeps): LegacySource {
  return {
    preferences() {
      return [...deps.tables.preferences.entries()].map(([, value]) => ({
        id: value.id,
        text: value.text,
        createdAt: value.createdAt,
      }))
    },
    days() {
      return [...deps.tables.days.entries()]
        .map(([, value]) => ({ date: value.date, events: value.events, notes: value.notes }))
        .sort(byDate)
    },
    reports() {
      return [...deps.tables.reports.entries()]
        .map(([, value]) => ({
          date: value.date,
          draft: value.draft,
          filePath: value.filePath,
          confirmedAt: value.confirmedAt,
        }))
        .sort(byDate)
    },
    readReportFile(filePath: string) {
      // 文件被用户挪走、删掉，或者被别的进程占着，都算读不出来，由迁移那边点名报告。
      try {
        return readFileSync(filePath, 'utf8')
      } catch {
        return null
      }
    },
    spans(date: string) {
      return deps.buildSpans(date)
    },
    sampleDates() {
      return listSampleDates(deps.sampleDir)
    },
    sampleFileOf(date: string) {
      return sampleFilePath(deps.sampleDir, date)
    },
  }
}

export interface LegacyPurgeOutcome {
  /** 真被删掉的旧表与行数。 */
  purged: Array<{ table: string; rows: number }>
  /** 明确不删的东西与原因，对应删除报告里"仍保留"那一类。 */
  retained: Array<{ table: string; reason: string }>
}

/**
 * 删除已经完整搬进新库的旧数据。
 *
 * days 表刻意不删：导入时只把笔记的来源标记搬了过来，正文没有复制（可能很长也很私密），
 * 删掉旧表就等于永久丢掉用户粘贴过的聊天导出。这不是"删不干净"，是"删了就找不回来"，
 * 所以留着，并在删除报告的"仍保留"里写明原因。
 *
 * reports 表可以删：定稿正文已经作为归档版本进了新库，原文件路径也一并记着，
 * 而且磁盘上那份 Markdown 一个字都不动。
 */
export async function purgeLegacyData(tables: LegacyTables): Promise<LegacyPurgeOutcome> {
  const purged: LegacyPurgeOutcome['purged'] = []

  const preferenceRows = [...tables.preferences.entries()]
  for (const [key] of preferenceRows) await tables.preferences.delete(key)
  purged.push({ table: 'preferences', rows: preferenceRows.length })

  const reportRows = [...tables.reports.entries()]
  const archivedFiles = reportRows.filter(([, value]) => value.filePath !== undefined).length
  for (const [key] of reportRows) await tables.reports.delete(key)
  purged.push({ table: 'reports', rows: reportRows.length })

  const dayRows = [...tables.days.entries()].length
  return {
    purged,
    retained: [
      {
        table: 'days',
        reason: `旧 days 表保留（${dayRows} 天）：用户导入的笔记正文没有被复制进新库，删掉就是永久丢失`,
      },
      {
        table: 'report files',
        reason: `已归档日报的 Markdown 原文件不改不删，共 ${archivedFiles} 份仍在磁盘上`,
      },
      {
        table: 'sample files',
        reason: '采样原文保留：新库里的活动片段只记了它的路径当依据，删掉依据，结论就无从核对',
      },
    ],
  }
}
