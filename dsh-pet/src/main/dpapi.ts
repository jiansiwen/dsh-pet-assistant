/**
 * 会议数据密钥：32 字节随机密钥，落盘形态是**用系统密钥库包装过**的 key.bin。
 *
 * 为什么不直接把密钥写文件：会议录音是参会者没预料到会被第三方读到的内容，明文密钥放在
 * userData 里等于没加密——任何能读这个目录的进程都能解密全部录音。包装把密钥绑到
 * **这台机器上的这个用户**：换用户、换机器都解不开，这正是我们要的边界。
 *
 * 两条实现，按平台分派：
 *
 * - **Windows**：DPAPI（`CurrentUser` 作用域），走 PowerShell 的
 *   `[System.Security.Cryptography.ProtectedData]`。壳里没有原生 addon 依赖链能碰到 DPAPI，
 *   PowerShell 是零依赖的那条路。
 * - **macOS / Linux**：Electron 的 `safeStorage`。macOS 上它落到 Keychain、Linux 落到
 *   libsecret，都是"绑当前用户"的同一层语义。用它是**同一个文件里最省的选择** ——
 *   不必再引一个原生 addon，也天然跨平台。
 *
 * 为什么不用 safeStorage 把 Windows 那条也统一掉：DPAPI 那条已经上线、key.bin 已经落盘，
 * 换实现等于让既有录音解不开。**已存在的密钥格式不动**，只给新平台补实现。
 *
 * **key.bin 解不开时返回 { status: 'lost' }，绝不重新生成覆盖。** 覆盖等于把既有录音
 * 永久变成乱码，还让用户以为一切正常——密钥丢了必须丢得明明白白。
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { platformOf, type SupportedPlatform } from './platform.ts'

/** 数据密钥长度（AES-256）。 */
export const KEY_BYTES = 32

/** key.bin 的落点。放在 meetings/ 目录之外：会议目录按保留期整目录删除，密钥不能被连带清掉。 */
export function keyFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'meetings-key.bin')
}

export type DpapiResult =
  | { readonly status: 'ok'; readonly key: Buffer }
  /** key.bin 存在但解不开（损坏、换了账户/机器）。调用方必须拒绝新会议并如实告知。 */
  | { readonly status: 'lost'; readonly message: string }
  /** 非 Windows：没有 DPAPI 可用。 */
  | { readonly status: 'unsupported' }
  /** 生成新密钥时包装失败（PowerShell 起不来等）。 */
  | { readonly status: 'error'; readonly message: string }

/** 测试注入面：平台、spawn、随机源、系统密钥库都可换掉，不必真跑 PowerShell。 */
export interface DpapiDeps {
  readonly platform?: string
  readonly spawn?: DpapiSpawn
  readonly randomBytes?: (size: number) => Buffer
  /**
   * macOS / Linux 上的系统密钥库（Electron 的 `safeStorage`）。
   *
   * 由主进程注入而不是这里 import electron：`dpapi.ts` 要被 `node --test` 直接导入，
   * 一沾 electron 就导不进来了。没注入就说明这条实现用不了 —— 返回 `unsupported`，
   * 这比"假装成功但存了明文"安全得多。
   */
  readonly safeStorage?: SafeStorageLike
}

/**
 * `safeStorage` 的结构子集。
 *
 * 只声明我们真正用到的三个方法。Electron 的真对象结构兼容（方法形参双变），
 * 直接传进来即可 —— 与 `meeting-recorder.ts` 注入 ipcMain 是同一套办法。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  /** 明文 → 系统密钥库包装后的字节。 */
  encryptString(plainText: string): Buffer
  /** 包装后的字节 → 明文。解不开时抛异常。 */
  decryptString(encrypted: Buffer): string
}

export interface DpapiSpawnResult {
  readonly status: number | null
  readonly stdout: string
  /** PowerShell 的报错原文（只用于把失败原因说清楚，不落盘）。 */
  readonly stderr?: string
  readonly error?: unknown
}

export type DpapiSpawn = (command: string, args: readonly string[], input: string) => DpapiSpawnResult

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const

/**
 * 包装：明文密钥的 base64 走 **stdin**，stdout 输出包装后的 base64。
 *
 * 不能用 `-Command "<脚本>" <值>` 传值：PowerShell 会把多出来的那个参数当成命令文本接着解析，
 * 直接 ParserError，`$args[0]` 永远是空的。这条只有真机上跑一次才看得见 —— 单测注入假 spawn，
 * 传参方式错了也照样绿。走 stdin 还顺带躲开了命令行里出现明文密钥。
 */
const PROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  '$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($d,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))"

