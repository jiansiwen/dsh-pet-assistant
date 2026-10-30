import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export interface AssistantAgentSettings {
  name: string
  persona: string
  provider: string
  model: string
  maxTokens: number
  tokenBudget: number
}

export interface AssistantSettingsOptions {
  home: string
  defaultModel: () => { provider: string; model: string } | null
  connected: () => boolean
  channelSettings: () => { allowedUserIds: string[]; deliverHere: string[] }
  reconnect: () => Promise<void>
  /** 仅供可信宿主注入加密器；生产环境默认使用当前 Windows 用户的 DPAPI。 */
  encrypt?: (secret: string) => Promise<string>
}

const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const botIdSchema = z.string().max(200).trim()
const agentShape = {
  name: z.string().max(80).trim().min(1),
  persona: z.string().max(8000),
  provider: z.string().max(128).trim(),
  model: z.string().max(256).trim(),
  maxTokens: z.number().int().min(1).max(32768),
  tokenBudget: z.number().int().min(0).max(10_000_000),
}
const pairedModel = (value: { provider: string; model: string }) => !!value.provider === !!value.model
const agentSchema = z.object(agentShape).strict().refine(pairedModel)
const reminderSchema = z.object({ repeatEverySeconds: z.number().int().min(60).max(604800) }).strict()
const settingsSchema = z.object({ revision: revisionSchema, reminder: reminderSchema, agent: agentSchema }).strict()
const wecomSchema = z.object({ enabled: z.boolean(), botId: botIdSchema }).strict()
const wecomRequestSchema = z.object({
  expectedRevision: revisionSchema, enabled: z.boolean(), botId: botIdSchema,
  secret: z.string().max(4096).optional(),
}).strict()
const reminderRequestSchema = reminderSchema.extend({ expectedRevision: revisionSchema }).strict()
const agentRequestSchema = z.object({ expectedRevision: revisionSchema, ...agentShape }).strict().refine(pairedModel)
const reconnectSchema = z.object({ expectedRevision: revisionSchema }).strict()
const routes = ['/companion/v1/settings', '/companion/v1/settings/wecom', '/companion/v1/settings/reminders',
  '/companion/v1/settings/agent', '/companion/v1/settings/wecom/reconnect'] as const
const envelopeSchema = z.object({ method: z.enum(['GET', 'POST']), pathname: z.enum(routes) }).strict()
const cipherSchema = z.string().min(4).max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const journalSchema = z.object({ hadSettings: z.boolean(), hadWecom: z.boolean(), hadSecret: z.boolean(), replaceSecret: z.boolean() }).strict()
type Settings = z.infer<typeof settingsSchema>
type WeCom = z.infer<typeof wecomSchema>
type Journal = z.infer<typeof journalSchema>
type Response = { status: number; body: unknown }

function defaults(): Settings {
  return { revision: 0, reminder: { repeatEverySeconds: 300 },
    agent: { name: '小潘', persona: '', provider: '', model: '', maxTokens: 4096, tokenBudget: 0 } }
}

class SettingsError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
const unavailable = () => new SettingsError(503, 'SETTINGS_UNAVAILABLE', '设置文件损坏、不可访问或恢复未完成；请检查后重启，未覆盖原配置。')
const invalid = () => new SettingsError(400, 'INVALID_INPUT', '请求字段、类型或取值不符合设置接口要求。')

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function fileExists(file: string): boolean {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 131072) throw unavailable()
    return true
  } catch (error) { if (missing(error)) return false; throw error }
}
function jsonFile<T>(file: string, schema: z.ZodType<T>): T | undefined {
  if (!fileExists(file)) return undefined
  // 不返回解析器异常：其消息可能包含用户输入或历史误存的凭据。
  return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
}
function secretExists(file: string): boolean {
  if (!fileExists(file)) return false
  if (lstatSync(file).size === 0) throw unavailable()
  return true // 不读取、解密或投影已有密钥内容。
}
function syncFile(file: string): void {
  const fd = openSync(file, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function removeFile(file: string): void {
  try { unlinkSync(file) } catch (error) { if (!missing(error)) throw error }
}
function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    syncFile(temporary)
    renameSync(temporary, file)
  } finally { removeFile(temporary) }
}
function atomicCopy(source: string, target: string): void {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    copyFileSync(source, temporary)
    syncFile(temporary)
    renameSync(temporary, target)
  } finally { removeFile(temporary) }
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

