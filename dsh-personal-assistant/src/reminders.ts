import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digestOf, type ApprovalService } from './approval.ts'
import { CompanionError, type CompanionInput, type DesktopReminderDelivery, type ReminderResponse, type ReminderSchedule } from './companion-contract.ts'
import { TERMINAL_TASK_STATUSES, type CompanionScheduleRecord, type ReminderCycleRecord, type ReminderDeliveryRecord, type Task, type TeamStore } from './team-domain.ts'
import { firstScheduleAt, nextScheduleAt } from './scheduler.ts'

export interface ReminderHost {
  store: TeamStore
  approvals: ApprovalService
  principalId: string
  deviceId: string
  epoch: string
  now: () => number
  ownedTask(taskId: string): Task
  changeTask(taskId: string, status: Task['status'], blocker?: 'manual-pause' | null, artifacts?: string[]): Task
  createChild(parent: Task, cycleId: string): Task
  acceptsRecipient(channel: 'desktop' | 'wecom', recipientRef: string, taskId?: string): boolean
}

export const reminderClaimSchema = z.object({ executorEpoch: z.string().min(1).max(200) }).strict()
export const reminderReceiptSchema = z.object({
  executorEpoch: z.string().min(1).max(200),
  state: z.enum(['succeeded', 'failed-before-effect', 'partial', 'unknown']),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(30),
}).strict()

export class CompanionReminders {
  private readonly host: ReminderHost

  constructor(host: ReminderHost) { this.host = host }

  private input(taskId: string): Extract<CompanionInput, { kind: 'reminder' }> {
    const meta = this.host.store.getCompanionMeta(taskId)!
    const record = this.host.store.getCompanionInput(meta.inputRef)
    if (!record || record.principalId !== this.host.principalId || record.input.kind !== 'reminder' || digestOf(record.input) !== record.digest) {
      throw new CompanionError('INPUT_CHANGED', '提醒输入已变化或不属于本人')
    }
    return record.input
  }

  private scope(schedule: CompanionScheduleRecord): string {
    const input = this.input(schedule.taskId)
    return digestOf({ input, schedule: schedule.spec, principalId: this.host.principalId,
      deviceId: this.host.deviceId, channel: input.channel, recipient: input.recipientId ?? this.host.principalId,
      capability: 'notification.send' })
  }

  authorize(schedule: CompanionScheduleRecord, operationId: string): void {
    const { store } = this.host
    const old = store.getReminderGrant(schedule.grantRef)
    if (old) store.saveReminderGrant({ ...old, enabled: false })
    schedule.grantRef = randomUUID()
    store.saveReminderGrant({ grantRef: schedule.grantRef, taskId: schedule.taskId, principalId: this.host.principalId,
      deviceId: this.host.deviceId, operationId, taskRevision: this.host.ownedTask(schedule.taskId).revision,
      generation: schedule.generation, scopeDigest: this.scope(schedule), enabled: schedule.enabled })
    store.saveCompanionSchedule(schedule)
  }

  create(task: Task, operationId: string): void {
    const input = this.input(task.taskId)
    const schedule: CompanionScheduleRecord = { scheduleId: randomUUID(), taskId: task.taskId, revision: 1,
      spec: input.schedule, nextRunAt: firstScheduleAt(input.schedule, this.host.now()), enabled: true,
      schedulerOwner: this.host.deviceId, generation: 1, missedPolicy: 'coalesce', grantRef: '' }
    this.authorize(schedule, operationId)
  }

  private validSchedule(schedule: CompanionScheduleRecord): boolean {
    const { store } = this.host
    const meta = store.getCompanionMeta(schedule.taskId)
    const task = store.getTask(schedule.taskId)
    const grant = store.getReminderGrant(schedule.grantRef)
    return !!(meta?.runtimeScope === 'companion' && meta.principalId === this.host.principalId &&
      meta.deviceId === this.host.deviceId && task && !meta.blocker && !TERMINAL_TASK_STATUSES.includes(task.status) &&
      task.status !== 'unknown' && task.status !== 'awaiting-approval' && schedule.enabled &&
      schedule.schedulerOwner === this.host.deviceId && grant?.enabled && grant.taskId === task.taskId &&
      grant.principalId === this.host.principalId && grant.deviceId === this.host.deviceId &&
      grant.taskRevision === task.revision && grant.generation === schedule.generation &&
      grant.scopeDigest === this.scope(schedule) && store.getOperation(grant.operationId)?.state === 'succeeded' &&
      task.dependsOn.every(id => store.getTask(id)?.status === 'done'))
  }

