/**
 * 口令式打断的行为契约：只有明确口令才停朗读。
 *
 * 这条规则来自现场问题：外放时助理自己的回声被当成插话，朗读频繁"说一半自己停了"。
 * 把"任何声音"改成"明确口令"，回声与闲聊就不再能打断朗读。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isNarrationEcho, parseInterruptPhrase, planInterruptInput, plausibleDirectQuestion } from '../src/voice-conversation.ts'

test('讲解插话的停一下进入后续听写，口令后直接带问题时只发送问题', () => {
  assert.deepEqual(planInterruptInput('停一下', true), { action: 'listen' })
  assert.deepEqual(planInterruptInput('停一下，这段什么意思？', true), { action: 'send', text: '这段什么意思？' })
  assert.deepEqual(planInterruptInput('这里是什么意思？', true), { action: 'direct' })
  assert.deepEqual(planInterruptInput('普通环境声', false), { action: 'ignore' })
})

test('直接提问的门槛：咳嗽、单字回声、被截断的口令尾巴都不打断讲解', () => {
  assert.equal(plausibleDirectQuestion('第三段再讲一遍'), true)
  assert.equal(plausibleDirectQuestion('为什么'), true)
  assert.equal(plausibleDirectQuestion('嗯'), false)
  assert.equal(plausibleDirectQuestion('啊？'), false)
  assert.equal(plausibleDirectQuestion('い下。'), false, '"停一下"只识别出尾巴时不能当提问')
  assert.equal(plausibleDirectQuestion('。。。'), false)
  assert.equal(plausibleDirectQuestion('   '), false)
})

describe('parseInterruptPhrase', () => {
  for (const word of ['停一下', '等等', '等一下', '打断一下', '暂停', '停下来', '别说了', '先别说', '安静一下', '停', '停！',
    '暂停一下', '稍等一下', '稍等', '等会', '等会儿', '先停一下']) {
    test(`识别口令「${word}」`, () => {
      const result = parseInterruptPhrase(word)
      assert.equal(result.matched, true, `${word} 应被识别为打断口令`)
    })
  }

  for (const word of ['稍微等一下', '请你停一下', '麻烦先停一下', '我说停一下', '嗯，停一下']) {
    test(`带客套前缀的口令「${word}」也识别`, () => {
      assert.equal(parseInterruptPhrase(word).matched, true, `${word} 应被识别为打断口令`)
      assert.equal(parseInterruptPhrase(word).rest, '', '整句只有口令时不该残留"问题"')
    })
  }

  test('真提问里出现"停一下"不算口令', () => {
    assert.equal(parseInterruptPhrase('为什么停一下就没声了').matched, false)
  })

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

describe('休息口令', () => {
  test('休息一下进入休息，与提问暂停分开', () => {
    assert.deepEqual(planInterruptInput('休息一下', true), { action: 'rest' })
    assert.deepEqual(planInterruptInput('大家休息一下', true), { action: 'rest' })
    assert.deepEqual(planInterruptInput('休息一会儿', false), { action: 'rest' })
    assert.deepEqual(planInterruptInput('我们休息一下', true), { action: 'rest' })
    assert.deepEqual(planInterruptInput('停一下', true), { action: 'listen' }, '停一下仍是提问暂停')
  })
  test('讨论里带休息字样不误判成休息', () => {
    assert.notEqual(planInterruptInput('我们休息讨论一下这个问题', true).action, 'rest')
    assert.notEqual(planInterruptInput('休息区在哪', true).action, 'rest')
  })
})

describe('念稿回声门禁', () => {
  test('口令落在正在念的段落里判回声', () => {
    assert.equal(isNarrationEcho('停一下', '请大家停一下，注意这里的配置。'), true)
    assert.equal(isNarrationEcho('等一下', '我们等一下再看结果。'), true)
    assert.equal(isNarrationEcho('稍微等一下', '我们稍微等一下再看。'), true, '客套前缀剥掉后仍判回声')
  })
  test('念的段落里没有口令则不算回声（真打断放行）', () => {
    assert.equal(isNarrationEcho('停一下', '这一段讲音频处理的流程。'), false)
    assert.equal(isNarrationEcho('停一下', ''), false)
  })
  test('非口令不参与回声判定', () => {
    assert.equal(isNarrationEcho('这段什么意思', '这段什么意思呢'), false)
  })
})
