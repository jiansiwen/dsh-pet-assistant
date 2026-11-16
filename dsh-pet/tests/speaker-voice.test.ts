/**
 * 音色仲裁与三链路一致性：唤醒/快答/回复必须同一个嗓子。
 *
 * 钉三件事：
 * 1. speakerOverlay 的优先级（样本 > 描述 > 预置）与模型互斥裁决；
 * 2. Narrator 没自带音色的句子走默认说话人（总助理），流式 feed 带成员音色；
 * 3. 句子自带音色优先于默认说话人 —— 成员回复不能串成总助理的嗓子。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Narrator, type TtsWorkerEvent } from '../src/main/tts.ts'
import { normalizePresetId, speakerOverlay } from '../src/shared/speaker-voice.ts'
import type { ResolvedVoiceApi } from '../src/voice-api-types.ts'
import type { SpeakerVoice } from '../src/shared/speaker-voice.ts'

function base(): ResolvedVoiceApi {
  return {
    id: 'x', kind: 'tts', name: 'mimo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-tts-voiceclone', voice: '', voiceDesign: '', apiKey: 'k', provider: 'mimo',
  }
}

describe('speakerOverlay：优先级与模型互斥', () => {
  test('样本 > 描述 > 预置；模型跟意图走，互斥字段清掉', () => {
    const clone = speakerOverlay('mimo', 'mimo-v2.5-tts', { voiceId: '冰糖', design: '描述', sampleFile: 'a.wav' })
    assert.equal(clone.model, 'mimo-v2.5-tts-voiceclone')
    assert.equal(clone.voice, '')
    assert.equal(clone.voiceDesign, '')
    assert.equal(clone.voiceSampleFile, 'a.wav')

    const design = speakerOverlay('mimo', 'mimo-v2.5-tts-voiceclone', { voiceId: '冰糖', design: '描述' })
    assert.equal(design.model, 'mimo-v2.5-tts-voicedesign')
    assert.equal(design.voice, '')
    assert.equal(design.voiceSampleFile, '')

    const preset = speakerOverlay('mimo', 'mimo-v2.5-tts-voicedesign', { voiceId: '冰糖' })
    assert.equal(preset.model, 'mimo-v2.5-tts')
    assert.equal(preset.voiceDesign, '')
  })

  test('只传语气不动音色来源与模型', () => {
    const ov = speakerOverlay('mimo', 'mimo-v2.5-tts', { style: '哪吒语气' })
    assert.equal(ov.voiceStyle, '哪吒语气')
    assert.equal(ov.model, undefined)
    assert.equal(ov.voice, undefined)
  })

  test('旧种子音色名映射到 MiMo 预置，不认识的原样保留', () => {
    assert.equal(normalizePresetId('steady-male'), '白桦')
    assert.equal(normalizePresetId('warm-female'), '冰糖')
    assert.equal(normalizePresetId('冰糖'), '冰糖')
  })
})

interface SpeakLine { speak: { id: string; api: ResolvedVoiceApi } }

function setup(defaultVoice?: () => SpeakerVoice | null, resolveProfile?: (id: string) => ResolvedVoiceApi | null) {
  const lines: SpeakLine[] = []
  let deliver: ((event: TtsWorkerEvent) => void) | null = null
  const narrator = new Narrator(d => {
    deliver = d
    return { write: line => lines.push(JSON.parse(line) as SpeakLine), close: () => {} }
  }, {}, {
    ttsApi: () => base(),
    defaultVoice: defaultVoice ?? (() => null),
    resolveProfile,
  })
  return { narrator, lines, ready: () => deliver?.({ ready: true }), fire: (e: TtsWorkerEvent) => deliver?.(e) }
}

describe('Narrator：唤醒/快答/回复同嗓子', () => {
  test('没自带音色的句子用默认说话人（总助理克隆样本+语气）', () => {
    const { narrator, lines, ready } = setup(() => ({ style: '哪吒语气', sampleFile: 'nezha.wav' }))
    narrator.speak({ utteranceId: 'w', text: '我在。' })
    ready()
    const api = lines[0].speak.api
    assert.equal(api.model, 'mimo-v2.5-tts-voiceclone')
    assert.equal(api.voiceSampleFile, 'nezha.wav')
    assert.equal(api.voiceStyle, '哪吒语气')
  })

  test('流式 feed 带成员音色：预置覆盖默认克隆，模型切回预置', () => {
    const { narrator, lines, ready } = setup(() => ({ sampleFile: 'nezha.wav' }))
    narrator.feed('r', '好嘞，这就去办。', { voiceId: '冰糖' })
    ready()
    const api = lines[0].speak.api
    assert.equal(api.model, 'mimo-v2.5-tts')
    assert.equal(api.voice, '冰糖')
    assert.equal(api.voiceSampleFile, '')
  })

  test('句子自带音色优先于默认说话人', () => {
    const { narrator, lines, ready } = setup(() => ({ sampleFile: 'nezha.wav' }))
    narrator.speak({ utteranceId: 'm', text: '交给我。', voiceDesign: '温柔女声' })
    ready()
    assert.equal(lines[0].speak.api.model, 'mimo-v2.5-tts-voicedesign')
    assert.equal(lines[0].speak.api.voiceDesign, '温柔女声')
  })

  test('默认说话人为空时沿用服务配置原样', () => {
    const { narrator, lines, ready } = setup()
    narrator.speak({ utteranceId: 'p', text: '你好。' })
    ready()
    assert.equal(lines[0].speak.api.model, 'mimo-v2.5-tts-voiceclone')
    assert.equal(lines[0].speak.api.voiceSampleFile, undefined)
  })

  test('成员选了另一条 TTS 配置：整句走那条的端点与模型', () => {
    const alt = { ...base(), id: 'alt', model: 'mimo-v2.5-tts', endpoint: 'https://alt.example/v1/chat/completions' }
    const { narrator, lines, ready } = setup(() => ({ profileId: 'alt' }), () => alt)
    narrator.speak({ utteranceId: 'm', text: '你好。' })
    ready()
    assert.equal(lines[0].speak.api.endpoint, alt.endpoint)
    assert.equal(lines[0].speak.api.model, 'mimo-v2.5-tts')
  })

  test('快答交棒只丢快答话语，主回复队列保留', () => {
    const { narrator, lines, ready, fire } = setup()
    narrator.speak({ utteranceId: 'ack', text: '好嘞。', ephemeral: true })
    narrator.speak({ utteranceId: 'main', text: '主回复。' })
    ready()
    assert.equal(lines[0].speak.id, 'ack#0')
    narrator.dropUtterance('ack')
    fire({ cancelled: { id: 'ack#0' } })
    assert.ok(lines.find(l => l.speak && l.speak.id === 'main#0'), '主回复应在快答被丢后接着派发')
  })
})