  private event(cycle: ReminderCycleRecord): void {
    this.host.store.appendEvent('reminder.changed', { cycleId: cycle.cycleId, taskId: cycle.childTaskId,
      revision: cycle.revision, state: cycle.state, nextNagAt: cycle.nextNagAt,
      snoozedUntil: cycle.snoozedUntil, relatedBusinessTaskId: cycle.relatedBusinessTaskId }, { taskId: cycle.childTaskId })
  }

  tick(): void {
    const { store } = this.host
    const now = this.host.now()
    store.transaction(() => {
      for (const schedule of store.listCompanionSchedules()) {
        if (!this.validSchedule(schedule) || schedule.nextRunAt === null || schedule.nextRunAt > now) continue
        const input = this.input(schedule.taskId)
        if (input.relatedBusinessTaskId && store.getTask(input.relatedBusinessTaskId)?.status === 'done') continue
        const active = store.listReminderCycles().some(cycle => cycle.scheduleId === schedule.scheduleId &&
          !['acknowledged', 'cancelled'].includes(cycle.state))
        if (!active) {
          const cycleId = randomUUID()
          const child = this.host.createChild(this.host.ownedTask(schedule.taskId), cycleId)
          const cycle: ReminderCycleRecord = { cycleId, scheduleId: schedule.scheduleId,
            generation: schedule.generation, triggerAt: schedule.nextRunAt, childTaskId: child.taskId,
            relatedBusinessTaskId: input.relatedBusinessTaskId, state: 'scheduled', repeatIntervalMs: input.repeatEverySeconds * 1000,
            nextNagAt: now, snoozedUntil: null, ackActorId: null, ackAt: null, revision: 1, grantRef: schedule.grantRef }
          store.saveReminderCycle(cycle)
          this.event(cycle)
        }
        store.saveCompanionSchedule({ ...schedule, nextRunAt: nextScheduleAt(schedule.spec, now) })
      }
      for (const cycle of store.listReminderCycles()) {
        if (!['scheduled', 'awaiting-response', 'snoozed'].includes(cycle.state) || cycle.nextNagAt === null || cycle.nextNagAt > now) continue
        const schedule = store.getCompanionSchedule(cycle.scheduleId)
        if (!schedule || !this.validSchedule(schedule) || cycle.generation !== schedule.generation) continue
        if (cycle.relatedBusinessTaskId && store.getTask(cycle.relatedBusinessTaskId)?.status === 'done') continue
        const child = this.host.ownedTask(cycle.childTaskId)
        if (TERMINAL_TASK_STATUSES.includes(child.status) || child.status === 'unknown') continue
        const unresolved = store.listReminderDeliveries().some(delivery => delivery.cycleId === cycle.cycleId &&
          ['pending', 'sending', 'unknown', 'partial'].includes(delivery.state))
        if (unresolved) continue
        const nextCycle: ReminderCycleRecord = { ...cycle, state: 'awaiting-response', revision: cycle.revision + 1,
          nextNagAt: now + cycle.repeatIntervalMs, snoozedUntil: null }
        store.saveReminderCycle(nextCycle)
        const task = this.host.changeTask(child.taskId, 'awaiting-user')
        const deliveryId = randomUUID()
        const operationId = randomUUID()
        const occurrenceId = `${cycle.cycleId}:${cycle.generation}:${cycle.revision}`
        const input = this.input(schedule.taskId)
        const delivery: ReminderDeliveryRecord = { deliveryId, operationId, occurrenceId, taskId: task.taskId,
          taskRevision: task.revision, cycleId: cycle.cycleId, cycleRevision: nextCycle.revision,
          title: task.goal, message: input.message, executorEpoch: this.host.epoch, generation: cycle.generation,
          grantRef: schedule.grantRef, channel: input.channel, recipientRef: input.recipientId ?? this.host.principalId, state: 'pending',
          attemptCount: 0, submittedAt: null, acceptedAt: null, receiptDigest: null, evidenceRefs: [] }
        store.insertOperation({ operationId, taskId: task.taskId, approvalId: null, kind: 'notification.send', state: 'planned',
          resultDigest: null, startedAt: now, endedAt: null, assistantId: 'executor:reminder', target: this.host.deviceId,
          paramsDigest: digestOf(delivery), runId: deliveryId, executedAt: null, resultDetail: null })
        store.setOperationEvidence(operationId, { grantRef: schedule.grantRef, occurrenceId, generation: cycle.generation })
        store.saveReminderDelivery(delivery)
        this.event(nextCycle)
      }
    })
  }

