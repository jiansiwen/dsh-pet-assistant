/** 会议确认版到邮件的交接：模型只给产物编号，正文由可信桌面核验后取得。 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeMeetingDraft, proposeMail, readMailConfig, type MailToolDeps } from './mail.ts'

interface Artifact {
  id: string
  meetingId: string
  revision: number
  digest: string
  confirmedAt: number
  path: string
  createdAt: number
}
interface Snapshot { artifact: Artifact; content: string }
interface Binding { accountKey: string; botId: string }

export interface MeetingMailDeps extends MailToolDeps {
  wecomBinding(recipient: string): Binding | null
  wecomRecipients(): string[]
  reminderInterval(): number
  ensureReminder(intentId: string): string | null
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const HEX = /^[a-f0-9]{64}$/u
const RECIPIENT = /^wecom:single:[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]{1,180}$/u
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null

function artifactOf(value: unknown): Artifact | null {
  const item = object(value)
  if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.meetingId !== 'string' || !item.meetingId || item.meetingId.length > 200
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.digest !== 'string' || !HEX.test(item.digest)
    || !Number.isSafeInteger(item.confirmedAt) || !Number.isSafeInteger(item.createdAt)
    || typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.length > 32_000) return null
  return { id: item.id, meetingId: item.meetingId, revision: Number(item.revision), digest: item.digest,
    confirmedAt: Number(item.confirmedAt), path: item.path, createdAt: Number(item.createdAt) }
}

async function readArtifact(deps: MeetingMailDeps, id: string, signal?: AbortSignal): Promise<Snapshot> {
  signal?.throwIfAborted()
  const result = object(await deps.bridge.requestDesktopCommand('meeting.artifact.read', { artifactId: id }, { signal, timeoutMs: 30_000 }))
  signal?.throwIfAborted()
  const artifact = artifactOf(result?.artifact)
  const content = result?.content
  if (result?.ok !== true || !artifact || artifact.id !== id || typeof content !== 'string'
    || !content.trim() || content.length > 50_000 || createHash('sha256').update(content, 'utf8').digest('hex') !== artifact.digest) {
    throw new Error('桌面未返回可核验的确认版纪要')
  }
  return { artifact, content }
}

export function registerMeetingMailTools(host: { tools: { register(definition: unknown): () => void } }, deps: MeetingMailDeps): () => void {
  const output = { schema: { type: 'string' } as const, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const disposers: Array<() => void> = []
  try {
  disposers.push(host.tools.register(defineTool({
    name: 'personal_assistant_meeting_artifacts',
    description: '列出指定会议已保存纪要的产物编号与版本，不返回正文；不填会议编号时查询最近会议。列表不代表文件仍可用。',
    parameters: { meetingId: { type: 'string', description: '可选会议编号' } }, output,
    async execute(args: { meetingId?: unknown }, exec) {
      try {
        exec.signal.throwIfAborted()
        const meetingId = typeof args.meetingId === 'string' && args.meetingId.trim() ? args.meetingId.trim() : undefined
        if (meetingId && meetingId.length > 200) throw new Error('会议编号无效')
        const result = object(await deps.bridge.requestDesktopCommand('meeting.artifact.list', meetingId ? { meetingId } : {}, { signal: exec.signal }))
        exec.signal.throwIfAborted()
        if (!result || typeof result.meetingId !== 'string' || !Array.isArray(result.artifacts)) throw new Error('桌面没有返回有效的产物列表')
        const artifacts = result.artifacts.slice(0, 20).flatMap(value => {
          const item = object(value)
          if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || item.meetingId !== result.meetingId
            || !Number.isSafeInteger(item.revision) || typeof item.digest !== 'string' || !HEX.test(item.digest)
            || !Number.isSafeInteger(item.confirmedAt) || !Number.isSafeInteger(item.createdAt)) return []
          return [{ id: item.id, meetingId: item.meetingId, revision: item.revision, digest: item.digest,
            confirmedAt: item.confirmedAt, createdAt: item.createdAt }]
        })
        return JSON.stringify({ ok: true, meetingId: result.meetingId, artifacts, notice: '列表不代表文件仍有效，发送前会重新核验。' })
      } catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  })))
  disposers.push(host.tools.register(defineTool({
    name: 'personal_assistant_send_meeting_minutes',
    description: '准备发送指定的已确认纪要文件及邮件接受后两分钟的企微提醒。正文来自桌面重新核验的固定产物，不接收模型改写；本人须在桌面审批完整邮件与提醒范围。',
    parameters: {
      artifactId: { type: 'string', required: true, description: '已保存的纪要产物编号' },
      to: { type: 'string', required: true, description: '邮件收件人，多个用逗号分隔' },
      subject: { type: 'string', required: true, description: '邮件主题' },
      reminderRecipientId: { type: 'string', description: '本人已绑定提醒的企业微信单聊标识；只有一个可用会话时可不填' },
    }, output,
    async execute(args: { artifactId?: unknown; to?: unknown; subject?: unknown; reminderRecipientId?: unknown }, exec) {
      try {
        exec.signal.throwIfAborted()
        if (typeof args.artifactId !== 'string' || !UUID.test(args.artifactId)) throw new Error('纪要产物编号无效')
        const candidates = [...new Set(deps.wecomRecipients().filter(value => RECIPIENT.test(value)))]
        const recipient = args.reminderRecipientId === undefined && candidates.length === 1 ? candidates[0] : args.reminderRecipientId
        if (typeof recipient !== 'string' || !RECIPIENT.test(recipient)) throw new Error('请明确选择本人已绑定的企业微信单聊提醒会话')
        const binding = deps.wecomBinding(recipient)
        if (!binding || !HEX.test(binding.accountKey) || !binding.botId) throw new Error('企业微信机器人或提醒会话未连接、未绑定')
        const repeatEverySeconds = deps.reminderInterval()
        if (!Number.isSafeInteger(repeatEverySeconds) || repeatEverySeconds < 60 || repeatEverySeconds > 604_800) throw new Error('提醒间隔无效')
        const config = readMailConfig(deps.home)
        if (!config) throw new Error('邮箱还没有配置，请先在本机完成邮箱设置')
        const snapshot = await readArtifact(deps, args.artifactId, exec.signal)
        const draft = normalizeMeetingDraft({ to: args.to, subject: args.subject, text: snapshot.content })
        if (deps.store.unresolvedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision)) {
          throw new Error('同一会议修订的邮件结果未知或部分接受，请先在团队页核查，不自动重发')
        }
        const reviewed = deps.store.reviewedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision)
        const acceptedBefore = deps.store.acceptedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision)
        const matchesBinding = (): boolean => {
          const current = deps.wecomBinding(recipient)
          return current?.accountKey === binding.accountKey && current.botId === binding.botId
            && deps.reminderInterval() === repeatEverySeconds
            && !deps.store.unresolvedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision)
            && deps.store.reviewedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision) === reviewed
            && deps.store.acceptedMeetingMail(snapshot.artifact.meetingId, snapshot.artifact.revision) === acceptedBefore
        }
        if (!matchesBinding()) throw new Error('企业微信机器人或提醒会话已改变，请重新提交')
        exec.signal.throwIfAborted()
        const submitted = await proposeMail(deps, config, draft, {
          tool: 'personal_assistant_send_meeting_minutes',
          summary: `向 ${draft.to.join('、')} 发送确认版会议纪要；邮件服务接受后两分钟提醒 ${recipient}，未回应每 ${repeatEverySeconds} 秒催办`,
          snapshot: { meetingArtifact: snapshot.artifact,
            ...(acceptedBefore ? { priorSendWarning: '同一会议修订的邮件已被服务接受，再次发送可能重复，请本人重新核对。' }
              : reviewed ? { priorSendWarning: '同一会议修订曾有部分或未知发送；再次发送可能重复，请本人重新核对。' } : {}),
            reminder: { channel: 'wecom', recipient, botId: binding.botId, repeatEverySeconds,
              anchor: '邮件服务完整接受后两分钟；服务接受不代表收件或已读' } },
          validate: matchesBinding,
          beforeSend: async () => {
            const current = await readArtifact(deps, snapshot.artifact.id)
            if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('纪要产物或确认版本已变化')
          },
          prepare: (intentId, proposalId, at) => deps.store.insertMeetingMailFollowup({ intentId, artifactId: snapshot.artifact.id,
            meetingId: snapshot.artifact.meetingId, revision: snapshot.artifact.revision, recipientRef: recipient,
            channelAccountKey: binding.accountKey, repeatEverySeconds, approvalId: proposalId, createdAt: at }),
          accepted: (intentId, acceptedAt) => {
            const taskId = deps.ensureReminder(intentId)
            return taskId ? { state: 'scheduled', taskId, runAt: new Date(acceptedAt + 120_000).toISOString() }
              : { state: 'pending', message: '邮件已获服务接受，但提醒尚未登记；请在任务页核查。' }
          },
        })
        return JSON.stringify({ ...submitted, artifactId: snapshot.artifact.id, meetingId: snapshot.artifact.meetingId, digest: snapshot.artifact.digest })
      } catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  })))
  } catch (error) {
    while (disposers.length) disposers.pop()!()
    throw error
  }
  return () => { while (disposers.length) disposers.pop()!() }
}
