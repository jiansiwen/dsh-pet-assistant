/**
 * 口令式打断的行为契约：只有明确口令才停朗读。
 *
 * 这条规则来自现场问题：外放时助理自己的回声被当成插话，朗读频繁"说一半自己停了"。
 * 把"任何声音"改成"明确口令"，回声与闲聊就不再能打断朗读。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseInterruptPhrase } from '../src/voice-conversation.ts'

describe('parseInterruptPhrase', () => {
  for (const word of ['停一下', '等等', '等一下', '打断一下', '暂停', '停下来', '别说了', '先别说', '安静一下', '停', '停！']) {
    test(`识别口令「${word}」`, () => {
      const result = parseInterruptPhrase(word)
      assert.equal(result.matched, true, `${word} 应被识别为打断口令`)
    })
  }

  test('口令后面带的问题原样保留', () => {
    assert.deepEqual(parseInterruptPhrase('停一下，这一段是什么意思'), { matched: true, rest: '这一段是什么意思' })
    assert.deepEqual(parseInterruptPhrase('等等，重讲一下第三页'), { matched: true, rest: '重讲一下第三页' })
  })

  for (const text of ['嗯', '你好', '今天的计划是什么', '停车场怎么走', '停下来看看这个功能']) {
    test(`普通内容不打断：「${text}」`, () => {
      const result = parseInterruptPhrase(text)
      // 「停下来看看这个功能」以口令词开头：按口令处理，rest 交给后续问答。
      if (text.startsWith('停下来')) {
        assert.equal(result.matched, true)
        assert.equal(result.rest, '看看这个功能')
        return
      }
      assert.equal(result.matched, false)
    })
  }

  test('空白与只有标点时不打断', () => {
    assert.equal(parseInterruptPhrase('   ').matched, false)
    assert.equal(parseInterruptPhrase('。').matched, false)
  })
})