  private validDelivery(delivery: ReminderDeliveryRecord): boolean {
    const { store } = this.host
    const cycle = store.getReminderCycle(delivery.cycleId)
    const schedule = cycle && store.getCompanionSchedule(cycle.scheduleId)
    const task = store.getTask(delivery.taskId)
    const channel = delivery.channel === 'wecom' ? 'wecom' : 'desktop'
    return !!(cycle && schedule && task && this.validSchedule(schedule) &&
      this.host.acceptsRecipient(channel, delivery.recipientRef, delivery.taskId) && delivery.grantRef === schedule.grantRef &&
      delivery.executorEpoch === this.host.epoch && cycle.generation === delivery.generation &&
      schedule.generation === delivery.generation && cycle.state === 'awaiting-response' &&
      cycle.revision === delivery.cycleRevision && task.revision === delivery.taskRevision &&
      task.status === 'awaiting-user' && (!cycle.relatedBusinessTaskId || store.getTask(cycle.relatedBusinessTaskId)?.status !== 'done'))
  }

  private view(delivery: ReminderDeliveryRecord): DesktopReminderDelivery {
    const { deliveryId, occurrenceId, operationId, taskId, taskRevision, cycleId, cycleRevision, title, message, executorEpoch, channel, recipientRef } = delivery
    return { deliveryId, occurrenceId, operationId, taskId, taskRevision, cycleId, cycleRevision, title, message, executorEpoch, channel, recipientRef }
  }

  list(channel: 'desktop' | 'wecom' = 'desktop'): DesktopReminderDelivery[] {
    return this.host.store.listReminderDeliveries().filter(delivery => delivery.state === 'pending' &&
      delivery.channel === channel && this.validDelivery(delivery)).map(delivery => this.view(delivery))
  }

  claim(deliveryId: string, body: unknown): DesktopReminderDelivery {
    const request = reminderClaimSchema.parse(body)
    if (request.executorEpoch !== this.host.epoch) throw new CompanionError('EPOCH_MISMATCH', '执行器代次已失效')
    return this.host.store.transaction(() => {
      const delivery = this.host.store.getReminderDelivery(deliveryId)
      if (!delivery || !this.host.acceptsRecipient(delivery.channel === 'wecom' ? 'wecom' : 'desktop', delivery.recipientRef, delivery.taskId)) {
        throw new CompanionError('NOT_FOUND', '投递不存在', 404)
      }
      if (delivery.state !== 'pending' || !this.validDelivery(delivery)) throw new CompanionError('ALREADY_CLAIMED', '投递已领取或已失效，禁止再次显示')
      if (!this.host.approvals.markRunning(delivery.operationId)) throw new CompanionError('ALREADY_CLAIMED', '操作已失效，禁止显示')
      this.host.store.insertRun({ runId: delivery.deliveryId, taskId: delivery.taskId, assistantId: 'executor:reminder',
        childSessionId: null, messageId: null, state: 'running', stopReason: null, outputDigest: null,
        startedAt: this.host.now(), endedAt: null })
      this.host.store.saveReminderDelivery({ ...delivery, state: 'sending', attemptCount: 1, submittedAt: this.host.now() })
      return this.view(delivery)
    })
  }

