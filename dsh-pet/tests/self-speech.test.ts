/**
 * 自回声过滤的行为契约。
 *
 * 现场故障：助理外放说了「我在这儿，你说。」，麦克风录到后识别成「我在这。」，
 * 当成用户发言发进了会话。这条规则负责把这类回声挡掉，同时不能误伤用户真正说的话。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SELF_SPEECH_TTL_MS, isSelfSpeech, rememberSelfSpeech, resetSelfSpeech } from '../src/renderer/self-speech.ts'

describe('自回声过滤', () => {
  beforeEach(() => resetSelfSpeech())

  test('同一句原样返回：判为回声', () => {
    rememberSelfSpeech('我在这儿，你说。')
    assert.equal(isSelfSpeech('我在这儿，你说。'), true)
  })

  test('标点差异不影响判断', () => {
    rememberSelfSpeech('我在这儿，你说。')
    assert.equal(isSelfSpeech('我在这儿 你说'), true)
  })

  test('识别截断 / 错字：仍判为回声（现场真实案例）', () => {
    // 助理说「我在这儿，你说。」，识别成「我在这。」——必须挡住。
    rememberSelfSpeech('我在这儿，你说。')
    assert.equal(isSelfSpeech('我在这'), true)
    rememberSelfSpeech('好，不说了，你讲。')
    assert.equal(isSelfSpeech('好不说了你讲'), true)
  })

  test('用户接着说的话必须放行', () => {
    rememberSelfSpeech('我在呢，说吧。')
    // 用户说的是完整需求：长度与内容差得远，不能吞。
    assert.equal(isSelfSpeech('我在呢帮我看一下这个报错是怎么回事'), false)
  })

  test('完全无关的内容不受影响', () => {
    rememberSelfSpeech('我在呢，说吧。')
    assert.equal(isSelfSpeech('帮我总结会议纪要'), false)
  })

  test('同一句回声只挡一次（用户复述一次要能说出口）', () => {
    rememberSelfSpeech('来啦，你说。')
    assert.equal(isSelfSpeech('来啦你说'), true)
    assert.equal(isSelfSpeech('来啦你说'), false, '第二次不当回声，否则用户复述会被一直吞掉')
  })

  test('超过有效期不再当回声', () => {
    const base = 1_000_000
    rememberSelfSpeech('我在呢，说吧。', base)
    assert.equal(isSelfSpeech('我在呢说吧', base + SELF_SPEECH_TTL_MS + 1), false)
  })

  test('空文本不算回声', () => {
    rememberSelfSpeech('我在呢')
    assert.equal(isSelfSpeech(''), false)
    assert.equal(isSelfSpeech('   '), false)
  })
})
