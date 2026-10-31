/**
 * 审批的判定与措辞：风险归档、目标规范化、卡片内容、原生确认框文案、专用窗口回执核验。
 *
 * 为什么单独一个文件、而且不 import electron：
 * 这一层是**安全边界**上的判断。"什么算高风险"、"哪些操作无论标称风险多低都要原生确认"、
 * "专用窗口回来的决定凭什么被采信"——这三条写错，界面上看起来一切正常，坏的是批准本身。
 * 放在主进程胶水里的话它们进不了 `node --test`（electron 导入不了），就只能靠真机点，
 * 而真机点不出"攻击者换了个工具名"这种分支。所以决策留在这里，胶水只做 IPC 与开窗。
 *
 * 渲染层也会 import 它（倒计时、风险标签）。这是刻意的：面板上的提示和专用窗口里的卡片
 * 必须是同一套措辞，两处各写一份的话，迟早出现面板说"还剩 5 秒"而卡片说"已过期"。
 */

export type Risk = 'low' | 'medium' | 'high'

export type MeetingMailOutcome =
  | { state: 'pending'; intentId: string; acceptedAt: number }
  | { state: 'scheduled'; intentId: string; acceptedAt: number; taskId: string; runAt: string }

/** 只采用完整服务回执和精确的两分钟锚点，不信任自由文本的成功宣称。 */
export function parseMeetingMailOutcome(value: unknown): MeetingMailOutcome | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as { intentId?: unknown; acceptedAt?: unknown; followup?: unknown }
  if (typeof result.intentId !== 'string' || !result.intentId || result.intentId.length > 200
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(result.intentId)
    || typeof result.acceptedAt !== 'number' || !Number.isSafeInteger(result.acceptedAt) || result.acceptedAt < 0
    || !result.followup || typeof result.followup !== 'object' || Array.isArray(result.followup)) return undefined
  const followup = result.followup as { state?: unknown; taskId?: unknown; runAt?: unknown }
  if (followup.state === 'pending') return { state: 'pending', intentId: result.intentId, acceptedAt: result.acceptedAt }
  if (followup.state !== 'scheduled' || typeof followup.taskId !== 'string' || !followup.taskId || followup.taskId.length > 200
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(followup.taskId) || typeof followup.runAt !== 'string'
    || Date.parse(followup.runAt) !== result.acceptedAt + 120_000) return undefined
  return { state: 'scheduled', intentId: result.intentId, acceptedAt: result.acceptedAt, taskId: followup.taskId, runAt: followup.runAt }
}

export function meetingMailOutcomeText(outcome: MeetingMailOutcome | undefined): { message: string; detail: string } {
  if (!outcome) return { message: '邮件与提醒结果未确认', detail: '请到团队页和任务页核查，不要重复批准或重发邮件。' }
  if (outcome.state === 'pending') return { message: '邮件服务已接受，但提醒尚未登记',
    detail: `邮件编号：${outcome.intentId}\n请打开任务与提醒页面核查运行状态；不要重发邮件。服务接受不代表收件或已读。` }
  return { message: '邮件服务已接受，提醒计划已登记',
    detail: `邮件编号：${outcome.intentId}\n提醒任务：${outcome.taskId}\n计划时间：${new Date(outcome.runAt).toLocaleString('zh-CN')}\n服务接受不代表收件或已读；提醒送达以实际回执为准。` }
}

/**
 * 桥接推来的操作提案。
 *
 * 所有字段都可选：这是 HTTP JSON，TypeScript 保证不了运行时形状。凡是"缺了怎么办"的判断
 * 都集中在本文件，界面拿到的 `ApprovalCardView` 里不再有可空字段需要各自处理。
 */
export interface ApprovalProposal {
  kind?: 'report' | 'team' | 'assistant'
  reportId?: string
  revision?: number
  digest?: string
  content?: string
  epoch?: string
  proposalId: string
  taskId?: string | null
  assistantId?: string | null
  summary?: string | null
  tool?: string | null
  target?: string | null
  risk?: string | null
  state?: string | null
  expiresAt?: number
}

