/**
 * 自定义 TTS 服务在派发链路上的两条安全线：
 * 配置要随句子送到 worker；配置读不出来要如实停，不悄悄换回默认服务。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Narrator, type TtsTransport, type TtsWorkerEvent } from '../src/main/tts.ts'
import type { ResolvedVoiceApi } from '../src/voice-api-types.ts'

const API: ResolvedVoiceApi = {
  id: 'p1', kind: 'tts', name: '我的服务', endpoint: 'https://example.com/v1',
  model: 'tts-1', voice: 'alloy', apiKey: 'sk-test', provider: 'openai',
}

class Lines implements TtsTransport {
  readonly lines: string[] = []
  write(line: string): void { this.lines.push(line) }
  close(): void {}
}

function narratorWith(ttsApi: () => ResolvedVoiceApi | null, errors: string[] = []) {
  const lines = new Lines()
  let deliver: (event: TtsWorkerEvent) => void = () => { throw new Error('worker 未就绪') }
  const narrator = new Narrator(
    (onEvent) => { deliver = onEvent; return lines },
    { onError: reason => errors.push(reason) },
    { ttsApi },
  )
  return { narrator, transport: lines, deliver: (event: TtsWorkerEvent) => deliver(event) }
}

test('选了自定义服务就随句子下发配置；没选不带这个字段', () => {
  const custom = narratorWith(() => API)
  custom.narrator.speak({ utteranceId: 'u1', text: '第一句。' })
  custom.deliver({ ready: true })
  const command = JSON.parse(custom.transport.lines[0]) as { speak?: { api?: unknown } }
  assert.deepEqual(command.speak?.api, API)

  const plain = narratorWith(() => null)
  plain.narrator.speak({ utteranceId: 'u1', text: '第一句。' })
  const speakLine = plain.transport.lines.find(line => line.startsWith('{"speak"')) ?? '{"speak":{}}'
  assert.equal('api' in ((JSON.parse(speakLine) as { speak?: Record<string, unknown> }).speak ?? {}), false)
})

test('配置读不出来要如实停，不悄悄退回默认服务', () => {
  const errors: string[] = []
  const h = narratorWith(() => { throw new Error('密钥解不开') }, errors)
  h.narrator.speak({ utteranceId: 'u1', text: '第一句。' })
  h.deliver({ ready: true })
  assert.deepEqual(errors, ['密钥解不开'])
  assert.equal(h.transport.lines.filter(line => line.startsWith('{"speak"')).length, 0, '一句都不该派出去')
  assert.equal(h.narrator.isSpeaking(), false)
})
