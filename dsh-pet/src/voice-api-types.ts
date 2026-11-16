export type VoiceApiKind = 'tts' | 'asr'
export type VoiceApiProvider = 'openai' | 'mimo'

export interface VoiceApiProfile {
  id: string
  kind: VoiceApiKind
  name: string
  endpoint: string
  model: string
  voice: string
  /**
   * 音色设计描述（MiMo 的 `mimo-v2.5-tts-voicedesign` 用）。
   *
   * 重要：MiMo 的"设计音色"**不返回 voice id**。每次合成都要把描述放进
   * `role: user` 消息、待合成文本放进 `role: assistant` 消息。
   * 所以这里存的是一段人话描述，而不是一个音色编号。
   */
  voiceDesign: string
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
  /** 音色设计描述；只在 TTS 且用 voicedesign 模型时有意义。 */
  voiceDesign?: string
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
  /** 音色设计描述；合成时作为 `user` 消息发给 voicedesign 模型。 */
  voiceDesign: string
  /**
   * 音色复刻用的音频样本（base64，不含 data: 前缀）。
   * 只在一次合成里临时覆盖：样本属于"某个说话人"，不落进共享的语音配置。
   */
  /** 语气/情绪/方言/角色扮演的自然语言指令（走 user 消息）。 */
  voiceStyle?: string
  voiceSample?: string
  /** 样本文件路径：有它就不必把 base64 塞进请求。 */
  voiceSampleFile?: string
  /** 样本的 mime，默认 audio/wav。 */
  voiceSampleMime?: string
  apiKey: string
  provider: VoiceApiProvider
}

export type VoiceApiResult = { ok: true; state: VoiceApiState } | { ok: false; error: string }