export const RISK_LABEL: Record<Risk, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

/**
 * 提案声明的风险等级。
 *
 * 认不出的值一律按 high 处理，不按 medium。理由：risk 这个字段是**提案方**填的，
 * 而提案方是模型。把"我不认识这个等级"翻译成"中等风险"，等于让一个写错枚举值的模型
 * 把自己的操作降级。往高了判最坏是多弹一次原生确认框，往低了判最坏是用户批准了
 * 一个他以为无关紧要、实际会删东西的操作。
 */
export function riskOf(proposal: Pick<ApprovalProposal, 'risk'>): Risk {
  const risk = proposal.risk
  if (risk === 'low' || risk === 'medium' || risk === 'high') return risk
  return 'high'
}

/**
 * 无论提案标称风险多低，都必须再过一次主进程原生确认框的工具名关键词。
 *
 * 对应设计文档的硬规定：删除、外发、安装和账户操作始终不接受低风险通道。
 * 这些操作有一个共同点——**不可撤销**，或者一旦执行就有第三方看到。
 * 不可撤销的操作不给"手滑点一下"留余地：原生确认框是另一个窗口、另一套外观，
 * 用户不会把两次点击当成一次。
 *
 * 用子串匹配而不是精确等于工具名：工具名会随插件版本变（`delete_file`、`fs.remove`、
 * `shell.rm`），精确匹配的话新增一个同义工具就悄悄绕过了这道确认。
 */
const ALWAYS_CONFIRM_KEYWORDS = [
  'delete',
  'remove',
  'unlink',
  'drop',
  'install',
  'uninstall',
  'send',
  'post',
  'publish',
  'push',
  'upload',
  'mail',
  'pay',
  'purchase',
  'login',
  'logout',
  'account',
  'credential',
  'shutdown',
  'restart',
  'kill',
  'format',
]

export function alwaysConfirmTool(tool: string | null | undefined): boolean {
  if (!tool) return false
  const name = tool.toLowerCase()
  return ALWAYS_CONFIRM_KEYWORDS.some(keyword => name.includes(keyword))
}

/**
 * 这次批准要不要再过一道主进程原生确认框。
 *
 * 工具名缺失时返回 true：不知道要动什么的操作，本身就是最该让人多看一眼的那种。
 */
export function needsNativeConfirm(proposal: Pick<ApprovalProposal, 'risk' | 'tool'>): boolean {
  if (!proposal.tool) return true
  return riskOf(proposal) === 'high' || alwaysConfirmTool(proposal.tool)
}

/**
 * 文件系统目标按段折叠。
 *
 * 丢掉 `''` 段（重复斜杠）和 `.` 段（当前目录），**保留** `..` 段。跨目录的相对路径是
 * 危险信号，把它算平等于替用户藏掉一条他本该看见的线索；而且纯文本解析 `..` 也算不对——
 * 符号链接会让 `a/../b` 和 `b` 指向不同的地方，假装算平是撒谎。
 */
function collapseSegments(unified: string): string {
  const drive = /^([A-Za-z]:)(?=\/|$)/.exec(unified)?.[1]
  const body = drive ? unified.slice(drive.length) : unified
  const kept = body.split('/').filter(segment => segment !== '' && segment !== '.')
  const joined = kept.join('/')
  if (drive) return joined ? `${drive}/${joined}` : drive
  return unified.startsWith('/') ? `/${joined}` : joined
}

/**
 * 目标规范化：同一个操作不能因为写法不同，就在卡片和原生确认框里长得不一样。
 *
 * URL 和文件系统目标分开处理。URL 只去掉 userinfo（`https://user:token@host`）——凭据
 * 出现在确认框里，用户可能截图、可能被人从背后看到，而它对"要不要批准"这个决定毫无帮助；
 * 路径部分原样保留，因为把 `//` 折叠掉会让 `https://host` 变成 `https:/host`，
 * 用户对着一个不像地址的地址做判断，比原样显示更糟。
 *
 * 协议名的量词是 `+` 而不是 `*`，这一处不能松：真实的协议名（http、file、ftp）都至少两个
 * 字符，而单字母后跟冒号在 Windows 上是盘符。写成 `*` 的话 `D://java//x` 会被认成一种
 * 叫 `d` 的协议，重复斜杠原样留着，规范化等于没做。
 */