// 固定命令只从标准输入接收秘密；不使用命令插值，不记录标准错误。
const DPAPI_COMMAND = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.Encoding]::UTF8;' +
  ' Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd();' +
  ' $b=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p),$null,"CurrentUser");' +
  ' [Console]::Out.Write([Convert]::ToBase64String($b))'

async function encryptWindows(secret: string): Promise<string> {
  if (process.platform !== 'win32') throw new SettingsError(503, 'CREDENTIALS_UNSUPPORTED', '当前系统不支持修改企业微信凭据，请在 Windows 上配置。')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_COMMAND],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new SettingsError(503, 'ENCRYPTION_FAILED', '凭据加密失败，原配置未变更。'))
    }
    const timer = setTimeout(fail, 15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 65536) fail() })
    child.stderr.resume()
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', code => {
      if (settled) return
      if (code !== 0 || !cipherSchema.safeParse(output.trim()).success) { fail(); return }
      settled = true
      clearTimeout(timer)
      resolve(output.trim())
    })
    child.stdin.end(secret, 'utf8')
  })
}

export class AssistantSettings {
  private readonly options: AssistantSettingsOptions
  private readonly dir: string
  private readonly transaction: string
  private settings = defaults()
  private wecom: WeCom = { enabled: false, botId: '' }
  private hasSecret = false
  private busy = false
  private fault = false

  constructor(options: AssistantSettingsOptions) {
    this.options = options
    this.dir = path.join(options.home, 'personal-assistant')
    this.transaction = path.join(this.dir, '.assistant-settings-transaction')
    try {
      this.recover()
      const disk = this.readDisk()
      this.settings = disk.settings
      this.wecom = disk.wecom
      this.hasSecret = disk.hasSecret
    } catch { this.fault = true }
  }

  private file(name: string): string { return path.join(this.dir, name) }
  private staged(name: string): string { return path.join(this.transaction, name) }
  private check(): void { if (this.fault) throw unavailable() }

  private readDisk() {
    const settings = jsonFile(this.file('assistant-settings.json'), settingsSchema) ?? defaults()
    const config = jsonFile(this.file('wecom.json'), wecomSchema)
    const wecom = config ?? { enabled: false, botId: '' }
    const hasSecret = secretExists(this.file('wecom.secret'))
    if ((wecom.enabled && (!wecom.botId || !hasSecret)) || (hasSecret && !wecom.botId)) throw unavailable()
    return { settings, wecom, hasSecret }
  }

  private checkDisk(): void {
    let disk: ReturnType<AssistantSettings['readDisk']>
    try { disk = this.readDisk() } catch { this.fault = true; throw unavailable() }
    if (json(disk) !== json({ settings: this.settings, wecom: this.wecom, hasSecret: this.hasSecret })) {
      this.settings = disk.settings
      this.wecom = disk.wecom
      this.hasSecret = disk.hasSecret
      throw new SettingsError(409, 'STALE_REVISION', '设置已由其他入口修改，请刷新后重试。')
    }
  }

  getAgent(): AssistantAgentSettings { this.check(); return { ...this.settings.agent } }
  getReminderInterval(): number { this.check(); return this.settings.reminder.repeatEverySeconds }

  snapshot() {
    this.check()
    // 宿主状态查询失败时保守投影；不能让保存成功变成包含宿主异常的失败响应。
    let connected = false
    let defaultModel: { provider: string; model: string } | null = null
    let allowedUserIds: string[] = [], deliverHere: string[] = []
    try { connected = this.options.connected() === true } catch { /* 不回显异常。 */ }
    try {
      const value = this.options.defaultModel()
      if (value) defaultModel = { provider: value.provider, model: value.model }
    } catch { /* 默认模型暂不可用。 */ }
    try {
      const value = this.options.channelSettings()
      allowedUserIds = [...value.allowedUserIds]
      deliverHere = [...value.deliverHere]
    } catch { /* 渠道配置暂不可用。 */ }
    return { revision: this.settings.revision,
      wecom: { ...this.wecom, secretConfigured: this.hasSecret, connected, allowedUserIds, deliverHere },
      reminder: { ...this.settings.reminder }, agent: this.getAgent(), defaultModel }
  }

