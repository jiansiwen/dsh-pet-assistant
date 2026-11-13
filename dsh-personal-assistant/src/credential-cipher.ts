/**
 * 凭据加密：Windows DPAPI（CurrentUser），与 `scripts/setup-mail.mjs`、
 * `scripts/setup-wecom.mjs`、`src/assistant-settings.ts` 用的是同一套机制。
 *
 * 这里只提供**加密**。解密沿用既有的 `mail.ts` 的 `decryptDpapiFile` / `decryptSecret`
 * （同一段 PowerShell、同一个 CurrentUser 作用域），不另造一套密文格式 ——
 * 否则"命令写进去、值守读不出来"。
 *
 * 明文只在内存与子进程的标准输入里出现；不回显、不写日志、不塞进任何错误文案。
 */
import { spawn } from 'node:child_process'

/**
 * 固定命令，不对秘密做字符串插值。标准输入给明文、标准输出拿 base64 密文。
 * 与 assistant-settings.ts 的 DPAPI_COMMAND 等价：两边产物能互相解密。
 */
const DPAPI_PROTECT = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.Encoding]::UTF8;'
  + ' Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd();'
  + ' $b=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p),$null,"CurrentUser");'
  + ' [Console]::Out.Write([Convert]::ToBase64String($b))'

/** 非 Windows 上没有 DPAPI。如实说不支持，绝不退化成明文/自造密钥。 */
export const DPAPI_UNSUPPORTED_REASON = '当前系统不支持加密保存凭据，只在 Windows 上可以保存'

const CIPHER = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * 用当前 Windows 用户的 DPAPI 加密一段明文，返回 base64 密文。
 *
 * 失败只抛一句人话（`凭据加密失败`），**不带上子进程的错误输出** ——
 * 那段文本不受我们控制，没有理由让它有机会沾上凭据。
 */
export function encryptWithDpapi(secret: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error(DPAPI_UNSUPPORTED_REASON))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error('凭据加密失败'))
    }
    const timer = setTimeout(fail, 15_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 65_536) fail()
    })
    child.stderr.resume()
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', code => {
      if (settled) return
      const cipher = output.trim()
      if (code !== 0 || cipher === '' || !CIPHER.test(cipher)) { fail(); return }
      settled = true
      clearTimeout(timer)
      resolve(cipher)
    })
    child.stdin.end(secret, 'utf8')
  })
}