export function normalizeTarget(target: string | null | undefined): string | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(trimmed)) {
    return trimmed.replace(/^([a-z][a-z0-9+.-]+:\/\/)[^/@\s]+@/i, '$1')
  }
  return collapseSegments(trimmed.replace(/\\/g, '/')) || null
}

/**
 * 中间省略的截断。
 *
 * 路径和 URL 的信息量都在两端（盘符/域名在前，文件名/接口在后），从头截断会把
 * 真正要看的部分切掉，只剩一串无关的目录。首尾各留一半，中间用 … 代替。
 *
 * 上限小到装不下两端时退回尾部省略：这时候"首尾都留"已经做不到了，硬凑的结果会比
 * 上限更长——调用方要的是一个能放进固定宽度里的字符串，超长就失去意义了。
 */
export function ellipsizeMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.floor((max - 1) / 2)
  if (keep < 4) return `${text.slice(0, Math.max(0, max - 1))}…`
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`
}

export interface ApprovalCardView {
  proposalId: string
  report: { reportId: string; revision: number; digest: string; content: string } | null
  assistant?: { revision: number; digest: string; content: string } | null
  /** 改动提案的可审阅差异（文件清单、增删行、截断提示）；只有 apply_change 有。 */
  change?: ChangeReviewView | null
  /** 验证命令的完整范围（cwd、程序、参数数组、超时、预期副作用）；只有 run_verification 有。 */
  verification?: VerificationReviewView | null
  /** unknown 人工复核要写进账本的结论；只有 review_unknown 有。 */
  review?: UnknownReviewView | null
  /** 卡片标题：按提案种类给，界面不再自己猜。 */
  title: string
  tool: string
  /** 给人看的操作名；可信执行器动作带中文说明，其余就是工具名。 */
  toolLabel: string
  target: string | null
  summary: string | null
  risk: Risk
  riskLabel: string
  /** 提请者的显示名。null 表示提案里没带 assistantId，界面上就不显示这一行。 */
  requester: string | null
  /**
   * 截止时间，不是算好的倒计时字符串。
   *
   * 卡片上的剩余时间要每秒跳一次：给字符串的话卡片要么静止不动（用户看着"0:05"以为还有时间，
   * 其实早过期了），要么每秒回主进程问一次。给截止时间，界面自己用 `formatCountdown` 跳字。
   *
   * 而"过没过期"这个**判断**不交给界面：`expired` 由主进程在投影时算，批准时再算一次。
   * null 表示这条提案根本没有期限，界面上不显示倒计时。
   */
  expiresAt: number | null
  expired: boolean
  canDecide: boolean
  /** 不能决定时的原因。必须显示出来，只禁用按钮的话用户不知道自己在等什么。 */
  blockedReason: string | null
  needsNativeConfirm: boolean
}

/**
 * 提案的剩余时间，格式化成 `m:ss`。
 *
 * 提案的有效期通常是几分钟，显示小时没有意义。到点或已过点返回「已过期」——
 * 卡片上的批准按钮同时会禁用，让用户点了才知道失败是很差的体验。
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '已过期'
  const totalSeconds = Math.floor(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

/**
 * 由插件可信执行器完成的三种动作。它们不是宿主工具：批准后由执行器应用改动、运行验证命令或写入复核结论，
 * 所以审批卡必须把「到底会发生什么」完整摊开 —— 差异、命令、结论任何一项缺失或对不上，都不能批。
 */
export const TRUSTED_REVIEW_TOOLS = ['apply_change', 'run_verification', 'review_unknown'] as const
export type TrustedReviewTool = (typeof TRUSTED_REVIEW_TOOLS)[number]

const TRUSTED_TOOL_LABEL: Record<TrustedReviewTool, string> = {
  apply_change: '应用改动（apply_change）',
  run_verification: '运行验证命令（run_verification）',
  review_unknown: '写入人工复核结论（review_unknown）',
}

export interface DiffLineView {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
  text: string
}

export interface ChangeFileView {
  path: string
  action: 'modify' | 'create'
  actionLabel: string
  added: number
  removed: number
  baseHash: string
  newHash: string
  lines: DiffLineView[]
  truncated: boolean
}

export interface ChangeReviewView {
  root: string
  revision: number
  digest: string
  files: ChangeFileView[]
  totalAdded: number
  totalRemoved: number
  truncated: boolean
  notice: string | null
}

export interface VerificationReviewView {
  root: string
  cwd: string
  cwdRelative: string
  program: string
  requested: string | null
  args: string[]
  timeoutMs: number
  timeoutLabel: string
  expectedEffects: string
  env: string
  afterChange: { revision: number; files: string[] } | null
  notes: string[]
  digest: string
  revision: number
}

export interface UnknownReviewView {
  operationId: string
  kind: string
  target: string | null
  startedAt: number | null
  executedAt: number | null
  detail: string | null
  resolution: 'verified-succeeded' | 'verified-failed' | 'abandoned'
  resolutionLabel: string
  note: string
  effect: string
  digest: string
}

const HEX64 = /^[a-f0-9]{64}$/
const MAX_REVIEW_FILES = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function count(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function diffLines(diff: string): DiffLineView[] {
  if (diff.length === 0) return []
  return diff.split('\n').map((text): DiffLineView => {
    if (text.startsWith('@@')) return { kind: 'hunk', text }
    if (text.startsWith('+')) return { kind: 'add', text }
    if (text.startsWith('-')) return { kind: 'del', text }
    if (text.startsWith('\\')) return { kind: 'meta', text }
    return { kind: 'ctx', text }
  })
}

/**
 * 改动审阅文档 → 卡片视图。每一项都核对：文件清单完整、增删行数与总数自洽、
 * 没截断时显示的差异行数必须等于声明的增删行数、截断时必须带提示。任何一项不符返回 null（不能批）。
 */
function parseChangeReview(proposal: ApprovalProposal, document: unknown): ChangeReviewView | null {
  if (!isRecord(document) || document.format !== 'dsh-change-review@1' || !nonEmpty(document.root)) return null
  if (document.revision !== proposal.revision || !Array.isArray(document.files)) return null
  if (document.files.length === 0 || document.files.length > MAX_REVIEW_FILES) return null
  const files: ChangeFileView[] = []
  for (const raw of document.files) {
    if (!isRecord(raw) || !nonEmpty(raw.path) || (raw.action !== 'modify' && raw.action !== 'create')) return null
    if (!count(raw.added) || !count(raw.removed) || typeof raw.diff !== 'string' || typeof raw.diffTruncated !== 'boolean') return null
    if (typeof raw.newHash !== 'string' || !HEX64.test(raw.newHash)) return null
    const baseOk = raw.action === 'create' ? raw.baseHash === 'absent' : typeof raw.baseHash === 'string' && HEX64.test(raw.baseHash)
    if (!baseOk) return null
    const lines = diffLines(raw.diff)
    if (!raw.diffTruncated) {
      // 显示的差异必须就是全部差异：行数对不上，说明卡片上看到的不是将要写进去的东西。
      if (lines.filter(line => line.kind === 'add').length !== raw.added) return null
      if (lines.filter(line => line.kind === 'del').length !== raw.removed) return null
    }
    files.push({
      path: raw.path, action: raw.action, actionLabel: raw.action === 'create' ? '新建' : '修改',
      added: raw.added, removed: raw.removed, baseHash: raw.baseHash as string, newHash: raw.newHash, lines, truncated: raw.diffTruncated,
    })
  }
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  if (document.totalAdded !== totalAdded || document.totalRemoved !== totalRemoved) return null
  const truncated = files.some(file => file.truncated)
  if (document.truncated !== truncated) return null
  if (truncated && !nonEmpty(document.notice)) return null
  return {
    root: document.root, revision: proposal.revision as number, digest: proposal.digest as string, files,
    totalAdded, totalRemoved, truncated, notice: truncated ? (document.notice as string) : null,
  }
}

function parseVerificationReview(proposal: ApprovalProposal, document: unknown): VerificationReviewView | null {
  if (!isRecord(document) || document.format !== 'dsh-verification-review@1') return null
  if (!nonEmpty(document.root) || !nonEmpty(document.cwd) || !nonEmpty(document.program)) return null
  if (!Array.isArray(document.args) || !document.args.every(arg => typeof arg === 'string')) return null
  if (!Number.isInteger(document.timeoutMs) || (document.timeoutMs as number) <= 0) return null
  if (!nonEmpty(document.expectedEffects) || !nonEmpty(document.env)) return null
  let afterChange: VerificationReviewView['afterChange'] = null
  if (document.afterChange !== null && document.afterChange !== undefined) {
    const after = document.afterChange
    if (!isRecord(after) || !Number.isInteger(after.revision) || !Array.isArray(after.files)
      || !after.files.every(file => typeof file === 'string')) return null
    afterChange = { revision: after.revision as number, files: after.files as string[] }
  }
  const notes = Array.isArray(document.notes) ? document.notes.filter((note): note is string => typeof note === 'string') : []
  const seconds = Math.round((document.timeoutMs as number) / 1000)
  return {
    root: document.root, cwd: document.cwd, cwdRelative: typeof document.cwdRelative === 'string' ? document.cwdRelative : document.cwd,
    program: document.program, requested: typeof document.requested === 'string' ? document.requested : null,
    args: document.args as string[], timeoutMs: document.timeoutMs as number,
    timeoutLabel: seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`,
    expectedEffects: document.expectedEffects, env: document.env, afterChange, notes,
    digest: proposal.digest as string, revision: proposal.revision as number,
  }
}

