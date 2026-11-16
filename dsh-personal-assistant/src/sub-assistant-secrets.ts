/**
 * 子助理平台密钥的加密存储：密钥不入团队库、不入模型上下文、不回显界面。
 * 快照只暴露 `{id, hasKey}`；明文只在 resolve() 内部短暂存在，供适配层放进 Authorization 头。
 *
 * 纪律与桌宠 `voice-api.ts` 的 VoiceApiStore 同源：
 * - 加密原语由构造注入（SecretCodec），测试可用可逆假 Codec；
 * - 原子写：临时文件 wx 0600 + fsync + rename，失败时原文件不修改；
 * - 文件损坏如实报错，绝不静默清空用户存过的密钥。
 *
 * 诚实边界（与 bridge.ts 的凭据说明同一口径）：插件进程没有系统密钥库
 * （safeStorage 属于 Electron 主进程），默认 Codec 是 AES-256-GCM + 本机
 * 0600 密钥文件。这挡得住对密钥文件的顺手查看，挡不住任意本地文件读取者
 * ——本地文件不是沙箱，这一点写在这里，不假装不存在。
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

const MB = 1024 * 1024
export const MAX_SECRETS = 32
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type SecretCodec = { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
type StoredEntry = { id: string; encryptedKey: string }
type StoredState = { version: 1; entries: StoredEntry[] }

class SubAssistantSecretsError extends Error {}
function fail(message: string): never { throw new SubAssistantSecretsError(message) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('子助理密钥库格式无效')
  return value as Record<string, unknown>
}
function keyField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value)) fail('子助理密钥格式无效或过长')
  return value
}
function idOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('子助理密钥标识无效')
  return value
}
function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value
}

export class SubAssistantSecrets {
  private readonly filePath: string
  private readonly codec: SecretCodec
  private state: StoredState = { version: 1, entries: [] }

  constructor(filePath: string, codec: SecretCodec) {
    this.filePath = filePath
    this.codec = codec
    let raw: string
    try {
      if (statSync(filePath).size > MB) fail('子助理密钥库文件过大')
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error instanceof SubAssistantSecretsError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      fail('无法读取子助理密钥库，请检查文件，原文件未修改')
    }
    try {
      const value = record(JSON.parse(raw))
      const keys = Object.keys(value)
      if (keys.some(key => !['version', 'entries'].includes(key)) || value.version !== 1 || !Array.isArray(value.entries)
        || value.entries.length > MAX_SECRETS) fail('子助理密钥库格式无效')
      const entries = value.entries.map(item => {
        const input = record(item)
        if (Object.keys(input).some(key => !['id', 'encryptedKey'].includes(key))) fail('子助理密钥条目包含未知字段')
        const encryptedKey = input.encryptedKey
        if (typeof encryptedKey !== 'string' || encryptedKey.length > 32768
          || (encryptedKey !== '' && (!isBase64(encryptedKey) || Buffer.from(encryptedKey, 'base64').length === 0))) fail('子助理密钥数据损坏')
        return { id: idOf(input.id), encryptedKey }
      })
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('子助理密钥标识重复')
      for (const entry of entries) if (entry.encryptedKey) this.decrypt(entry)
      this.state = { version: 1, entries }
    } catch (error) {
      if (error instanceof SubAssistantSecretsError) throw error
      fail('子助理密钥库损坏，无法加载，原文件未修改')
    }
  }

  /** 快照永不携带密钥值：界面与模型上下文只见「已配置/未配置」。 */
  snapshot(): Array<{ id: string; hasKey: boolean }> {
    return this.state.entries.map(entry => ({ id: entry.id, hasKey: entry.encryptedKey !== '' }))
  }

  has(id: string): boolean {
    return this.state.entries.some(entry => entry.id === id)
  }

  /** 明文只在这里短暂存在；条目不存在或密钥未配置返回空串，由调用方如实拒绝。 */
  resolve(id: string): string {
    const entry = this.state.entries.find(item => item.id === id)
    if (!entry || entry.encryptedKey === '') return ''
    return this.decrypt(entry)
  }

  /** 新建或更新一条密钥；apiKey 缺省=保留旧值，空串=清除；返回条目标识（入绑定的 secretId）。 */
  save(input: { id?: unknown; apiKey?: unknown }): { id: string; hasKey: boolean } {
    const value = record(input)
    if (Object.keys(value).some(key => !['id', 'apiKey'].includes(key))) fail('子助理密钥保存请求包含未知字段')
    const id = value.id === undefined ? randomUUID() : idOf(value.id)
    const previous = this.state.entries.find(entry => entry.id === id)
    if (!previous && this.state.entries.length >= MAX_SECRETS) fail('子助理密钥数量已达上限')
    let encryptedKey = previous?.encryptedKey ?? ''
    if (value.apiKey !== undefined) {
      const key = keyField(value.apiKey)
      try {
        const encrypted = key ? this.codec.encrypt(key) : Buffer.alloc(0)
        if (!Buffer.isBuffer(encrypted) || (key && encrypted.length === 0)) fail('子助理密钥加密失败')
        encryptedKey = encrypted.toString('base64')
        if (encryptedKey.length > 32768) fail('子助理密钥加密失败')
      } catch (error) {
        if (error instanceof SubAssistantSecretsError) throw error
        fail('子助理密钥加密失败，原密钥库未修改')
      }
    }
    const entry = { id, encryptedKey }
    const entries = previous
      ? this.state.entries.map(item => item.id === id ? entry : item)
      : [...this.state.entries, entry]
    this.commit({ version: 1, entries })
    return { id, hasKey: encryptedKey !== '' }
  }

  remove(id: unknown): Array<{ id: string; hasKey: boolean }> {
    const validId = idOf(id)
    if (!this.state.entries.some(entry => entry.id === validId)) fail('子助理密钥条目不存在')
    this.commit({ version: 1, entries: this.state.entries.filter(entry => entry.id !== validId) })
    return this.snapshot()
  }

  private decrypt(entry: StoredEntry): string {
    try { return keyField(this.codec.decrypt(Buffer.from(entry.encryptedKey, 'base64'))) }
    catch (error) {
      if (error instanceof SubAssistantSecretsError) throw error
      fail('子助理密钥无法解密，原密钥库未修改')
    }
  }

  private commit(next: StoredState): void {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    let created = false
    try {
      const content = JSON.stringify(next)
      if (Buffer.byteLength(content) > MB) fail('子助理密钥库文件过大')
      descriptor = openSync(temporary, 'wx', 0o600)
      created = true
      writeFileSync(descriptor, content, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.filePath)
    } catch (error) {
      if (error instanceof SubAssistantSecretsError) throw error
      fail('子助理密钥库保存失败，原密钥库未修改')
    } finally {
      if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* 保留原始安全错误 */ } }
      if (created) { try { unlinkSync(temporary) } catch { /* 重命名成功后临时文件已不存在 */ } }
    }
    this.state = next
  }
}

