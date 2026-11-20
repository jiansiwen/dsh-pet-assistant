/**
 * 回读值该不该覆盖输入框：**空值不覆盖已有的非空内容**。
 *
 * 单独放在这里是因为它要被**渲染进程**和主进程两边共用：
 * 渲染进程不能碰 node:fs，规则本身却是纯函数。
 *
 * 这一条是"点保存反而把描述清空"那次事故的硬保险。
 */
export function preferNonEmpty(current: string, incoming: string): string {
  if (incoming === '' && current !== '') return current
  return incoming
}

/**
 * 把设置页的三个输入框转成设置补丁。
 *
 * 单独收在这里，是因为这里出过一次很难看的错：渲染进程写的是 `voiceStyle`，
 * 而存储字段叫 `agentVoiceStyle` —— 补丁里那个键被 normalize 直接丢掉，
 * 于是"保存成功、内容没变"。字段名现在只有这一处，改错会立刻在类型和测试里露出来。
 */
export interface AgentVoiceInput {
  design: string
  style: string
  voiceId: string
  sampleData: string
  sampleMime: string
}

export interface AgentVoicePatch {
  agentVoiceDesign: string
  agentVoiceStyle: string
  agentVoiceId: string
  agentVoiceSample: string
  agentVoiceSampleMime: string
}

export function agentVoicePatch(input: AgentVoiceInput): AgentVoicePatch {
  return {
    agentVoiceDesign: input.design.trim(),
    agentVoiceStyle: input.style.trim(),
    agentVoiceId: input.voiceId.trim(),
    agentVoiceSample: input.sampleData,
    agentVoiceSampleMime: input.sampleMime,
  }
}

/**
 * 按"想用哪种音色"决定该用哪个模型。
 *
 * 这是 400 的根源：MiMo 三个模型对参数的要求互斥 ——
 *   mimo-v2.5-tts          只认 audio.voice（预置音色）
 *   mimo-v2.5-tts-voicedesign 只认 user 里的描述，带了 audio.voice 就 400
 *   mimo-v2.5-tts-voiceclone  只认 audio.voice 里的 data URI 样本
 * 试听会按意图挑模型，唤醒却直接用"选中那条配置"的模型，于是选的是 design/clone
 * 却塞进预置音色 → 服务端 400。规则收到这里，两处共用，不会再各写一套。
 */
export interface VoiceIntent {
  voiceId?: string
  hasSample?: boolean
  design?: string
}

export function modelForIntent(provider: string, model: string, intent: VoiceIntent): string {
  if (provider !== 'mimo') return model
  const current = model.toLowerCase()
  const hasVoiceId = typeof intent.voiceId === 'string' && intent.voiceId.trim() !== ''
  /* 选了预置音色：设计/复刻模型都不认它，必须切回预置模型。 */
  if (hasVoiceId) return current.includes('voicedesign') || current.includes('voiceclone') ? 'mimo-v2.5-tts' : model
  /* 有样本：必须用复刻模型。 */
  if (intent.hasSample) return current.includes('voiceclone') ? model : 'mimo-v2.5-tts-voiceclone'
  /* 有描述：必须用设计模型（复刻模型会忽略描述）。 */
  if (typeof intent.design === 'string' && intent.design.trim() !== '') {
    return current.includes('voicedesign') ? model : 'mimo-v2.5-tts-voicedesign'
  }
  /*
    三样都没有（没音色、没样本、没描述）却还挂着 design/clone 模型 —— 这种组合必 400：
    clone 模型会收到空样本，design 模型会收到空描述。
    唤醒语最容易踩这一条：它可能一项都没带。降级回预置模型，用默认音色。
  */
  if (current.includes('voiceclone') || current.includes('voicedesign')) return 'mimo-v2.5-tts'
  return model
}