const RESOLUTIONS = ['verified-succeeded', 'verified-failed', 'abandoned'] as const

function parseUnknownReview(proposal: ApprovalProposal, document: unknown): UnknownReviewView | null {
  if (!isRecord(document) || document.format !== 'dsh-unknown-review@1' || !isRecord(document.operation)) return null
  const operation = document.operation
  if (!nonEmpty(operation.operationId) || !nonEmpty(operation.kind)) return null
  if (!(RESOLUTIONS as readonly unknown[]).includes(document.resolution) || !nonEmpty(document.resolutionLabel)) return null
  if (typeof document.note !== 'string' || !nonEmpty(document.effect)) return null
  const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    operationId: operation.operationId, kind: operation.kind,
    target: typeof operation.target === 'string' ? operation.target : null,
    startedAt: time(operation.startedAt), executedAt: time(operation.executedAt),
    detail: typeof operation.detail === 'string' ? operation.detail : null,
    resolution: document.resolution as UnknownReviewView['resolution'], resolutionLabel: document.resolutionLabel,
    note: document.note, effect: document.effect, digest: proposal.digest as string,
  }
}

/** 可信执行器动作的审阅内容：解析不出来就返回 null，调用方据此禁止批准。 */
function trustedReview(proposal: ApprovalProposal): Pick<ApprovalCardView, 'change' | 'verification' | 'review'> | null {
  if (typeof proposal.digest !== 'string' || !HEX64.test(proposal.digest)) return null
  if (!Number.isInteger(proposal.revision) || (proposal.revision ?? 0) <= 0) return null
  if (typeof proposal.content !== 'string' || proposal.content.length === 0) return null
  let document: unknown
  try {
    document = JSON.parse(proposal.content)
  } catch {
    return null
  }
  if (proposal.tool === 'apply_change') {
    const change = parseChangeReview(proposal, document)
    return change ? { change } : null
  }
  if (proposal.tool === 'run_verification') {
    const verification = parseVerificationReview(proposal, document)
    return verification ? { verification } : null
  }
  const review = parseUnknownReview(proposal, document)
  return review ? { review } : null
}

