/**
 * 企业微信**应用**配置的运行时读写（`/assistant-wecom-config`）。
 *
 * ## 和既有 `assistant-settings.ts` 的 wecom 段是什么关系（为什么不写在一起）
 *
 * 包里已经有两套企业微信的东西，语义不同、字段不通用：
 * 1. `wecom.json` + `wecom.secret`（`wecom.ts`）—— 智能机器人（aibot 长连接）：`{ enabled, botId }`
 *    + DPAPI 密文。`AssistantSettings` 的 `/companion/v1/settings/wecom` 路由管的是**这一套**，
 *    并且带 revision 事务与重连。
 * 2. 工作台「企业微信」表单要的是**企业应用消息**四个字段：`corpId / agentId / secret / toUser`。
 *    这套字段在包内此前不存在，两边的 secret 也不能互换。
 *
 * 所以这里**不新开一套事务型存储**，而是沿用既有的那套文件面与机制：
 * - 同一个目录（`~/.dsh/personal-assistant`）、同一套 DPAPI 凭据机制、同样的原子写 + `0o600`；
 * - 刻意**不写** `wecom.secret`：`assistant-settings.ts:readDisk()` 有一条不变量
 *   「有 `wecom.secret` 就必须有 `botId`，否则整块设置视为损坏」，把应用 Secret 塞进去会让设置页直接变不可用；
 * - 也刻意不改 `wecomSchema`（`.strict()`）：给 `wecom.json` 加字段会让既有的设置快照/REST 契约一起变形。
 *
 * 一句话：共用存储目录与凭据机制，字段独立成 `wecom-app.json` / `wecom-app.secret`，
 * 互不影响 —— 机器人连着、应用配置也能改，反之亦然。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { argumentOf } from './config-args.ts'
import { encryptWithDpapi } from './credential-cipher.ts'
import { mailDir } from './mail.ts'
import { writePrivateFile } from './private-file.ts'

const APP_FILE = 'wecom-app.json'
const APP_SECRET_FILE = 'wecom-app.secret'

const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
/** 企业 ID / AgentId / 接收人都不该带空白；这是最省事也最不容易误伤的边界。 */
const NO_SPACE = /^[^\s]+$/u

export const WECOM_CONFIG_HINT = '用法：/assistant-wecom-config 查看；保存形如 corpId=ww1234 '
  + 'agentId=1000002 secret=应用Secret toUser=@all'

export interface WeComAppView {
  readonly corpId: string
  readonly agentId: string
  readonly toUser: string
  /** 只表示"有没有存过 Secret"，永远不表示值本身。 */
  readonly hasSecret: boolean
}

function readRaw(home: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(path.join(mailDir(home), APP_FILE), 'utf8')) as unknown
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  } catch { return {} }
}

const text = (value: unknown): string => (typeof value === 'string' && !UNSAFE.test(value) ? value.trim() : '')

/** 读当前配置。没配过也返回四个空值 —— 读命令永远能给出四行，前端才好画表。 */
export function readWeComAppView(home: string): WeComAppView {
  const raw = readRaw(home)
  return {
    corpId: text(raw.corpId),
    agentId: text(raw.agentId),
    toUser: text(raw.toUser),
    hasSecret: existsSync(path.join(mailDir(home), APP_SECRET_FILE)),
  }
}

/** 读回执：一行一条。**任何分支都不回显 Secret**，只说「已保存 / 未配置」。 */
export function formatWeComAppView(view: WeComAppView): string {
  const orUnset = (value: string): string => (value === '' ? '未配置' : value)
  return [
    `企业 ID | ${orUnset(view.corpId)}`,
    `AgentId | ${orUnset(view.agentId)}`,
    `接收人 | ${orUnset(view.toUser)}`,
    `Secret | ${view.hasSecret ? '已保存' : '未配置'}`,
  ].join('\n')
}

export interface WeComAppInput {
  readonly corpId: string
  readonly agentId: string
  readonly toUser: string
  /** 空字符串 = 本次不动已保存的 Secret。 */
  readonly secret: string
}

export type WeComConfigCheck =
  | { readonly ok: true; readonly value: WeComAppInput }
  | { readonly ok: false; readonly reason: string }

const failed = (reason: string): WeComConfigCheck => ({ ok: false, reason })

/** 校验写参数：四个字段都必填，AgentId 必须是数字。失败给具体原因。 */
export function checkWeComAppConfig(values: Record<string, string>): WeComConfigCheck {
  const corpId = argumentOf(values, 'corpId')
  if (corpId === '') return failed('企业 ID 不能为空')
  if (!NO_SPACE.test(corpId)) return failed('企业 ID 不能含空格')

  const agentId = argumentOf(values, 'agentId')
  if (agentId === '') return failed('AgentId 不能为空')
  if (!/^\d+$/u.test(agentId)) return failed('AgentId 必须是数字')

  const toUser = argumentOf(values, 'toUser')
  if (toUser === '') return failed('接收人不能为空')
  if (!NO_SPACE.test(toUser)) return failed('接收人不能含空格，多个账号用 | 隔开')

  return { ok: true, value: { corpId, agentId, toUser, secret: argumentOf(values, 'secret') } }
}

export interface WeComAppStoreOptions {
  readonly home: string
  /** 仅供可信宿主/测试注入加密器；默认当前 Windows 用户 DPAPI。 */
  readonly encrypt?: (secret: string) => Promise<string>
}

/**
 * 保存应用配置并回读确认。顺序同邮件：先加密（失败不碰文件）→ 写密文 → 写配置 → 回读比对。
 */
export async function saveWeComAppConfig(
  options: WeComAppStoreOptions,
  input: WeComAppInput,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const dir = mailDir(options.home)
  const jsonFile = path.join(dir, APP_FILE)
  const secretFile = path.join(dir, APP_SECRET_FILE)

  let cipher: string | undefined
  if (input.secret !== '') {
    let encrypted = ''
    try { encrypted = (await (options.encrypt ?? encryptWithDpapi)(input.secret)).trim() } catch { encrypted = '' }
    if (encrypted === '') return { ok: false, reason: 'Secret 没能加密保存，配置未改动' }
    cipher = encrypted
  } else if (!existsSync(secretFile)) {
    return { ok: false, reason: 'Secret 不能为空' }
  }

  try {
    if (cipher !== undefined) writePrivateFile(secretFile, `${cipher}\n`)
    writePrivateFile(jsonFile, `${JSON.stringify({ corpId: input.corpId, agentId: input.agentId, toUser: input.toUser }, null, 2)}\n`)
  } catch {
    return { ok: false, reason: '配置文件没能写入，请检查目标目录权限后重试' }
  }

  const readBack = readWeComAppView(options.home)
  const mismatch = readBack.corpId !== input.corpId || readBack.agentId !== input.agentId
    || readBack.toUser !== input.toUser || !readBack.hasSecret
  if (mismatch) return { ok: false, reason: '保存后回读不一致：配置没能完整写入，请重试' }
  return { ok: true }
}
