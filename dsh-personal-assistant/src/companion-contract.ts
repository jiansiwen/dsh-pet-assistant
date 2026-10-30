import { z } from 'zod'
import { TASK_STATUSES } from './team-domain.ts'

export const COMPANION_TASK_KINDS = [
  'reminder', 'mail-send', 'mail-analyze', 'context-analyze', 'document-translate',
  'desktop-action', 'meeting', 'presentation', 'skill-run', 'memory-maintain', 'agent',
] as const
export type CompanionTaskKind = (typeof COMPANION_TASK_KINDS)[number]
export const COMPANION_BLOCKERS = [
  'device-offline', 'budget', 'credentials', 'permission', 'input-changed', 'manual-pause',
] as const
export type CompanionBlocker = (typeof COMPANION_BLOCKERS)[number] | null
export type CompanionSubject = 'client' | 'owner' | 'executor'

const identifier = z.string().min(1).max(200)
const timestamp = z.iso.datetime({ offset: true })
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, '时区无效')

export const companionTaskViewSchema = z.object({
  taskId: identifier,
  parentTaskId: identifier.nullable(),
  kind: z.enum(COMPANION_TASK_KINDS),
  title: z.string().min(1).max(500),
  status: z.enum(TASK_STATUSES),
  blocker: z.enum(COMPANION_BLOCKERS).nullable(),
  revision: z.number().int().positive(),
  deviceId: identifier,
  artifactIds: z.array(identifier),
  updatedAt: timestamp,
}).strict()
export type CompanionTaskView = z.infer<typeof companionTaskViewSchema>

export const companionCommandSchema = z.object({
  protocolVersion: z.literal(1),
  commandId: identifier,
  taskId: identifier.optional(),
  expectedRevision: z.number().int().positive().optional(),
  expiresAt: timestamp,
  payload: z.record(z.string(), z.unknown()),
}).strict()
export type CompanionCommand = z.infer<typeof companionCommandSchema>

export const companionCreateSchema = z.object({
  kind: z.enum(COMPANION_TASK_KINDS),
  title: z.string().trim().min(1).max(500),
  inputRef: identifier,
  dependsOn: z.array(identifier).max(20),
  budgetAccountId: identifier.optional(),
  parentTaskId: identifier.optional(),
}).strict()
export type CompanionCreateInput = z.infer<typeof companionCreateSchema>

export const reminderScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), timezone, runAt: timestamp }).strict(),
  z.object({
    kind: z.literal('interval'), timezone, runAt: timestamp,
    everySeconds: z.number().int().min(60).max(31_536_000),
  }).strict(),
  z.object({ kind: z.literal('daily'), timezone, localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
])
export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>

export const companionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), executionMode: z.literal('manual'), description: z.string().trim().min(1).max(8000) }).strict(),
  z.object({
    kind: z.literal('reminder'),
    message: z.string().trim().min(1).max(2000),
    schedule: reminderScheduleSchema,
    repeatEverySeconds: z.number().int().min(60).max(604_800).default(300),
    relatedBusinessTaskId: identifier.nullable().default(null),
    channel: z.enum(['desktop', 'wecom']).default('desktop'),
    recipientId: identifier.optional(),
  }).strict(),
])
export type CompanionInput = z.infer<typeof companionInputSchema>

export const companionContextSchema = z.object({
  url: z.string().max(4096).refine(value => /^https?:\/\//i.test(value), '只接受 http/https 页面'),
  title: z.string().trim().min(1).max(500),
  selection: z.string().max(8000).default(''),
  text: z.string().max(20000).default(''),
  truncated: z.boolean().default(false),
  capturedAt: timestamp,
  tabId: z.number().int().nonnegative().optional(),
  windowId: z.number().int().nonnegative().optional(),
}).strict()
export type CompanionContextInput = z.infer<typeof companionContextSchema>

export const reminderResponseSchema = z.object({
  cycleId: identifier,
  expectedCycleRevision: z.number().int().positive(),
  action: z.enum(['ack', 'snooze', 'cancel']),
  snoozedUntil: timestamp.nullable(),
}).strict().refine(value => value.action === 'snooze' ? value.snoozedUntil !== null : value.snoozedUntil === null,
  '延后需要明确时间，其他回应不能携带延后时间')
export type ReminderResponse = z.infer<typeof reminderResponseSchema>

export interface CompanionHttpResult {
  status: number
  body: unknown
}

export interface CompanionRuntimePort {
  request(method: string, pathname: string, body: unknown, subject: CompanionSubject, query?: URLSearchParams): Promise<CompanionHttpResult>
  stopAccepting(): void
}

export interface DesktopReminderDelivery {
  deliveryId: string
  occurrenceId: string
  operationId: string
  taskId: string
  taskRevision: number
  cycleId: string
  cycleRevision: number
  title: string
  message: string
  executorEpoch: string
  channel: 'desktop' | 'wecom'
  recipientRef: string
}

export class CompanionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CompanionError'
    this.code = code
    this.status = status
  }
}