function isTrustedReviewTool(tool: unknown): tool is TrustedReviewTool {
  return typeof tool === 'string' && (TRUSTED_REVIEW_TOOLS as readonly string[]).includes(tool)
}

/**
 * 把一条原始提案投影成卡片要渲染的内容。
 *
 * `requesterName` 由调用方按 assistantId 查好再传进来：这个模块不认识角色清单，
 * 认识的话渲染层就用不了它了（清单在 renderer 侧）。
 *
 * 只有 `state` 是 pending 的提案能决定。已经批准/驳回/过期的提案再点一次，
 * 宿主那边会拒绝重放，但界面上不能让用户先点、再看一句报错。
 */
export function cardView(
  proposal: ApprovalProposal,
  requesterName: string | null,
  now: number,
): ApprovalCardView {
  const risk = riskOf(proposal)
  const expiresAt = typeof proposal.expiresAt === 'number' ? proposal.expiresAt : null
  const left = expiresAt === null ? null : expiresAt - now
  const expired = left !== null && left <= 0
  const state = proposal.state ?? 'pending'
  const settled = state !== 'pending'

  let blockedReason: string | null = null
  if (expired) {
    blockedReason = '这个提案已经过期，等助理重新提请'
  } else if (settled) {
    blockedReason = `这个提案已经${state === 'approved' ? '批准' : state === 'rejected' ? '驳回' : '结束'}了`
  }

  const isReport = proposal.kind === 'report'
  const report = isReport && typeof proposal.reportId === 'string'
    && Number.isInteger(proposal.revision) && (proposal.revision ?? 0) > 0
    && typeof proposal.digest === 'string' && /^[a-f0-9]{64}$/.test(proposal.digest)
    && typeof proposal.content === 'string' && typeof proposal.epoch === 'string' && proposal.epoch.length > 0
    && typeof proposal.target === 'string' && proposal.target.length > 0
    && typeof proposal.expiresAt === 'number' && Number.isFinite(proposal.expiresAt)
    ? { reportId: proposal.reportId, revision: proposal.revision!, digest: proposal.digest, content: proposal.content }
    : null
  if (isReport && !report) blockedReason = '日报全文、版本或绑定信息缺失，不能批准，请重新提交'
  const isAssistant = proposal.kind === 'assistant'
  const assistant = isAssistant && proposal.state === 'pending'
    && typeof proposal.tool === 'string' && proposal.tool.trim().length > 0
    && Number.isInteger(proposal.revision) && (proposal.revision ?? 0) > 0
    && typeof proposal.digest === 'string' && /^[a-f0-9]{64}$/.test(proposal.digest)
    && typeof proposal.content === 'string' && proposal.content.trim().length > 0
    && typeof proposal.epoch === 'string' && proposal.epoch.length > 0
    && typeof proposal.target === 'string' && proposal.target.length > 0
    && typeof proposal.expiresAt === 'number' && Number.isFinite(proposal.expiresAt)
    ? { revision: proposal.revision!, digest: proposal.digest, content: proposal.content } : null
  if (isAssistant && !assistant) blockedReason = '授权全文、版本或绑定信息缺失，不能批准，请重新提交'
  // 可信执行器动作只出现在团队提案里；审阅内容缺失、格式不对或前后不自洽都不能批。
  const isTrusted = (proposal.kind === undefined || proposal.kind === 'team') && isTrustedReviewTool(proposal.tool)
  const trusted = isTrusted ? trustedReview(proposal) : null
  if (isTrusted && !trusted) {
    blockedReason = proposal.tool === 'apply_change' ? '改动差异、版本或绑定信息缺失或对不上，不能批准，请让助理重新提交'
      : proposal.tool === 'run_verification' ? '验证命令的完整范围缺失或格式不对，不能批准，请让助理重新提交'
        : '复核结论或被复核的操作信息缺失，不能批准，请让助理重新提交'
  }
  const trustedTool = isTrusted ? (proposal.tool as TrustedReviewTool) : null
  const title = isReport ? '请确认这版日报' : isAssistant ? '请确认助理操作范围'
    : trustedTool === 'apply_change' ? '请审阅这次改动'
      : trustedTool === 'run_verification' ? '请确认这条验证命令'
        : trustedTool === 'review_unknown' ? '请确认人工复核结论' : '有个操作等你点头'

  return {
    proposalId: proposal.proposalId,
    report,
    ...(isAssistant ? { assistant } : {}),
    ...(trustedTool === 'apply_change' ? { change: trusted?.change ?? null } : {}),
    ...(trustedTool === 'run_verification' ? { verification: trusted?.verification ?? null } : {}),
    ...(trustedTool === 'review_unknown' ? { review: trusted?.review ?? null } : {}),
    title,
    tool: proposal.tool || '未知操作',
    toolLabel: trustedTool ? TRUSTED_TOOL_LABEL[trustedTool] : proposal.tool || '未知操作',
    // 日报目标必须完整显示，不能把中间的目录截断成省略号。
    target: isReport || isAssistant ? proposal.target ?? null : ellipsizeMiddle(normalizeTarget(proposal.target) ?? '', 160) || null,
    summary: proposal.summary?.trim() || null,
    risk,
    riskLabel: RISK_LABEL[risk],
    requester: requesterName,
    expiresAt,
    expired,
    canDecide: blockedReason === null,
    blockedReason,
    needsNativeConfirm: needsNativeConfirm(proposal),
  }
}