  receipt(deliveryId: string, body: unknown): { deliveryId: string; state: string } {
    const receipt = reminderReceiptSchema.parse(body)
    if (receipt.executorEpoch !== this.host.epoch) throw new CompanionError('EPOCH_MISMATCH', '执行器代次已失效')
    const { store, approvals } = this.host
    return store.transaction(() => {
      const delivery = store.getReminderDelivery(deliveryId)
      if (!delivery || !this.host.acceptsRecipient(delivery.channel === 'wecom' ? 'wecom' : 'desktop', delivery.recipientRef, delivery.taskId)) {
        throw new CompanionError('NOT_FOUND', '投递不存在', 404)
      }
      if (delivery.executorEpoch !== receipt.executorEpoch) throw new CompanionError('EPOCH_MISMATCH', '领取代次已失效')
      const digest = digestOf(receipt)
      if (delivery.receiptDigest === digest) return { deliveryId, state: delivery.state }
      if (delivery.state !== 'sending') throw new CompanionError('RECEIPT_CONFLICT', '未领取或已有回执，不能覆盖')
      const state = receipt.state === 'succeeded' ? 'accepted' : receipt.state === 'failed-before-effect' ? 'failed-before-send' : receipt.state
      const operationState = state === 'accepted' ? 'succeeded' : state === 'failed-before-send' ? 'failed' : 'unknown'
      store.saveReminderDelivery({ ...delivery, state, receiptDigest: digest, evidenceRefs: receipt.evidenceRefs,
        acceptedAt: state === 'accepted' ? this.host.now() : null })
      approvals.settle(delivery.operationId, operationState, digest, state === 'accepted' ? '系统已接受通知，不代表本人已回应' : '桌面执行器回执')
      store.setOperationEvidence(delivery.operationId, { grantRef: delivery.grantRef, occurrenceId: delivery.occurrenceId, ...receipt })
      store.finishRun(deliveryId, operationState, '桌面执行器回执', digest)
      const task = this.host.ownedTask(delivery.taskId)
      const artifact = store.insertCompanionArtifact(task.taskId, delivery.operationId, receipt, this.host.now())
      this.host.changeTask(task.taskId, operationState === 'unknown' ? 'unknown' : task.status, undefined, [...task.artifacts, artifact])
      store.appendEvent('task.artifact', { taskId: task.taskId, artifactId: artifact }, { taskId: task.taskId })
      const cycle = store.getReminderCycle(delivery.cycleId)!
      if (operationState === 'unknown') this.holdUnknown(cycle)
      else if (['scheduled', 'awaiting-response', 'snoozed'].includes(cycle.state)) {
        const next = { ...cycle, nextNagAt: Math.max(cycle.nextNagAt ?? 0, this.host.now() + cycle.repeatIntervalMs) }
        store.saveReminderCycle(next)
        this.event(next)
      }
      return { deliveryId, state }
    })
  }

  private holdUnknown(cycle: ReminderCycleRecord): void {
    const { store } = this.host
    const schedule = store.getCompanionSchedule(cycle.scheduleId)!
    store.saveCompanionSchedule({ ...schedule, enabled: false })
    const grant = store.getReminderGrant(schedule.grantRef)
    if (grant) store.saveReminderGrant({ ...grant, enabled: false })
    const next: ReminderCycleRecord = { ...cycle, state: ['acknowledged', 'cancelled'].includes(cycle.state) ? cycle.state : 'unknown',
      nextNagAt: null, revision: cycle.revision + 1 }
    store.saveReminderCycle(next)
    for (const taskId of [cycle.childTaskId, schedule.taskId]) {
      if (!TERMINAL_TASK_STATUSES.includes(this.host.ownedTask(taskId).status)) this.host.changeTask(taskId, 'unknown')
    }
    this.event(next)
  }

  private cancelPending(cycle: ReminderCycleRecord): boolean {
    let inFlight = false
    for (const delivery of this.host.store.listReminderDeliveries().filter(item => item.cycleId === cycle.cycleId)) {
      if (delivery.state === 'pending') {
        this.host.store.saveReminderDelivery({ ...delivery, state: 'cancelled' })
        this.host.approvals.settle(delivery.operationId, 'failed', null, '尚未领取的投递已作废')
      }
      if (['sending', 'unknown', 'partial'].includes(delivery.state)) inFlight = true
    }
    return inFlight
  }

