/**
 * 邮件配置的**运行时**读写（`/assistant-mail-config`）。
 *
 * ## 为什么写的是 `mail.json` + `mail.secret`，而不是新开一个 `mail-config.json`
 *
 * 这两个文件是包内**已经存在的运行时配置面**，只是此前只有 `scripts/setup-mail.mjs` 会写：
 * - 发信侧 `mail.ts:readMailConfig()` 读 `mail.json`；
 * - 值守侧 `mail-watch.ts:readMailImapConfig()` 读 `mail.json` 的 `imapHost/imapPort/imapSecure/
 *   watchEnabled/watchIntervalSeconds`，并且**每轮 tick 都重新读**（`tick()` 第一行）；
 * - 授权码从 `mail.secret` 解（`mail.ts:decryptSecret()`）。
 *
 * 若写到另一个文件名，页面里保存成功、值守却永远读不到 —— 正是要避免的那种失败。
 * 所以字段与 `setup-mail.mjs` 的产物逐字对齐，只是把写入搬进了运行时。
 *
 * ## 授权码不落明文
 * 沿用包内既有的 DPAPI（CurrentUser）机制，密文格式与 `setup-mail.mjs` 一致（base64 + 换行），
 * 解密仍走既有的 `decryptSecret()`。两个文件都以 `0o600` 写入，先写密文、后写配置，最后回读确认。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { argumentOf } from './config-args.ts'
import { encryptWithDpapi } from './credential-cipher.ts'
import { mailDir, readMailConfig } from './mail.ts'
import { readMailImapConfig } from './mail-watch.ts'
import { writePrivateFile } from './private-file.ts'

const MAIL_FILE = 'mail.json'
const SECRET_FILE = 'mail.secret'

/** 与 `mail.ts` 的邮箱校验同一套：命令层放过的地址必须能被发信层接住。 */
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/u
const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
const validEmail = (value: string): boolean => value.length <= 320 && EMAIL.test(value) && !UNSAFE.test(value)

/** 主机名：不含空白与控制字符，且不能是邮箱地址那种带 `@` 的串。 */
const validHost = (value: string): boolean => value !== '' && value.length <= 255 && !/[\s@/\\]/u.test(value) && !UNSAFE.test(value)

const UNCONFIGURED = '还没有配置邮箱'

export const MAIL_CONFIG_HINT = '用法：/assistant-mail-config 查看；保存形如 mail=name@example.com '
  + 'smtpHost=smtp.example.com smtpPort=465 imapHost=imap.example.com imapPort=993 password=授权码'

export interface MailConfigView {
  readonly address: string
  readonly smtpHost: string
  readonly smtpPort: number
  readonly imapHost: string
  readonly imapPort: number
  /** 只表示"有没有存过授权码"，永远不表示值本身。 */
  readonly hasPassword: boolean
  /** 值守开关与间隔（mail.json）；页面据此显示"值守中/未开启"。 */
  readonly watchEnabled: boolean
  readonly watchIntervalSeconds: number
}

/** 读当前配置。返回 `null` = 还没配过（`mail.json` 缺失或不可用）。 */
export function readMailConfigView(home: string): MailConfigView | null {
  const base = readMailConfig(home)
  if (base === null) return null
  const imap = readMailImapConfig(home)
  return {
    address: base.user,
    smtpHost: base.host,
    smtpPort: base.port,
    imapHost: imap?.imapHost ?? '',
    imapPort: imap?.imapPort ?? 0,
    hasPassword: existsSync(path.join(mailDir(home), SECRET_FILE)),
    watchEnabled: imap?.watchEnabled ?? false,
    watchIntervalSeconds: imap?.watchIntervalSeconds ?? 600,
  }
}

/**
 * 读回执：一行一条，前端按 ` | ` 切两列直接显示。
 *
 * **任何分支都不回显授权码**，只说「已保存 / 未配置」。这是硬约束：
 * 回包里一旦出现密码（哪怕是截断片段），它就会进会话记录、进日志、进截图。
 */
export function formatMailConfigView(view: MailConfigView | null): string {
  if (view === null) return UNCONFIGURED
  // 空字段统一说「未配置」，**不拼出 `host:` / `:0`**：
  // 前端按 `host:port` 解析时，`:0` 会被当成"端口 0"预填回表单，用户一点保存才发现非法，
  // 而那个 0 是我们塞进去的。宁可少给一个字段，也不要给一个假值。
  const endpoint = (host: string, port: number): string => (host === '' ? '未配置' : `${host}:${port}`)
  return [
    `邮箱 | ${view.address === '' ? '未配置' : view.address}`,
    `SMTP | ${endpoint(view.smtpHost, view.smtpPort)}`,
    `IMAP | ${endpoint(view.imapHost, view.imapPort)}`,
    `授权码 | ${view.hasPassword ? '已保存' : '未配置'}`,
  ].join('\n')
}

export interface MailConfigInput {
  readonly address: string
  readonly smtpHost: string
  readonly smtpPort: number
  readonly imapHost: string
  readonly imapPort: number
  /** 空字符串 = 本次不动已保存的授权码。 */
  readonly password: string
}

export type ConfigCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

