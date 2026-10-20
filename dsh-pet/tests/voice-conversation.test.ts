import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTINUOUS_IDLE_TIMEOUT_MS, CONTINUOUS_VOICE_LIMIT_MS, CONTINUOUS_VOICE_MAX_ROUNDS, VoiceConversation, isVoiceStop,
} from '../src/voice-conversation.ts'

const T0 = 1_000_000

function started(now = T0): VoiceConversation {
  const conversation = new VoiceConversation()
  assert.equal(conversation.start('绑定A', true, true, now), true)
  return conversation
}

/** 走完一轮：录音 → 提交 → 生成返回 → 实际播完。返回是否允许续听。 */
function round(conversation: VoiceConversation, now = T0): boolean {
  assert.equal(conversation.record(conversation.generation, conversation.bindingId, now), true)
  const turn = conversation.submit(now)
  assert.ok(turn)
  assert.equal(conversation.result(turn, true, now), false, '只有生成结果、还没播完，不能续听')
  return conversation.complete({ ...turn, outcome: 'played' }, now)
}

test('默认关闭：任一选项未开或缺少绑定都不进入连续对话', () => {
  const conversation = new VoiceConversation()
  assert.equal(conversation.active, false)
  assert.equal(conversation.start('绑定A', true, false), false)
  assert.equal(conversation.start('绑定A', false, true), false)
  assert.equal(conversation.start('', true, true), false)
  assert.equal(conversation.active, false)
})

test('生成结束且实际播完才续听一次；回执先到、结果后到也只续听一次', () => {
  const conversation = started()
  assert.equal(round(conversation), true)
  assert.equal(conversation.phase, 'waiting')

  assert.equal(conversation.record(conversation.generation, '绑定A', T0), true)
  const turn = conversation.submit(T0)!
  assert.equal(conversation.complete({ ...turn, outcome: 'played' }, T0), false, '播完回执先到，结果没回来前不续听')
  assert.equal(conversation.result(turn, true, T0), true)
  assert.equal(conversation.complete({ ...turn, outcome: 'played' }, T0), false, '重复回执不能再续听一次')
  assert.equal(conversation.result(turn, true, T0), false, '重复结果不能再续听一次')
})

test('未播出、被停止或路径被排除都结束连续对话', () => {
  for (const outcome of ['stopped', 'excluded'] as const) {
    const conversation = started()
    conversation.record(conversation.generation, '绑定A', T0)
    const turn = conversation.submit(T0)!
    assert.equal(conversation.complete({ ...turn, outcome }, T0), false)
    assert.equal(conversation.active, false, outcome)
  }
  const failed = started()
  failed.record(failed.generation, '绑定A', T0)
  assert.equal(failed.result(failed.submit(T0)!, false, T0), false)
  assert.equal(failed.active, false, '无回复或提交失败不续听')
})

test('旧代号、其他绑定和旧轮次的迟到事件全部丢弃', () => {
  const conversation = started()
  conversation.record(conversation.generation, '绑定A', T0)
  const old = conversation.submit(T0)!
  conversation.stop()
  assert.equal(conversation.complete({ ...old, outcome: 'played' }, T0), false)
  assert.equal(conversation.result(old, true, T0), false)
  assert.equal(conversation.record(old.generation, '绑定A', T0), false, '停止后旧代号不能重新开麦')

  assert.equal(conversation.start('绑定A', true, true, T0), true)
  assert.notEqual(conversation.generation, old.generation)
  assert.equal(conversation.record(conversation.generation, '绑定B', T0), false, '换绑后的事件不属于本轮')
  conversation.record(conversation.generation, '绑定A', T0)
  const current = conversation.submit(T0)!
  assert.equal(conversation.complete({ ...current, roundId: `${current.generation}:99`, outcome: 'played' }, T0), false)
  assert.equal(conversation.phase, 'generating', '别的轮次回执不推进本轮')
})