export interface ConfirmDialogSpec {
  title: string
  message: string
  detail: string
  approveLabel: string
  cancelLabel: string
}

/**
 * 高风险操作的原生确认框文案。
 *
 * 这里用主进程**保存的原始提案**渲染，不用专用窗口回传的任何字段：窗口是渲染层，
 * 它回传的目标字符串可以被改。卡片视图（view）也是主进程自己算出来的，同样可信。
 *
 * `now` 由调用方在弹框那一刻传进来：确认框可能比卡片晚几秒才弹（用户先读了卡片），
 * 显示卡片渲染时的剩余时间会多报几秒，而这几秒正是用户以为还来得及的那部分。
 *
 * detail 里明确写出批准后会真的动手，让用户知道自己点的是什么。
 */
export function confirmDialogSpec(
  view: ApprovalCardView,
  requesterName: string | null,
  now: number,
): ConfirmDialogSpec {
  const who = requesterName ?? '助理'
  const left = view.expiresAt === null ? null : view.expiresAt - now
  const change = view.change
  const verification = view.verification
  const review = view.review
  const lines = [
    `操作：${view.toolLabel}`,
    view.target ? `目标：${view.target}` : null,
    view.report ? `日报：${view.report.reportId}，第 ${view.report.revision} 版\n摘要：${view.report.digest}` : null,
    view.assistant ? `助理提案：第 ${view.assistant.revision} 版\n摘要：${view.assistant.digest}\n完整范围：${view.assistant.content}` : null,
    change
      ? [
          `改动：第 ${change.revision} 版，${change.files.length} 个文件（+${change.totalAdded} −${change.totalRemoved}）`,
          ...change.files.map(file => `  · ${file.path}（${file.actionLabel}，+${file.added} −${file.removed}）`),
          change.notice ? `注意：${change.notice}` : null,
        ].filter((line): line is string => line !== null).join('\n')
      : null,
    verification
      ? [
          `工作目录：${verification.cwd}`,
          `程序：${verification.program}`,
          `参数：${JSON.stringify(verification.args)}`,
          `超时：${verification.timeoutLabel}`,
          `预期副作用：${verification.expectedEffects}`,
          `环境：${verification.env}`,
        ].join('\n')
      : null,
    review
      ? `复核：把 ${review.kind}${review.target ? `（${review.target}）` : ''} 标记为「${review.resolutionLabel}」${review.note ? `\n备注：${review.note}` : ''}`
      : null,
    view.summary ? `说明：${view.summary}` : null,
    `提请：${who}`,
    `风险：${view.riskLabel}`,
    left === null ? null : `剩余：${formatCountdown(left)}`,
  ].filter((line): line is string => line !== null)

  return {
    title: '需要你确认这个操作',
    message: `${who}请求执行「${view.toolLabel}」，这一步批准后就会真的动手。`,
    detail: lines.join('\n'),
    approveLabel: '我确认，批准',
    cancelLabel: '先不批准',
  }
}

