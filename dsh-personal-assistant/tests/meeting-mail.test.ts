/** 真实临时会议库与任务库、模拟桌面桥和 SMTP；不读取用户数据、不外发。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { INITIAL_AUDIO_STATE, nextAudio } from '../../dsh-pet/src/main/audio.ts'
import { MeetingRecorder } from '../../dsh-pet/src/main/meeting-recorder.ts'
import { MeetingStore } from '../../dsh-pet/src/main/meeting-store.ts'
import { AssistantApprovalService, type AssistantSubmission } from '../src/assistant-approval.ts'
import { ApprovalService } from '../src/approval.ts'
import { registerMeetingMailTools } from '../src/meeting-mail.ts'
import type { MailDraft } from '../src/mail.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

const BOT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const RECIPIENT = 'wecom:single:主人'

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-mail-'))
  const configDir = path.join(home, 'personal-assistant')
  const destination = path.join(home, 'selected')
  mkdirSync(configDir); mkdirSync(destination)
  writeFileSync(path.join(configDir, 'mail.json'), JSON.stringify({ host: 'smtp.example.com', port: 465,
    secure: true, user: 'sender@example.com', from: 'sender@example.com' }))
  let now = 1_800_000_000_000
  let bot = BOT
  let binding = true
  const meetingStore = new MeetingStore(path.join(home, 'meeting'), { keyProvider: () => ({ status: 'ok', key: Buffer.alloc(32, 29) }), now: () => now })
  const recorder = new MeetingRecorder({ store: meetingStore, userDataDir: home, audio: event => nextAudio(INITIAL_AUDIO_STATE, event), notifyRenderer: () => {}, now: () => now })
  const started = meetingStore.startMeeting({ name: '隔离会议', sources: 'mic', consented: true, consentText: '参会人知情', retentionDays: 30 },
    { status: 'pending', reasons: [], tracks: {} })
  if (!started.ok) throw new Error(started.error)
  const meetingId = started.meetingId
  assert.ok(meetingStore.appendChunk(meetingId, Buffer.alloc(1600, 3), now, { track: 'mic', trackSeq: 0, startMs: 0, sourceSampleRate: 16_000 }).ok)
  assert.equal(meetingStore.finishRecording(meetingId, { status: 'complete', reasons: [], tracks: { mic: { sent: 0, acknowledged: 0, persisted: 0 } } }), true)
  meetingStore.setMeetingState(meetingId, 'transcribed')
  assert.ok(meetingStore.replaceSegments(meetingId, [{ idx: 0, speaker: 'mic-s1', label: '参会人', uncertain: false,
    startMs: 0, endMs: 1000, text: '会议纪要固定版本', source: 'asr', track: 'mic' }]).ok)
  assert.ok(recorder.useLocalMinutes(meetingId).ok)
  const minutes = meetingStore.getMinutes(meetingId)!
  assert.ok(recorder.confirmMinutes(meetingId, minutes.digest).ok)
  const saved = recorder.saveMinutesFile(meetingId, minutes.revision, minutes.digest, destination)
  if (!saved.ok) throw new Error(saved.error)
  const artifact = saved.artifact
  const store = new TeamStore(path.join(home, 'team.sqlite'))
  let approval = new AssistantApprovalService({ epoch: 'epoch', ttlMs: 60_000, now: () => now })
  const taskApprovals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch', now: () => now })
  const runtime = new CompanionTaskRuntime(store, taskApprovals, { epoch: 'epoch', now: () => now,
    acceptsRecipient: (channel, recipient) => binding && channel === 'wecom' && recipient === RECIPIENT })
  runtime.setChannelAccountKey(() => binding ? bot : null)
  const tools = new Map<string, { execute(args: unknown, exec: { signal: AbortSignal }): Promise<string> }>()
  const exec = { signal: new AbortController().signal }
  const sent: MailDraft[] = []
  let sender = async (draft: MailDraft) => ({ messageId: '测试邮件编号', accepted: draft.to, rejected: [] as string[] })
  let reminderFails = false
  let readGate: Promise<void> | null = null
  const bridge = {
    submitAssistant: (submission: AssistantSubmission) => approval.submit(submission),
    requestDesktopCommand: async (command: string, payload: { artifactId?: string; meetingId?: string }) => {
      if (command === 'meeting.artifact.list') return { meetingId, artifacts: recorder.listMinutesArtifacts(meetingId) }
      if (command !== 'meeting.artifact.read') throw new Error('未知桌面命令')
      if (readGate) await readGate
      const result = recorder.readMinutesArtifact(payload.artifactId ?? '')
      if (!result.ok) throw new Error(result.error)
      return result
    },
  }
  const dispose = registerMeetingMailTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
    { home, store, epoch: 'epoch', bridge: bridge as never, now: () => now, log: () => {}, readSecret: async () => 'fake-secret',
      send: async (_config, _secret, draft) => { sent.push(draft); return sender(draft) },
      wecomBinding: recipient => binding && recipient === RECIPIENT ? { accountKey: bot, botId: '测试机器人' } : null,
      wecomRecipients: () => binding ? [RECIPIENT] : [],
      reminderInterval: () => 60,
      ensureReminder: intentId => { if (reminderFails) throw new Error('模拟提醒登记故障'); return runtime.ensureMeetingMailReminder(intentId) } })
  t.after(async () => { dispose(); await runtime.dispose(); store.close(); meetingStore.close(); rmSync(home, { recursive: true, force: true }) })
  const input = { artifactId: artifact.id, to: 'a@example.com,b@example.com', subject: '完整纪要', reminderRecipientId: RECIPIENT }
  const request = async (override: Partial<typeof input> = {}) => JSON.parse(await tools.get('personal_assistant_send_meeting_minutes')!.execute({ ...input, ...override }, exec)) as {
    ok: boolean; pending?: boolean; proposalId?: string; intentId?: string; error?: string }
  return { artifact, minutes, meetingId, recorder, store, runtime, get approval() { return approval }, sent, tools, request, exec,
    decide: (id: string, decision: 'approve' | 'reject' = 'approve') => approval.decide(id, decision, 'epoch', approval.approvalCapabilityToken),
    tick: () => (runtime as unknown as { tick(): void }).tick(), advance: (ms: number) => { now += ms }, now: () => now,
    setBot: (value: string) => { bot = value }, setBinding: (value: boolean) => { binding = value },
    setSender: (value: typeof sender) => { sender = value }, failReminder: (value: boolean) => { reminderFails = value },
    setReadGate: (gate: Promise<void>) => { readGate = gate },
    restartApproval: () => { approval = new AssistantApprovalService({ epoch: 'epoch', ttlMs: 60_000, now: () => now }) } }
}

test('固定确认版经本人批准原样送交 SMTP，完整接受后创建两分钟企微提醒', async t => {
  const f = fixture(t)
  const listed = JSON.parse(await f.tools.get('personal_assistant_meeting_artifacts')!.execute({ meetingId: f.meetingId }, f.exec))
  assert.equal(listed.artifacts[0].id, f.artifact.id)
  assert.doesNotMatch(JSON.stringify(listed), /会议纪要固定版本/u, '产物列表不把会议正文交给模型')
  const request = await f.request()
  assert.ok(request.pending && request.proposalId && request.intentId)
  assert.equal(f.sent.length, 0)
  const proposal = f.approval.pendingProposals()[0]!
  assert.match(proposal.content, new RegExp(f.artifact.digest))
  assert.match(proposal.content, /会议纪要固定版本/u)
  assert.match(proposal.content, /服务接受.*两分钟|服务接受.*120/u)
  const result = await f.decide(request.proposalId)
  assert.equal(result.ok, true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0]!.text, f.minutes.content, '不能裁剪或重新猜正文')
  const ledger = f.store.getMailSendIntent(request.intentId)!
  assert.equal(ledger.state, 'accepted')
  assert.equal(ledger.acceptedAt, f.now())
  const plan = f.store.getMeetingMailFollowup(request.intentId)!
  assert.equal(plan.artifactId, f.artifact.id)
  assert.equal(plan.meetingId, f.meetingId)
  assert.equal(plan.revision, f.minutes.revision)
  assert.equal(plan.channelAccountKey, BOT)
  assert.ok(plan.taskId)
  assert.equal(f.store.listCompanionSchedules()[0]!.nextRunAt, ledger.acceptedAt! + 120_000)
  assert.equal((await f.decide(request.proposalId)).ok, false)
  assert.equal(f.sent.length, 1)
})

test('只有一个已绑定单聊时可省略提醒会话，但仍展示在批准范围内', async t => {
  const f = fixture(t)
  const result = JSON.parse(await f.tools.get('personal_assistant_send_meeting_minutes')!.execute({
    artifactId: f.artifact.id, to: 'a@example.com', subject: '纪要' }, f.exec))
  assert.equal(result.pending, true)
  assert.ok(f.approval.pendingProposals()[0]!.content.includes(RECIPIENT))
  assert.equal(f.sent.length, 0)
})

test('拒绝批准或批准前纪要文件、会议版本发生变化，均不发送且不创建提醒', async t => {
  const rejected = fixture(t)
  const one = await rejected.request()
  assert.ok(one.proposalId)
  assert.equal((await rejected.decide(one.proposalId, 'reject')).ok, true)
  assert.equal(rejected.sent.length, 0)
  assert.equal(rejected.store.listCompanionSchedules().length, 0)
  const changed = fixture(t)
  const two = await changed.request()
  assert.ok(two.proposalId && two.intentId)
  writeFileSync(changed.artifact.path, '文件已被替换')
  const result = await changed.decide(two.proposalId)
  assert.equal(result.ok, false)
  assert.equal(result.state, 'failed')
  assert.equal(changed.sent.length, 0)
  assert.equal(changed.store.getMailSendIntent(two.intentId), null)
  assert.equal(changed.store.listCompanionSchedules().length, 0)
  const revised = fixture(t)
  const three = await revised.request()
  assert.ok(three.proposalId)
  assert.ok(revised.recorder.renameSpeaker(revised.meetingId, 'mic-s1', '新名字').ok)
  assert.equal((await revised.decide(three.proposalId)).ok, false)
  assert.equal(revised.sent.length, 0)
})

test('机器人或接收会话改变使旧批准失效；更改收件人必须重新审批', async t => {
  const f = fixture(t)
  const first = await f.request()
  assert.ok(first.proposalId)
  f.setBot(OTHER)
  assert.equal((await f.decide(first.proposalId)).ok, false)
  assert.equal(f.sent.length, 0)
  f.setBot(BOT)
  const second = await f.request()
  assert.ok(second.proposalId)
  const third = await f.request({ to: 'other@example.com' })
  assert.ok(third.proposalId)
  assert.equal((await f.decide(second.proposalId)).ok, false)
  assert.match(f.approval.pendingProposals()[0]!.content, /other@example.com/u)
  f.setBinding(false)
  assert.equal((await f.decide(third.proposalId)).ok, false)
  assert.equal(f.sent.length, 0)
})

test('部分或未知发送不创建提醒，相同内容不能盲目重发', async t => {
  for (const kind of ['partial', 'unknown'] as const) {
    const f = fixture(t)
    f.setSender(kind === 'partial'
      ? async () => ({ messageId: '部分接受', accepted: ['a@example.com'], rejected: ['b@example.com'] })
      : async () => { throw new Error('模拟连接断开') })
    const request = await f.request()
    assert.ok(request.proposalId && request.intentId)
    assert.equal((await f.decide(request.proposalId)).state, 'unknown')
    assert.equal(f.store.getMailSendIntent(request.intentId)?.state, kind)
    assert.equal(f.store.getMeetingMailFollowup(request.intentId)?.taskId, null)
    f.advance(300_000); f.tick()
    assert.equal(f.store.listCompanionSchedules().length, 0)
    f.restartApproval()
    assert.equal((await f.request()).ok, false)
    assert.equal((await f.request({ subject: '只改主题' })).ok, false, '不能靠改主题绕过同一纪要的未知或部分发送')
    assert.equal((await f.request({ to: 'another@example.com' })).ok, false, '本人核查前不能对同一产物盲目再次投递')
    const alias = f.recorder.saveMinutesFile(f.meetingId, f.minutes.revision, f.minutes.digest, path.dirname(f.artifact.path))
    assert.ok(alias.ok)
    if (alias.ok) assert.equal((await f.request({ artifactId: alias.artifact.id, subject: '另存版本' })).ok, false,
      '同一会议修订重新导出文件也不能绕过未核查发送')
    assert.equal(f.sent.length, 1)
  }
})

test('同一纪要未知发送经本人核查后，即便修改主题也要在新审批中提示可能重复', async t => {
  const f = fixture(t)
  f.setSender(async () => { throw new Error('结果未知') })
  const first = await f.request()
  assert.ok(first.proposalId && first.intentId)
  assert.equal((await f.decide(first.proposalId)).state, 'unknown')
  const ledger = f.store.getMailSendIntent(first.intentId)!
  assert.equal(f.store.acknowledgeMailSend(first.intentId, ledger.accountKey, 'unknown', f.now()), true)
  assert.equal(f.approval.acknowledgeUnknown('mail', first.intentId), true)
  const next = await f.request({ subject: '改过的主题' })
  assert.equal(next.pending, true)
  assert.match(f.approval.pendingProposals()[0]?.content ?? '', /可能重复/u)
  assert.equal(f.sent.length, 1)
})

test('同一会议修订已被邮件服务接受，再次提交须在新审批中提示可能重复', async t => {
  const f = fixture(t)
  const first = await f.request()
  assert.ok(first.proposalId)
  assert.equal((await f.decide(first.proposalId)).ok, true)
  const alias = f.recorder.saveMinutesFile(f.meetingId, f.minutes.revision, f.minutes.digest, path.dirname(f.artifact.path))
  assert.ok(alias.ok)
  if (!alias.ok) return
  const second = await f.request({ artifactId: alias.artifact.id, subject: '新主题' })
  assert.equal(second.pending, true)
  assert.match(f.approval.pendingProposals()[0]?.content ?? '', /已.*接受.*可能重复/u)
  assert.equal(f.sent.length, 1, '再次提交不能自动外发')
})

test('邮件已接受但提醒登记失败时如实返回待恢复，后续只补提醒不再发信', async t => {
  const f = fixture(t)
  f.failReminder(true)
  const request = await f.request()
  assert.ok(request.proposalId && request.intentId)
  const decision = await f.decide(request.proposalId)
  assert.equal(decision.ok, true)
  assert.equal((decision.result as { followup: { state: string } }).followup.state, 'pending')
  assert.equal(f.store.getMailSendIntent(request.intentId)?.state, 'accepted')
  assert.equal(f.store.listCompanionSchedules().length, 0)
  assert.equal(f.runtime.snapshot().meetingMailAttention[0]?.intentId, request.intentId, '提醒未登记必须能从任务页核查')
  f.failReminder(false)
  f.tick()
  assert.equal(f.store.listCompanionSchedules().length, 1)
  assert.equal(f.runtime.snapshot().meetingMailAttention.length, 0)
  assert.equal(f.sent.length, 1)
})

test('读取产物期间请求被取消，迟到桌面回执不能再生成邮件审批', async t => {
  const f = fixture(t)
  let release!: () => void
  f.setReadGate(new Promise<void>(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = f.tools.get('personal_assistant_send_meeting_minutes')!.execute({ artifactId: f.artifact.id,
    to: 'a@example.com', subject: '纪要', reminderRecipientId: RECIPIENT }, { signal: controller.signal })
  controller.abort()
  release()
  const result = JSON.parse(await pending)
  assert.equal(result.ok, false)
  assert.equal(f.approval.pendingProposals().length, 0)
  assert.equal(f.sent.length, 0)
})

test('会议邮件工具注册中途失败时撤销已注册的工具，不留下半套入口', () => {
  let registered = 0, disposed = 0
  assert.throws(() => registerMeetingMailTools({ tools: { register: () => {
    registered++
    if (registered === 2) throw new Error('模拟注册失败')
    return () => { disposed++ }
  } } }, {} as never), /模拟注册失败/u)
  assert.equal(disposed, 1)
})
