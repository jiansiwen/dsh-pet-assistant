/**
 * desktop-action 受管执行器（4.6 切片1）。
 *
 * 按 harness/主进程既有执行器轮询模式（领取→执行→回执，in-flight 守卫）消费
 * kind=desktop-action 的 ExecutionCommand。两种固定能力：
 *
 * - desktop.readback：只读 UIA 观察（desktop-actions 的 readVisibleText/readPage），
 *   不需动作批准，但任务输入必须携带有效的目标授权引用（目标锁或授权编号）；
 * - desktop.action：只消费已获本机批准的一次性 actionId（由装配侧接 computer.ts apply
 *   的核验路径），执行后用 UIA 读回对照 successCheck。
 *
 * 回执严格四态：
 * - 读回匹配 = succeeded + evidenceRefs；
 * - 读回失败但输入已发出 = partial（含无法读回：输入本身已是确定发生的部分效果）；
 * - 无法判断输入是否发出 = unknown；
 * - 执行前证实无效果（未批准/缺授权/目标锁失效/核验拒绝）= failed-before-effect。
 *
 * 禁止自动重试：每条命令只领取一次、动作只执行一次、回执只发送一次；
 * 回执没送达也不重放动作，留给插件侧对账（重启转 unknown）。
 * 本模块不 import electron、不 spawn，IO 全部注入，node --test 可直接导入。
 */
import type { DesktopActions, SemanticProfile, WindowIdentity } from './desktop-actions.ts'
import type { TargetLock } from './target-lock.ts'

export type ExecutionState = 'succeeded' | 'failed-before-effect' | 'partial' | 'unknown'

export interface SuccessCheck {
  controlValue?: string
  textIncludes?: string
  page?: number
  total?: number
}

/** 任务输入（插件侧受管执行器校验器负责创建时校验，这里执行前再核一次）。 */
export interface DesktopActionInput {
  kind: 'desktop-action'
  capability: 'desktop.readback' | 'desktop.action'
  /** 唤醒前目标锁编号；与 targetGrantRef 至少其一，缺锁不猜"刚才那个"。 */
  targetLockId?: string
  /** 既有逐次审批链的目标授权引用。 */
  targetGrantRef?: string
  /** desktop.action 必填：已获本机批准的一次性操作编号。 */
  actionId?: string
  identity?: WindowIdentity
  profile?: SemanticProfile
  /** true 时读页码（需要 profile），否则读可见文字。 */
  readPage?: boolean
  successCheck?: SuccessCheck
  maxChars?: number
}

/** 与公共契约 ExecutionCommand 对齐的命令视图（执行器通道下发）。 */
export interface DesktopExecutionCommand {
  commandId: string
  operationId: string
  taskId: string
  taskRevision: number
  executorEpoch: string
  kind: string
  inputRef: string
  inputDigest: string
  grantRef: string
  expiresAt: string
  title?: string
  capabilities?: string[]
  input?: DesktopActionInput
}

export interface DesktopExecutionReceipt {
  executorEpoch: string
  state: ExecutionState
  evidenceRefs: string[]
  evidence?: Record<string, unknown>
  validatorKind?: string
  errorCode?: string | null
}

/** 领取通道：装配侧接 BridgeClient 的 /executor/v1/commands 三个方法。 */
export interface CommandChannel {
  nextCommand(): Promise<DesktopExecutionCommand | null>
  claimCommand(commandId: string): Promise<boolean>
  receiptCommand(commandId: string, receipt: DesktopExecutionReceipt): Promise<boolean>
}

/**
 * 一次性动作的执行结果，形状对齐 computer.ts apply 的回执语义：
 * issued = 系统已接收输入（issued:true/verified:false）；执行前拒绝 = failed-before-effect；
 * 超时/异常等无法判断 = unknown。装配侧负责把 apply 的 JSON 映射到这里。
 */
export type ApprovedActionResult =
  | { state: 'issued'; detail?: string }
  | { state: 'failed-before-effect'; error: string }
  | { state: 'unknown'; error: string }

export interface DesktopTaskExecutorDeps {
  channel: CommandChannel
  actions: Pick<DesktopActions, 'readVisibleText' | 'readPage'>
  targetLock: { resolveTargetLock(lockId: string, now: number): Promise<TargetLock | null> }
  /** 只消费已批准 actionId；未批准/已过期/已消费必须由它拒绝（failed-before-effect）。 */
  applyApprovedAction(actionId: string, command: DesktopExecutionCommand): Promise<ApprovedActionResult>
  now?: () => number
  log?: (message: string) => void
}

export interface ReadBackObservation {
  text?: string
  controlValue?: string
  page?: number
  total?: number
}

