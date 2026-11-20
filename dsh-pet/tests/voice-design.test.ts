/**
 * 音色设计字段的回归钉子。
 *
 * 这两个用例是补一次真实事故：`voiceDesign` 只加进了**读取**白名单，没加进**保存**白名单，
 * 于是用户在界面上填完音色设计描述、点保存，得到的是"语音配置包含未知字段"。
 * 单测当时没覆盖"带设计描述保存"，所以没挡住。现在两条都钉住。
 */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { VoiceApiStore } from '../src/main/voice-api.ts'

const encryptionKey = randomBytes(32)
const codec = {
  encrypt(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes])
  },
  decrypt(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  },
}

function storeAt() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-voice-design-'))
  const file = path.join(root, 'voice-api.json.enc')
  return { file, store: new VoiceApiStore(file, codec) }
}

void test('保存：带音色设计描述能存进去，并能读回来', () => {
  const { store } = storeAt()
  const saved = store.save({
    kind: 'tts', name: 'MiMo 设计音色', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts-voicedesign', voice: '', apiKey: 'tp-test-key', provider: 'mimo',
    voiceDesign: '中低音，语速偏慢，句间留白明显，尾音收得干净。',
  })
  const profile = saved.profiles[0]
  assert.equal(profile.model, 'mimo-v2.5-tts-voicedesign')
  assert.match(profile.voiceDesign, /语速偏慢/u)
})

void test('重载：设计描述跟着配置一起落盘（不是只在内存里）', () => {
  const { file, store } = storeAt()
  store.save({
    kind: 'tts', name: '设计音色', endpoint: 'https://example.invalid/v1',
    model: 'mimo-v2.5-tts-voicedesign', voice: '', apiKey: 'k', provider: 'mimo',
    voiceDesign: '明亮清亮，语速稍快，尾音上扬。',
  })
  const reopened = new VoiceApiStore(file, codec)
  assert.match(reopened.snapshot().profiles[0].voiceDesign, /语速稍快/u)
})

void test('兼容：老配置里没有 voiceDesign 也能读，读出来是空串', () => {
  const { store } = storeAt()
  const saved = store.save({
    kind: 'tts', name: '老配置', endpoint: 'https://example.invalid/v1',
    model: 'mimo-v2.5-tts', voice: '冰糖', apiKey: 'k', provider: 'mimo',
  })
  assert.equal(saved.profiles[0].voiceDesign, '')
})
