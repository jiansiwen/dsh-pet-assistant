/**
 * 说话人音色 → 语音配置覆盖层。唤醒、快答、回复三条播报链路共用的唯一仲裁点。
 *
 * 之前这三条路各叠各的：唤醒不叠、流式回复不叠、非流式回复叠一半，
 * 于是"唤醒一个嗓子、回答另一个嗓子"。规则收在这里后，调用方只负责
 * 把"这个说话人配了什么"交进来，模型与互斥字段由这里统一裁决。
 *
 * 优先级：克隆样本 > 设计描述 > 预置音色 ID。MiMo 三个模型参数互斥
 * （预置只认 audio.voice、设计只认 user 描述、复刻只认样本 data URI），
 * 模型选择走 modelForIntent，覆盖时清掉互斥字段，避免 400。
 */
import { modelForIntent } from './agent-voice-rule.ts'

export interface SpeakerVoice {
  /** 预置音色 ID（服务商侧，如 MiMo 的「冰糖」）。 */
  readonly voiceId?: string
  /** 音色生成：一段自然语言描述，走 voicedesign 模型的 user 消息。 */
  readonly design?: string
  /** 语气/情绪/角色扮演指令，走 user 消息（哪吒的"语气"就放这里）。 */
  readonly style?: string
  /** 音色克隆：参考音频文件路径（大样本走文件）。 */
  readonly sampleFile?: string
  readonly sampleMime?: string
  /** 音色克隆：内联 base64 样本（不含 data: 前缀）。 */
  readonly sample?: string
  /** 成员级 TTS 配置 id（语音设置里配好的某条，如 MiMo 三模型之一）；空＝跟随全局选中。 */
  readonly profileId?: string
}

export interface SpeakerOverlay {
  readonly model?: string
  readonly voice?: string
  readonly voiceDesign?: string
  readonly voiceStyle?: string
  readonly voiceSampleFile?: string
  readonly voiceSampleMime?: string
  readonly voiceSample?: string
}

function trim(value: string | undefined): string {
  return (value ?? '').trim()
}

/** MiMo v2.5 预置音色清单（文档全量）：成员编辑下拉与旧配置校验共用。 */
export const MIMO_PRESET_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] as const

/** 旧版成员种子音色名 → MiMo 预置音色；不认识的名字原样保留（用户自填的 ID）。 */
const LEGACY_PROFILE_PRESET: Record<string, string> = {
  'steady-male': '白桦', 'bright-male': '苏打', 'warm-female': '冰糖', 'calm-male': 'Milo', 'soft-male': 'Dean',
}
export function normalizePresetId(id: string): string {
  const trimmed = id.trim()
  return LEGACY_PROFILE_PRESET[trimmed] ?? trimmed
}

/** 说话人是否自带音色配置；没有任何一项时调用方应沿用服务配置原样。 */
export function hasSpeakerVoice(voice: SpeakerVoice | null | undefined): boolean {
  if (!voice) return false
  return trim(voice.voiceId) !== '' || trim(voice.design) !== '' || trim(voice.style) !== ''
    || trim(voice.sampleFile) !== '' || trim(voice.sample) !== '' || trim(voice.profileId) !== ''
}

/** 读取角色方案和实际播报使用同一套成员音色继承规则。 */
export function memberSpeakerVoice(local: SpeakerVoice | undefined, directory: SpeakerVoice | undefined, chief: SpeakerVoice): SpeakerVoice {
  const voice: SpeakerVoice = {
    ...local,
    voiceId: normalizePresetId(local?.voiceId || directory?.voiceId || ''),
    design: local?.design || directory?.design || '',
  }
  return hasSpeakerVoice(voice) ? voice : chief
}

/**
 * 把说话人音色裁成可叠到 ResolvedVoiceApi 上的覆盖层。
 *
 * 只传语气（style）时不动模型与音色来源：语气是"怎么演"，不是"谁的嗓子"。
 * 带了样本/描述/预置之一时，清掉其余互斥来源 —— 配置里残留的旧样本或旧音色
 * 不能跟着新意图一起发出去（那是之前 400 的根源之一）。
 */
export function speakerOverlay(provider: string, baseModel: string, voice: SpeakerVoice | null | undefined): SpeakerOverlay {
  if (!hasSpeakerVoice(voice)) return {}
  const v = voice as SpeakerVoice
  const voiceId = trim(v.voiceId)
  const design = trim(v.design)
  const style = trim(v.style)
  const sampleFile = trim(v.sampleFile)
  const sample = trim(v.sample)
  const hasSample = sampleFile !== '' || sample !== ''
  const stylePart = style !== '' ? { voiceStyle: style } : {}
  if (!hasSample && design === '' && voiceId === '') return { ...stylePart }
  const model = modelForIntent(provider, baseModel, {
    voiceId: hasSample || design !== '' ? '' : voiceId,
    hasSample,
    design: hasSample ? '' : design,
  })
  if (hasSample) {
    return {
      model, voice: '', voiceDesign: '', voiceSample: '', ...stylePart,
      ...(sampleFile !== '' ? { voiceSampleFile: sampleFile, voiceSampleMime: v.sampleMime } : { voiceSampleFile: '' }),
      ...(sample !== '' ? { voiceSample: sample, voiceSampleMime: v.sampleMime } : {}),
    }
  }
  if (design !== '') {
    return { model, voice: '', voiceDesign: design, voiceSample: '', voiceSampleFile: '', ...stylePart }
  }
  return { model, voice: voiceId, voiceDesign: '', voiceSample: '', voiceSampleFile: '', ...stylePart }
}

/** 说话人音色 → Narrator 每句请求的音色字段（speak/feed 共用）。 */
export function speakerRequestFields(voice: SpeakerVoice | null | undefined): {
  voice?: string
  voiceDesign?: string
  voiceStyle?: string
  voiceSampleFile?: string
  voiceSampleMime?: string
  voiceSample?: string
  ttsProfileId?: string
} {
  if (!hasSpeakerVoice(voice)) return {}
  const v = voice as SpeakerVoice
  return {
    ...(trim(v.voiceId) !== '' ? { voice: trim(v.voiceId) } : {}),
    ...(trim(v.design) !== '' ? { voiceDesign: trim(v.design) } : {}),
    ...(trim(v.style) !== '' ? { voiceStyle: trim(v.style) } : {}),
    ...(trim(v.sampleFile) !== '' ? { voiceSampleFile: trim(v.sampleFile), voiceSampleMime: v.sampleMime } : {}),
    ...(trim(v.sample) !== '' ? { voiceSample: trim(v.sample), voiceSampleMime: v.sampleMime } : {}),
    ...(trim(v.profileId) !== '' ? { ttsProfileId: trim(v.profileId) } : {}),
  }
}