/**
 * 两个 URL 是不是同一个打包在应用里的本地页面。
 *
 * 不用字符串全等：Electron 会按自己的规则百分号编码路径里的空格与非 ASCII 字符，
 * 而主进程用 `pathToFileURL` 算出来的那个未必编码方式一致。字符串全等在这里的后果是
 * **审批窗口完全不能用**——每一条回执都因为"URL 不相等"被拒，而界面上一句报错也看不出来。
 *
 * 改成三段比对，精确程度不降：
 * - 协议必须是 `file:`（远程页面一律不行）；
 * - 不能带 query 与 hash（带了就不是"那个页面"了，而且这正是被导到别处的常见形态）；
 * - 解码后的路径必须完全相等。
 *
 * 路径大小写按原样比对，不做平台相关的忽略：主进程加载的就是它自己算出来的那个路径，
 * 两边都来自同一处，正常情况下不可能只有大小写不同；真出现了，那本身就是异常。
 */
export function sameLocalPage(url: string, expectedUrl: string): boolean {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(url)
    expected = new URL(expectedUrl)
  } catch {
    // 解析不出来的 URL 不是本地页面。宁可拒掉，也不要退回某种"看着像"的比较。
    return false
  }
  if (actual.protocol !== 'file:' || expected.protocol !== 'file:') return false
  if (actual.search !== '' || actual.hash !== '') return false
  return decodeURIComponent(actual.pathname) === decodeURIComponent(expected.pathname)
}