  respond(response: ReminderResponse): Task {
    const { store } = this.host
    const cycle = store.getReminderCycle(response.cycleId)
    if (!cycle) throw new CompanionError('NOT_FOUND', '提醒周期不存在', 404)
    this.host.ownedTask(cycle.childTaskId)
    if (cycle.revision !== response.expectedCycleRevision) throw new CompanionError('STALE_REVISION', '提醒周期已变化，请刷新')
    if (['acknowledged', 'cancelled'].includes(cycle.state)) throw new CompanionError('CYCLE_CLOSED', '本轮提醒已经结束')
    if (response.action === 'snooze' && (cycle.state === 'unknown' || Date.parse(response.snoozedUntil!) <= this.host.now())) {
      throw new CompanionError('INVALID_SNOOZE', '结果未知不能重排，延后时间必须晚于当前时间', 422)
    }
    const inFlight = this.cancelPending(cycle)
    const next: ReminderCycleRecord = { ...cycle, revision: cycle.revision + 1,
      state: response.action === 'ack' ? 'acknowledged' : response.action === 'cancel' ? 'cancelled' : 'snoozed',
      nextNagAt: response.action === 'snooze' ? Date.parse(response.snoozedUntil!) : null,
      snoozedUntil: response.action === 'snooze' ? Date.parse(response.snoozedUntil!) : null,
      ackActorId: response.action === 'ack' ? this.host.principalId : null,
      ackAt: response.action === 'ack' ? this.host.now() : null }
    store.saveReminderCycle(next)
    const task = this.host.changeTask(cycle.childTaskId, inFlight ? 'unknown' : response.action === 'ack' ? 'done' : response.action === 'cancel' ? 'cancelled' : 'awaiting-user')
    const schedule = store.getCompanionSchedule(cycle.scheduleId)!
    if (response.action !== 'snooze' && schedule.spec.kind === 'once') {
      store.saveCompanionSchedule({ ...schedule, enabled: false })
      this.host.changeTask(schedule.taskId, inFlight ? 'unknown' : response.action === 'ack' ? 'done' : 'cancelled')
    }
    if (inFlight) this.holdUnknown(next)
    this.event(next)
    return this.host.ownedTask(task.taskId)
  }

  control(taskId: string, action: 'pause' | 'resume' | 'cancel' | 'reschedule', operationId: string, spec?: ReminderSchedule): void {
    const { store } = this.host
    const schedule = store.listCompanionSchedules().find(item => item.taskId === taskId)
    if (!schedule) throw new CompanionError('NOT_FOUND', '提醒计划不存在', 404)
    const task = this.host.ownedTask(taskId)
    if ((action === 'resume' || action === 'reschedule') && task.status === 'unknown') throw new CompanionError('RESULT_UNKNOWN', '存在结果未知的通知，禁止自动重发')
    let inFlight = task.status === 'unknown'
    for (const cycle of store.listReminderCycles().filter(item => item.scheduleId === schedule.scheduleId)) {
      if (['acknowledged', 'cancelled'].includes(cycle.state)) continue
      inFlight = this.cancelPending(cycle) || inFlight
      if (action === 'pause' || action === 'resume') {
        const next = { ...cycle, nextNagAt: action === 'pause' ? null : this.host.now(), revision: cycle.revision + 1 }
        store.saveReminderCycle(next)
        this.host.changeTask(cycle.childTaskId, inFlight ? 'unknown' : action === 'pause' ? 'queued' : 'awaiting-user', action === 'pause' ? 'manual-pause' : null)
        this.event(next)
      } else {
        const next: ReminderCycleRecord = { ...cycle, state: 'cancelled', nextNagAt: null, revision: cycle.revision + 1 }
        store.saveReminderCycle(next)
        this.host.changeTask(cycle.childTaskId, inFlight ? 'unknown' : 'cancelled')
        this.event(next)
      }
    }
    const next: CompanionScheduleRecord = { ...schedule, revision: schedule.revision + 1,
      generation: schedule.generation + 1, spec: spec ?? schedule.spec,
      nextRunAt: action === 'reschedule' ? firstScheduleAt(spec!, this.host.now()) : schedule.nextRunAt,
      enabled: !inFlight && (action === 'resume' || action === 'reschedule') }
    this.host.changeTask(taskId, inFlight ? 'unknown' : action === 'cancel' ? 'cancelled' : 'queued', action === 'pause' && !inFlight ? 'manual-pause' : null)
    this.authorize(next, operationId)
    if (action === 'pause' || action === 'resume') {
      for (const cycle of store.listReminderCycles().filter(item => item.scheduleId === schedule.scheduleId && !['acknowledged', 'cancelled'].includes(item.state))) {
        store.saveReminderCycle({ ...cycle, generation: next.generation, grantRef: next.grantRef })
      }
    }
  }

