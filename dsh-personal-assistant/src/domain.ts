/**
 * 个人助理存储域：当日记忆（活动片段/语义事项/笔记）、长期偏好、日报归档、模式状态。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 一个连续的前台窗口活动片段（证据层）。 */
export const activitySpanSchema = z.object({
  /** 开始时间（epoch 毫秒）。 */
  start: z.number(),
  /** 结束时间（epoch 毫秒）。 */
  end: z.number(),
  /** 前台进程名。 */
  app: z.string(),
  /** 分类：chat/browser/document/dev/meeting/ai/terminal/idle/no-input/excluded/other；no-input不代表离席。 */
  category: z.string(),
  /** 提取后的有效标题（文档名/网页标题/聊天对象等）。 */
  title: z.string(),
})
export type ActivitySpan = z.infer<typeof activitySpanSchema>

/** 一个语义工作事项（语义层或用户补充层）。 */
export const semanticEventSchema = z.object({
  id: z.string(),
  /** 事项覆盖的开始时间（epoch 毫秒）。 */
  start: z.number(),
  /** 事项覆盖的结束时间（epoch 毫秒）。 */
  end: z.number(),
  /** 一句话概括，如"与张三讨论了需求评审文档"。 */
  summary: z.string(),
  /** 支撑该结论的证据（应用/窗口标题列表）。 */
  evidence: z.array(z.string()),
  /** auto=模型解释；user=用户随手记；import=导入的记录。 */
  source: z.enum(['auto', 'user', 'import']),
  /** high=证据直接支持；medium=基于相邻活动的推断。 */
  confidence: z.enum(['high', 'medium']),
  createdAt: z.number(),
})
export type SemanticEvent = z.infer<typeof semanticEventSchema>

/** 用户导入的原始记录（聊天导出/笔记全文）。 */
export const noteSchema = z.object({
  id: z.string(),
  content: z.string(),
  /** 来源：manual / wechat_export / wxwork_export 等。 */
  source: z.string(),
  createdAt: z.number(),
})
export type Note = z.infer<typeof noteSchema>

/** 一天的持久记录（活动片段来自采样日志文件的实时聚合，不在此存储）。 */
export const dayRecordSchema = z.object({
  /** YYYY-MM-DD（本机时区）。 */
  date: z.string(),
  events: z.array(semanticEventSchema),
  notes: z.array(noteSchema),
  /** 增量解释游标：该时间戳之前的片段已被模型解释过。 */
  interpretedUpto: z.number(),
})
export type DayRecord = z.infer<typeof dayRecordSchema>

/** 一条长期偏好。 */
export const preferenceSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
})
export type Preference = z.infer<typeof preferenceSchema>

/** 日报记录：草稿持久化（无会话连续场景的修改流转）与定稿归档。 */
export const reportMetaSchema = z.object({
  date: z.string(),
  /** 当前草稿内容（确认后清空）。 */
  draft: z.string().optional(),
  /** 定稿文件路径。 */
  filePath: z.string().optional(),
  confirmedAt: z.number().optional(),
})
export type ReportMeta = z.infer<typeof reportMetaSchema>

/** 助理模式状态（持久化，跨进程/跨会话恢复；采样器是分离进程，记录其 pid）。 */
export const modeStateSchema = z.object({
  active: z.boolean(),
  startedAt: z.number(),
  pid: z.number().optional(),
  /** 运行时对标题采集的覆盖；缺省沿用插件配置。撤销标题授权后立即生效并重启采样。 */
  captureTitles: z.boolean().optional(),
})
export type ModeState = z.infer<typeof modeStateSchema>

const initialModeState: ModeState = { active: false, startedAt: 0 }

export const personalAssistantDomainSpec = defineDomain({
  name: 'personal_assistant',
  version: 0,
  global: {
    schema: modeStateSchema,
    initial: initialModeState,
  },
  tables: {
    /** key = YYYY-MM-DD。 */
    days: domainTable<string, DayRecord>(dayRecordSchema),
    /** key = 偏好 id。 */
    preferences: domainTable<string, Preference>(preferenceSchema),
    /** key = YYYY-MM-DD。 */
    reports: domainTable<string, ReportMeta>(reportMetaSchema),
  },
})
export type PersonalAssistantDomainSpec = typeof personalAssistantDomainSpec
