/**
 * 配置企业微信智能机器人：Secret 只从标准输入读取并交给 Windows DPAPI 加密。
 * 用法：node scripts/setup-wecom.mjs --bot-id <BotID> [--userid <你的UserID>] [--pairing-code 123456]
 * 不要在命令行里传 Secret。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined
}
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dir = path.join(home, 'personal-assistant')
const botId = valueOf('bot-id')?.trim()
const userId = valueOf('userid')?.trim()
const pairingCode = valueOf('pairing-code')?.trim()
if (!botId) {
  console.error('缺少 --bot-id')
  process.exit(2)
}

const secret = await new Promise((resolve, reject) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
  process.stdin.on('error', reject)
})
if (!secret) {
  console.error('标准输入没有收到 Secret')
  process.exit(2)
}

const cipher = await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd();' +
    ' $b=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p),$null,"CurrentUser");' +
    ' [Console]::Out.Write([Convert]::ToBase64String($b))'], { windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { err += String(chunk) })
  child.on('error', reject)
  child.on('close', code => code === 0 && out ? resolve(out.trim()) : reject(new Error(err || `DPAPI 加密失败（${code}）`)))
  child.stdin.end(secret)
})

mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'wecom.secret'), `${cipher}\n`, 'utf8')
writeFileSync(path.join(dir, 'wecom.json'), `${JSON.stringify({ enabled: true, botId }, null, 2)}\n`, 'utf8')

const channelsFile = path.join(dir, 'channels.json')
let channels = { allowedUserIds: [], deliverHere: [], pairingCode: undefined }
if (existsSync(channelsFile)) {
  try { channels = JSON.parse(readFileSync(channelsFile, 'utf8')) } catch { /* 损坏时重建 */ }
}
if (!Array.isArray(channels.allowedUserIds)) channels.allowedUserIds = []
if (userId && !channels.allowedUserIds.includes(userId)) channels.allowedUserIds.push(userId)
if (pairingCode) channels.pairingCode = pairingCode
writeFileSync(channelsFile, `${JSON.stringify(channels, null, 2)}\n`, 'utf8')
console.log(`企业微信配置已保存：BotID ${botId}${userId ? `，已允许用户 ${userId}` : ''}；Secret 已用当前 Windows 用户密钥加密。`)