  assertIntervalEditable(taskId: string): void {
    const { store } = this.host
    const schedule = store.listCompanionSchedules().find(item => item.taskId === taskId)
    if (!schedule) throw new CompanionError('NOT_FOUND', '提醒计划不存在', 404)
    const cycles = store.listReminderCycles().filter(item => item.scheduleId === schedule.scheduleId)
    if (this.host.ownedTask(taskId).status === 'unknown' || cycles.some(cycle => cycle.state === 'unknown') ||
      store.listReminderDeliveries().some(delivery => cycles.some(cycle => cycle.cycleId === delivery.cycleId) &&
        ['sending', 'unknown', 'partial'].includes(delivery.state))) {
      throw new CompanionError('DELIVERY_UNSETTLED', '通知正在投递或结果未知，请先核对投递结果再修改间隔')
    }
  }

  setInterval(taskId: string, seconds: number, operationId: string): void {
    this.assertIntervalEditable(taskId)
    const { store } = this.host
    const schedule = store.listCompanionSchedules().find(item => item.taskId === taskId)!
    const input = { ...this.input(taskId), schedule: schedule.spec, repeatEverySeconds: seconds }
    const inputRef = randomUUID()
    store.insertCompanionInput({ inputRef, principalId: this.host.principalId, input, digest: digestOf(input), createdAt: this.host.now() })
    const parent = this.host.ownedTask(taskId)
    store.saveCompanionMeta({ ...store.getCompanionMeta(taskId)!, inputRef })
    this.host.changeTask(taskId, parent.status)
    const next = { ...schedule, revision: schedule.revision + 1, generation: schedule.generation + 1 }
    this.authorize(next, operationId)
    for (const cycle of store.listReminderCycles().filter(item => item.scheduleId === schedule.scheduleId && !['acknowledged', 'cancelled'].includes(item.state))) {
      this.cancelPending(cycle)
      store.saveCompanionMeta({ ...store.getCompanionMeta(cycle.childTaskId)!, inputRef })
      this.host.changeTask(cycle.childTaskId, this.host.ownedTask(cycle.childTaskId).status)
      const updated = { ...cycle, repeatIntervalMs: seconds * 1000, revision: cycle.revision + 1,
        generation: next.generation, grantRef: next.grantRef,
        nextNagAt: cycle.nextNagAt === null || cycle.state === 'snoozed' || cycle.state === 'scheduled'
          ? cycle.nextNagAt : this.host.now() + seconds * 1000 }
      store.saveReminderCycle(updated)
      this.event(updated)
    }
  }

  cancelRelated(taskId: string, operationId: string): void {
    for (const schedule of this.host.store.listCompanionSchedules()) {
      if (this.host.store.getCompanionMeta(schedule.taskId)?.principalId !== this.host.principalId) continue
      if (this.input(schedule.taskId).relatedBusinessTaskId === taskId && !TERMINAL_TASK_STATUSES.includes(this.host.ownedTask(schedule.taskId).status)) {
        this.control(schedule.taskId, 'cancel', operationId)
      }
    }
  }

  recover(): void {
    const { store } = this.host
    const ownsTask = (taskId: string): boolean => {
      const meta = store.getCompanionMeta(taskId)
      return store.getTaskRuntimeScope(taskId) === 'companion' && meta?.runtimeScope === 'companion' &&
        meta.principalId === this.host.principalId && meta.deviceId === this.host.deviceId
    }
    store.transaction(() => {
      for (const delivery of store.listReminderDeliveries()) {
        // 账本恢复只按任务归属判断，不依赖收件人、渠道在线状态或当前绑定策略。
        if (!['pending', 'sending'].includes(delivery.state) || !ownsTask(delivery.taskId)) continue
        const cycle = store.getReminderCycle(delivery.cycleId)
        const schedule = cycle && store.getCompanionSchedule(cycle.scheduleId)
        if (!cycle || cycle.childTaskId !== delivery.taskId || !schedule || !ownsTask(schedule.taskId)) continue
        if (delivery.state === 'sending') {
          store.saveReminderDelivery({ ...delivery, state: 'unknown' })
          this.host.approvals.settle(delivery.operationId, 'unknown', null, '执行器退出前没有确定回执，禁止重发')
          store.finishRun(delivery.deliveryId, 'unknown', '执行器回执缺失', null)
          this.holdUnknown(cycle)
        } else if (delivery.state === 'pending') {
          store.saveReminderDelivery({ ...delivery, executorEpoch: this.host.epoch })
        }
      }
    })
  }
}
