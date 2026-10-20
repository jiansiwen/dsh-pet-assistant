/**
 * 固定话术与语音缓存的行为契约。
 *
 * 两件事必须钉住：
 * 1. 应答话术不能只有一句（听多了会烦），也不能超长（它只是"我听见了"的信号）。
 * 2. 缓存按「音色 + 文本」区分：换音色必须失效重合成，换回旧音色仍可复用旧音频。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { INTERRUPT_ACKS, LOCAL_ACKS, MAX_GREETING_CHARS, WAKE_GREETINGS, fixedPhrases, pickPhrase } from '../src/main/greetings.ts'
import { TtsCache, voiceFingerprint } from '../src/main/tts-cache.ts'

describe('唤醒应答话术', () => {
  test('有多种说法（不是固定一句）', () => {
    assert.ok(WAKE_GREETINGS.length >= 6, `只有 ${WAKE_GREETINGS.length} 句，太单调`)
    assert.ok(new Set(WAKE_GREETINGS).size === WAKE_GREETINGS.length, '有重复句子')
  })

  test('每句都短到像应答而不是回答', () => {
    for (const line of [...WAKE_GREETINGS, ...INTERRUPT_ACKS, ...LOCAL_ACKS]) {
      assert.ok(line.length <= MAX_GREETING_CHARS, `「${line}」太长（${line.length} 字）`)
      assert.ok(line.trim().length > 0, '不能有空句子')
    }
  })

  test('pickPhrase 覆盖全部并处理边界', () => {
    assert.equal(pickPhrase(['a', 'b'], () => 0), 'a')
    assert.equal(pickPhrase(['a', 'b'], () => 0.9999), 'b')
    assert.equal(pickPhrase([], () => 0.5), '')
  })

  test('fixedPhrases 去重且并集完整', () => {
    const all = fixedPhrases()
    assert.equal(new Set(all).size, all.length)
    assert.equal(all.length, new Set([...WAKE_GREETINGS, ...INTERRUPT_ACKS, ...LOCAL_ACKS]).size)
  })
})

describe('语音缓存', () => {
  test('同一音色同一句命中，换音色不命中', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tts-cache-test-'))
    try {
      const cache = new TtsCache(dir)
      const a = voiceFingerprint({ provider: 'mimo', model: 'mimo-v2.5-tts', voice: '冰糖' })
      const b = voiceFingerprint({ provider: 'mimo', model: 'mimo-v2.5-tts', voice: '茉莉' })
      assert.notEqual(a, b, '不同音色必须是不同指纹')

      cache.put({ voiceKey: a, text: '我在呢。' }, Buffer.from('wav-冰糖'))
      assert.deepEqual(cache.get({ voiceKey: a, text: '我在呢。' }), Buffer.from('wav-冰糖'))
      // 换音色：同一句话必须没有缓存（要重新合成）。
      assert.equal(cache.get({ voiceKey: b, text: '我在呢。' }), null)
      // 同一音色、不同句子：不能串。
      assert.equal(cache.get({ voiceKey: a, text: '来啦，你说。' }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('换回旧音色仍可复用旧音频', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tts-cache-test-'))
    try {
      const cache = new TtsCache(dir)
      const a = voiceFingerprint({ provider: 'mimo', voice: '冰糖' })
      const b = voiceFingerprint({ provider: 'mimo', voice: '茉莉' })
      cache.put({ voiceKey: a, text: '我在。' }, Buffer.from('a'))
      cache.put({ voiceKey: b, text: '我在。' }, Buffer.from('b'))
      assert.deepEqual(cache.get({ voiceKey: a, text: '我在。' }), Buffer.from('a'))
      assert.deepEqual(cache.get({ voiceKey: b, text: '我在。' }), Buffer.from('b'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('指纹纳入服务地址与模型：同名音色换服务不算命中', () => {
    const one = voiceFingerprint({ provider: 'mimo', endpoint: 'https://a/v1', model: 'm1', voice: '冰糖' })
    const two = voiceFingerprint({ provider: 'mimo', endpoint: 'https://b/v1', model: 'm1', voice: '冰糖' })
    assert.notEqual(one, two)
  })
})


