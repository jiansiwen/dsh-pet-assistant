/**
 * 「存进去 / 读回来 / 空值不覆盖」这条链的回归测试。
 *
 * 这块连着出过三次事故，每次都是让用户点界面才发现：
 * 描述被空值覆盖、样本存了读不到、列表一报错输入框全空。
 * 现在钉在测试里，改完跑一遍就知道有没有再犯。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agentVoicePayload } from '../src/main/agent-voice.ts'
import { isMimo } from '../src/main/voice-api.ts'
import { agentVoicePatch, modelForIntent, preferNonEmpty } from '../src/shared/agent-voice-rule.ts'

void test('读回：描述、风格、音色都原样返回', () => {
  const payload = agentVoicePayload({
    agentVoiceDesign: '偏高偏亮的少年音',
    agentVoiceStyle: '语速偏快，句尾上扬',
    agentVoiceId: '白桦',
    agentVoiceSampleMime: 'audio/wav',
  })
  assert.equal(payload.design, '偏高偏亮的少年音')
  assert.equal(payload.style, '语速偏快，句尾上扬')
  assert.equal(payload.voiceId, '白桦')
  assert.equal(payload.mime, 'audio/wav')
})

void test('读回：样本落成文件时从文件读出来，长度对得上', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-voice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'voice-sample.wav')
  const bytes = Buffer.from('RIFF-fake-wav-bytes')
  writeFileSync(file, bytes)
  const payload = agentVoicePayload({ agentVoiceSampleFile: file })
  assert.equal(payload.sample, bytes.toString('base64'))
  assert.equal(payload.sampleLength, payload.sample.length)
})

void test('读回：文件不存在时回空，不抛异常', () => {
  const payload = agentVoicePayload({ agentVoiceSampleFile: path.join(tmpdir(), 'not-there-xyz.wav') })
  assert.equal(payload.sample, '')
  assert.equal(payload.sampleLength, 0)
})

void test('空值不覆盖：设置读回来是空，输入框里已经写的字要留住', () => {
  assert.equal(preferNonEmpty('用户刚写的描述', ''), '用户刚写的描述')
  assert.equal(preferNonEmpty('', '配置里的新值'), '配置里的新值')
  assert.equal(preferNonEmpty('旧', '新'), '新')
  assert.equal(preferNonEmpty('', ''), '')
})

void test('真实事故回放：保存后立刻刷新，不能把刚存的内容清空', () => {
  // 用户填好 → 保存 → 刷新读回（这一次读回因为列表接口失败而返回空）
  const typed = { design: '偏高偏亮的少年音', style: '语速偏快' }
  const readBack = agentVoicePayload({}) // 读回全空，正是事故现场
  const afterRefresh = {
    design: preferNonEmpty(typed.design, readBack.design),
    style: preferNonEmpty(typed.style, readBack.style),
  }
  assert.deepEqual(afterRefresh, typed)
})

void test('保存补丁的字段名必须与设置的存储字段一致（"保存成功但内容没变"就是这么来的）', () => {
  const patch = agentVoicePatch({ design: ' 描述 ', style: ' 风格 ', voiceId: ' 白桦 ', sampleData: 'AAAA', sampleMime: 'audio/wav' })
  assert.deepEqual(Object.keys(patch).sort(), [
    'agentVoiceDesign', 'agentVoiceId', 'agentVoiceSample', 'agentVoiceSampleMime', 'agentVoiceStyle',
  ].sort())
  assert.equal(patch.agentVoiceDesign, '描述')
  assert.equal(patch.agentVoiceStyle, '风格')
  assert.equal(patch.agentVoiceId, '白桦')
})

void test('保存补丁 → 读回：风格不会丢', () => {
  const patch = agentVoicePatch({ design: 'd', style: '语速偏快', voiceId: '', sampleData: '', sampleMime: '' })
  const payload = agentVoicePayload(patch)
  assert.equal(payload.style, '语速偏快')
  assert.equal(payload.design, 'd')
})

void test('模型按意图定：选了预置音色就不能再用 design/clone 模型（400 的根源）', () => {
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voicedesign', { voiceId: '白桦' }), 'mimo-v2.5-tts')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voiceclone', { voiceId: '白桦' }), 'mimo-v2.5-tts')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts', { voiceId: '白桦' }), 'mimo-v2.5-tts')
})

void test('模型按意图定：有样本必须用复刻模型', () => {
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts', { hasSample: true }), 'mimo-v2.5-tts-voiceclone')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voicedesign', { hasSample: true }), 'mimo-v2.5-tts-voiceclone')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voiceclone', { hasSample: true }), 'mimo-v2.5-tts-voiceclone')
})

void test('模型按意图定：什么都没有时，design/clone 模型要降级回预置（否则必 400）', () => {
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voiceclone', {}), 'mimo-v2.5-tts')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts-voicedesign', {}), 'mimo-v2.5-tts')
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts', {}), 'mimo-v2.5-tts')
})

void test('模型按意图定：有描述用设计模型；非 mimo 厂商不动模型', () => {
  assert.equal(modelForIntent('mimo', 'mimo-v2.5-tts', { design: '低沉男声' }), 'mimo-v2.5-tts-voicedesign')
  assert.equal(modelForIntent('openai', 'tts-1', { design: '低沉男声' }), 'tts-1')
  assert.equal(modelForIntent('openai', 'tts-1', { voiceId: 'alloy' }), 'tts-1')
})

void test('MiMo 按域名识别：提供商标签选成 openai 也要走 chat/completions', () => {
  assert.equal(isMimo({ provider: 'mimo' }), true)
  assert.equal(isMimo({ provider: 'openai', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1' }), true)
  assert.equal(isMimo({ provider: 'openai', endpoint: 'https://api.openai.com/v1' }), false)
})
