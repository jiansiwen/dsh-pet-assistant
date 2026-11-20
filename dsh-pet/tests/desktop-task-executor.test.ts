/**
 * desktop-action 执行器：四态映射、禁止自动重试、未批准 actionId 拒绝。
 * 领取通道/桌面动作/目标锁/一次性动作全部用替身注入，不拉起真实 UIA。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fail, ok, type WindowIdentity } from '../src/main/desktop-actions.ts'
import {
  createDesktopTaskExecutor, readbackMatches,
  type ApprovedActionResult, type CommandChannel, type DesktopActionInput,
  type DesktopExecutionCommand, type DesktopExecutionReceipt,
} from '../src/main/desktop-task-executor.ts'
import type { TargetLock } from '../src/main/target-lock.ts'

const ID: WindowIdentity = {
  platform: 'win32', pid: 21452, windowId: '68352', title: '测试.pdf - WPS Office',
  processPath: 'D:\\WPS Office\\office6\\wps.exe', processStartedAt: '134365870439557783',
}
const LOCK: TargetLock = {
  lockId: 'lock-1', hwnd: '68352', pid: 21452, processStartedAt: '134365870439557783',
  processPath: ID.processPath, displayId: '65537', capturedAt: 1_000, expiresAt: 16_000,
}

const actionInput = (over: Partial<DesktopActionInput> = {}): DesktopActionInput => ({
  kind: 'desktop-action', capability: 'desktop.action', actionId: 'act-1',
  targetGrantRef: 'grant-1', identity: ID, readPage: true, profile: 'wps-pdf',
  successCheck: { page: 3, total: 12 }, ...over,
})

const commandOf = (input: DesktopActionInput, over: Partial<DesktopExecutionCommand> = {}): DesktopExecutionCommand => ({
  commandId: 'cmd-1', operationId: 'op-1', taskId: 'task-1', taskRevision: 2, executorEpoch: 'epoch-1',
  kind: 'desktop-action', inputRef: 'input-1', inputDigest: 'digest-1', grantRef: 'grant-1',
  expiresAt: '2026-11-07T10:15:00Z', capabilities: ['desktop.readback', 'desktop.action'], input, ...over,
})

function fixture(options: {
  commands?: DesktopExecutionCommand[]
  claimOk?: boolean
  receiptOk?: boolean
  apply?: ApprovedActionResult | Error
  page?: { page: number; total: number }
  text?: string
  readFails?: boolean
  lock?: TargetLock | null
} = {}) {
  const queue = [...(options.commands ?? [])]
  const receipts: Array<{ commandId: string; receipt: DesktopExecutionReceipt }> = []
  const claims: string[] = []
  const applyCalls: string[] = []
  const readCalls: string[] = []
  const channel: CommandChannel = {
    async nextCommand() { return queue.shift() ?? null },
    async claimCommand(commandId) { claims.push(commandId); return options.claimOk !== false },
    async receiptCommand(commandId, receipt) { receipts.push({ commandId, receipt }); return options.receiptOk !== false },
  }
  const executor = createDesktopTaskExecutor({
    channel,
    actions: {
      readVisibleText: async () => {
        readCalls.push('text')
        return options.readFails
          ? fail('window-not-found', '目标窗口已不存在', { action: 'readVisibleText', platform: 'win32' })
          : ok({ text: options.text ?? '第 3 页 内容', truncated: false }, { action: 'readVisibleText', platform: 'win32' })
      },
      readPage: async () => {
        readCalls.push('page')
        return options.readFails
          ? fail('identity-changed', '窗口身份变化', { action: 'readPage', platform: 'win32' })
          : ok(options.page ?? { page: 3, total: 12 }, { action: 'readPage', platform: 'win32' })
      },
    },
    targetLock: { resolveTargetLock: async () => options.lock === undefined ? LOCK : options.lock },
    applyApprovedAction: async actionId => {
      applyCalls.push(actionId)
      if (options.apply instanceof Error) throw options.apply
      return options.apply ?? { state: 'issued' }
    },
    now: () => 2_000,
    log: () => {},
  })
  return { executor, receipts, claims, applyCalls, readCalls }
}

test('四态映射：读回匹配 succeeded，读回不符 partial，无法判断 unknown，执行前拒绝 failed-before-effect', async () => {
  const matched = fixture({ commands: [commandOf(actionInput())] })
  await matched.executor.runOnce()
  assert.equal(matched.receipts.length, 1)
  assert.equal(matched.receipts[0]!.receipt.state, 'succeeded')
  assert.ok(matched.receipts[0]!.receipt.evidenceRefs.length > 0, '成功回执必须带证据引用')
  assert.equal(matched.receipts[0]!.receipt.validatorKind, 'ui-readback')
  assert.deepEqual(matched.receipts[0]!.receipt.evidence?.readBack, { page: 3, total: 12 })

  const mismatched = fixture({ commands: [commandOf(actionInput())], page: { page: 4, total: 12 } })
  await mismatched.executor.runOnce()
  assert.equal(mismatched.receipts[0]!.receipt.state, 'partial', '输入已发出但读回不符 → partial')

  const unknown = fixture({ commands: [commandOf(actionInput())], apply: { state: 'unknown', error: '超时' } })
  await unknown.executor.runOnce()
  assert.equal(unknown.receipts[0]!.receipt.state, 'unknown')
  assert.equal(unknown.readCalls.length, 0, '无法判断时不再追加读回动作')

  const rejected = fixture({ commands: [commandOf(actionInput())], apply: { state: 'failed-before-effect', error: '操作未获批准' } })
  await rejected.executor.runOnce()
  assert.equal(rejected.receipts[0]!.receipt.state, 'failed-before-effect')
  assert.equal(rejected.readCalls.length, 0, '执行前拒绝不产生读回')
})

test('禁止自动重试：每条命令动作只执行一次，回执后不重放', async () => {
  const f = fixture({ commands: [commandOf(actionInput())], page: { page: 4, total: 12 } })
  await f.executor.runOnce()
  assert.equal(f.applyCalls.length, 1)
  assert.equal(f.receipts[0]!.receipt.state, 'partial')
  await f.executor.runOnce()
  await f.executor.runOnce()
  assert.equal(f.applyCalls.length, 1, 'partial 之后绝不自动重试同一动作')
  assert.equal(f.receipts.length, 1)

  const thrown = fixture({ commands: [commandOf(actionInput())], apply: new Error('辅助进程超时') })
  await thrown.executor.runOnce()
  assert.equal(thrown.applyCalls.length, 1)
  assert.equal(thrown.receipts[0]!.receipt.state, 'unknown', '动作抛错无法判断是否发出 → unknown，不重试')
  await thrown.executor.runOnce()
  assert.equal(thrown.applyCalls.length, 1)
})

test('回执未送达也不重放动作', async () => {
  const f = fixture({ commands: [commandOf(actionInput())], receiptOk: false })
  await f.executor.runOnce()
  assert.equal(f.applyCalls.length, 1)
  assert.equal(f.receipts.length, 1)
  await f.executor.runOnce()
  assert.equal(f.applyCalls.length, 1, '回执失败只留给插件侧对账，不重新执行')
})

test('未批准 actionId 拒绝：一次性核验拒绝后不执行、不读回、不重试', async () => {
  const f = fixture({
    commands: [commandOf(actionInput())],
    apply: { state: 'failed-before-effect', error: '操作不存在、未获批准、已过期或已消费' },
  })
  await f.executor.runOnce()
  assert.deepEqual(f.applyCalls, ['act-1'], '只交给核验路径一次')
  assert.equal(f.receipts[0]!.receipt.state, 'failed-before-effect')
  assert.equal(f.readCalls.length, 0)

  const missing = fixture({ commands: [commandOf(actionInput({ actionId: undefined }))] })
  await missing.executor.runOnce()
  assert.equal(missing.applyCalls.length, 0, '缺 actionId 根本不进入执行')
  assert.equal(missing.receipts[0]!.receipt.state, 'failed-before-effect')
  assert.equal(missing.receipts[0]!.receipt.errorCode, 'ACTION_ID_MISSING')
})

test('目标授权：锁失效或缺授权引用时不执行；锁解析出的身份用于读回', async () => {
  const expired = fixture({ commands: [commandOf(actionInput({ targetLockId: 'lock-1', targetGrantRef: undefined, identity: undefined }))], lock: null })
  await expired.executor.runOnce()
  assert.equal(expired.applyCalls.length, 0, '缺锁不猜刚才那个')
  assert.equal(expired.receipts[0]!.receipt.state, 'failed-before-effect')
  assert.equal(expired.receipts[0]!.receipt.errorCode, 'TARGET_LOCK_INVALID')

  const unauthorized = fixture({ commands: [commandOf(actionInput({ targetGrantRef: undefined, identity: undefined }))] })
  await unauthorized.executor.runOnce()
  assert.equal(unauthorized.applyCalls.length, 0)
  assert.equal(unauthorized.receipts[0]!.receipt.errorCode, 'TARGET_UNAUTHORIZED')

  const locked = fixture({ commands: [commandOf(actionInput({ targetLockId: 'lock-1', targetGrantRef: undefined, identity: undefined }))] })
  await locked.executor.runOnce()
  assert.equal(locked.receipts[0]!.receipt.state, 'succeeded', '锁有效时用锁内身份读回')
  assert.equal(locked.receipts[0]!.receipt.evidence?.lockId, 'lock-1')
})

test('desktop.readback：只读观察不需动作批准，但必须有目标授权', async () => {
  const readInput: DesktopActionInput = { kind: 'desktop-action', capability: 'desktop.readback', targetGrantRef: 'grant-1', identity: ID }
  const f = fixture({ commands: [commandOf(readInput)], text: '第 3 页 可见文字' })
  await f.executor.runOnce()
  assert.equal(f.applyCalls.length, 0, '只读观察不消费动作许可')
  assert.deepEqual(f.readCalls, ['text'])
  assert.equal(f.receipts[0]!.receipt.state, 'succeeded')
  assert.deepEqual(f.receipts[0]!.receipt.evidence?.readBack, { text: '第 3 页 可见文字' })

  const noGrant = fixture({ commands: [commandOf({ ...readInput, targetGrantRef: undefined })] })
  await noGrant.executor.runOnce()
  assert.equal(noGrant.readCalls.length, 0, '未授权不读取')
  assert.equal(noGrant.receipts[0]!.receipt.state, 'failed-before-effect')

  const readFail = fixture({ commands: [commandOf(readInput)], readFails: true })
  await readFail.executor.runOnce()
  assert.equal(readFail.receipts[0]!.receipt.state, 'failed-before-effect', '只读失败没有副作用，如实报执行前无效果')
})

test('领取守卫：领不到不执行；能力清单外拒绝；非 desktop-action 不消费', async () => {
  const unclaimed = fixture({ commands: [commandOf(actionInput())], claimOk: false })
  await unclaimed.executor.runOnce()
  assert.equal(unclaimed.applyCalls.length, 0)
  assert.equal(unclaimed.receipts.length, 0)

  const outOfScope = fixture({ commands: [commandOf(actionInput(), { capabilities: ['desktop.readback'] })] })
  await outOfScope.executor.runOnce()
  assert.equal(outOfScope.applyCalls.length, 0)
  assert.equal(outOfScope.receipts[0]!.receipt.errorCode, 'CAPABILITY_UNSUPPORTED')

  const otherKind = fixture({ commands: [commandOf(actionInput(), { kind: 'reminder' })] })
  await otherKind.executor.runOnce()
  assert.equal(otherKind.claims.length, 0, '其他 kind 不在本执行器领取范围')
  assert.equal(otherKind.receipts.length, 0)
})

test('readbackMatches：逐项期望核对，与插件 ui-readback 验证器同口径', () => {
  assert.equal(readbackMatches({ page: 3, total: 12 }, { page: 3, total: 12 }), true)
  assert.equal(readbackMatches({ page: 3 }, { page: 4 }), false)
  assert.equal(readbackMatches({ controlValue: '已保存' }, { text: '已保存' }), true)
  assert.equal(readbackMatches({ controlValue: '已保存' }, { controlValue: '未保存' }), false)
  assert.equal(readbackMatches({ textIncludes: '完成' }, { text: '翻译完成' }), true)
  assert.equal(readbackMatches({ textIncludes: '完成' }, { text: '进行中' }), false)
  assert.equal(readbackMatches(undefined, { page: 3 }), false)
  assert.equal(readbackMatches({}, { page: 3 }), false, '没有期望不能声称匹配')
})