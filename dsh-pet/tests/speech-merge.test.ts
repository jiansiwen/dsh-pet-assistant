/**
 * 短句合并：用户的要求是"一句小于 10 个字的都合并掉"。
 *
 * 为什么要在意：每发一次合成请求就是一次网络往返，两三个字的句子
 * 音频比往返还短，听感就是每句后面都顿一下。合并后一次合成念完一串，
 * 前瞻预取才有意义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { configureSpeech, splitIntoSegments } from '../src/main/speech.ts'

const request = (text: string) => ({ utteranceId: 'u', text })

function segmentsOf(text: string): string[] {
  configureSpeech({ mergeShortSentences: true })
  const segments = splitIntoSegments(request(text))
  configureSpeech({ mergeShortSentences: false })
  return segments.map(segment => segment.text)
}

void test('几个字的短句会被并成一段', () => {
  const parts = segmentsOf('好。嗯。行。对。')
  assert.equal(parts.length, 1, `被切成 ${parts.length} 段：${parts.join('|')}`)
  assert.ok(parts[0].length >= 4)
})

void test('并到至少 10 个字才发出去', () => {
  const parts = segmentsOf('收到。明白。这就去办。')
  assert.equal(parts.length, 1)
  assert.ok(parts[0].length >= 8)
})

void test('长句不会被硬粘在一起', () => {
  const long = '这是一句话很长的句子用来验证不会被并到别的句子里去。'
  const parts = segmentsOf(`${long}${long}`)
  assert.equal(parts.length, 2, '两个长句应各自成段')
})

void test('合并没有丢字：所有片段拼起来等于原文', () => {
  const text = '先开会。再录音。然后讲文档。最后答疑。'
  const parts = segmentsOf(text)
  assert.equal(parts.join(''), text.replace(/\s+/gu, ''))
})

void test('关掉开关就恢复一句一段', () => {
  configureSpeech({ mergeShortSentences: false })
  const parts = splitIntoSegments(request('好。嗯。行。')).map(segment => segment.text)
  assert.ok(parts.length >= 3, `应当逐句切分，实际 ${parts.length} 段`)
})