/** 专用审批窗口回传决定时，主进程能核验的事实。 */
export interface SenderFacts {
  /** 回执来自哪个 webContents。 */
  senderId: number
  /** 开窗时登记的那个 webContents；没有登记过就是 null。 */
  registeredId: number | null
  /** 回执是不是来自主 frame。 */
  isMainFrame: boolean
  /** 发信页面的完整 URL。 */
  url: string
  /** 主进程当初 loadFile 的那个页面的完整 URL。 */
  expectedUrl: string
  /** 回执里自报的提案 id。 */
  claimedProposalId: string
  /** 主进程当前登记给这个窗口的提案 id。 */
  registeredProposalId: string | null
}

export type SenderCheck = { ok: true } | { ok: false; reason: string }

/**
 * 专用窗口回来的批准凭什么被采信。
 *
 * 四条，缺一条就拒：
 * 1. 发信者必须是开窗时登记的那个 webContents —— 不能是另一个窗口，也不能是窗口重开后的新实例；
 * 2. 必须来自主 frame —— 页面里嵌的 iframe（就算加载的是本地文件）不该有签发批准的能力；
 * 3. 发信页面必须就是主进程加载的那个本地页面 —— 专用窗口禁止导航，所以任何差异都意味着
 *    有人把它导到别处去了；
 * 4. 自报的提案 id 必须等于登记的那个 —— 窗口是显示层，它说自己在批哪条不算数，
 *    主进程只批自己登记的那条。
 *
 * 注意这里**不看**回执里的目标、范围、摘要：那些一律以主进程保存的原始提案为准。
 */
export function checkSender(facts: SenderFacts): SenderCheck {
  if (facts.registeredId === null) {
    return { ok: false, reason: '这个窗口没有登记过审批任务' }
  }
  if (facts.senderId !== facts.registeredId) {
    return { ok: false, reason: '回执不是来自登记的那个审批窗口' }
  }
  if (!facts.isMainFrame) {
    return { ok: false, reason: '回执来自子 frame，不予采信' }
  }
  if (!sameLocalPage(facts.url, facts.expectedUrl)) {
    return { ok: false, reason: '审批页面已经不在原始地址上' }
  }
  if (facts.registeredProposalId === null || facts.claimedProposalId !== facts.registeredProposalId) {
    return { ok: false, reason: '回执指向的提案与登记的不一致' }
  }
  return { ok: true }
}
