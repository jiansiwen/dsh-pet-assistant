/**
 * MiMo 语音请求体的形状钉子。
 *
 * 三种音色来源，报文结构各不相同 —— 踩过 400 才确认的：
 * - 预置音色：只放 assistant 消息 + `audio.voice = 音色名`
 * - 音色设计：`user` 放描述、`assistant` 放正文、不带 voice
 * - 音色复刻：样本走 **`audio.voice` 的 data URI**（不是 OpenAI 的 input_audio 消息）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMimoTtsBody } from '../src/main/voice-api.ts'

type Msg = { role: string; content: unknown }

void test('复刻：样本放在 audio.voice，值是 data URI', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts-voiceclone', '', '老板你好。', '', { data: 'AAAA', mime: 'audio/wav' })
  const audio = body.audio as Record<string, unknown>
  assert.equal(audio.voice, 'data:audio/wav;base64,AAAA')
  const messages = body.messages as Msg[]
  assert.equal(messages.length, 1, '复刻只要 assistant 一条')
  assert.equal(messages[0].role, 'assistant')
  assert.equal(messages[0].content, '老板你好。')
})

void test('复刻：样本已带 data: 前缀时不重复拼', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts-voiceclone', '', '文本', '', { data: 'data:audio/mpeg;base64,BBBB' })
  assert.equal((body.audio as Record<string, unknown>).voice, 'data:audio/mpeg;base64,BBBB')
})

void test('复刻：同时给描述时，描述作为风格指令放 user', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts-voiceclone', '', '文本', '语速偏慢', { data: 'S' })
  const messages = body.messages as Msg[]
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, '语速偏慢')
  assert.equal(messages[1].role, 'assistant')
  assert.match(String((body.audio as Record<string, unknown>).voice), /^data:audio\/wav;base64,S$/u)
})

void test('设计：描述放 user，正文放 assistant，不带 voice', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts-voicedesign', '', '老板你好。', '少年男声，语速快。')
  const messages = body.messages as Msg[]
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.match(String(messages[0].content), /少年男声/u)
  assert.equal(messages[1].role, 'assistant')
  assert.equal('voice' in (body.audio as Record<string, unknown>), false)
})

void test('预置音色：没有描述也没有样本时用 voice，缺省 mimo_default', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts', '', '你好。')
  assert.equal((body.audio as Record<string, unknown>).voice, 'mimo_default')
  assert.equal((body.messages as Msg[]).length, 1)
  const named = buildMimoTtsBody('mimo-v2.5-tts', '冰糖', '你好。')
  assert.equal((named.audio as Record<string, unknown>).voice, '冰糖')
})
