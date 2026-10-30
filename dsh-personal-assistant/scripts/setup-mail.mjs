/**
 * 配置收发邮箱：口令只从标准输入读取，经 Windows DPAPI 加密后落盘。
 * 用法：node scripts/setup-mail.mjs --user lakala_wpos2@lakala.com [--host smtp.exmail.qq.com] [--port 465]
 *       [--imap-host imap.exmail.qq.com] [--imap-port 993] [--watch-interval 600] [--watch-disabled]
 * 口令通过 stdin 输入（例如从密码管理器管道传入），不要写进命令行参数或仓库。
 * 未显式给 imap-host 时，若 SMTP 主机以 smtp. 开头，会推导为 imap.*；值守默认每 600 秒检查一次未读。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined
}
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const user = valueOf('user')
const host = valueOf('host') ?? 'smtp.exmail.qq.com'
const port = Number(valueOf('port') ?? '465')
const from = valueOf('from') ?? user
const imapHost = valueOf('imap-host') ?? (host.startsWith('smtp.') ? `imap.${host.slice(5)}` : undefined)
const imapPort = Number(valueOf('imap-port') ?? '993')
const watchIntervalSeconds = Number(valueOf('watch-interval') ?? '600')
const watchEnabled = !args.includes('--watch-disabled')
if (!user) {
  console.error('缺少 --user')
  process.exit(2)
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
  console.error('SMTP/IMAP 端口必须是 1-65535 的整数')
  process.exit(2)
}
if (!Number.isInteger(watchIntervalSeconds) || watchIntervalSeconds < 60 || watchIntervalSeconds > 86400) {
  console.error('值守间隔必须是 60-86400 秒的整数')
  process.exit(2)
}

const password = await new Promise((resolve, reject) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
  process.stdin.on('error', reject)
})
if (!password) {
  console.error('标准输入没有收到口令')
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
  child.stdin.end(password)
})

const dir = path.join(home, 'personal-assistant')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'mail.secret'), `${cipher}\n`, 'utf8')
writeFileSync(path.join(dir, 'mail.json'), `${JSON.stringify({ host, port, secure: port === 465, user, from,
  ...(imapHost ? { imapHost } : {}), imapPort, imapSecure: true, watchEnabled, watchIntervalSeconds }, null, 2)}\n`, 'utf8')
console.log(`邮箱配置已保存：${user} @ ${host}:${port}；口令已用当前 Windows 用户密钥加密。`)
console.log(`值守：${watchEnabled ? `每 ${watchIntervalSeconds} 秒检查未读` : '已关闭'}${imapHost ? `，IMAP ${imapHost}:${imapPort}` : '，未配置 IMAP 主机'}`)
