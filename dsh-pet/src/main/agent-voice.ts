/**
 * 总助理音色的读取与"空值不覆盖"规则。
 *
 * 抽成纯函数是有原因的：这块之前连续出过三次事故 ——
 * 1) 存进配置了，但回读走错结构，界面显示空；
 * 2) 界面显示空，用户一点保存，空值把真描述覆盖掉；
 * 3) 回读排在语音配置列表后面，列表一报错就提前 return，永远读不到。
 *
 * 所以把"读什么""空值怎么办"单独拎出来，用测试钉死，
 * 而不是靠每次改完让人点一遍界面去发现。
 */
import { readFileSync } from 'node:fs'
import { preferNonEmpty } from '../shared/agent-voice-rule.ts'

export { preferNonEmpty }

export interface AgentVoiceSettings {
  agentVoiceDesign?: string
  agentVoiceStyle?: string
  agentVoiceId?: string
  agentVoiceSample?: string
  agentVoiceSampleFile?: string
  agentVoiceSampleMime?: string
}

export interface AgentVoicePayload {
  design: string
  style: string
  voiceId: string
  sampleLength: number
  mime: string
  sample: string
}

/**
 * 组装设置页要回显的内容。
 *
 * 样本优先从文件读：落盘之后配置里只剩路径，不回读文件等于界面永远显示"没有样本"。
 * 文件读不到不算错误 —— 回空即可，界面会显示"没读到"，而不是整块报错。
 */
export function agentVoicePayload(settings: AgentVoiceSettings): AgentVoicePayload {
  const inline = typeof settings.agentVoiceSample === 'string' ? settings.agentVoiceSample : ''
  let sample = inline
  if (sample === '' && typeof settings.agentVoiceSampleFile === 'string' && settings.agentVoiceSampleFile !== '') {
    try { sample = readFileSync(settings.agentVoiceSampleFile).toString('base64') } catch { sample = '' }
  }
  return {
    design: typeof settings.agentVoiceDesign === 'string' ? settings.agentVoiceDesign : '',
    style: typeof settings.agentVoiceStyle === 'string' ? settings.agentVoiceStyle : '',
    voiceId: typeof settings.agentVoiceId === 'string' ? settings.agentVoiceId : '',
    sampleLength: sample.length,
    mime: typeof settings.agentVoiceSampleMime === 'string' ? settings.agentVoiceSampleMime : '',
    sample,
  }
}

