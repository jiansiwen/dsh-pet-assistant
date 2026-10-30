/**
 * 帮助任务的可信执行（M2-06 / M3-07）：已授权项目 → 读取 → 改动提案 → 可信批准 → 可信执行器应用 → 验证命令 → 账本。
 *
 * 边界，逐条落在代码里而不是提示词里：
 * - 只读已授权项目：每次读、提案、执行前都向帮助授权（help-context，按真实路径）重新确认，撤销或改指立即拒绝；
 *   路径一律经 gate 的 canonicalPath 解析成真实路径再与授权根比对（符号链接越界、相似前缀都按真实位置判断）。
 * - 模型不直接写文件：它只能提交改动提案（目标文件 + 统一 diff 或替换内容 + 每个文件的基线哈希）。
 *   审阅差异由这里重算；批准绑定提案修订、基线哈希与目标路径；应用由可信执行器在批准签发之后完成，
 *   应用前重读哈希，外部改过就冲突暂停、一个文件都不写；写入走临时文件 + 改名；前后哈希进账本。
 * - 验证命令是独立授权的动作：cwd 在授权项目内、程序与参数数组（不经 shell）、超时、预期副作用说明，
 *   批准后执行一次，真实退出码、截断输出与文件结果写进账本。
 * - 「已应用」与「验证通过」分开记；测试失败不会被说成修复完成；unknown 只能由可信人工复核改写。
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  ApprovalError, digestOf, isTrustedActionTool,
  type ApprovalService, type TrustedActionTool, type TrustedDecision,
} from './approval.ts'
import {
  ABSENT_VERSION, MAX_CHANGE_FILES, MAX_FILE_BYTES, applyUnifiedDiff, buildChangeReview, commitFiles, decodeText,
  diffTrees, readSnapshot, sha256Hex, snapshotTree, splitLines, unifiedDiff, type CommitHooks, type UnifiedDiff,
} from './change-set.ts'
import { canonicalPath, canonicalRoot, isRootOrWithin, isWithinRoot } from './gate.ts'
import {
  REVIEW_RESOLUTIONS, TERMINAL_TASK_STATUSES,
  type ActionProposal, type ChangeFile, type ChangeSet, type HelpTaskLink, type OperationRecord, type OperationState,
  type ReviewResolution, type Task, type TaskStatus, type TeamStore, type VerificationRecord, type VerificationState,
} from './team-domain.ts'
import { ENV_POLICY_TEXT, buildVerificationEnv, resolveProgram, runCommand, type CommandResult } from './verify-command.ts'

/** 帮助授权记录（来自助理库 help_contexts），路径均为真实路径。 */
export interface HelpScopeRecord {
  readonly id: string
  readonly projectDir: string
  readonly currentFile: string | null
}

/** 帮助授权来源：HelpContextStore 满足这个形状。撤销或链接改指后返回 null。 */
export interface HelpScopeSource {
  authorizedScope(projectDir: string): HelpScopeRecord | null
  /** 按授权记录 id 复核（帮助任务绑定的就是那一条）；没有时退回按目录复核。 */
  validById?(id: string): HelpScopeRecord | null
}

/** 主动帮助 episode 的回链（HelpEpisodeStore 满足这个形状）；跨库，只做追溯。 */
export interface EpisodeLinker {
  canAttach(episodeId: string): boolean
  attachTask(episodeId: string, taskId: string): boolean
}

export interface HelpTaskOptions {
  readonly store: TeamStore
  readonly approvals: ApprovalService
  readonly teamId: string
  /** 帮助任务记在谁名下（总助理）。 */
  readonly chiefId: () => string
  readonly scopes?: HelpScopeSource
  readonly episodes?: EpisodeLinker
  readonly logger: { warn(message: string, meta?: unknown): void }
  /** 批准签发后的执行交给谁调度；默认立即（已经在审批请求返回之后）。测试用它制造「批准后、应用前」。 */
  readonly schedule?: (run: () => void) => void
  /** 测试用的提交故障注入点。 */
  readonly commitHooks?: CommitHooks
  /** 查程序与传给验证命令的环境来源；默认 process.env。 */
  readonly env?: NodeJS.ProcessEnv
}

export class HelpTaskError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HelpTaskError'
    this.code = code
  }
}

export interface ChangeFileInput {
  readonly path: string
  readonly baseHash: string
  readonly content?: string
  readonly diff?: string
}

export interface ExecutionOutcome {
  readonly proposalId: string
  readonly tool: TrustedActionTool
  /** 执行后改动 / 验证 / 复核的状态。 */
  readonly state: string
  readonly detail: string
  readonly operationId: string | null
}

export type HelpVerdictState = 'no-change' | 'conflict' | 'applied-unverified' | 'verified' | 'verification-failed' | 'unknown'

/** 帮助任务的结论：完全由账本推出，模型说什么都不影响。 */
export interface HelpVerdict {
  readonly state: HelpVerdictState
  /** 只有「已应用且其后的验证命令真实退出码为 0、且没有结果不明的操作」才是 true。 */
  readonly mayClaimFixed: boolean
  readonly text: string
  readonly changeId: string | null
  readonly revision: number | null
  readonly verificationId: string | null
  readonly exitCode: number | null
}

const RESOLUTION_LABEL: Readonly<Record<ReviewResolution, string>> = {
  'verified-succeeded': '已核实成功',
  'verified-failed': '已核实失败',
  abandoned: '放弃核查（结果仍不明）',
}

const RESOLUTION_STATE: Readonly<Record<ReviewResolution, OperationState>> = {
  'verified-succeeded': 'succeeded',
  'verified-failed': 'failed',
  abandoned: 'abandoned',
}

