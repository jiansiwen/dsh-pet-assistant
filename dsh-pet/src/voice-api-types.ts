export type VoiceApiKind = 'tts' | 'asr'
export type VoiceApiProvider = 'openai' | 'mimo'

export interface VoiceApiProfile {
  id: string
  kind: VoiceApiKind
  name: string
  endpoint: string
  model: string
  voice: string
  hasKey: boolean
  provider: VoiceApiProvider
}

export interface VoiceApiState {
  profiles: VoiceApiProfile[]
  selected: Record<VoiceApiKind, string | null>
}

export interface VoiceApiInput {
  id?: string
  kind: VoiceApiKind
  name: string
  endpoint: string
  model: string
  voice?: string
  apiKey?: string
  provider?: VoiceApiProvider
}

export interface ResolvedVoiceApi {
  id: string
  kind: VoiceApiKind
  name: string
  endpoint: string
  model: string
  voice: string
  apiKey: string
  provider: VoiceApiProvider
}

export type VoiceApiResult = { ok: true; state: VoiceApiState } | { ok: false; error: string }
