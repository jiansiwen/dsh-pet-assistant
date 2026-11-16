/**
 * 声纹注册与验证的纯本地测试：不加载真模型，用注入的提取器验证
 * "几段有效、怎么加密、怎么比对、删掉之后是什么状态"。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  bestVoiceprintScore,
  clearVoiceprint,
  cosineSimilarity,
  enrollVoiceprint,
  loadVoiceprint,
  saveVoiceprint,
  voiceprintPath,
  voiceprintStatus,
  wavToSamples,
} from '../src/main/voiceprint.ts'

const KEY = Buffer.alloc(32, 7)
const loadKey = () => ({ status: 'ok' as const, key: KEY })

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-voiceprint-test-'))
}

/** 44 字节头 + 16bit 单声道 PCM；默认 16k。 */
function makeWav(samples: readonly number[], sampleRate = 16000): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), index * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function samples(seconds = 1): Float32Array {
  // 一段有能量的方波；长度够 MinSamples（0.4s）。
  const out = new Float32Array(Math.floor(16000 * seconds))
  for (let i = 0; i < out.length; i++) out[i] = (i % 2 === 0 ? 0.4 : -0.4)
  return out
}

test('余弦相似度与多次注册取最高分', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, '维度不同不硬比')
  assert.equal(bestVoiceprintScore([[1, 0], [0, 1]], [0.9, 0.1]), cosineSimilarity([1, 0], [0.9, 0.1]))
})

test('WAV 解析只接受 16k 单声道 16bit', () => {
  const parsed = wavToSamples(makeWav([0.5, -0.5]))
  assert.deepEqual([parsed.length, Math.round(parsed[0] * 1000), Math.round(parsed[1] * 1000)], [2, 500, -500])
  assert.equal(wavToSamples(makeWav([0.5, -0.5], 8000)).length, 0)
  assert.equal(wavToSamples(Buffer.from('not a wav')).length, 0)
})

test('注册 3 段、保存后能读回；文件里没有明文 embedding', async () => {
  const dir = tempDir()
  try {
    const wavs = [1, 2, 3].map(() => makeWav(Array.from(samples(1))))
    const result = await enrollVoiceprint({
      userDataDir: dir,
      name: '潘潘',
      wavs,
      extract: async () => [0.1, 0.2, 0.3],
      loadKey,
    })
    assert.deepEqual(result, { ok: true, count: 3 })
    const record = loadVoiceprint(dir, loadKey)
    assert.equal(record?.name, '潘潘')
    assert.equal(record?.embeddings.length, 3)
    assert.deepEqual(loadVoiceprint(dir, loadKey)?.embeddings[0], [0.1, 0.2, 0.3])
    assert.equal(readFileSync(voiceprintPath(dir), 'utf8').includes('0.1'), false, 'embedding 不能以明文落盘')
    const status = voiceprintStatus(dir, loadKey)
    assert.deepEqual([status.registered, status.count, status.problem], [true, 3, null])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('有效录音不足 2 段时失败，不覆盖已有声纹', async () => {
  const dir = tempDir()
  try {
    saveVoiceprint(dir, { version: 1, name: '旧名字', embeddings: [[1, 0]], createdAt: 1 }, loadKey)
    const result = await enrollVoiceprint({
      userDataDir: dir,
      name: '潘潘',
      wavs: [makeWav(Array.from(samples(1))), makeWav(Array.from(samples(1)))],
      extract: async () => { throw new Error('没检测到有效人声') },
      loadKey,
    })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /没检测到有效人声/)
    assert.equal(loadVoiceprint(dir, loadKey)?.name, '旧名字', '失败不能把旧声纹冲掉')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('短录音在提取前就被拒绝；删除后状态回到未注册', async () => {
  const dir = tempDir()
  try {
    const result = await enrollVoiceprint({
      userDataDir: dir,
      name: '潘潘',
      wavs: [makeWav([0.1, 0.1]), makeWav([0.1, 0.1])],
      extract: async () => [1, 0],
      loadKey,
    })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /太短/)
    assert.equal(voiceprintStatus(dir, loadKey).registered, false)
    assert.equal(existsSync(voiceprintPath(dir)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('删掉声纹文件后状态干净，重复删除不报错', async () => {
  const dir = tempDir()
  try {
    saveVoiceprint(dir, { version: 1, name: '潘潘', embeddings: [[1, 0]], createdAt: 1 }, loadKey)
    assert.equal(clearVoiceprint(dir), true)
    assert.equal(clearVoiceprint(dir), false)
    assert.deepEqual(voiceprintStatus(dir, loadKey), { registered: false, count: 0, createdAt: null, problem: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('密钥不对 / 文件被改：状态报 problem，不冒充未注册', () => {
  const dir = tempDir()
  try {
    saveVoiceprint(dir, { version: 1, name: '潘潘', embeddings: [[1, 0]], createdAt: 1 }, loadKey)
    const status = voiceprintStatus(dir, () => ({ status: 'ok', key: Buffer.alloc(32, 9) }))
    assert.equal(status.registered, false)
    assert.match(status.problem ?? '', /声纹文件读不出来/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
