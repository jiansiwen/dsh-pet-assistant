import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TeamStore } from '../src/team-domain.ts'
import { mailTopicKey, MUTE_MAIL } from '../src/member-feedback.ts'

test('按原机器人、原私聊与明确引用接到实际会话，不自动换成员或选择最近一份', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const ledger = store.feedback
  const chat = 'wecom:single:本人'
  const first = { runId: '定时运行一', assistantId: '信使', sessionId: '成员会话一' }
  const second = { runId: '定时运行二', assistantId: '助理二', sessionId: '成员会话二' }
  const reports: string[] = []
  const send = async (text: string) => { reports.push(text); return true }
  assert.equal(await ledger.send('机器人甲', chat, first, '汇报内容一', send), true)
  assert.equal(await ledger.send('机器人甲', chat, first, '不要重复发', send), false)
  assert.equal(ledger.resolve('机器人甲', chat, '这类邮件以后不用提醒').kind, 'reply')
  assert.equal(await ledger.send('机器人甲', chat, second, '汇报内容二', send), true)
  assert.equal(ledger.resolve('机器人甲', chat, '这类邮件以后不用提醒').kind, 'clarify')
  assert.deepEqual(ledger.resolve('机器人甲', chat, '这次帮我建一个提醒'), { kind: 'new' })
  const quoted = ledger.resolve('机器人甲', chat, '这次结果确认正确', reports[0])
  assert.equal(quoted.kind, 'reply')
  assert.equal(quoted.kind === 'reply' && quoted.report.sessionId, first.sessionId)
  assert.equal(ledger.resolve('机器人乙', chat, '确认', reports[0]).kind, 'clarify')
  assert.equal(ledger.resolve('机器人甲', 'wecom:single:其他人', '确认', reports[0]).kind, 'clarify')
  assert.equal(ledger.resolve('机器人甲', 'wecom:group:群', '确认', reports[0]).kind, 'clarify')
  if (quoted.kind !== 'reply') throw new Error('未找到原汇报')
  ledger.replied(quoted.ref)
  const alternate = ledger.resolve('机器人甲', chat, `/新接续 ${quoted.ref} 继续处理`)
  assert.ok(alternate.kind === 'reply' && alternate.fresh && alternate.report.sessionId === first.sessionId)
  assert.equal(reports.length, 2)
})

test('消除提醒只影响可识别的同发件人、同主题邮件，不将一般讨论当命令', () => {
  assert.equal(MUTE_MAIL.test('这类邮件以后不用提醒'), true)
  assert.equal(MUTE_MAIL.test('这类邮件以后不用关注。'), true)
  assert.equal(MUTE_MAIL.test('我想问问这类邮件以后是不是不用提醒'), false)
  assert.equal(mailTopicKey('Test@example.com', '每日通知'), mailTopicKey('test@example.com', 'RE: 每日通知'))
  assert.notEqual(mailTopicKey('test@example.com', '每日通知'), mailTopicKey('test@example.com', '异常告警'))
})
