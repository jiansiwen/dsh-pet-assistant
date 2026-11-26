/**
 * 子助理分派服务：总助理工具 `personal_assistant_dispatch_subassistant` 的执行体。
 *
 * 链路（设计 4.5）：深度检查 → 账本先行（dispatch_id 幂等）→ Registry 会话分派 →
 * 回执落账 → 结构化返回。返回值始终携带结果文本——无论汇报模式如何，
 * 总助理总会收到一份汇总（汇报分发归单元 6 的 subassistant-report 事件）。
 *
 * 防环第 2 层在这里：同一成员同一任务摘要（taskDigest）越权回退后再分派 depth+1，
 * 超过 maxDispatchDepth 记账 refused 并如实拒绝。改写任务文本=新摘要=新深度链
 * ——真重分析的表述理应不同。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { MemberDirectory } from './member-directory.ts'
import type { MemberProfile } from './member-contract.ts'
import {
  platformChat, platformChatList, platformListAssistants, platformSessionList, platformUploadKnowledge,
  type PlatformConfig,
} from './platform-connector.ts'
import type { SubAssistantReceipt } from './sub-assistant-protocol.ts'
import type { SubAssistantRegistry } from './sub-assistant-registry.ts'

export type SubAssistantDispatchStatus = 'completed' | 'escalated' | 'failed' | 'refused'
export type SubAssistantPlatformQuery = 'list_assistants' | 'list_sessions' | 'list_chats'
export type SubAssistantDispatchRequest = {
  /** 只读查询：智能体 / 会话 / 聊天记录。 */
  platformQuery?: SubAssistantPlatformQuery
  /** 向平台智能体提问，产生真实对话。 */
  platformChat?: { question: string; chatId?: string; assistId?: string }
  /** 把本地文件上传到平台知识库（写操作）。 */
  platformUpload?: { filePath: string; assistId?: string }
  signal?: AbortSignal
}
/** 上传上限：与平台文件接口的常见限额一致，避免一次把超大文件塞进模型上下文。 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export interface SubAssistantDispatchResult {
  runId: string | null
  assistantId: string
  displayName: string
  status: SubAssistantDispatchStatus
  text: string
  depth: number
  elapsedMs: number
}

export interface SubAssistantDispatchLedger {
  getSubAssistantRunByDispatchId(dispatchId: string): { runId: string; status: string; resultKind: string | null; resultText: string | null; depth: number } | null
  beginSubAssistantRun(input: { runId: string; assistantId: string; dispatchId: string; taskDigest: string; depth: number }, at: number): { runId: string; status: string } | null
  finishSubAssistantRun(runId: string, status: 'completed' | 'escalated' | 'failed' | 'refused', resultKind: string, resultText: string, at: number): boolean
  latestEscalatedSubAssistantRun(assistantId: string, taskDigest: string): { depth: number } | null
}

export interface SubAssistantSelfReport {
  assistantId: string
  displayName: string
  skinId: string
  voiceProfile: string
  text: string
  runId: string
  reportMode: 'self'
}

export interface SubAssistantDispatchOptions {
  directory: Pick<MemberDirectory, 'get'>
  registry: SubAssistantRegistry
  ledger: SubAssistantDispatchLedger
  maxDispatchDepth: number
  timeoutMs: number
  /** 只读平台查询走本机签名连接器，不把任意本机工具交给外部聊天端点。 */
  platformConfig?: () => PlatformConfig
  /** 解析成员自己保存的签名密钥；未装配时只接受本机平台对接配置。 */
  resolveSecret?: (secretId: string) => string
  now?: () => number
  /** 汇报分发（§4.6 ★①）：仅 completed 且成员 reportMode=self 时触发；chief 模式结果只经工具返回值进总助理上下文。 */
  onSelfReport?: (report: SubAssistantSelfReport) => void
}

export function subAssistantTaskDigest(task: string): string {
  return createHash('sha256').update(task).digest('hex')
}

export class SubAssistantDispatch {
  private readonly options: SubAssistantDispatchOptions

  constructor(options: SubAssistantDispatchOptions) {
    if (!Number.isSafeInteger(options.maxDispatchDepth) || options.maxDispatchDepth < 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('子助理分派参数无效（深度下限 0，超时须为正整数毫秒）')
    }
    this.options = options
  }

