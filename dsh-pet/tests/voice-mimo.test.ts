/**
 * MiMo 语音合成的纯函数契约：请求体与响应解析。
 *
 * 这两个函数钉住的是协议形态——请求文本必须在 assistant 角色、音频参数用预置音色 ID、
 * 响应是 chat.completion 里的 base64 音频。接错任何一处，用户听到的就是"没有声音"或"语音服务出错"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildMimoTtsBody, parseMimoTtsPayload } from '../src/main/voice-api.ts'

describe('buildMimoTtsBody', () => {
  test('合成文本放在 assistant 角色，音频参数带音色', () => {
    const body = buildMimoTtsBody('mimo-v2.5-tts', '冰糖', '你好，我是小潘。')
    assert.deepEqual(body, {
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '你好，我是小潘。' }],
      audio: { format: 'wav', voice: '冰糖' },
    })
  })

  test('没填音色时退回默认音色', () => {
    const body = buildMimoTtsBody('mimo-v2.5-tts', '  ', '测试')
    assert.deepEqual((body as { audio: { voice: string } }).audio.voice, 'mimo_default')
  })
})

describe('parseMimoTtsPayload', () => {
  const audio = Buffer.from('RIFF0000WAVEfmt ')

  test('从 choices[0].message.audio.data 取出 base64 音频', () => {
    const payload = { choices: [{ message: { role: 'assistant', audio: { data: audio.toString('base64') } } }] }
    assert.deepEqual(parseMimoTtsPayload(payload), audio)
  })

  test('缺少音频数据时抛错', () => {
    assert.throws(() => parseMimoTtsPayload({ choices: [{ message: {} }] }), /音频数据无效/)
    assert.throws(() => parseMimoTtsPayload({}), /音频数据无效/)
    assert.throws(() => parseMimoTtsPayload(null), /音频数据无效/)
  })

  test('空 base64 时抛错', () => {
    assert.throws(() => parseMimoTtsPayload({ choices: [{ message: { audio: { data: '' } } }] }), /音频数据无效/)
  })
})