  /** 恢复只复制密文，不读取内容。回滚始终先禁用，再恢复密钥，最后恢复启用配置。 */
  private recover(): void {
    try {
      const stat = lstatSync(this.transaction)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
    } catch (error) { if (missing(error)) return; throw error }
    const journal = jsonFile(this.staged('ready.json'), journalSchema)
    const committed = jsonFile(this.staged('committed.json'), z.literal(true))
    if (journal && !committed) {
      // 所有备份先校验，避免把不完整备份恢复到正式文件。
      if (journal.hadSettings && !jsonFile(this.staged('settings.old'), settingsSchema)) throw unavailable()
      const oldWecom = journal.hadWecom ? jsonFile(this.staged('wecom.old'), wecomSchema) : undefined
      if (journal.hadWecom && !oldWecom) throw unavailable()
      if (journal.replaceSecret && journal.hadSecret && !secretExists(this.staged('secret.old'))) throw unavailable()
      atomicWrite(this.file('wecom.json'), json({ enabled: false, botId: '' }))
      if (journal.replaceSecret) {
        if (journal.hadSecret) atomicCopy(this.staged('secret.old'), this.file('wecom.secret'))
        else removeFile(this.file('wecom.secret'))
      }
      if (journal.hadSettings) atomicCopy(this.staged('settings.old'), this.file('assistant-settings.json'))
      else removeFile(this.file('assistant-settings.json'))
      if (journal.hadWecom) atomicCopy(this.staged('wecom.old'), this.file('wecom.json'))
      else removeFile(this.file('wecom.json'))
    }
    // 没有 ready 的暂存从未触碰正式文件；有 committed 的事务已经完整提交。
    rmSync(this.transaction, { recursive: true })
  }

  private saveWeCom(next: WeCom, settings: Settings, cipher?: string): void {
    this.recover()
    mkdirSync(this.transaction)
    let committed = false
    try {
      const journal: Journal = {
        hadSettings: fileExists(this.file('assistant-settings.json')),
        hadWecom: fileExists(this.file('wecom.json')),
        hadSecret: this.hasSecret, replaceSecret: cipher !== undefined,
      }
      if (journal.hadSettings) atomicCopy(this.file('assistant-settings.json'), this.staged('settings.old'))
      if (journal.hadWecom) atomicCopy(this.file('wecom.json'), this.staged('wecom.old'))
      if (journal.replaceSecret && journal.hadSecret) atomicCopy(this.file('wecom.secret'), this.staged('secret.old'))
      atomicWrite(this.staged('settings.next'), json(settings))
      atomicWrite(this.staged('wecom.next'), json(next))
      if (cipher !== undefined) atomicWrite(this.staged('secret.next'), `${cipher}\n`)
      atomicWrite(this.staged('ready.json'), json(journal))
      // 原读取器仅认 enabled=true：切换密钥期间不可见新旧混搭配置。
      atomicWrite(this.file('wecom.json'), json({ enabled: false, botId: this.wecom.botId }))
      if (cipher !== undefined) renameSync(this.staged('secret.next'), this.file('wecom.secret'))
      renameSync(this.staged('settings.next'), this.file('assistant-settings.json'))
      renameSync(this.staged('wecom.next'), this.file('wecom.json'))
      atomicWrite(this.staged('committed.json'), json(true))
      committed = true
    } catch {
      try { this.recover() } catch { this.fault = true }
      throw new SettingsError(503, 'SAVE_FAILED', this.fault
        ? '保存中断，设置暂不可用；请检查文件并重启以恢复，勿重新绑定。'
        : '设置保存失败，原配置已保留。')
    } finally {
      if (committed) {
        try { rmSync(this.transaction, { recursive: true }) } catch { /* 已提交；下次操作或启动清理。 */ }
      }
    }
  }