/**
 * 插件进程的默认加密原语：AES-256-GCM，密钥是密钥库旁边一个 0600 的随机 32 字节文件。
 * 密文格式 iv(12) + tag(16) + ciphertext，base64 存库。密钥文件首次使用时原子创建（wx 0600）。
 */
export function fileKeyCodec(keyPath: string): SecretCodec {
  let cached: Buffer | null = null
  const loadKey = (): Buffer => {
    if (cached) return cached
    try {
      const key = readFileSync(keyPath)
      if (key.length !== 32) throw new Error('bad length')
      cached = key
      return key
    } catch {
      // 首次使用：原子创建随机密钥文件。已存在但长度不对时上面的读会走到这里再创建——
      // 会覆盖坏文件；可接受：坏密钥文件本就解不开任何既有密文（如实报错路径）。
      const key = randomBytes(32)
      const temporary = `${keyPath}.${randomUUID()}.tmp`
      try {
        const descriptor = openSync(temporary, 'wx', 0o600)
        try {
          writeFileSync(descriptor, key)
          fsyncSync(descriptor)
        } finally { closeSync(descriptor) }
        renameSync(temporary, keyPath)
      } finally { try { unlinkSync(temporary) } catch { /* 重命名成功后临时文件已不存在 */ } }
      cached = key
      return key
    }
  }
  return {
    encrypt(value: string): Buffer {
      const key = loadKey()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decrypt(value: Buffer): string {
      if (value.length < 28) throw new Error('ciphertext too short')
      const key = loadKey()
      const iv = value.subarray(0, 12)
      const tag = value.subarray(value.length - 16)
      const body = value.subarray(12, value.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    },
  }
}

/** 测试与诊断用：把密钥文件的权限修正为 0600（仅当文件存在）。 */
export function ensureKeyFileMode(keyPath: string): void {
  try { chmodSync(keyPath, 0o600) } catch { /* 密钥文件不存在时无需修正 */ }
}