test('最多十轮，第十轮播完即结束', () => {
  const conversation = started()
  for (let index = 1; index < CONTINUOUS_VOICE_MAX_ROUNDS; index++) assert.equal(round(conversation), true, `第 ${index} 轮`)
  assert.equal(round(conversation), false)
  assert.equal(conversation.active, false)
  assert.equal(conversation.rounds, CONTINUOUS_VOICE_MAX_ROUNDS)
})

test('五分钟墙钟到期：不再开麦、不再提交，正在播的轮次播完后结束', () => {
  const expired = started()
  assert.equal(expired.record(expired.generation, '绑定A', T0 + CONTINUOUS_VOICE_LIMIT_MS), false)

  const recording = started()
  recording.record(recording.generation, '绑定A', T0)
  assert.equal(recording.submit(T0 + CONTINUOUS_VOICE_LIMIT_MS), null, '到期后说完的话不再自动发送')

  const playing = started()
  playing.record(playing.generation, '绑定A', T0)
  const turn = playing.submit(T0)!
  const late = T0 + CONTINUOUS_VOICE_LIMIT_MS + 1
  assert.equal(playing.result(turn, true, late), false)
  assert.equal(playing.complete({ ...turn, outcome: 'played' }, late), false)
})

test('结束口令只认整句，不误伤普通问句', () => {
  for (const text of ['先这样', '结束对话。', '停止对话！', ' 先这样， ']) assert.equal(isVoiceStop(text), true, text)
  for (const text of ['先这样处理这个文件', '帮我结束对话框', '什么时候停止对话']) assert.equal(isVoiceStop(text), false, text)
})

test('长回答：生成与播放期间静默窗到期，也不影响这一轮播完后续听', () => {
  const conversation = started()
  assert.equal(conversation.record(conversation.generation, '绑定A', T0), true)
  const turn = conversation.submit(T0)!
  // 现场故障就是这么来的：回答合成、播放加起来远超 10 秒，若拿静默窗判有效，播完那一刻整场对话已经失效。
  const late = T0 + CONTINUOUS_IDLE_TIMEOUT_MS * 3
  assert.equal(conversation.result(turn, true, late), false, '只有结果、还没播完，不能续听')
  assert.equal(conversation.complete({ ...turn, outcome: 'played' }, late + 5_000), true, '播完就该续听')
  assert.equal(conversation.phase, 'waiting')
  assert.equal(conversation.record(conversation.generation, '绑定A', late + 5_001), true)
})

test('静默窗从"开始等用户开口"算：到期不再开麦，重新计时后又能听', () => {
  const expired = started()
  assert.equal(expired.record(expired.generation, '绑定A', T0 + CONTINUOUS_IDLE_TIMEOUT_MS), false, '到期即不再开麦')
  assert.equal(expired.active, true, '到期只是不开麦，收摊由调用方按截止时间决定')

  const rearmed = started()
  rearmed.awaiting(T0 + CONTINUOUS_IDLE_TIMEOUT_MS)
  assert.equal(rearmed.record(rearmed.generation, '绑定A', T0 + CONTINUOUS_IDLE_TIMEOUT_MS + 1), true)
})

test('播完后的静默窗按播完那一刻重新起算', () => {
  const conversation = started()
  let at = T0 + 1_000
  for (let index = 1; index <= 2; index++) {
    assert.equal(conversation.record(conversation.generation, '绑定A', at), true, `第 ${index} 轮开麦`)
    const turn = conversation.submit(at)!
    assert.equal(conversation.result(turn, true, at), false)
    // 这一轮念了 20 秒，比静默窗还长；播完仍然算数。
    const playedAt = at + CONTINUOUS_IDLE_TIMEOUT_MS * 2
    assert.equal(conversation.complete({ ...turn, outcome: 'played' }, playedAt), true, `第 ${index} 轮播完续听`)
    assert.equal(conversation.idleDeadline, playedAt + CONTINUOUS_IDLE_TIMEOUT_MS)
    at = playedAt + 1_000
  }
})
