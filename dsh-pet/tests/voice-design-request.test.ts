/**
 * 「填了描述却还是预置女声」的回归钉子。
 *
 * 现场：用户选了 `mimo-v2.5-tts-voicedesign`、写了音色描述、音色 ID 留空，
 * 点保存报「请填写…音色 ID」；就算绕过界面，合成也会回落到 `audio.voice`（默认冰糖，女声）。
 *
 * 两道关都得钉住：
 * 1. 只写描述、不写音色 ID 的配置**必须能存**（后端 profileFields）；
 * 2. 存下来的描述**必须真的进请求体**，且此时不再带 `audio.voice`。
 */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { VoiceApiStore, buildMimoTtsBody } from '../src/main/voice-api.ts'

const key = randomBytes(32)
const codec = {
  encrypt(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    // 顺序要紧：先 final 再 getAuthTag，否则 tag 是空的（加密会直接失败）。
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  },
  decrypt(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  },
}

function store() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-voice-design2-'))
  return new VoiceApiStore(path.join(root, 'voice-api.json.enc'), codec)
}

void test('只写描述、不写音色 ID，能存进去', () => {
  const state = store().save({
    kind: 'tts', name: 'MiMo 设计音色', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts-voicedesign', voice: '', apiKey: 'k', provider: 'mimo',
    voiceDesign: '少年男声，音高偏中，带沙哑颗粒感。',
  })
  assert.equal(state.profiles[0].voice, '', '音色 ID 就该是空的')
  assert.match(state.profiles[0].voiceDesign, /沙哑/u)
})

void test('请求体：有描述时把描述放进 user，且不再传 audio.voice', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts-voicedesign', '', '老板你好。', '少年男声，语速快。')
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.equal(messages.length, 2, 'user（描述）+ assistant（正文）')
  assert.equal(messages[0].role, 'user')
  assert.match(messages[0].content, /少年男声/u)
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content, '老板你好。')
  const audio = body.audio as Record<string, unknown>
  assert.equal('voice' in audio, false, '设计模型不认预置音色，带上反而是干扰')
})

void test('请求体：没描述时仍走预置音色，缺省是 mimo_default', () => {
  const body = buildMimoTtsBody('mimo-v2.5-tts', '', '你好。')
  const audio = body.audio as Record<string, unknown>
  assert.equal(audio.voice, 'mimo_default')
  assert.equal((body.messages as unknown[]).length, 1)
})