/** 解包：同样走 stdin；密钥损坏或换了账户/机器时 Protect 抛异常，进程以非零码退出。 */
const UNPROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  '$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($d,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))"

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function defaultSpawn(command: string, args: readonly string[], input: string): DpapiSpawnResult {
  const result = nodeSpawnSync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/** PowerShell 的 stdout 可能带 BOM/空行，取最后一行非空文本。 */
function lastLine(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

/** 严格解析 base64：Buffer.from 对垃圾输入不报错只截断，长度与字符集都得自己验。 */
function parseBase64Key(text: string, expectedBytes: number): Buffer | null {
  if (text.length === 0 || !BASE64_RE.test(text)) return null
  const buf = Buffer.from(text, 'base64')
  return buf.length === expectedBytes ? buf : null
}

/**
 * 取会议数据密钥。key.bin 在就解包返回；不在就生成 32 字节随机密钥、包装后落盘。
 *
 * 解不开一律 'lost'（不覆盖、不重生成）。三个平台的包装手段不同，但**语义相同**：
 * 绑到这台机器上的这个用户。
 */
export function getDataKey(userDataDir: string, deps: DpapiDeps = {}): DpapiResult {
  const platform = platformOf(deps.platform ?? process.platform)
  // Windows 走 DPAPI（PowerShell），macOS/Linux 走 Electron safeStorage。
  if (platform === 'win32') return getDataKeyDpapi(userDataDir, deps)
  return getDataKeySafeStorage(userDataDir, platform, deps)
}

/** Windows：DPAPI CurrentUser，走 PowerShell（壳里没有能碰 DPAPI 的原生依赖链）。 */
function getDataKeyDpapi(userDataDir: string, deps: DpapiDeps): DpapiResult {
  const spawn = deps.spawn ?? defaultSpawn
  const file = keyFilePath(userDataDir)

  if (existsSync(file)) {
    let wrapped: Buffer
    try {
      wrapped = readFileSync(file)
    } catch (error) {
      return { status: 'lost', message: `密钥文件读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (wrapped.length === 0) return { status: 'lost', message: '密钥文件是空的' }
    const result = spawn('powershell', [...POWERSHELL_ARGS, UNPROTECT_SCRIPT], wrapped.toString('base64'))
    if (result.error !== undefined || result.status !== 0) {
      return { status: 'lost', message: 'DPAPI 解包失败：密钥可能已损坏，或换了 Windows 账户/机器' }
    }
    const key = parseBase64Key(lastLine(result.stdout), KEY_BYTES)
    if (key === null) return { status: 'lost', message: 'DPAPI 解包结果不是 32 字节密钥' }
    return { status: 'ok', key }
  }

  const key = (deps.randomBytes ?? nodeRandomBytes)(KEY_BYTES)
  const result = spawn('powershell', [...POWERSHELL_ARGS, PROTECT_SCRIPT], key.toString('base64'))
  if (result.error !== undefined || result.status !== 0) {
    return { status: 'error', message: 'DPAPI 包装失败，无法创建会议密钥' }
  }
  const text = lastLine(result.stdout)
  if (text.length === 0 || !BASE64_RE.test(text)) {
    return { status: 'error', message: 'DPAPI 包装输出无法解析' }
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    // 先写临时文件再改名：半路上断掉不会留下一个空 key.bin 把之后的启动全判成 lost。
    const tmp = `${file}.tmp`
    writeFileSync(tmp, Buffer.from(text, 'base64'))
    renameSync(tmp, file)
  } catch (error) {
    return { status: 'error', message: `密钥落盘失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { status: 'ok', key }
}

/**
 * macOS / Linux：Electron 的 `safeStorage`（macOS → Keychain，Linux → libsecret）。
 *
 * 密钥本体在系统密钥库里是**字符串**，而我们要 32 字节二进制 —— 用 base64 作载体：
 * 它是 ASCII，过得了任何文本通道，且长度可精确校验（见 `parseBase64Key`）。
 *
 * 落盘的是 safeStorage 的输出字节，与 Windows 的 key.bin 同格式同位置。两者**不能互相解**，
 * 这是对的：密钥本来就该绑在机器上。跨平台迁移时旧会议读不出来，但那比"密钥跟着文件跑"
 * 安全 —— 后者意味着拿到 userData 目录的人就能解开全部录音。
 */
function getDataKeySafeStorage(
  userDataDir: string,
  platform: SupportedPlatform,
  deps: DpapiDeps,
): DpapiResult {
  const store = deps.safeStorage
  // 没注入实现（纯 Node 测试、或 Electron 还没 ready）→ 如实说这条能力用不了。
  if (store === undefined) return { status: 'unsupported' }
  // 系统密钥库不可用（Linux 没装 libsecret、macOS 上 Keychain 被锁）→ 同样如实拒绝。
  // 这时候退化成明文存储是**最坏**的选择：用户以为录音是加密的。
  try {
    if (!store.isEncryptionAvailable()) return { status: 'unsupported' }
  } catch {
    return { status: 'unsupported' }
  }

  const file = keyFilePath(userDataDir)

  if (existsSync(file)) {
    let wrapped: Buffer
    try {
      wrapped = readFileSync(file)
    } catch (error) {
      return { status: 'lost', message: `密钥文件读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (wrapped.length === 0) return { status: 'lost', message: '密钥文件是空的' }
    let plain: string
    try {
      plain = store.decryptString(wrapped)
    } catch {
      return {
        status: 'lost',
        message: platform === 'darwin'
          ? '系统钥匙串解包失败：密钥可能已损坏，或换了 macOS 账户/机器'
          : '系统密钥库解包失败：密钥可能已损坏，或换了账户/机器',
      }
    }
    const key = parseBase64Key(plain.trim(), KEY_BYTES)
    if (key === null) return { status: 'lost', message: '系统密钥库解包结果不是 32 字节密钥' }
    return { status: 'ok', key }
  }

  const key = (deps.randomBytes ?? nodeRandomBytes)(KEY_BYTES)
  let wrapped: Buffer
  try {
    wrapped = store.encryptString(key.toString('base64'))
  } catch (error) {
    return { status: 'error', message: `系统密钥库包装失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (wrapped.length === 0) return { status: 'error', message: '系统密钥库包装输出为空' }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, wrapped)
    renameSync(tmp, file)
  } catch (error) {
    return { status: 'error', message: `密钥落盘失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { status: 'ok', key }
}