const HASH = /^[0-9a-f]{64}$/
const MAX_READ_LINES = 4000
const DEFAULT_READ_LINES = 2000
const MAX_LIST_ENTRIES = 300
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4096
const MAX_TIMEOUT_SECONDS = 1800

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function short(hash: string): string {
  return hash === ABSENT_VERSION ? '（不存在）' : HASH.test(hash) ? hash.slice(0, 12) : hash
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

/** 批准绑定的改动对象：修订、根目录与每个文件的（真实路径、动作、基线哈希、新哈希）。 */
export function changeBinding(change: Pick<ChangeSet, 'taskId' | 'changeId' | 'revision' | 'root' | 'files'>) {
  return {
    kind: 'apply_change', taskId: change.taskId, changeId: change.changeId, revision: change.revision, root: change.root,
    files: change.files.map(file => ({ path: file.path, action: file.action, baseHash: file.baseHash, newHash: file.newHash })),
  }
}

/** 批准绑定的验证命令：cwd、程序绝对路径、参数数组、超时、预期副作用、针对的改动与环境策略。 */
export function verificationBinding(record: Pick<VerificationRecord,
  'taskId' | 'verificationId' | 'cwd' | 'program' | 'args' | 'timeoutMs' | 'expectedEffects' | 'afterChangeId'>) {
  return {
    kind: 'run_verification', taskId: record.taskId, verificationId: record.verificationId, cwd: record.cwd,
    program: record.program, args: [...record.args], timeoutMs: record.timeoutMs, expectedEffects: record.expectedEffects,
    afterChangeId: record.afterChangeId, env: 'basic',
  }
}

/** 被复核操作的状态快照：应用复核时它变了就拒绝（迟到结果或并发复核）。 */
function operationSnapshot(operation: OperationRecord) {
  return {
    operationId: operation.operationId, state: operation.state, kind: operation.kind, target: operation.target ?? null,
    resultDigest: operation.resultDigest, executedAt: operation.executedAt ?? null, endedAt: operation.endedAt,
    resultDetail: operation.resultDetail ?? null,
  }
}

function reviewBinding(review: { reviewId: string; operationId: string; resolution: ReviewResolution; note: string; snapshotDigest: string }) {
  return {
    kind: 'review_unknown', reviewId: review.reviewId, operationId: review.operationId, resolution: review.resolution,
    note: review.note, snapshotDigest: review.snapshotDigest,
  }
}

/** 给人看的命令行（只用于显示与账本目标，执行永远走参数数组）。 */
export function displayCommand(program: string, args: readonly string[]): string {
  const quote = (value: string) => (/^[\w@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value))
  return clip([program, ...args].map(quote).join(' '), 300)
}

/**
 * 授权记录里的路径按 gate 的口径（原生 realpath）再解析一次：授权库用的是 JS 版 realpath，
 * Windows 上两者可能在短文件名等细节上不同，路径比对必须用同一种口径。
 */
function nativeScope(scope: HelpScopeRecord): { projectDir: string; currentFile: string | null } | null {
  const projectDir = canonicalRoot(scope.projectDir)
  if (!projectDir) return null
  if (scope.currentFile === null) return { projectDir, currentFile: null }
  try {
    return { projectDir, currentFile: realpathSync.native(scope.currentFile) }
  } catch {
    return null
  }
}

interface PreparedFile {
  readonly path: string
  readonly action: 'modify' | 'create'
  readonly baseHash: string
  readonly newHash: string
  readonly content: string
  readonly diff: UnifiedDiff
}

export class HelpTaskService {
  private readonly options: HelpTaskOptions
  private readonly store: TeamStore
  /** 每个任务的执行串行链：同一任务的应用、验证、复核一次只跑一个。 */
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly busy = new Map<string, number>()
  private readonly outcomes = new Map<string, ReturnType<typeof deferred<ExecutionOutcome>>>()
  /** 正在跑的验证命令按任务可取消（任务取消、服务停止）。 */
  private readonly aborts = new Map<string, AbortController>()
  private readonly releases: Array<() => void> = []
  private disposed = false
  private disposal: Promise<void> | null = null

  constructor(options: HelpTaskOptions) {
    this.options = options
    this.store = options.store
    // 进程启动时就要登记：上个进程留下的待批卡片可能在任何新提案之前就被批准。
    // 只读测试替身可能没有这个方法（不涉及执行器），那就不登记。
    if (typeof (options.approvals as Partial<ApprovalService>)?.onTrustedDecision === 'function') {
      for (const tool of ['apply_change', 'run_verification', 'review_unknown'] as const) {
        this.releases.push(options.approvals.onTrustedDecision(tool, (proposal, decision) => this.onDecision(proposal, decision)))
      }
    }
  }

  /** 帮助授权已装配：读取、改动与验证工具才可用（unknown 复核不依赖它）。 */
  get available(): boolean {
    return this.options.scopes !== undefined
  }

  /** 这个任务有执行器动作正在跑（对账时跳过，免得把在途执行误记成中断）。 */
  isBusy(taskId: string): boolean {
    return (this.busy.get(taskId) ?? 0) > 0
  }

  helpTask(taskId: string): HelpTaskLink | null {
    this.requireActive()
    return this.getTask(taskId) ? this.store.getHelpTask(taskId) : null
  }

  // ───────────────────────────── 打开帮助任务与读取 ─────────────────────────────

  /**
   * 在已授权的帮助范围上开一个帮助任务（记在总助理名下）。任务直接进入「等你回话」，
   * 不进排队状态 —— 它由主会话与用户推进，不会被团队调度器拿去委派子代理。
   */
  openTask(input: { projectDir: string; goal: string; episodeId?: string | null; helpContextId?: string | null }): { task: Task; link: HelpTaskLink } {
    const scopes = this.requireScopes()
    if (typeof input.projectDir !== 'string' || !path.isAbsolute(input.projectDir)) {
      throw new HelpTaskError('BAD_INPUT', 'projectDir 必须是已授权帮助范围的绝对路径')
    }
    const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
    if (!goal) throw new HelpTaskError('BAD_INPUT', '帮助任务的目标不能为空')
    // 指定了授权记录就按那一条复核（同一目录可能既有目录级、又有文件级授权）。
    const byId = typeof input.helpContextId === 'string' && input.helpContextId && scopes.validById
      ? scopes.validById(input.helpContextId) : undefined
    const scope = byId === undefined ? scopes.authorizedScope(input.projectDir)
      : byId !== null && byId.projectDir === path.resolve(input.projectDir) ? byId : null
    if (!scope) throw new HelpTaskError('NOT_AUTHORIZED', '该目录没有有效的帮助授权（未授权、已撤销或实际路径已改指），先请用户在桌面审批窗口确认读取范围')
    const native = nativeScope(scope)
    if (!native) throw new HelpTaskError('NOT_AUTHORIZED', '授权目录已不可用（不存在或不是目录），不能开帮助任务')
    const episodeId = input.episodeId ?? null
    if (episodeId !== null && !(this.options.episodes?.canAttach(episodeId) ?? false)) {
      throw new HelpTaskError('BAD_INPUT', `主动帮助记录 ${episodeId} 不存在或已结束，不能关联`)
    }
    const now = Date.now()
    const taskId = randomUUID()
    const task: Task = {
      taskId, teamId: this.options.teamId, ownerId: this.options.chiefId(), goal: clip(goal, 500),
      inputEvidence: [`帮助范围：${native.currentFile ?? native.projectDir}`, ...(episodeId ? [`主动帮助：${episodeId}`] : [])],
      acceptance: ['每处改动先经用户在桌面审批窗口批准，由可信执行器应用', '验证命令的真实退出码为 0 才算验证通过'],
      toolScope: 'side-effect', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'awaiting-user', revision: 1,
      artifacts: [], originRequestId: null, originChannel: 'help-task', createdAt: now, updatedAt: now,
    }
    const link: HelpTaskLink = {
      taskId, projectRoot: native.projectDir, currentFile: native.currentFile, helpContextId: scope.id, episodeId, createdAt: now,
    }
    this.store.transaction(() => {
      this.store.insertTask(task)
      this.store.insertHelpTask(link)
      this.store.appendEvent('task/created', { taskId, goal: task.goal, ownerId: task.ownerId, status: task.status, help: true, episodeId },
        { taskId, assistantId: task.ownerId })
    })
    if (episodeId !== null) this.options.episodes?.attachTask(episodeId, taskId)
    return { task, link }
  }

  /**
   * 只读授权项目里的一个文件或目录。文件返回全文哈希（作为改动提案的基线）与按行窗口的内容；
   * 目录返回条目清单。路径越界、授权撤销、二进制文件一律拒绝。
   */
  read(input: { taskId: string; path?: string; startLine?: number; maxLines?: number }) {
    const { link } = this.requireLink(input.taskId)
    this.requireScope(link)
    const raw = typeof input.path === 'string' && input.path.trim() ? input.path : link.currentFile ?? link.projectRoot
    const target = this.resolveInside(link, raw, 'any')
    let stat
    try {
      stat = lstatSync(target)
    } catch {
      throw new HelpTaskError('NOT_FOUND', `${this.relative(link, target)} 不存在`)
    }
    if (stat.isDirectory()) {
      if (link.currentFile !== null) throw new HelpTaskError('OUT_OF_SCOPE', `本次只授权了文件 ${link.currentFile}，不能列目录`)
      const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      return {
        ok: true, kind: 'directory', path: target, relative: this.relative(link, target),
        entries: entries.slice(0, MAX_LIST_ENTRIES).map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other',
        })),
        truncated: entries.length > MAX_LIST_ENTRIES,
      }
    }
    const snapshot = readSnapshot(target)
    if (!HASH.test(snapshot.version) || snapshot.bytes === null) {
      throw new HelpTaskError('UNSUPPORTED', `${this.relative(link, target)} 不是可读取的普通文件（${snapshot.version}；单文件上限 ${MAX_FILE_BYTES} 字节）`)
    }
    const text = decodeText(snapshot.bytes)
    if (text === null) throw new HelpTaskError('UNSUPPORTED', `${this.relative(link, target)} 不是 UTF-8 文本（或含 NUL），不读取`)
    const lines = splitLines(text)
    const startLine = Math.max(1, Math.floor(input.startLine ?? 1))
    const maxLines = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(input.maxLines ?? DEFAULT_READ_LINES)))
    const window = lines.slice(startLine - 1, startLine - 1 + maxLines)
    const partial = startLine > 1 || startLine - 1 + maxLines < lines.length
    const crlf = lines.filter(line => line.eol === '\r\n').length
    return {
      ok: true, kind: 'file', path: target, relative: this.relative(link, target),
      hash: snapshot.version, size: snapshot.bytes.length, lineCount: lines.length,
      startLine, endLine: startLine - 1 + window.length, content: window.map(line => line.body + line.eol).join(''),
      truncated: partial, eol: crlf > lines.length / 2 ? 'CRLF' : 'LF',
      note: partial
        ? '只返回了部分行；提交改动时 baseHash 用这里的 hash，并用 diff（统一 diff）而不是整文件 content'
        : '提交改动时把这里的 hash 作为该文件的 baseHash',
    }
  }

  // ───────────────────────────── 改动提案 ─────────────────────────────

  /**
   * 提交一版改动提案。不写任何文件：校验授权与基线、套用补丁、重算审阅差异，然后生成桌面审批卡。
   * 同一任务里新的一版会取代还没执行的旧版（旧审批卡作废）。
   */
  proposeChange(input: { taskId: string; summary: string; files: readonly ChangeFileInput[] }) {
    const { task, link } = this.requireOpenTask(input.taskId)
    this.requireScope(link)
    const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
    if (!summary) throw new HelpTaskError('BAD_INPUT', 'summary 不能为空：用一句话说明这版改动要解决什么')
    if (!Array.isArray(input.files) || input.files.length === 0) throw new HelpTaskError('BAD_INPUT', 'files 至少要有一个文件')
    if (input.files.length > MAX_CHANGE_FILES) {
      throw new HelpTaskError('BAD_INPUT', `一版改动最多 ${MAX_CHANGE_FILES} 个文件（审批卡要完整列出文件清单），请拆成多版`)
    }
    const seen = new Set<string>()
    const prepared = input.files.map((file, index) => this.prepareFile(link, file, index, seen))
    // 先落定已有结论的旧卡（驳回 / 到期），剩下仍在等的才算「被新一版取代」。
    this.syncExpired(task.taskId)
    const revision = this.store.latestChangeRevision(task.taskId) + 1
    const changeId = randomUUID()
    const files: ChangeFile[] = prepared.map((file, seq) => ({
      seq, path: file.path, action: file.action, baseHash: file.baseHash, newHash: file.newHash,
      added: file.diff.added, removed: file.diff.removed, afterHash: null,
    }))
    const binding = changeBinding({ taskId: task.taskId, changeId, revision, root: link.projectRoot, files })
    const review = buildChangeReview(link.projectRoot, revision, prepared)
    const facts = `${files.length} 个文件（+${review.totalAdded} −${review.totalRemoved}）`
    const now = Date.now()
    const superseded = this.store.listChangeSets(task.taskId).filter(change => change.state === 'pending' || change.state === 'approved')
    const proposal = this.store.transaction(() => {
      for (const old of superseded) {
        this.store.setChangeState(old.changeId, 'superseded', { detail: `被第 ${revision} 版取代，未执行`, from: ['pending', 'approved'] })
        this.store.purgeChangeContents(old.changeId)
      }
      this.store.insertChangeSet({
        changeId, taskId: task.taskId, revision, proposalId: null, root: link.projectRoot, summary: clip(summary, 300),
        digest: digestOf(binding), state: 'pending', operationId: null, detail: null, files, createdAt: now, updatedAt: now,
      }, prepared.map(file => file.content))
      const created = this.options.approvals.proposeTrusted({
        taskId: task.taskId, assistantId: task.ownerId, tool: 'apply_change', target: link.projectRoot, params: binding,
        inputRevision: revision, risk: 'medium',
        summary: `改动第 ${revision} 版：${facts}。助理说明：${clip(summary, 200)}`,
        review: { content: JSON.stringify(review), revision },
      })
      this.store.setChangeProposal(changeId, created.proposalId)
      return created
    })
    for (const old of superseded) if (old.proposalId) this.options.approvals.expire(old.proposalId, `被第 ${revision} 版改动提案取代`)
    this.refresh(task.taskId)
    return {
      ok: true, proposalId: proposal.proposalId, changeId, revision, digest: proposal.paramsDigest, expiresAt: proposal.expiresAt,
      files: review.files.map(file => ({ path: file.path, action: file.action, added: file.added, removed: file.removed, baseHash: file.baseHash, newHash: file.newHash })),
      totalAdded: review.totalAdded, totalRemoved: review.totalRemoved, reviewTruncated: review.truncated,
      supersededRevisions: superseded.map(change => change.revision),
      note: '尚未写入任何文件。用户在桌面审批窗口核对差异并批准后，由可信执行器应用（应用前重读基线哈希，外部改过就冲突暂停、零写入）；'
        + '批准只对这一版生效，改内容必须重新提案。可以用 desktop_team_wait 等待结果。',
    }
  }

  private prepareFile(link: HelpTaskLink, file: ChangeFileInput, index: number, seen: Set<string>): PreparedFile {
    const label = `第 ${index + 1} 个文件`
    if (typeof file?.path !== 'string' || !file.path.trim()) throw new HelpTaskError('BAD_INPUT', `${label}缺少 path`)
    const hasContent = typeof file.content === 'string'
    const hasDiff = typeof file.diff === 'string'
    if (hasContent === hasDiff) throw new HelpTaskError('BAD_INPUT', `${label}必须且只能给 content（整文件替换内容）或 diff（统一 diff）之一`)
    if (typeof file.baseHash !== 'string' || (file.baseHash !== ABSENT_VERSION && !HASH.test(file.baseHash))) {
      throw new HelpTaskError('BAD_INPUT', `${label}的 baseHash 必须是 desktop_team_read_file 返回的 64 位 hash；新建文件写 absent`)
    }
    const target = this.resolveInside(link, file.path, 'file')
    const relative = this.relative(link, target)
    if (seen.has(target)) throw new HelpTaskError('BAD_INPUT', `${relative} 在同一版改动里出现了两次`)
    seen.add(target)
    const snapshot = readSnapshot(target)
    let before = ''
    let action: 'modify' | 'create'
    if (snapshot.version === ABSENT_VERSION) {
      if (file.baseHash !== ABSENT_VERSION) throw new HelpTaskError('BASE_CHANGED', `${relative} 现在不存在；新建文件的 baseHash 写 absent，已有文件请重新读取`)
      if (hasDiff) throw new HelpTaskError('BAD_INPUT', `${relative} 是新建文件，请直接给 content`)
      let parentIsDir = false
      try { parentIsDir = statSync(path.dirname(target)).isDirectory() } catch { /* 不存在 */ }
      if (!parentIsDir) throw new HelpTaskError('BAD_INPUT', `${relative} 的上级目录不存在；本流程不新建目录`)
      action = 'create'
    } else {
      if (!HASH.test(snapshot.version) || snapshot.bytes === null) {
        throw new HelpTaskError('UNSUPPORTED', `${relative} 不是可改动的普通文本文件（${snapshot.version}）`)
      }
      const text = decodeText(snapshot.bytes)
      if (text === null) throw new HelpTaskError('UNSUPPORTED', `${relative} 不是 UTF-8 文本（或含 NUL），不支持改动`)
      if (file.baseHash !== snapshot.version) {
        throw new HelpTaskError('BASE_CHANGED',
          `${relative} 的基线已变化：提交的 baseHash 是 ${short(file.baseHash)}，文件现在是 ${short(snapshot.version)}。请重新读取后再提交`)
      }
      before = text
      action = 'modify'
    }
    let after: string
    if (hasContent) {
      after = file.content!
    } else {
      const applied = applyUnifiedDiff(before, file.diff!)
      if (!applied.ok) throw new HelpTaskError('PATCH_FAILED', `${relative}：${applied.error}`)
      after = applied.text
    }
    if (after.includes('\0')) throw new HelpTaskError('UNSUPPORTED', `${relative} 的新内容含 NUL，不支持`)
    if (Buffer.byteLength(after, 'utf8') > MAX_FILE_BYTES) throw new HelpTaskError('BAD_INPUT', `${relative} 的新内容超过 ${MAX_FILE_BYTES} 字节`)
    if (action === 'modify' && after === before) throw new HelpTaskError('BAD_INPUT', `${relative} 没有任何改动`)
    return {
      path: target, action, baseHash: action === 'create' ? ABSENT_VERSION : snapshot.version,
      newHash: sha256Hex(Buffer.from(after, 'utf8')), content: after, diff: unifiedDiff(before, after),
    }
  }

  // ───────────────────────────── 验证命令提案 ─────────────────────────────

  /**
   * 提交一条验证命令。不运行任何东西：cwd 必须在授权项目内，程序解析成绝对路径（不经 shell、不搜工作目录），
   * 参数是数组，超时与预期副作用说明必填。批准后由可信执行器运行一次。
   */
  proposeVerification(input: { taskId: string; cwd?: string; program: string; args: readonly string[]; timeoutSeconds: number; expectedEffects: string }) {
    const { task, link } = this.requireOpenTask(input.taskId)
    this.requireScope(link)
    const cwd = this.resolveInside(link, typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : link.projectRoot, 'dir')
    let cwdIsDir = false
    try { cwdIsDir = statSync(cwd).isDirectory() } catch { /* 不存在 */ }
    if (!cwdIsDir) throw new HelpTaskError('BAD_INPUT', `工作目录 ${cwd} 不存在或不是目录`)
    if (!Array.isArray(input.args) || input.args.length > MAX_ARGS
      || input.args.some(arg => typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0'))) {
      throw new HelpTaskError('BAD_INPUT', `args 必须是字符串数组（最多 ${MAX_ARGS} 项、每项不超过 ${MAX_ARG_LENGTH} 字符、不含 NUL）；不要把整条命令拼成一个字符串`)
    }
    const timeoutSeconds = Number(input.timeoutSeconds)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new HelpTaskError('BAD_INPUT', `timeoutSeconds 必须是 1 到 ${MAX_TIMEOUT_SECONDS} 之间的整数`)
    }
    const expectedEffects = typeof input.expectedEffects === 'string' ? input.expectedEffects.trim() : ''
    if (!expectedEffects || expectedEffects.length > 500) {
      throw new HelpTaskError('BAD_INPUT', 'expectedEffects 必填（不超过 500 字）：说明这条命令预计会产生哪些副作用，例如「只运行测试，不改源文件」')
    }
    const env = this.options.env ?? process.env
    const resolved = resolveProgram(input.program, cwd, env.PATH ?? env.Path)
    if (!resolved.ok) throw new HelpTaskError('BAD_PROGRAM', resolved.error)
    const args = [...input.args]
    this.syncExpired(task.taskId)
    const applied = this.latestApplied(task.taskId)
    const verificationId = randomUUID()
    const sequence = this.store.listVerifications(task.taskId).length + 1
    const record: VerificationRecord = {
      verificationId, taskId: task.taskId, proposalId: null, cwd, program: resolved.path, args, timeoutMs: timeoutSeconds * 1000,
      expectedEffects, digest: '', afterChangeId: applied?.changeId ?? null, state: 'pending', exitCode: null, signal: null,
      durationMs: null, stdout: null, stderr: null, stdoutTruncated: false, stderrTruncated: false, fileResults: null,
      operationId: null, detail: null, createdAt: Date.now(), startedAt: null, endedAt: null,
    }
    const binding = verificationBinding(record)
    const review = {
      format: 'dsh-verification-review@1', root: link.projectRoot, cwd, cwdRelative: this.relative(link, cwd) || '.',
      program: resolved.path, requested: input.program, args, timeoutMs: record.timeoutMs, expectedEffects, env: ENV_POLICY_TEXT,
      afterChange: applied ? { changeId: applied.changeId, revision: applied.revision, files: applied.files.map(file => this.relative(link, file.path)) } : null,
      notes: [
        '程序与参数按数组原样传给系统，不经过 shell；批准后只运行这一次',
        ...(link.currentFile !== null ? ['本次帮助只授权了单个文件；这条命令运行的项目代码可能读取授权文件之外的内容'] : []),
      ],
    }
    const superseded = this.store.listVerifications(task.taskId).filter(item => item.state === 'pending' || item.state === 'approved')
    const proposal = this.store.transaction(() => {
      for (const old of superseded) this.store.setVerificationState(old.verificationId, 'superseded', { detail: '被新的验证命令取代，未运行', from: ['pending', 'approved'] })
      this.store.insertVerification({ ...record, digest: digestOf(binding) })
      const created = this.options.approvals.proposeTrusted({
        taskId: task.taskId, assistantId: task.ownerId, tool: 'run_verification', target: displayCommand(resolved.path, args),
        params: binding, inputRevision: sequence, risk: 'high',
        summary: `在 ${review.cwdRelative} 运行验证命令（超时 ${timeoutSeconds} 秒）。预期副作用：${clip(expectedEffects, 160)}`,
        review: { content: JSON.stringify(review), revision: sequence },
      })
      this.store.setVerificationProposal(verificationId, created.proposalId)
      return created
    })
    for (const old of superseded) if (old.proposalId) this.options.approvals.expire(old.proposalId, '被新的验证命令取代')
    this.refresh(task.taskId)
    return {
      ok: true, proposalId: proposal.proposalId, verificationId, program: resolved.path, args, cwd, timeoutMs: record.timeoutMs,
      afterChange: applied ? { changeId: applied.changeId, revision: applied.revision } : null, expiresAt: proposal.expiresAt,
      note: '尚未运行。用户在桌面审批窗口批准后由可信执行器运行一次，真实退出码与截断输出写进账本；退出码不是 0 就不能说修复完成。',
    }
  }

  // ───────────────────────────── unknown 人工复核 ─────────────────────────────

  /**
   * 为一条结果不明（unknown）的操作申请人工复核。结论（已核实成功 / 已核实失败 / 放弃）绑在提案里，
   * 只有用户在桌面审批窗口批准后才写进账本；调用本身不改任何账目，模型自报无效。
   */
  proposeReview(input: { operationId: string; resolution: string; note?: string }) {
    this.requireActive()
    const operation = typeof input.operationId === 'string' ? this.store.getOperation(input.operationId) : null
    if (!operation || !this.getTask(operation.taskId)) throw new HelpTaskError('NOT_FOUND', `账本里没有当前团队的操作 ${input.operationId}`)
    if (operation.state !== 'unknown') throw new HelpTaskError('BAD_INPUT', `操作 ${operation.operationId} 当前是 ${operation.state}，只有结果不明的操作需要人工复核`)
    if (!(REVIEW_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
      throw new HelpTaskError('BAD_INPUT', `resolution 只能是 ${REVIEW_RESOLUTIONS.join(' / ')}`)
    }
    const resolution = input.resolution as ReviewResolution
    const note = typeof input.note === 'string' ? clip(input.note.trim(), 500) : ''
    const task = this.getTask(operation.taskId)
    if (!task) throw new HelpTaskError('NOT_FOUND', `操作所属的任务 ${operation.taskId} 不存在`)
    this.syncExpired(operation.taskId)
    const reviewId = randomUUID()
    const snapshotDigest = digestOf(operationSnapshot(operation))
    const binding = reviewBinding({ reviewId, operationId: operation.operationId, resolution, note, snapshotDigest })
    const previous = this.store.listReviews(operation.operationId).filter(item => item.state === 'pending')
    const content = {
      format: 'dsh-unknown-review@1',
      operation: {
        operationId: operation.operationId, kind: operation.kind, target: operation.target ?? null, startedAt: operation.startedAt,
        executedAt: operation.executedAt ?? null, endedAt: operation.endedAt, detail: operation.resultDetail ?? null,
      },
      resolution, resolutionLabel: RESOLUTION_LABEL[resolution], note,
      effect: '只改写账本里这一项操作的结论，不执行任何命令、不改动任何文件；请先自己核对真实外部状态再批准',
    }
    const proposal = this.store.transaction(() => {
      for (const old of previous) this.store.setReviewState(old.reviewId, 'superseded', '被新的复核申请取代', null)
      this.store.insertReview({
        reviewId, operationId: operation.operationId, taskId: operation.taskId, proposalId: null, resolution, note,
        snapshotDigest, state: 'pending', detail: null, createdAt: Date.now(), decidedAt: null,
      })
      const created = this.options.approvals.proposeTrusted({
        taskId: operation.taskId, assistantId: task.ownerId, tool: 'review_unknown', target: `operation:${operation.operationId}`,
        params: binding, inputRevision: this.store.listReviews(operation.operationId).length, risk: 'medium',
        summary: `把结果不明的 ${operation.kind}（${clip(operation.target ?? '无目标', 120)}）标记为「${RESOLUTION_LABEL[resolution]}」${note ? `：${clip(note, 120)}` : ''}`,
        review: { content: JSON.stringify(content), revision: 1 },
      })
      this.store.setReviewProposal(reviewId, created.proposalId)
      return created
    })
    for (const old of previous) if (old.proposalId) this.options.approvals.expire(old.proposalId, '被新的复核申请取代')
    return {
      ok: true, proposalId: proposal.proposalId, reviewId, operationId: operation.operationId, resolution,
      note: '尚未改动账本。只有用户在桌面审批窗口批准后，这条结论才会写进账本；不要对用户说已核实。',
    }
  }

  // ───────────────────────────── 等待、状态与结论 ─────────────────────────────

  /**
   * 等用户对一张执行器审批卡做决定，批准时再等执行器跑完。放弃等待不作废审批卡：
   * 批准后照样由执行器执行，结果以账本为准。
   */
  async wait(proposalId: string, signal: AbortSignal, timeoutMs: number) {
    this.requireActive()
    const proposal = this.options.approvals.proposal(proposalId)
    if (!proposal || !isTrustedActionTool(proposal.tool) || !this.getTask(proposal.taskId)) throw new HelpTaskError('NOT_FOUND', `${proposalId} 不是当前团队的改动、验证或复核审批卡`)
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
    const bounded = AbortSignal.any([signal, timeout])
    const decision = await this.options.approvals.waitForDecision(proposalId, bounded, { abandonOnAbort: false })
    this.requireActive()
    if (decision !== 'approved') {
      return { proposalId, tool: proposal.tool, decision: decision === 'aborted' ? 'still-pending' : decision, outcome: null, ...this.describe(proposal) }
    }
    const pendingOutcome = this.outcomeFor(proposalId)
    const outcome = await Promise.race([
      pendingOutcome,
      new Promise<null>(resolve => {
        if (bounded.aborted) return resolve(null)
        bounded.addEventListener('abort', () => resolve(null), { once: true })
      }),
    ])
    return { proposalId, tool: proposal.tool, decision: outcome ? 'executed' : 'approved-executing', outcome, ...this.describe(proposal) }
  }

  private describe(proposal: ActionProposal) {
    this.requireActive()
    const status = this.status(proposal.taskId)
    return { verdict: status?.verdict ?? null, taskStatus: this.getTask(proposal.taskId)?.status ?? null }
  }

  /** 由账本推出的结论；模型的任何说法都不参与。 */
  verdict(taskId: string): HelpVerdict {
    this.requireActive()
    if (!this.getTask(taskId)) throw new HelpTaskError('NOT_FOUND', `${taskId} 不是当前团队的任务`)
    const base = { changeId: null, revision: null, verificationId: null, exitCode: null }
    const unknown = this.store.listOperations(taskId).filter(operation => operation.state === 'unknown')
    if (unknown.length > 0) {
      return { ...base, state: 'unknown', mayClaimFixed: false, text: `有 ${unknown.length} 项操作结果不明，需要用户人工复核；在此之前不能说修复完成` }
    }
    const changes = this.store.listChangeSets(taskId)
    const applied = changes.find(change => change.state === 'applied')
    if (!applied) {
      const latest = changes[0]
      if (latest?.state === 'conflict') {
        return { ...base, state: 'conflict', mayClaimFixed: false, changeId: latest.changeId, revision: latest.revision,
          text: `第 ${latest.revision} 版改动在应用前发现文件已被修改，已冲突暂停，没有写入任何文件；需要重新读取后提交新一版` }
      }
      return { ...base, state: 'no-change', mayClaimFixed: false, text: '还没有应用任何改动' }
    }
    const done: VerificationState[] = ['passed', 'failed', 'timed-out', 'error', 'unknown', 'reviewed']
    const last = this.store.listVerifications(taskId).find(item => item.afterChangeId === applied.changeId && done.includes(item.state))
    const at = { changeId: applied.changeId, revision: applied.revision }
    if (!last) {
      return { ...base, ...at, state: 'applied-unverified', mayClaimFixed: false,
        text: `第 ${applied.revision} 版改动已应用，尚未运行验证命令；不能说修复完成` }
    }
    if (last.state === 'passed') {
      return { ...base, ...at, state: 'verified', mayClaimFixed: true, verificationId: last.verificationId, exitCode: last.exitCode,
        text: `第 ${applied.revision} 版改动已应用，验证命令真实退出码 0，验证通过` }
    }
    const why = last.state === 'timed-out' ? `超时（${Math.round(last.timeoutMs / 1000)} 秒）被终止`
      : last.state === 'error' ? `未能启动（${last.detail ?? '未知原因'}）`
        : last.state === 'reviewed' ? '运行结果经人工复核，没有真实退出码'
          : `退出码 ${last.exitCode ?? '无'}${last.signal ? `（信号 ${last.signal}）` : ''}`
    return { ...base, ...at, state: 'verification-failed', mayClaimFixed: false, verificationId: last.verificationId, exitCode: last.exitCode,
      text: `第 ${applied.revision} 版改动已应用，但验证未通过：${why}；不能说修复完成` }
  }

  /** 帮助任务的完整可追溯视图：episode / 授权 / 每版改动 / 每次验证 / 结论。 */
  status(taskId: string) {
    this.requireActive()
    const task = this.getTask(taskId)
    const link = task ? this.store.getHelpTask(taskId) : null
    if (!link || !task) return null
    this.syncExpired(taskId)
    const relative = (file: string) => this.relative(link, file)
    return {
      taskId, status: task.status, goal: task.goal, projectRoot: link.projectRoot, currentFile: link.currentFile,
      helpContextId: link.helpContextId, episodeId: link.episodeId,
      verdict: this.verdict(taskId),
      changes: this.store.listChangeSets(taskId).map(change => ({
        changeId: change.changeId, revision: change.revision, state: change.state, detail: change.detail, proposalId: change.proposalId,
        operationId: change.operationId, summary: change.summary,
        files: change.files.map(file => ({ path: relative(file.path), action: file.action, added: file.added, removed: file.removed,
          baseHash: file.baseHash, newHash: file.newHash, afterHash: file.afterHash })),
      })),
      verifications: this.store.listVerifications(taskId).map(item => ({
        verificationId: item.verificationId, state: item.state, cwd: item.cwd, program: item.program, args: item.args,
        timeoutMs: item.timeoutMs, afterChangeId: item.afterChangeId, exitCode: item.exitCode, signal: item.signal,
        durationMs: item.durationMs, detail: item.detail, proposalId: item.proposalId, operationId: item.operationId,
        stdoutTail: item.stdout === null ? null : item.stdout.slice(-1500), stderrTail: item.stderr === null ? null : item.stderr.slice(-1500),
      })),
    }
  }

  // ───────────────────────────── 可信执行器 ─────────────────────────────

  /**
   * 执行一张已批准的执行器审批卡（批准签发后由决定回调调度；测试可直接调用）。
   * 每一步都重新核验，任何一项不符都拒绝且不写文件、不运行命令。
   */
  execute(proposalId: string): Promise<ExecutionOutcome> {
    if (this.disposed) return Promise.resolve({ proposalId, tool: 'apply_change', state: 'refused', detail: '帮助任务服务已经停止，未执行', operationId: null })
    const proposal = this.options.approvals.proposal(proposalId)
    if (!proposal || !isTrustedActionTool(proposal.tool) || !this.getTask(proposal.taskId)) {
      return Promise.resolve({ proposalId, tool: 'apply_change', state: 'refused', detail: `${proposalId} 不是当前团队的执行器审批卡`, operationId: null })
    }
    const tool = proposal.tool
    const body = (): Promise<ExecutionOutcome> => {
      if (tool === 'apply_change') return Promise.resolve(this.applyChange(proposal))
      if (tool === 'run_verification') return this.runVerification(proposal)
      return Promise.resolve(this.applyReview(proposal))
    }
    const serialized = this.serialize(proposal.taskId, async () => {
      try {
        if (this.disposed || !this.getTask(proposal.taskId)) {
          return { proposalId, tool, state: 'refused', detail: '帮助任务服务已停止或任务不属于当前团队，未执行', operationId: null } satisfies ExecutionOutcome
        }
        return await body()
      } catch (error) {
        this.options.logger.warn('可信执行器异常', { proposalId, error: messageOf(error) })
        return { proposalId, tool, state: 'error', detail: messageOf(error), operationId: null } satisfies ExecutionOutcome
      }
    })
    return serialized.then(outcome => {
      // 串行链上这一步结束：按账本落定任务状态（同一任务还有排队的动作时保持执行中），再交出结果。
      if (!this.isBusy(proposal.taskId) && !this.disposed) this.safeRefresh(proposal.taskId)
      this.outcomeHolder(proposalId).resolve(outcome)
      this.pruneOutcomes()
      return outcome
    })
  }

  private safeRefresh(taskId: string): void {
    try {
      if (this.store.getHelpTask(taskId)) this.refresh(taskId)
      else this.reopenAfterReview(taskId)
    } catch (error) {
      this.options.logger.warn('刷新帮助任务状态失败', { taskId, error: messageOf(error) })
    }
  }

  /** 已出结果的等待记录只留最近 200 条。 */
  private pruneOutcomes(): void {
    if (this.outcomes.size <= 200) return
    for (const key of [...this.outcomes.keys()].slice(0, this.outcomes.size - 200)) this.outcomes.delete(key)
  }

  private onDecision(proposal: ActionProposal, decision: TrustedDecision): void {
    if (this.disposed) return
    try {
      if (!this.getTask(proposal.taskId)) return
      if (decision === 'approved') {
        this.markApproved(proposal)
        this.outcomeHolder(proposal.proposalId)
        const schedule = this.options.schedule ?? ((run: () => void) => run())
        schedule(() => { if (!this.disposed) void this.execute(proposal.proposalId) })
        return
      }
      this.markRejected(proposal)
    } catch (error) {
      this.options.logger.warn('处理执行器审批决定失败', { proposalId: proposal.proposalId, error: messageOf(error) })
    }
  }

  private markApproved(proposal: ActionProposal): void {
    if (proposal.tool === 'apply_change') {
      const change = this.store.changeSetByProposal(proposal.proposalId)
      if (change) this.store.setChangeState(change.changeId, 'approved', { from: ['pending'] })
    } else if (proposal.tool === 'run_verification') {
      const record = this.store.verificationByProposal(proposal.proposalId)
      if (record) this.store.setVerificationState(record.verificationId, 'approved', { from: ['pending'] })
    }
  }

  /** 驳回：零改动。改动内容随之清除，任务回到等用户。 */
  private markRejected(proposal: ActionProposal): void {
    let detail = '用户在审批窗口驳回，未执行'
    if (proposal.tool === 'apply_change') {
      const change = this.store.changeSetByProposal(proposal.proposalId)
      if (change && this.store.setChangeState(change.changeId, 'rejected', { detail, from: ['pending', 'approved'] })) {
        this.store.purgeChangeContents(change.changeId)
      }
    } else if (proposal.tool === 'run_verification') {
      const record = this.store.verificationByProposal(proposal.proposalId)
      if (record) this.store.setVerificationState(record.verificationId, 'rejected', { detail, from: ['pending', 'approved'] })
    } else {
      const review = this.store.reviewByProposal(proposal.proposalId)
      if (review) this.store.setReviewState(review.reviewId, 'rejected', detail, Date.now())
      detail = '用户驳回了这条复核结论，账本未改'
    }
    this.outcomeHolder(proposal.proposalId).resolve({ proposalId: proposal.proposalId, tool: proposal.tool as TrustedActionTool, state: 'rejected', detail, operationId: null })
    if (this.store.getHelpTask(proposal.taskId)) this.refresh(proposal.taskId)
  }

  /** 应用一版已批准的改动。 */
  private applyChange(proposal: ActionProposal): ExecutionOutcome {
    const result = (state: string, detail: string, operationId: string | null = null): ExecutionOutcome =>
      ({ proposalId: proposal.proposalId, tool: 'apply_change', state, detail, operationId })
    const change = this.store.changeSetByProposal(proposal.proposalId)
    if (!change) return result('refused', '找不到这张审批卡对应的改动提案，未执行')
    const link = this.store.getHelpTask(change.taskId)
    if (!link) return result('refused', '改动不属于帮助任务，未执行')
    if (change.state !== 'approved') return result(change.state, `改动当前是 ${change.state}，不执行（${change.detail ?? '可能已被新修订取代或已处理'}）`)
    if (this.store.latestChangeRevision(change.taskId) !== change.revision) {
      this.store.setChangeState(change.changeId, 'superseded', { detail: '已有更新的修订，未执行', from: ['approved'] })
      this.store.purgeChangeContents(change.changeId)
      return result('superseded', '已有更新的修订，这一版不再执行')
    }
    const binding = changeBinding(change)
    let operation: OperationRecord
    try {
      operation = this.options.approvals.consumeTrusted(proposal.proposalId, {
        tool: 'apply_change', taskId: change.taskId, target: change.root, params: binding, inputRevision: change.revision,
        blockOnUncertain: true,
      })
    } catch (error) {
      const expired = error instanceof ApprovalError && error.code === 'EXPIRED'
      const detail = `批准不可用，未写入任何文件：${error instanceof ApprovalError ? `${error.code}：` : ''}${messageOf(error)}`
      this.store.setChangeState(change.changeId, expired ? 'expired' : 'failed', { detail, from: ['approved'] })
      this.store.purgeChangeContents(change.changeId)
      return result(expired ? 'expired' : 'failed', detail)
    }
    this.store.setChangeState(change.changeId, 'applying', { operationId: operation.operationId, from: ['approved'] })
    this.setTaskStatus(change.taskId, 'running')
    const finish = (opState: OperationState, changeState: ChangeSet['state'], detail: string, evidence: unknown) => {
      this.store.transaction(() => {
        this.store.setOperationEvidence(operation.operationId, evidence)
        this.options.approvals.settle(operation.operationId, opState, digestOf(evidence), detail)
        this.store.setChangeState(change.changeId, changeState, { detail, from: ['applying'] })
        this.store.purgeChangeContents(change.changeId)
      })
      return result(changeState, detail, operation.operationId)
    }
    if (!this.options.approvals.markRunning(operation.operationId)) {
      return finish('failed', 'failed', '执行账本已不在待执行状态，未写入任何文件', { kind: 'apply_change', outcome: 'refused' })
    }
    const scopeError = this.scopeError(link)
    if (scopeError) return finish('failed', 'failed', `${scopeError}，未写入任何文件`, { kind: 'apply_change', outcome: 'refused', reason: scopeError })
    const contents = this.store.changeContents(change.changeId)
    const files = change.files.map(file => ({ path: file.path, baseHash: file.baseHash, newHash: file.newHash, content: contents.get(file.seq) ?? null }))
    if (files.some(file => file.content === null)) {
      return finish('failed', 'failed', '保存的新内容已被清除，未写入任何文件', { kind: 'apply_change', outcome: 'refused' })
    }
    // 路径链在批准之后被换成符号链接：真实落点已不是批准时那个位置，按冲突处理。
    const moved = change.files.filter(file => {
      try { return canonicalPath(file.path, link.projectRoot) !== file.path || !isWithinRoot(link.projectRoot, file.path) } catch { return true }
    })
    if (moved.length > 0) {
      const detail = `冲突暂停：${moved.map(file => this.relative(link, file.path)).join('、')} 的真实位置在批准后发生变化（符号链接被替换），未写入任何文件`
      return finish('failed', 'conflict', detail, { kind: 'apply_change', outcome: 'conflict', conflicts: moved.map(file => ({ path: file.path, expected: 'same-real-path', actual: 'moved' })) })
    }
    let commit
    try {
      commit = commitFiles(files.map(file => ({ ...file, content: file.content! })), this.options.commitHooks)
    } catch (error) {
      // 走到这里说明提交过程本身抛出了预料外的错误：可能已改名了一部分，不能声称没执行。
      return finish('unknown', 'unknown', `应用过程异常，部分文件可能已改动，需要人工复核：${messageOf(error)}`, { kind: 'apply_change', outcome: 'exception' })
    }
    const label = (file: string) => this.relative(link, file)
    if (commit.kind === 'applied') {
      for (const file of change.files) {
        const after = commit.files.find(item => item.path === file.path)?.afterHash ?? null
        this.store.setChangeFileAfter(change.changeId, file.seq, after)
      }
      const added = change.files.reduce((sum, file) => sum + file.added, 0)
      const removed = change.files.reduce((sum, file) => sum + file.removed, 0)
      const evidence = { kind: 'apply_change', outcome: 'applied', changeId: change.changeId, revision: change.revision,
        files: commit.files.map(file => ({ path: label(file.path), beforeHash: file.beforeHash, afterHash: file.afterHash })) }
      return finish('succeeded', 'applied', `已应用第 ${change.revision} 版改动：${change.files.length} 个文件（+${added} −${removed}）`, evidence)
    }
    if (commit.kind === 'conflict') {
      const detail = `冲突暂停：${commit.conflicts.map(item => `${label(item.path)}（批准时 ${short(item.expected)}，现在 ${short(item.actual)}）`).join('、')} 在批准后被修改，未写入任何文件`
      return finish('failed', 'conflict', detail, { kind: 'apply_change', outcome: 'conflict',
        conflicts: commit.conflicts.map(item => ({ path: label(item.path), expected: item.expected, actual: item.actual })) })
    }
    if (commit.kind === 'failed') {
      return finish('failed', 'failed', commit.error, { kind: 'apply_change', outcome: 'failed', wroteTargets: commit.wroteTargets })
    }
    return finish('unknown', 'unknown', `${commit.error}；需要人工复核`, { kind: 'apply_change', outcome: 'unknown',
      files: commit.files.map(file => ({ path: label(file.path), state: file.state })) })
  }

  /** 运行一条已批准的验证命令。 */
  private async runVerification(proposal: ActionProposal): Promise<ExecutionOutcome> {
    const result = (state: string, detail: string, operationId: string | null = null): ExecutionOutcome =>
      ({ proposalId: proposal.proposalId, tool: 'run_verification', state, detail, operationId })
    const record = this.store.verificationByProposal(proposal.proposalId)
    if (!record) return result('refused', '找不到这张审批卡对应的验证命令，未运行')
    const link = this.store.getHelpTask(record.taskId)
    if (!link) return result('refused', '验证命令不属于帮助任务，未运行')
    if (record.state !== 'approved') return result(record.state, `验证命令当前是 ${record.state}，不运行`)
    if ((this.latestApplied(record.taskId)?.changeId ?? null) !== record.afterChangeId) {
      this.store.setVerificationState(record.verificationId, 'superseded', { detail: '提案后又应用了新的改动，这条验证针对的已不是最新状态，未运行', from: ['approved'] })
      return result('superseded', '提案后又应用了新的改动，这条验证不再运行；请针对最新改动重新提案')
    }
    let operation: OperationRecord
    try {
      operation = this.options.approvals.consumeTrusted(proposal.proposalId, {
        tool: 'run_verification', taskId: record.taskId, target: proposal.target, params: verificationBinding(record),
        inputRevision: proposal.inputRevision, blockOnUncertain: true,
      })
    } catch (error) {
      const expired = error instanceof ApprovalError && error.code === 'EXPIRED'
      const detail = `批准不可用，未运行：${error instanceof ApprovalError ? `${error.code}：` : ''}${messageOf(error)}`
      this.store.setVerificationState(record.verificationId, expired ? 'expired' : 'error', { detail, from: ['approved'] })
      return result(expired ? 'expired' : 'error', detail)
    }
    const startedAt = Date.now()
    this.store.setVerificationState(record.verificationId, 'running', { operationId: operation.operationId, startedAt, from: ['approved'] })
    this.setTaskStatus(record.taskId, 'running')
    const refuse = (detail: string) => {
      const evidence = { kind: 'run_verification', outcome: 'refused', reason: detail }
      this.store.transaction(() => {
        this.store.setOperationEvidence(operation.operationId, evidence)
        this.options.approvals.settle(operation.operationId, 'failed', digestOf(evidence), `${detail}，未运行`)
        this.store.finishVerification(record.verificationId, 'error', { exitCode: null, signal: null, durationMs: null, stdout: '', stderr: '',
          stdoutTruncated: false, stderrTruncated: false, fileResults: null, detail: `${detail}，未运行` })
      })
      return result('error', `${detail}，未运行`, operation.operationId)
    }
    if (!this.options.approvals.markRunning(operation.operationId)) return refuse('执行账本已不在待执行状态')
    const scopeError = this.scopeError(link)
    if (scopeError) return refuse(scopeError)
    let cwdNow: string | null = null
    try { cwdNow = canonicalPath(record.cwd, link.projectRoot) } catch { cwdNow = null }
    if (cwdNow !== record.cwd || !isRootOrWithin(link.projectRoot, record.cwd)) return refuse('工作目录的真实位置在批准后发生变化')
    const env = this.options.env ?? process.env
    const program = resolveProgram(record.program, record.cwd, env.PATH ?? env.Path)
    if (!program.ok || program.path !== record.program) return refuse(`程序 ${record.program} 在批准后已无法按原路径解析`)
    const controller = new AbortController()
    this.aborts.set(record.taskId, controller)
    const before = snapshotTree(link.projectRoot)
    let run: CommandResult
    try {
      run = await runCommand({ program: record.program, args: record.args, cwd: record.cwd, timeoutMs: record.timeoutMs, env: buildVerificationEnv(env) }, controller.signal)
    } finally {
      if (this.aborts.get(record.taskId) === controller) this.aborts.delete(record.taskId)
    }
    const after = snapshotTree(link.projectRoot)
    const applied = record.afterChangeId ? this.store.getChangeSet(record.afterChangeId) : null
    const fileResults = {
      ...diffTrees(before, after),
      appliedFiles: (applied?.files ?? []).map(file => {
        const now = readSnapshot(file.path).version
        return { path: this.relative(link, file.path), expected: file.afterHash, actual: now, unchanged: now === file.afterHash }
      }),
    }
    const seconds = Math.round(record.timeoutMs / 1000)
    let state: VerificationState
    let opState: OperationState
    let detail: string
    switch (run.outcome) {
      case 'exited':
        if (run.exitCode === 0) { state = 'passed'; opState = 'succeeded'; detail = '验证通过：命令已运行，退出码 0' } else {
          state = 'failed'; opState = 'failed'
          detail = run.exitCode === null ? `命令被信号 ${run.signal ?? '未知'} 终止，验证未通过` : `命令已运行，退出码 ${run.exitCode}，验证未通过`
        }
        break
      case 'timed-out':
        state = 'timed-out'; opState = 'failed'; detail = `命令超过 ${seconds} 秒被终止（已结束整棵进程树），验证未通过`
        break
      case 'cancelled':
        state = 'failed'; opState = 'failed'; detail = '任务被取消，命令已被终止，验证未完成'
        break
      case 'spawn-error':
        state = 'error'; opState = 'failed'; detail = `命令未能启动（${run.error ?? '未知错误'}），未执行`
        break
      default:
        state = 'unknown'; opState = 'unknown'; detail = `${run.error ?? '未能确认命令是否已结束'}；结果不明，需要人工复核`
    }
    const evidence = {
      kind: 'run_verification', outcome: run.outcome, verdict: state, verificationId: record.verificationId,
      exitCode: run.exitCode, signal: run.signal, timedOut: run.outcome === 'timed-out', durationMs: run.durationMs,
      stdout: run.stdout, stderr: run.stderr, stdoutBytes: run.stdoutBytes, stderrBytes: run.stderrBytes,
      stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated, fileResults,
    }
    this.store.transaction(() => {
      this.store.setOperationEvidence(operation.operationId, evidence)
      this.options.approvals.settle(operation.operationId, opState, digestOf(evidence), detail)
      this.store.finishVerification(record.verificationId, state, {
        exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs, stdout: run.stdout, stderr: run.stderr,
        stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated, fileResults, detail,
      })
    })
    return result(state, detail, operation.operationId)
  }

  /** 写入一条已批准的人工复核结论。 */
  private applyReview(proposal: ActionProposal): ExecutionOutcome {
    const result = (state: string, detail: string, operationId: string | null = null): ExecutionOutcome =>
      ({ proposalId: proposal.proposalId, tool: 'review_unknown', state, detail, operationId })
    const review = this.store.reviewByProposal(proposal.proposalId)
    if (!review) return result('refused', '找不到这张审批卡对应的复核申请')
    if (review.state !== 'pending') return result(review.state, `复核申请当前是 ${review.state}，不再写入`)
    let reviewOperation: OperationRecord
    try {
      reviewOperation = this.options.approvals.consumeTrusted(proposal.proposalId, {
        tool: 'review_unknown', taskId: review.taskId, target: `operation:${review.operationId}`, params: reviewBinding(review),
        inputRevision: proposal.inputRevision, blockOnUncertain: false,
      })
    } catch (error) {
      const detail = `批准不可用，账本未改：${messageOf(error)}`
      this.store.setReviewState(review.reviewId, error instanceof ApprovalError && error.code === 'EXPIRED' ? 'expired' : 'refused', detail, Date.now())
      return result('refused', detail)
    }
    this.options.approvals.markRunning(reviewOperation.operationId)
    const target = this.store.getOperation(review.operationId)
    const label = RESOLUTION_LABEL[review.resolution]
    if (!target || target.state !== 'unknown' || digestOf(operationSnapshot(target)) !== review.snapshotDigest) {
      const detail = '被复核的操作在申请之后已经变化（可能已有结论），这条复核没有写入'
      this.store.transaction(() => {
        this.options.approvals.settle(reviewOperation.operationId, 'failed', null, detail)
        this.store.setReviewState(review.reviewId, 'refused', detail, Date.now())
      })
      return result('refused', detail, reviewOperation.operationId)
    }
    const decidedAt = Date.now()
    const newState = RESOLUTION_STATE[review.resolution]
    const detail = `人工复核：${label}${review.note ? `——${review.note}` : ''}（原说明：${target.resultDetail ?? '无'}）`
    try {
      this.store.transaction(() => {
        if (!this.store.reviewOperation(target.operationId, newState, {
          reviewId: review.reviewId, proposalId: proposal.proposalId, resolution: review.resolution, note: review.note, decidedAt,
          previousDetail: target.resultDetail ?? null,
        }, detail)) {
          throw new HelpTaskError('CONFLICT', '被复核的操作已不是结果不明')
        }
        this.store.appendEvent('operation/updated',
          { operationId: target.operationId, state: newState, kind: target.kind, target: target.target ?? null, review: review.resolution },
          { taskId: target.taskId, assistantId: target.assistantId ?? null })
        // 关联的改动与验证随之更新；人工复核过的验证永远不算「验证通过」，没有真实退出码就要重新跑。
        const change = this.store.listChangeSets(target.taskId).find(item => item.operationId === target.operationId)
        if (change && change.state === 'unknown') {
          this.store.setChangeState(change.changeId, review.resolution === 'verified-succeeded' ? 'applied' : review.resolution === 'verified-failed' ? 'failed' : 'abandoned',
            { detail: `人工复核：${label}`, from: ['unknown'] })
        }
        const verification = this.store.listVerifications(target.taskId).find(item => item.operationId === target.operationId)
        if (verification && verification.state === 'unknown') {
          this.store.setVerificationState(verification.verificationId, 'reviewed', { detail: `人工复核：${label}（没有真实退出码，不算验证通过）`, from: ['unknown'] })
        }
        const evidence = { kind: 'review_unknown', operationId: target.operationId, resolution: review.resolution, note: review.note, decidedAt }
        this.store.setOperationEvidence(reviewOperation.operationId, evidence)
        this.options.approvals.settle(reviewOperation.operationId, 'succeeded', digestOf(evidence), `已写入人工复核结论：${label}`)
        this.store.setReviewState(review.reviewId, 'applied', `已写入：${label}`, decidedAt)
      })
    } catch (error) {
      // 整个写入已回滚：复核动作本身记 failed（账本没改），不留下一条悬空的执行中记录。
      const why = `复核结论没有写入：${messageOf(error)}`
      this.store.transaction(() => {
        this.options.approvals.settle(reviewOperation.operationId, 'failed', null, why)
        this.store.setReviewState(review.reviewId, 'refused', why, Date.now())
      })
      return result('refused', why, reviewOperation.operationId)
    }
    return result('applied', `已写入人工复核结论：${label}`, reviewOperation.operationId)
  }

  /** 普通团队任务的 unknown 都复核完之后回到「等复核」，不自动判成完成。 */
  private reopenAfterReview(taskId: string): void {
    const task = this.getTask(taskId)
    if (!task || task.status !== 'unknown') return
    if (this.store.listOperations(taskId).some(item => ['planned', 'running', 'unknown'].includes(item.state))) return
    this.setTaskStatus(taskId, 'review')
  }

  // ───────────────────────────── 对账、取消与释放 ─────────────────────────────

  /**
   * 进程重启后的对账（由 TeamService.recoverInterruptedTasks 在它的事务里调用）：
   * 应用中的改动、运行中的验证一律记 unknown（操作本身由团队对账记 unknown）；
   * 旧代次签发、尚未执行的批准再也消费不了，对应改动 / 验证记 expired。
   */
  recover(taskId: string): void {
    if (!this.getTask(taskId)) return
    this.syncExpired(taskId)
    // 批准签发时执行器不在（团队正在卸载）：提案已批准、记录却还停在 pending，同样没执行过。
    const approvedButIdle = (proposalId: string | null) => proposalId !== null && this.store.getProposal(proposalId)?.state === 'approved'
    for (const change of this.store.listChangeSets(taskId)) {
      if (change.state === 'applying') this.store.setChangeState(change.changeId, 'unknown', { detail: '进程在应用中途中断，文件可能已部分改动，需要人工复核', from: ['applying'] })
      else if (change.state === 'approved' || (change.state === 'pending' && approvedButIdle(change.proposalId))) {
        this.store.setChangeState(change.changeId, 'expired', { detail: '批准后执行器未在运行（进程重启或团队卸载），未执行；需要重新提案', from: ['approved', 'pending'] })
        this.store.purgeChangeContents(change.changeId)
      }
    }
    for (const record of this.store.listVerifications(taskId)) {
      if (record.state === 'running') this.store.setVerificationState(record.verificationId, 'unknown', { detail: '进程在验证命令运行中途中断，结果不明，需要人工复核', from: ['running'] })
      else if (record.state === 'approved' || (record.state === 'pending' && approvedButIdle(record.proposalId))) {
        this.store.setVerificationState(record.verificationId, 'expired', { detail: '批准后执行器未在运行（进程重启或团队卸载），未运行；需要重新提案', from: ['approved', 'pending'] })
      }
    }
    for (const review of this.store.listReviewsForTask(taskId)) {
      if (review.state === 'pending' && approvedButIdle(review.proposalId)) {
        this.store.setReviewState(review.reviewId, 'expired', '批准后执行器未在运行，账本未改；需要重新申请', null)
      }
    }
  }

  /** 取消帮助任务：作废待批的执行器审批卡、终止正在跑的验证命令，等在途执行收尾。 */
  async cancel(taskId: string): Promise<void> {
    if (!this.getTask(taskId)) return
    this.aborts.get(taskId)?.abort()
    for (const proposal of this.options.approvals.proposalsForTask(taskId)) {
      if (proposal.state === 'pending' && isTrustedActionTool(proposal.tool)) this.options.approvals.expire(proposal.proposalId, '任务已取消')
    }
    for (const change of this.store.listChangeSets(taskId)) {
      if (this.store.setChangeState(change.changeId, 'expired', { detail: '任务已取消，未执行', from: ['pending', 'approved'] })) this.store.purgeChangeContents(change.changeId)
    }
    for (const record of this.store.listVerifications(taskId)) {
      this.store.setVerificationState(record.verificationId, 'expired', { detail: '任务已取消，未运行', from: ['pending', 'approved'] })
    }
    await this.chains.get(taskId)
  }

  dispose(): Promise<void> {
    this.disposed = true
    if (this.disposal) return this.disposal
    this.disposal = this.releaseResources().catch(error => {
      this.disposal = null
      throw error
    })
    return this.disposal
  }

  private async releaseResources(): Promise<void> {
    const errors: unknown[] = []
    for (let index = this.releases.length - 1; index >= 0; index -= 1) {
      try {
        this.releases[index]!()
        this.releases.splice(index, 1)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const controller of this.aborts.values()) controller.abort()
    await Promise.all([...this.chains.values()])
    if (errors.length > 0) throw new AggregateError(errors, '帮助任务服务释放未完成，请重试 dispose')
  }

  // ───────────────────────────── 内部工具 ─────────────────────────────

  private requireActive(): void {
    if (this.disposed) throw new HelpTaskError('STOPPED', '帮助任务服务已经停止')
  }

  private getTask(taskId: string): Task | null {
    if (this.store.getTaskRuntimeScope(taskId) !== 'team') return null
    const task = this.store.getTask(taskId)
    return task?.teamId === this.options.teamId ? task : null
  }

  private requireScopes(): HelpScopeSource {
    this.requireActive()
    if (!this.options.scopes) throw new HelpTaskError('NOT_AVAILABLE', '帮助授权未装配，不能读取或改动项目')
    return this.options.scopes
  }

  private requireLink(taskId: string): { task: Task; link: HelpTaskLink } {
    this.requireActive()
    const task = typeof taskId === 'string' ? this.getTask(taskId) : null
    const link = task ? this.store.getHelpTask(taskId) : null
    if (!link || !task) throw new HelpTaskError('NOT_FOUND', `${taskId} 不是帮助任务；先用 desktop_team_open_help_task 在已授权范围上开任务`)
    return { task, link }
  }

  /** 能继续提案的任务：未终结、没有结果不明的操作（在途执行的 planned/running 不算）。 */
  private requireOpenTask(taskId: string): { task: Task; link: HelpTaskLink } {
    const found = this.requireLink(taskId)
    const { task } = found
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new HelpTaskError('TASK_CLOSED', `任务已是 ${task.status}，不再接受新的改动或验证；需要的话开一个新的帮助任务`)
    const blocking = this.store.listOperations(taskId).filter(item => item.state === 'unknown'
      || (!this.isBusy(taskId) && (item.state === 'planned' || item.state === 'running')))
    if (task.status === 'unknown' || blocking.length > 0) {
      throw new HelpTaskError('UNKNOWN_PENDING', '任务里有结果不明的操作，先请用户人工复核（desktop_team_review_unknown），禁止在不清楚现状时继续改动')
    }
    return found
  }

  /** 授权仍有效时返回 null，否则返回拒绝原因。 */
  private scopeError(link: HelpTaskLink): string | null {
    const scopes = this.options.scopes
    if (!scopes) return '帮助授权未装配'
    const scope = link.helpContextId && scopes.validById ? scopes.validById(link.helpContextId) : scopes.authorizedScope(link.projectRoot)
    const native = scope ? nativeScope(scope) : null
    if (!native || native.projectDir !== link.projectRoot || native.currentFile !== link.currentFile) {
      return '该项目的帮助授权已撤销或实际路径已改指'
    }
    return null
  }

  private requireScope(link: HelpTaskLink): void {
    const error = this.scopeError(link)
    if (error) throw new HelpTaskError('NOT_AUTHORIZED', `${error}，不再读取或改动；需要继续请用户重新确认读取范围`)
  }

  /** 按 gate 的口径把路径解析成真实路径，并限制在授权范围内。 */
  private resolveInside(link: HelpTaskLink, raw: string, kind: 'file' | 'dir' | 'any'): string {
    let target: string
    try {
      target = canonicalPath(raw, link.projectRoot)
    } catch (error) {
      throw new HelpTaskError('OUT_OF_SCOPE', `无法确认 ${raw} 的实际位置：${messageOf(error)}`)
    }
    const inside = kind === 'file' ? isWithinRoot(link.projectRoot, target) : isRootOrWithin(link.projectRoot, target)
    if (!inside) {
      throw new HelpTaskError('OUT_OF_SCOPE', `${raw} 的实际位置 ${target} 不在授权项目 ${link.projectRoot} 内（符号链接与相似前缀按真实路径判断）`)
    }
    if (link.currentFile !== null && kind !== 'dir' && target !== link.currentFile) {
      throw new HelpTaskError('OUT_OF_SCOPE', `本次只授权了文件 ${link.currentFile}`)
    }
    if (path.relative(link.projectRoot, target).split(path.sep).some(segment => segment.toLowerCase() === '.git')) {
      throw new HelpTaskError('OUT_OF_SCOPE', '不读取、不改动版本库元数据（.git）')
    }
    return target
  }

  private relative(link: HelpTaskLink, target: string): string {
    return path.relative(link.projectRoot, target).split(path.sep).join('/')
  }

  private latestApplied(taskId: string): ChangeSet | null {
    return this.store.listChangeSets(taskId).find(change => change.state === 'applied') ?? null
  }

  /**
   * 把已经有结论的审批卡同步到改动 / 验证 / 复核记录（懒同步，不靠定时器）：
   * 驳回 → rejected；到期未批 → expired。决定回调在下一拍才跑，提新提案或查状态前先在这里落定，
   * 免得用户驳回的那一版被紧接着的新提案记成「被取代」。
   */
  private syncExpired(taskId: string): void {
    const now = Date.now()
    for (const proposal of this.options.approvals.proposalsForTask(taskId)) {
      if (!isTrustedActionTool(proposal.tool)) continue
      const rejected = proposal.state === 'rejected'
      const stale = proposal.state === 'expired' || (proposal.state === 'pending' && proposal.expiresAt <= now)
      if (!rejected && !stale) continue
      const state = rejected ? 'rejected' as const : 'expired' as const
      const detail = rejected ? '用户在审批窗口驳回，未执行' : '审批卡到期未获批，未执行'
      if (proposal.tool === 'apply_change') {
        const change = this.store.changeSetByProposal(proposal.proposalId)
        if (change && this.store.setChangeState(change.changeId, state, { detail, from: rejected ? ['pending', 'approved'] : ['pending'] })) {
          this.store.purgeChangeContents(change.changeId)
        }
      } else if (proposal.tool === 'run_verification') {
        const record = this.store.verificationByProposal(proposal.proposalId)
        if (record) this.store.setVerificationState(record.verificationId, state, { detail: rejected ? detail : '审批卡到期未获批，未运行', from: rejected ? ['pending', 'approved'] : ['pending'] })
      } else {
        const review = this.store.reviewByProposal(proposal.proposalId)
        if (review) this.store.setReviewState(review.reviewId, state, rejected ? '用户驳回了这条复核结论，账本未改' : '审批卡到期未获批，账本未改', rejected ? now : null)
      }
    }
  }

  private setTaskStatus(taskId: string, status: TaskStatus, artifacts?: readonly string[]): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = this.getTask(taskId)
      if (!task || (task.status === status && artifacts === undefined)) return
      const updated = this.store.updateTask(taskId, task.revision, { status, artifacts })
      if (updated) {
        this.store.appendEvent('task/updated', { taskId, status: updated.status, revision: updated.revision, help: true },
          { taskId, assistantId: updated.ownerId })
        return
      }
    }
  }

  /** 按账本重算帮助任务的状态：结果不明 → unknown；有待批 → 等你点头；验证通过 → 已完成；已应用 → 等复核。 */
  private refresh(taskId: string): void {
    const task = this.getTask(taskId)
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return
    if (this.isBusy(taskId)) {
      if (task.status !== 'running') this.setTaskStatus(taskId, 'running')
      return
    }
    this.syncExpired(taskId)
    const operations = this.store.listOperations(taskId)
    if (operations.some(item => ['planned', 'running', 'unknown'].includes(item.state))) {
      this.setTaskStatus(taskId, 'unknown')
      return
    }
    const now = Date.now()
    const pending = this.options.approvals.proposalsForTask(taskId).some(item => item.state === 'pending' && item.expiresAt > now)
    if (pending) {
      this.setTaskStatus(taskId, 'awaiting-approval')
      return
    }
    const verdict = this.verdict(taskId)
    if (verdict.state === 'verified') {
      const link = this.store.getHelpTask(taskId)!
      const change = verdict.changeId ? this.store.getChangeSet(verdict.changeId) : null
      const verification = verdict.verificationId ? this.store.getVerification(verdict.verificationId) : null
      const artifacts = [
        ...(change ? [`第 ${change.revision} 版改动已应用：${change.files.map(file => `${this.relative(link, file.path)}（+${file.added} −${file.removed}）`).join('、')}`] : []),
        ...(verification ? [`验证通过：${displayCommand(path.basename(verification.program), verification.args)}（退出码 0）`] : []),
      ]
      this.setTaskStatus(taskId, 'done', artifacts)
      return
    }
    this.setTaskStatus(taskId, verdict.state === 'applied-unverified' || verdict.state === 'verification-failed' ? 'review' : 'awaiting-user')
  }

  private serialize<T>(taskId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(taskId) ?? Promise.resolve()
    this.busy.set(taskId, (this.busy.get(taskId) ?? 0) + 1)
    const run = previous.catch(() => undefined).then(body)
    const tracked = run.finally(() => {
      const left = (this.busy.get(taskId) ?? 1) - 1
      if (left <= 0) this.busy.delete(taskId)
      else this.busy.set(taskId, left)
    })
    const settled = tracked.then(() => undefined, () => undefined)
    this.chains.set(taskId, settled)
    void settled.then(() => {
      if (this.chains.get(taskId) === settled) this.chains.delete(taskId)
    })
    return tracked
  }

  private outcomeHolder(proposalId: string) {
    let holder = this.outcomes.get(proposalId)
    if (!holder) {
      holder = deferred<ExecutionOutcome>()
      this.outcomes.set(proposalId, holder)
    }
    return holder
  }

  private outcomeFor(proposalId: string): Promise<ExecutionOutcome> {
    const proposal = this.options.approvals.proposal(proposalId)
    const operation = proposal ? this.options.approvals.operationByProposal(proposalId) : null
    // 已经执行完（例如等待之前就批准并执行了）：直接按账本回答。
    if (operation && ['succeeded', 'failed', 'unknown', 'abandoned'].includes(operation.state) && !this.outcomes.has(proposalId)) {
      return Promise.resolve({ proposalId, tool: proposal!.tool as TrustedActionTool, state: operation.state, detail: operation.resultDetail ?? '', operationId: operation.operationId })
    }
    return this.outcomeHolder(proposalId).promise
  }
}
