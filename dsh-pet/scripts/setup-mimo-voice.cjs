/**
 * 把 MiMo 语音配置写进桌面壳的用户目录（不在仓库里）。
 *
 * 用法（在 dsh-pet 目录）：
 *   $env:MIMO_API_KEY='sk-...'; node_modules\electron\dist\electron.exe scripts\setup-mimo-voice.cjs
 *
 * 做三件事：
 * 1. 用系统密钥库（Windows DPAPI / macOS safeStorage）加密 API Key；
 * 2. 在 voice-apis.json 里创建/更新「MiMo TTS」与「MiMo ASR」两个配置，并设为当前选择；
 * 3. 完成即退出。本脚本不含任何密钥，可以随仓库分发。
 *
 * script 只读环境变量 MIMO_API_KEY；可选 MIMO_TTS_VOICE 指定音色（默认冰糖）。
 * 写完后重启桌面宠物生效（语音配置在启动时加载）。
 */
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync, existsSync, copyFileSync } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function upsert(profiles, profile) {
  const index = profiles.findIndex(item => item && item.kind === profile.kind && item.name === profile.name)
  if (index >= 0) {
    profile.id = profiles[index].id
    profiles[index] = profile
  } else {
    profiles.push(profile)
  }
  return profile
}

app.whenReady().then(() => {
  try {
    const apiKey = (process.env.MIMO_API_KEY || '').trim()
    if (!apiKey) {
      console.error('缺少环境变量 MIMO_API_KEY')
      process.exitCode = 1
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('系统密钥库不可用（Windows DPAPI / macOS Keychain），拒绝以明文保存密钥')
      process.exitCode = 1
      return
    }
    const file = path.join(app.getPath('userData'), 'voice-apis.json')
    let state = { version: 1, profiles: [], selected: { tts: null, asr: null } }
    if (existsSync(file)) {
      const backup = `${file}.bak`
      try {
        copyFileSync(file, backup)
        state = JSON.parse(readFileSync(file, 'utf8'))
        if (!Array.isArray(state.profiles)) state.profiles = []
        if (!state.selected || typeof state.selected !== 'object') state.selected = { tts: null, asr: null }
      } catch {
        // 损坏时从空状态重建；原文件已备份为 .bak。
        state = { version: 1, profiles: [], selected: { tts: null, asr: null } }
      }
    }
    const encryptedKey = safeStorage.encryptString(apiKey).toString('base64')
    const endpoint = 'https://api.xiaomimimo.com/v1/chat/completions'
    const voice = (process.env.MIMO_TTS_VOICE || '冰糖').trim() || '冰糖'
    const tts = upsert(state.profiles, { id: randomUUID(), kind: 'tts', name: 'MiMo TTS', endpoint, model: 'mimo-v2.5-tts', voice, encryptedKey, provider: 'mimo' })
    const asr = upsert(state.profiles, { id: randomUUID(), kind: 'asr', name: 'MiMo ASR', endpoint, model: 'mimo-v2.5-asr', voice: '', encryptedKey, provider: 'mimo' })
    state.selected = { ...state.selected, tts: tts.id, asr: asr.id }
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
    console.log(`已写入 ${file}：MiMo TTS(${voice}) + MiMo ASR 已设为当前选择。重启桌面宠物生效。`)
  } catch (error) {
    console.error('写入失败：', error && error.message ? error.message : error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
