/**
 * 自定义音色：本人同意样本 → 用户自配克隆 provider → voiceId → 复用 openai 兼容 TTS profile 发声。
 * 只克隆本人或已授权声音；同意记录可撤销，撤销后删除 profile 并回退默认音色。
 * 样本只以 base64 发给用户自己配置的克隆端点，不落公共缓存。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MediaError, cloneVoice, type CloneProviderConfig, type MediaProviderStore } from './media-providers.ts'
import type { VoiceApiState } from '../voice-api-types.ts'

export interface VoiceStoreLike {
  save(input: unknown): VoiceApiState
  remove(id: unknown): VoiceApiState
  select(kind: unknown, id: unknown): VoiceApiState
  snapshot(): VoiceApiState
}

export interface CustomVoice {
  id: string
  name: string
  voiceId: string
  providerId: string
  profileId: string | null
  createdAt: number
  consentAt: number
  sampleNames: string[]
}

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac'])
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024

export class VoiceCloneService {
  private readonly deps: {
    userDataDir: string
    store: MediaProviderStore
    voices: VoiceStoreLike
    emit?: (event: string) => void
    now?: () => number
  }

  constructor(deps: {
    userDataDir: string
    store: MediaProviderStore
    voices: VoiceStoreLike
    emit?: (event: string) => void
    now?: () => number
  }) {
    this.deps = deps
  }

  private voicesPath(): string {
    return path.join(this.deps.userDataDir, 'asset-studio', 'voices.json')
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  list(): CustomVoice[] {
    try {
      const raw = JSON.parse(readFileSync(this.voicesPath(), 'utf8')) as { voices: CustomVoice[] }
      return Array.isArray(raw.voices) ? raw.voices : []
    } catch {
      return []
    }
  }

  private save(voices: CustomVoice[]): void {
    mkdirSync(path.dirname(this.voicesPath()), { recursive: true })
    writeFileSync(this.voicesPath(), JSON.stringify({ voices }, null, 2), 'utf8')
    this.deps.emit?.('voices-changed')
  }

  /** 样本校验 + 克隆 + 登记；未同意直接拒绝。 */
  async enroll(input: { providerId: string; name: string; files: string[]; consent: boolean }): Promise<CustomVoice> {
    if (input.consent !== true) throw new MediaError('需确认样本为本人或已授权声音', 'CONSENT_REQUIRED')
    const config = this.deps.store.load()
    const provider = config.clone.find(p => p.id === input.providerId)
    if (!provider) throw new MediaError('克隆 provider 未配置', 'PROVIDER_MISSING')
    if (!input.files.length || input.files.length > 3) throw new MediaError('样本需 1–3 个音频文件', 'BAD_SAMPLES')
    const samples = input.files.map(file => {
      const ext = path.extname(file).toLowerCase()
      if (!AUDIO_EXT.has(ext)) throw new MediaError(`不支持的样本格式：${ext}`, 'BAD_SAMPLES')
      const size = statSync(file).size
      if (size <= 0 || size > MAX_SAMPLE_BYTES) throw new MediaError('样本需小于 10MB', 'BAD_SAMPLES')
      return { base64: readFileSync(file).toString('base64'), name: path.basename(file) }
    })
    const voiceId = await cloneVoice(this.deps.store, provider, samples)
    const voice: CustomVoice = {
      id: `voice-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: input.name.trim().slice(0, 60) || '自定义音色',
      voiceId,
      providerId: provider.id,
      profileId: null,
      createdAt: this.now(),
      consentAt: this.now(),
      sampleNames: samples.map(s => s.name),
    }
    this.save([...this.list(), voice])
    return voice
  }

  /** 把克隆音色接成当前 TTS：建 openai 兼容 profile 并选中。 */
  apply(id: string): void {
    const voice = this.list().find(v => v.id === id)
    if (!voice) throw new MediaError('音色不存在', 'VOICE_MISSING')
    const provider = this.deps.store.load().clone.find(p => p.id === voice.providerId)
    if (!provider) throw new MediaError('克隆 provider 配置已删除', 'PROVIDER_MISSING')
    const apiKey = this.deps.store.secretOf(provider.ttsApiKeyRef)
    const state = this.deps.voices.save({
      kind: 'tts',
      name: `自定义·${voice.name}`,
      endpoint: provider.ttsEndpoint,
      model: provider.ttsModel,
      voice: voice.voiceId,
      provider: 'openai',
      ...(apiKey ? { apiKey } : {}),
    })
    const profile = state.profiles.find(p => p.kind === 'tts' && p.voice === voice.voiceId && p.endpoint === provider.ttsEndpoint)
    if (!profile) throw new MediaError('TTS profile 创建失败', 'PROFILE_FAILED')
    this.deps.voices.select('tts', profile.id)
    voice.profileId = profile.id
    this.save(this.list().map(v => v.id === id ? voice : v))
  }

  /** 撤销：删 profile、清选择、删登记；已发给克隆端点的样本副本不可控，如实告知。 */
  revoke(id: string): { externalCopiesUncontrolled: boolean } {
    const voice = this.list().find(v => v.id === id)
    if (!voice) throw new MediaError('音色不存在', 'VOICE_MISSING')
    if (voice.profileId) {
      const state = this.deps.voices.snapshot()
      this.deps.voices.remove(voice.profileId)
      if (state.selected.tts === voice.profileId) this.deps.voices.select('tts', null)
    }
    this.save(this.list().filter(v => v.id !== id))
    return { externalCopiesUncontrolled: true }
  }
}