const failed = (reason: string): ConfigCheck<never> => ({ ok: false, reason })

function portOf(raw: string, label: string): ConfigCheck<number> {
  const text = raw.trim()
  if (text === '') return failed(`${label}不能为空`)
  if (!/^\d+$/u.test(text)) return failed(`${label}必须是数字`)
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return failed(`${label}要在 1–65535`)
  return { ok: true, value: port }
}

function hostOf(raw: string, label: string): ConfigCheck<string> {
  const text = raw.trim()
  if (text === '') return failed(`${label}不能为空`)
  if (!validHost(text)) return failed(`${label}格式不对，例如 smtp.example.com`)
  return { ok: true, value: text }
}

/**
 * 校验写参数。失败给**具体原因**（哪个字段、错在哪），不说"保存失败"。
 *
 * 键名同时认 `mail=`（命令文档）与 `address=`（工作台表单的字段名）—— 两边都对，
 * 否则表单拼出来的命令行会被服务端当成缺字段。
 */
export function checkMailConfig(values: Record<string, string>): ConfigCheck<MailConfigInput> {
  const address = argumentOf(values, 'mail', 'address')
  if (address === '') return failed('邮箱地址不能为空，例如 name@example.com')
  if (!validEmail(address)) return failed('邮箱地址格式不对，要像 name@example.com')

  const smtpHost = hostOf(argumentOf(values, 'smtpHost'), 'SMTP 主机')
  if (!smtpHost.ok) return smtpHost
  const smtpPort = portOf(argumentOf(values, 'smtpPort'), 'SMTP 端口')
  if (!smtpPort.ok) return smtpPort

  const imapHost = hostOf(argumentOf(values, 'imapHost'), 'IMAP 主机')
  if (!imapHost.ok) return imapHost
  const imapPort = portOf(argumentOf(values, 'imapPort'), 'IMAP 端口')
  if (!imapPort.ok) return imapPort

  return {
    ok: true,
    value: {
      address,
      smtpHost: smtpHost.value,
      smtpPort: smtpPort.value,
      imapHost: imapHost.value,
      imapPort: imapPort.value,
      password: argumentOf(values, 'password'),
    },
  }
}

export interface MailConfigStoreOptions {
  readonly home: string
  /** 仅供可信宿主/测试注入加密器；默认当前 Windows 用户 DPAPI。 */
  readonly encrypt?: (secret: string) => Promise<string>
}

function previousRaw(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  } catch { return {} }
}

function nextWatchInterval(previous: Record<string, unknown>): number {
  const value = previous.watchIntervalSeconds
  return typeof value === 'number' && Number.isInteger(value) && value >= 60 && value <= 86_400 ? value : 600
}

/**
 * 保存邮箱配置，并在**写完之后回读**确认。
 *
 * 顺序刻意如此：
 * 1. 先加密（失败时一个文件都不碰）；
 * 2. 保留 `watchEnabled / watchIntervalSeconds / from` 等既有取值 —— 保存地址不该顺手把值守关掉；
 * 3. 先写密文、再写配置；
 * 4. 回读与期望逐项比对，不一致就报错（不假装成功）。
 */
export async function saveMailConfig(
  options: MailConfigStoreOptions,
  input: MailConfigInput,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const dir = mailDir(options.home)
  const jsonFile = path.join(dir, MAIL_FILE)
  const secretFile = path.join(dir, SECRET_FILE)
  const previous = previousRaw(jsonFile)

  let cipher: string | undefined
  if (input.password !== '') {
    let encrypted = ''
    try { encrypted = (await (options.encrypt ?? encryptWithDpapi)(input.password)).trim() } catch { encrypted = '' }
    if (encrypted === '') return { ok: false, reason: '授权码没能加密保存，配置未改动' }
    cipher = encrypted
  } else if (!existsSync(secretFile)) {
    return { ok: false, reason: '授权码不能为空' }
  }

  const from = typeof previous.from === 'string' && validEmail(previous.from) ? previous.from : input.address
  const next: Record<string, unknown> = {
    host: input.smtpHost,
    port: input.smtpPort,
    // 465 是隐式 TLS；其余端口走 STARTTLS。与 scripts/setup-mail.mjs 的算法一致。
    secure: input.smtpPort === 465,
    user: input.address,
    from,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: previous.imapSecure !== false,
    watchEnabled: previous.watchEnabled !== false,
    watchIntervalSeconds: nextWatchInterval(previous),
  }

  try {
    if (cipher !== undefined) writePrivateFile(secretFile, `${cipher}\n`)
    writePrivateFile(jsonFile, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    return { ok: false, reason: '配置文件没能写入，请检查目标目录权限后重试' }
  }

  const readBack = readMailConfigView(options.home)
  if (readBack === null) return { ok: false, reason: '保存后回读不一致：配置没能完整写入，请重试' }
  const mismatch = readBack.address !== input.address
    || readBack.smtpHost !== input.smtpHost || readBack.smtpPort !== input.smtpPort
    || readBack.imapHost !== input.imapHost || readBack.imapPort !== input.imapPort
    || !readBack.hasPassword
  if (mismatch) return { ok: false, reason: '保存后回读不一致：配置没能完整写入，请重试' }
  return { ok: true }
}