  /** 一次分派往返。dispatchId 即工具调用幂等键（exec.rootCallId），重放命中已有 run 直接返回。 */
  async dispatch(assistantId: string, task: string, dispatchId: string, request: SubAssistantDispatchRequest = {}): Promise<SubAssistantDispatchResult> {
    const startedAt = this.now()
    const member = this.options.directory.get(assistantId)
    if (!member || !member.enabled) {
      return { runId: null, assistantId, displayName: assistantId, status: 'failed',
        text: `成员不存在或未启用：${assistantId}`, depth: 0, elapsedMs: this.now() - startedAt }
    }
    if (member.kind === 'expert' || member.binding === null) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, 0,
        '普通成员（专家）不经子助理通道，请用现有成员对话或团队任务工具', startedAt)
    }
    const platformOps = [request.platformQuery !== undefined, request.platformChat !== undefined, request.platformUpload !== undefined]
      .filter(Boolean).length
    if (platformOps > 1) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, 0,
        '一次只能用一种平台操作：查询、对话或上传知识库。', startedAt)
    }
    if (platformOps === 1 && (member.kind !== 'platform' || !member.capabilities.includes('platform'))) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, 0,
        '该成员未获准调用外部平台。', startedAt)
    }
    // 幂等：同一次工具调用重放返回既有 run
    const existing = this.options.ledger.getSubAssistantRunByDispatchId(dispatchId)
    if (existing) {
      return { runId: existing.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: existing.status as SubAssistantDispatchStatus,
        text: existing.resultText ?? existing.status,
        depth: existing.depth, elapsedMs: this.now() - startedAt }
    }
    // 防环第 2 层：同成员同任务摘要的越权回退链深度递增，超限拒绝
    const platformKind = request.platformQuery ? `query:${request.platformQuery}`
      : request.platformChat ? 'chat' : request.platformUpload ? 'upload' : ''
    const taskDigest = subAssistantTaskDigest(platformKind ? `${platformKind}\n${task}` : task)
    const prior = this.options.ledger.latestEscalatedSubAssistantRun(member.assistantId, taskDigest)
    const depth = prior ? prior.depth + 1 : 0
    if (depth > this.options.maxDispatchDepth) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, depth,
        `任务已越权回退 ${this.options.maxDispatchDepth} 次仍未找到可承接的子助理（当前深度 ${depth}）。请重新分析任务与成员能力的匹配，或由你直接完成。`, startedAt)
    }
    const run = this.options.ledger.beginSubAssistantRun({ runId: randomUUID(), assistantId: member.assistantId,
      dispatchId, taskDigest, depth }, startedAt)
    if (!run || run.runId === '') {
      return { runId: null, assistantId: member.assistantId, displayName: member.displayName, status: 'failed',
        text: '分派账本写入失败', depth, elapsedMs: this.now() - startedAt }
    }
    const receipt = platformOps === 1
      ? await this.runPlatform(member, request)
      : await this.options.registry.send(member, task, this.options.timeoutMs)
    const finishedAt = this.now()
    if (receipt.kind === 'reply') {
      const resultKind = platformKind || 'reply'
      this.options.ledger.finishSubAssistantRun(run.runId, 'completed', resultKind, receipt.text, finishedAt)
      // 回执驱动：账本终态先行，再推汇报事件（self 模式桌宠以其形象+音色播报）。
      if (member.reportMode === 'self') {
        this.options.onSelfReport?.({ assistantId: member.assistantId, displayName: member.displayName,
          skinId: member.skinId, voiceProfile: member.voiceProfile, text: receipt.text,
          runId: run.runId, reportMode: 'self' })
      }
      return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: 'completed', text: receipt.text, depth, elapsedMs: finishedAt - startedAt }
    }
    if (receipt.kind === 'out-of-scope') {
      this.options.ledger.finishSubAssistantRun(run.runId, 'escalated', 'out-of-scope', receipt.reason, finishedAt)
      return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: 'escalated', text: receipt.reason, depth, elapsedMs: finishedAt - startedAt }
    }
    const text = receipt.kind === 'timeout' ? '子助理超时未回执' : receipt.text
    this.options.ledger.finishSubAssistantRun(run.runId, 'failed', receipt.kind, text, finishedAt)
    return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
      status: 'failed', text, depth, elapsedMs: finishedAt - startedAt }
  }

  private async runPlatform(member: MemberProfile, request: SubAssistantDispatchRequest): Promise<SubAssistantReceipt> {
    const resolved = this.platformConfigOf(member)
    if ('error' in resolved) return { kind: 'error', text: resolved.error }
    const { config, assistId } = resolved
    if (request.platformQuery === 'list_assistants') return this.assistantList(await platformListAssistants(config, request.signal))
    if (request.platformQuery === 'list_sessions') return this.sessionList(await platformSessionList(config, {}, request.signal))
    if (request.platformQuery === 'list_chats') return this.chatList(await platformChatList(config, {}, request.signal))
    if (request.platformChat) return this.platformChatWith(config, request.platformChat, assistId, request.signal)
    if (request.platformUpload) return this.platformUploadFile(config, request.platformUpload, assistId, request.signal)
    return { kind: 'error', text: '平台操作参数无效。' }
  }

  /** 成员自己的四项签名配置逐项覆盖本机连接器；缺哪项就用本机的哪项。 */
  private platformConfigOf(member: MemberProfile): { config: PlatformConfig; assistId: string } | { error: string } {
    if (!this.options.platformConfig) return { error: '未发起请求：本机平台连接器未装配。' }
    const base = this.options.platformConfig()
    const binding = member.binding?.kind === 'platform' ? member.binding : null
    const appId = binding?.appId?.trim() ?? ''
    const appSecretId = binding?.appSecretId?.trim() ?? ''
    let config = base
    if ((binding?.signEndpoint?.trim() ?? '') !== '') config = { ...config, endpoint: binding!.signEndpoint!.trim() }
    if ((binding?.signUserId?.trim() ?? '') !== '') config = { ...config, userId: binding!.signUserId!.trim() }
    if (appId !== '' || appSecretId !== '') {
      if (appId === '') return { error: '未发起请求：成员只配置了签名密钥，缺少应用 ID。' }
      if (appSecretId === '') return { error: '未发起请求：成员已填写应用 ID，但签名密钥还没配置。' }
      const appSecret = this.options.resolveSecret?.(appSecretId) ?? ''
      if (appSecret === '') return { error: '未发起请求：成员的签名密钥无法解密，请重新填写。' }
      config = { ...config, appid: appId, secret: appSecret }
    }
    return { config, assistId: binding?.agentId?.trim() ?? '' }
  }

  private failure(result: { desc?: string; error?: string; code?: number }): SubAssistantReceipt {
    const code = result.code !== undefined && result.code !== 0 ? `（业务码 ${result.code}）` : ''
    return { kind: 'error', text: `${result.desc || result.error || '平台没有返回成功回执'}${code}` }
  }

  private assistantList(result: Awaited<ReturnType<typeof platformListAssistants>>): SubAssistantReceipt {
    if (!result.ok) return this.failure(result)
    const page = result.data as { datas?: unknown; count?: unknown } | null | undefined
    if (!Array.isArray(page?.datas)) return { kind: 'error', text: '平台回执缺少智能体列表，无法确认查询结果。' }
    const total = typeof page.count === 'number' && Number.isSafeInteger(page.count) && page.count >= page.datas.length
      ? `共 ${page.count} 个，` : ''
    const names = page.datas.slice(0, 8).flatMap(item => typeof item?.assist_name === 'string' && item.assist_name.trim()
      ? [JSON.stringify(item.assist_name.trim().slice(0, 100))] : [])
    const empty = page.datas.length === 0 ? '接口验签已通过；0 条表示这个应用下没有可列出的智能体，不代表连接失败。' : ''
    return { kind: 'reply', text: `已通过外部平台接口查询智能体列表：${total}本页返回 ${page.datas.length} 个。${names.length ? `名称摘要：${names.join('、')}。` : ''}${empty}` }
  }

  private sessionList(result: Awaited<ReturnType<typeof platformSessionList>>): SubAssistantReceipt {
    if (!result.ok) return this.failure(result)
    const page = result.data as { datas?: unknown; count?: unknown } | null | undefined
    if (!Array.isArray(page?.datas)) return { kind: 'error', text: '平台回执缺少会话列表，无法确认查询结果。' }
    const total = typeof page.count === 'number' && Number.isSafeInteger(page.count) && page.count >= page.datas.length
      ? `共 ${page.count} 个，` : ''
    const names = page.datas.slice(0, 8).flatMap(item => typeof item?.session_name === 'string' && item.session_name.trim()
      ? [JSON.stringify(item.session_name.trim().slice(0, 80))] : [])
    return { kind: 'reply', text: `已查询外部平台会话：${total}本页返回 ${page.datas.length} 个。${names.length ? `会话摘要：${names.join('、')}。` : ''}${page.datas.length === 0 ? '该用户下暂时没有会话。' : ''}` }
  }

  private chatList(result: Awaited<ReturnType<typeof platformChatList>>): SubAssistantReceipt {
    if (!result.ok) return this.failure(result)
    const page = result.data as { datas?: unknown; count?: unknown } | null | undefined
    if (!Array.isArray(page?.datas)) return { kind: 'error', text: '平台回执缺少聊天记录，无法确认查询结果。' }
    const total = typeof page.count === 'number' && Number.isSafeInteger(page.count) && page.count >= page.datas.length
      ? `共 ${page.count} 条，` : ''
    const questions = page.datas.slice(0, 5).flatMap(item => typeof item?.question === 'string' && item.question.trim()
      ? [JSON.stringify(item.question.trim().slice(0, 60))] : [])
    return { kind: 'reply', text: `已查询外部平台聊天记录：${total}本页返回 ${page.datas.length} 条。${questions.length ? `最近问题：${questions.join('、')}。` : ''}${page.datas.length === 0 ? '该用户下暂时没有聊天记录。' : ''}` }
  }

  private async platformChatWith(config: PlatformConfig, input: { question: string; chatId?: string; assistId?: string },
    defaultAssistId: string, signal?: AbortSignal): Promise<SubAssistantReceipt> {
    const question = (input.question ?? '').trim()
    if (question === '') return { kind: 'error', text: '平台对话需要问题内容。' }
    if (question.length > 4000) return { kind: 'error', text: '问题过长（最多 4000 字）。' }
    const target = (input.assistId ?? '').trim() || defaultAssistId
    const chatId = (input.chatId ?? '').trim() || (target !== '' && config.userId !== '' ? `${config.userId}_${target}` : undefined)
    const result = await platformChat(config, question, { chatId, assistId: target !== '' ? target : undefined }, signal)
    if (!result.ok) return this.failure(result)
    const content = (result.data as { content?: unknown } | null | undefined)?.content
    if (typeof content !== 'string' || content.trim() === '') return { kind: 'error', text: '平台没有返回回复内容。' }
    return { kind: 'reply', text: `平台智能体${target !== '' ? `（${target}）` : ''}回复：${content.slice(0, 4000)}` }
  }

  private async platformUploadFile(config: PlatformConfig, input: { filePath: string; assistId?: string },
    defaultAssistId: string, signal?: AbortSignal): Promise<SubAssistantReceipt> {
    const filePath = (input.filePath ?? '').trim()
    if (filePath === '') return { kind: 'error', text: '上传知识库需要本地文件路径。' }
    const target = (input.assistId ?? '').trim() || defaultAssistId
    if (target === '') return { kind: 'error', text: '上传知识库需要智能体 ID。' }
    const resolved = path.resolve(filePath)
    let stat
    try { stat = statSync(resolved) } catch { return { kind: 'error', text: `读不到文件：${filePath}` } }
    if (!stat.isFile()) return { kind: 'error', text: `不是普通文件：${filePath}` }
    if (stat.size <= 0) return { kind: 'error', text: '文件是空的，未上传。' }
    if (stat.size > MAX_UPLOAD_BYTES) return { kind: 'error', text: `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB，未上传。` }
    const ext = path.extname(resolved).slice(1).toLowerCase()
    // 实测平台只按 txt 稳定解析文本类文件；二进制文档保留原后缀，其他一律按 txt 上传。
    const fileExt = ['pdf', 'docx', 'doc', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg'].includes(ext) ? ext : 'txt'
    const name = `${path.basename(resolved, path.extname(resolved))}.${fileExt}`
    let base64 = ''
    try { base64 = readFileSync(resolved).toString('base64') } catch { return { kind: 'error', text: `读取文件失败：${filePath}` } }
    const result = await platformUploadKnowledge(config, [{ base64, file_ext: fileExt, file_name: name }], target, signal)
    if (!result.ok) return this.failure(result)
    const rows = Array.isArray(result.data) ? result.data as Array<{ success?: unknown; desc?: unknown }> : []
    const failed = rows.find(row => row?.success === false)
    if (failed) return { kind: 'error', text: `平台拒绝上传：${typeof failed.desc === 'string' ? failed.desc : '未知原因'}` }
    return { kind: 'reply', text: `已上传「${name}」（${stat.size} 字节，按 ${fileExt} 解析）到智能体 ${target} 的知识库。` }
  }

  private refuse(assistantId: string, displayName: string, dispatchId: string, task: string, depth: number, reason: string, startedAt: number): SubAssistantDispatchResult {
    // 账本先行：拒绝也要如实入账（dispatch_id 唯一，重放命中既有 refused 行）
    const existing = this.options.ledger.getSubAssistantRunByDispatchId(dispatchId)
    const runId = existing?.runId ?? this.options.ledger.beginSubAssistantRun({ runId: randomUUID(), assistantId,
      dispatchId, taskDigest: subAssistantTaskDigest(task), depth }, startedAt)?.runId ?? null
    if (runId) this.options.ledger.finishSubAssistantRun(runId, 'refused', 'refused', reason, this.now())
    return { runId, assistantId, displayName, status: 'refused', text: reason, depth, elapsedMs: this.now() - startedAt }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
