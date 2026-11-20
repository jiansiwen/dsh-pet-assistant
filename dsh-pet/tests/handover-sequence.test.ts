/**
 * 交接时序的钉子用例。
 *
 * 钉的是"像真人交接"的三条判断：
 * 1. 只在**真的换人**时触发（派活→上台），连续活动不重复开场；
 * 2. 没人在场时不硬插"我这就来"；
 * 3. 成员自己不出声时，道别不该由他说。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handoverClosing, handoverOpening, isHandoverStart, type HandoverLines } from '../src/main/handover-sequence.ts'

const CHIEF = 'member-tangseng'
const lines: HandoverLines = {
  chiefToUser: '这事我交给小张了。',
  chiefToMember: '小张，老板叫你！',
  memberToChief: '总助，我这就来。',
  memberToUser: '老板你好，接下来由我来讲解。',
  memberFarewell: '老板，那我先退下了。',
}

void test('触发：从没人上台变成某成员上台 = 一次交接', () => {
  assert.equal(isHandoverStart(null, { active: true, assistantId: 'member-zhang' }, CHIEF), true)
  assert.equal(isHandoverStart({ active: false, assistantId: null }, { active: true, assistantId: 'member-zhang' }, CHIEF), true)
})

void test('触发：同一个人继续干，不重复交接', () => {
  assert.equal(isHandoverStart({ active: true, assistantId: 'member-zhang' }, { active: true, assistantId: 'member-zhang' }, CHIEF), false)
})

void test('触发：总助自己上台不算交接；没活动也不算', () => {
  assert.equal(isHandoverStart(null, { active: true, assistantId: CHIEF }, CHIEF), false)
  assert.equal(isHandoverStart(null, { active: false, assistantId: null }, CHIEF), false)
  assert.equal(isHandoverStart(null, { active: true, assistantId: '' }, CHIEF), false)
})

void test('触发：换另一个人上台也算一次交接', () => {
  assert.equal(isHandoverStart({ active: true, assistantId: 'member-zhang' }, { active: true, assistantId: 'member-wang' }, CHIEF), true)
})

void test('开场：总助在场时三句（叫人→应声→成员开口），不重复总助对用户的交代', () => {
  const steps = handoverOpening(lines, { chiefPresent: true })
  assert.deepEqual(steps.map(s => s.speaker), ['chief', 'member', 'member'])
  assert.equal(steps[0].text, lines.chiefToMember)
  assert.equal(steps[2].text, lines.memberToUser)
})

void test('开场：没人在场时只留成员自己那句', () => {
  const steps = handoverOpening(lines, { chiefPresent: false })
  assert.deepEqual(steps, [{ speaker: 'member', text: lines.memberToUser }])
})

void test('开场：空台词被丢掉，不念空字符串', () => {
  // memberToChief 空被丢掉，剩下 chief→member 两句。
  const steps = handoverOpening({ ...lines, memberToChief: '' }, { chiefPresent: true })
  assert.deepEqual(steps.map(s => s.speaker), ['chief', 'member'])
  assert.equal(steps[0].text, lines.chiefToMember)
  assert.equal(steps[1].text, lines.memberToUser)
})

void test('收场：成员自己出声才由他道别，否则总助代说', () => {
  assert.deepEqual(handoverClosing(lines, { memberSpeaks: true }), [{ speaker: 'member', text: lines.memberFarewell }])
  assert.deepEqual(handoverClosing(lines, { memberSpeaks: false }), [{ speaker: 'chief', text: lines.memberFarewell }])
})