  async request(method: string, pathname: string, body: unknown): Promise<Response> {
    try {
      this.check()
      if (!envelopeSchema.safeParse({ method, pathname }).success) throw invalid()
      if (method === 'GET') {
        if (pathname !== routes[0] || !z.union([z.undefined(), z.null(), z.object({}).strict()]).safeParse(body).success) throw invalid()
        return { status: 200, body: this.snapshot() }
      }
      if (pathname === routes[0]) throw invalid()
      const schema = pathname === routes[1] ? wecomRequestSchema : pathname === routes[2] ? reminderRequestSchema
        : pathname === routes[3] ? agentRequestSchema : reconnectSchema
      const parsed = schema.safeParse(body)
      if (!parsed.success) throw invalid()
      if (this.busy) throw new SettingsError(409, 'SETTINGS_BUSY', '设置正在保存或重连，请稍后刷新重试。')
      this.checkDisk()
      if (parsed.data.expectedRevision !== this.settings.revision) throw new SettingsError(409, 'STALE_REVISION', '设置版本已变化，请刷新后重试。')
      if (this.settings.revision === Number.MAX_SAFE_INTEGER) throw new SettingsError(503, 'REVISION_EXHAUSTED', '设置版本已达上限，无法继续保存。')
      this.busy = true // 在任何异步等待之前占用，所有写接口共用一个版本和互斥入口。
      try {
        const next = settingsSchema.parse({ ...this.settings, revision: this.settings.revision + 1 })
        let nextWecom: WeCom | undefined, cipher: string | undefined
        if (pathname === routes[1]) {
          const input = wecomRequestSchema.parse(parsed.data)
          const newSecret = input.secret !== undefined && input.secret !== ''
          if (this.hasSecret && input.botId !== this.wecom.botId && !newSecret) {
            throw new SettingsError(422, 'SECRET_REQUIRED', '更换已配置的机器人标识时必须同时提供新密钥。')
          }
          if ((newSecret && !input.botId) || (input.enabled && (!input.botId || (!newSecret && !this.hasSecret)))) {
            throw new SettingsError(422, 'CREDENTIALS_REQUIRED', '启用企业微信需要机器人标识和密钥，密钥必须关联机器人标识。')
          }
          if (process.platform !== 'win32' && !this.options.encrypt && (newSecret || input.botId !== this.wecom.botId)) {
            throw new SettingsError(503, 'CREDENTIALS_UNSUPPORTED', '当前系统不支持修改企业微信凭据，请在 Windows 上配置。')
          }
          if (newSecret) {
            try {
              const encrypted = await (this.options.encrypt ?? encryptWindows)(input.secret!)
              const validated = cipherSchema.safeParse(encrypted)
              if (!validated.success || encrypted === input.secret) throw invalid()
              cipher = validated.data
            } catch { throw new SettingsError(503, 'ENCRYPTION_FAILED', '凭据加密失败，原配置未变更。') }
          }
          nextWecom = { enabled: input.enabled, botId: input.botId }
        } else if (pathname === routes[2]) {
          next.reminder = { repeatEverySeconds: reminderRequestSchema.parse(parsed.data).repeatEverySeconds }
        } else if (pathname === routes[3]) {
          const { expectedRevision: _, ...agent } = agentRequestSchema.parse(parsed.data)
          next.agent = agent
        }
        // 加密等待期间磁盘可能被其他可信入口修改；确认后才开始写入。
        this.checkDisk()
        try {
          mkdirSync(this.dir, { recursive: true })
          if (nextWecom) this.saveWeCom(nextWecom, next, cipher)
          else {
            this.recover()
            atomicWrite(this.file('assistant-settings.json'), json(next))
          }
        } catch (error) {
          if (error instanceof SettingsError) throw error
          throw new SettingsError(503, 'SAVE_FAILED', '设置保存失败，请检查本地文件后重试。')
        }
        this.settings = next
        if (nextWecom) { this.wecom = nextWecom; this.hasSecret = this.hasSecret || cipher !== undefined }
        if (nextWecom || pathname === routes[4]) {
          try { await this.options.reconnect() } catch {
            return { status: 200, body: { ...this.snapshot(), message: '设置已保存，但企业微信重连失败，请检查连接状态后重试。' } }
          }
        }
        return { status: 200, body: this.snapshot() }
      } finally { this.busy = false }
    } catch (error) {
      const safe = error instanceof SettingsError ? error : unavailable()
      return { status: safe.status, body: { code: safe.code, message: safe.message } }
    }
  }
}