/** 读回证据与期望逐项一致才算匹配；没有期望或任何一项不符都不匹配（与插件 ui-readback 验证器同口径）。 */
export function readbackMatches(expected: SuccessCheck | undefined, observed: ReadBackObservation): boolean {
  if (!expected) return false
  const checks: Array<() => boolean> = []
  if (expected.page !== undefined) checks.push(() => Number.isSafeInteger(expected.page) && observed.page === expected.page)
  if (expected.total !== undefined) checks.push(() => Number.isSafeInteger(expected.total) && observed.total === expected.total)
  if (expected.controlValue !== undefined) {
    checks.push(() => typeof expected.controlValue === 'string' && (observed.controlValue ?? observed.text) === expected.controlValue)
  }
  if (expected.textIncludes !== undefined) {
    checks.push(() => typeof expected.textIncludes === 'string' && expected.textIncludes.length > 0
      && typeof observed.text === 'string' && observed.text.includes(expected.textIncludes))
  }
  return checks.length > 0 && checks.every(check => check())
}

export function createDesktopTaskExecutor(deps: DesktopTaskExecutorDeps): {
  /** 一拍轮询：领取一条 desktop-action 命令并执行回执；无命令或领不到时什么都不做。 */
  runOnce(): Promise<void>
  /** 是否在途（测试与装配守卫用）。 */
  readonly inFlight: boolean
} {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  let inFlight = false

  const receipt = (command: DesktopExecutionCommand, state: ExecutionState,
    extra: Partial<DesktopExecutionReceipt> = {}): DesktopExecutionReceipt =>
    ({ executorEpoch: command.executorEpoch, state, evidenceRefs: [], errorCode: null, ...extra })

  /** 目标授权：锁必须能解析为同一代进程；否则要有审批链授权引用。两者皆无 → 未授权。 */
  async function resolveTarget(command: DesktopExecutionCommand, input: DesktopActionInput):
    Promise<{ identity: WindowIdentity | null; lockId?: string } | { error: string }> {
    if (typeof input.targetLockId === 'string' && input.targetLockId) {
      const lock = await deps.targetLock.resolveTargetLock(input.targetLockId, now())
      if (!lock) return { error: 'TARGET_LOCK_INVALID' }
      return { lockId: lock.lockId, identity: { platform: 'win32', pid: lock.pid, windowId: lock.hwnd, title: '',
        processPath: lock.processPath, processStartedAt: lock.processStartedAt } }
    }
    if (typeof input.targetGrantRef === 'string' && input.targetGrantRef) {
      return { identity: input.identity ?? null }
    }
    return { error: 'TARGET_UNAUTHORIZED' }
  }

  /** 只读观察：readPage 或 readVisibleText。失败按错误码归类，不产生任何动作效果。 */
  async function observe(input: DesktopActionInput, identity: WindowIdentity, taskId: string):
    Promise<{ ok: true; observed: ReadBackObservation; method: string } | { ok: false; code: string; message: string }> {
    if (input.readPage === true) {
      if (!input.profile) return { ok: false, code: 'invalid-argument', message: '读页码需要明确的语义配置档' }
      const result = await deps.actions.readPage(identity, input.profile)
      if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
      return { ok: true, observed: { page: result.value.page, total: result.value.total }, method: 'uia-page' }
    }
    const result = await deps.actions.readVisibleText(identity,
      { authorized: true, reason: `desktop-task:${taskId}`, ...(input.maxChars ? { maxChars: input.maxChars } : {}) }, input.profile)
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
    return { ok: true, observed: { text: result.value.text }, method: 'uia-text' }
  }

  async function executeCommand(command: DesktopExecutionCommand): Promise<DesktopExecutionReceipt> {
    const input = command.input
    if (!input || input.kind !== 'desktop-action' || (input.capability !== 'desktop.readback' && input.capability !== 'desktop.action')) {
      return receipt(command, 'failed-before-effect', { errorCode: 'INVALID_INPUT', evidence: { message: '命令输入不是有效的 desktop-action 能力声明，未执行' } })
    }
    if (Array.isArray(command.capabilities) && command.capabilities.length > 0 && !command.capabilities.includes(input.capability)) {
      return receipt(command, 'failed-before-effect', { errorCode: 'CAPABILITY_UNSUPPORTED', evidence: { message: '能力不在执行器登记清单内，未执行' } })
    }
    let target: { identity: WindowIdentity | null; lockId?: string }
    try {
      const resolved = await resolveTarget(command, input)
      if ('error' in resolved) {
        return receipt(command, 'failed-before-effect', { errorCode: resolved.error,
          evidence: { message: '目标授权缺失或目标锁已失效；请重新选择目标，未猜测也未执行' } })
      }
      target = resolved
    } catch {
      return receipt(command, 'failed-before-effect', { errorCode: 'TARGET_LOCK_INVALID', evidence: { message: '目标锁核验异常，未执行' } })
    }

    if (input.capability === 'desktop.readback') {
      // 只读观察不需要动作批准，但必须有可核验的目标身份。
      if (!target.identity) return receipt(command, 'failed-before-effect', { errorCode: 'TARGET_IDENTITY_MISSING', evidence: { message: '缺少目标窗口身份，未读取' } })
      let seen: Awaited<ReturnType<typeof observe>>
      try { seen = await observe(input, target.identity, command.taskId) } catch {
        return receipt(command, 'failed-before-effect', { errorCode: 'READ_ERROR', evidence: { message: '只读观察异常，未产生任何动作效果' } })
      }
      if (!seen.ok) {
        return receipt(command, 'failed-before-effect', { errorCode: seen.code, evidence: { message: `只读观察失败：${seen.message}` } })
      }
      return receipt(command, 'succeeded', {
        evidenceRefs: [`uia-readback:${command.commandId}`],
        validatorKind: 'ui-readback',
        evidence: { method: seen.method, lockId: target.lockId ?? null, readBack: seen.observed,
          ...(input.successCheck ? { successCheck: input.successCheck } : {}) },
      })
    }

    // desktop.action：只消费已获本机批准的一次性 actionId，只执行一次。
    if (typeof input.actionId !== 'string' || !input.actionId) {
      return receipt(command, 'failed-before-effect', { errorCode: 'ACTION_ID_MISSING', evidence: { message: '缺少已批准的一次性操作编号，未执行' } })
    }
    let applied: ApprovedActionResult
    try { applied = await deps.applyApprovedAction(input.actionId, command) } catch (error) {
      return receipt(command, 'unknown', { errorCode: 'APPLY_NO_RECEIPT',
        evidence: { message: `动作没有得到确定回执：${error instanceof Error ? error.message : String(error)}；可能已部分执行，不自动重试` } })
    }
    if (applied.state === 'failed-before-effect') {
      return receipt(command, 'failed-before-effect', { errorCode: 'ACTION_REJECTED', evidence: { message: applied.error } })
    }
    if (applied.state === 'unknown') {
      return receipt(command, 'unknown', { errorCode: 'APPLY_UNKNOWN', evidence: { message: applied.error } })
    }
    // 输入已发出（issued:true/verified:false）。读回匹配才 succeeded；否则 partial。
    const evidenceBase: Record<string, unknown> = { actionId: input.actionId, lockId: target.lockId ?? null, issued: true }
    if (!target.identity || !input.successCheck) {
      return receipt(command, 'partial', { evidenceRefs: [`action:${input.actionId}`],
        evidence: { ...evidenceBase, message: '输入已发出，但缺少读回目标或期望，无法证实业务效果；不自动重试' } })
    }
    let seen: Awaited<ReturnType<typeof observe>>
    try { seen = await observe(input, target.identity, command.taskId) } catch {
      return receipt(command, 'partial', { evidenceRefs: [`action:${input.actionId}`],
        evidence: { ...evidenceBase, message: '输入已发出，读回异常；保留证据待复核，不自动重试' } })
    }
    if (!seen.ok) {
      return receipt(command, 'partial', { evidenceRefs: [`action:${input.actionId}`],
        evidence: { ...evidenceBase, readError: seen.code, message: `输入已发出，读回失败：${seen.message}；不自动重试` } })
    }
    if (!readbackMatches(input.successCheck, seen.observed)) {
      return receipt(command, 'partial', { evidenceRefs: [`action:${input.actionId}`, `uia-readback:${command.commandId}`],
        validatorKind: 'ui-readback',
        evidence: { ...evidenceBase, successCheck: input.successCheck, readBack: seen.observed, message: '输入已发出，读回与期望不一致；保留证据待复核，不自动重试' } })
    }
    return receipt(command, 'succeeded', {
      evidenceRefs: [`action:${input.actionId}`, `uia-readback:${command.commandId}`],
      validatorKind: 'ui-readback',
      evidence: { ...evidenceBase, successCheck: input.successCheck, readBack: seen.observed, method: seen.method },
    })
  }

  return {
    get inFlight() { return inFlight },
    async runOnce() {
      if (inFlight) return
      inFlight = true
      try {
        const command = await deps.channel.nextCommand()
        if (!command || command.kind !== 'desktop-action' || typeof command.commandId !== 'string' || !command.commandId) return
        if (!(await deps.channel.claimCommand(command.commandId))) return
        let result: DesktopExecutionReceipt
        try { result = await executeCommand(command) } catch (error) {
          // 执行框架异常不能证明动作未发生：如实报 unknown，绝不重放。
          result = receipt(command, 'unknown', { errorCode: 'EXECUTOR_ERROR',
            evidence: { message: `执行异常：${error instanceof Error ? error.message : String(error)}；不自动重试` } })
        }
        const delivered = await deps.channel.receiptCommand(command.commandId, result)
        if (!delivered) log(`[warn] 桌面任务 ${command.taskId} 回执未送达；动作不会重发，等待插件侧对账。`)
      } catch (error) {
        log(`[warn] 桌面任务领取异常：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        inFlight = false
      }
    },
  }
}