import type { AssistantSettingsSnapshot } from '../assistant-settings-types.ts'
import type { MemberDraft, MemberProfile } from '../member-types.ts'
import { CHIEF_ROLE_ID, type RolePresetView } from '../role-preset-types.ts'
import { memberSpeakerVoice, type SpeakerVoice } from '../shared/speaker-voice.ts'
import type { VoiceApiState } from '../voice-api-types.ts'
import { projectAssistantSettings } from './assistant-settings.ts'
import type { CustomSkinRecord } from './custom-skins.ts'
import { memberPathIdentifier, projectMemberState } from './member-management.ts'
import { ACTION_LABELS, buildPetConfigView, candidateActions, PET_SKIN_OPTIONS } from './pet-config.ts'
import { RolePresetError, RolePresetStore, type StoredRolePreset } from './role-preset-store.ts'
import type { PetSettings } from './settings.ts'

const SETTINGS = '/companion/v1/settings'
const MEMBERS = '/companion/v1/members'
type Target = { id: typeof CHIEF_ROLE_ID; state: AssistantSettingsSnapshot; member?: undefined }
  | { id: string; member: MemberProfile; state?: undefined }

interface Options {
  userData: string
  request(method: 'GET' | 'POST', path: string, input?: unknown): Promise<{ status: number; body: unknown }>
  settings(): PetSettings
  saveSettings(patch: Partial<PetSettings>): PetSettings
  customSkins(): readonly CustomSkinRecord[]
  voiceProfiles(): VoiceApiState | undefined
  changed(assistantId: string): void
}

export function chiefRoleVoice(s: PetSettings): SpeakerVoice {
  return { voiceId: s.agentVoiceId, design: s.agentVoiceDesign, style: s.agentVoiceStyle,
    sample: s.agentVoiceSample, sampleFile: s.agentVoiceSampleFile, sampleMime: s.agentVoiceSampleMime, profileId: s.agentVoiceProfileId }
}

type MemberFields = Pick<MemberDraft, 'skinId' | 'personality' | 'voiceProfile' | 'voiceDesign'>
type PreparedRole = { preset: StoredRolePreset; voice: SpeakerVoice; fields: MemberFields }
export interface PreparedMemberRole {
  fields: MemberFields
  validate(): void
  apply(assistantId: string): void
}

export class RolePresets {
  private readonly options: Options
  private readonly store: RolePresetStore
  private applying = false

  constructor(options: Options) {
    this.options = options
    this.store = new RolePresetStore(options.userData)
  }

  private skinLabel(skin: string): string | undefined {
    return PET_SKIN_OPTIONS.find(item => item.id === skin)?.label ?? this.options.customSkins().find(item => item.id === skin)?.name
  }

  list(): RolePresetView[] {
    return this.store.list().map(preset => ({ id: preset.id, name: preset.name,
      skinLabel: this.skinLabel(preset.skin) ?? `${preset.skin}（素材已缺失）`, personality: preset.personality,
      actions: preset.randomActions.map(action => ACTION_LABELS[action] ?? action),
      voiceLabel: preset.hasSample ? '克隆音色' : preset.voice.design ? '设计音色' : preset.voice.voiceId || (preset.voice.style ? '自定义语气' : '默认音色'),
    }))
  }

  private async target(id: string): Promise<Target> {
    const root = id === CHIEF_ROLE_ID ? SETTINGS : MEMBERS
    const response = await this.options.request('GET', root)
    if (response.status !== 200) throw new RolePresetError('暂时读不到助理配置，请连接 DSH 后再试。')
    if (id === CHIEF_ROLE_ID) return { id, state: projectAssistantSettings(response.body) }
    const member = projectMemberState(response.body).members.find(item => item.profile.assistantId === id)?.profile
    if (!member) throw new RolePresetError('这位助理已不存在，未执行角色操作。')
    return { id, member }
  }

  async save(id: string, name: string): Promise<void> {
    const target = await this.target(id)
    const settings = this.options.settings()
    const { member } = target
    const appearance = buildPetConfigView({ stageVisible: true, settings,
      members: member ? [member] : [], customSkins: this.options.customSkins(),
    }).characters.find(item => item.assistantId === id)
    if (!appearance) throw new RolePresetError('暂时读不到角色形象，角色方案未保存。')
    const chief = chiefRoleVoice(settings)
    const voice = member ? memberSpeakerVoice(settings.memberVoices?.[id], { voiceId: member.voiceProfile, design: member.voiceDesign }, chief) : chief
    const voiceState = this.options.voiceProfiles()
    const profileId = voice.profileId || voiceState?.selected.tts
    const profile = voiceState?.profiles.find(item => item.id === profileId && item.kind === 'tts')
    if (voice.profileId && !profile) throw new RolePresetError('当前音色使用的语音配置已缺失，请重新选择后保存方案。')
    const hasSource = voice.sampleFile || voice.sample || voice.design || voice.voiceId
    this.store.save(name, { skin: appearance.skin, randomActions: appearance.randomActions,
      personality: member ? member.personality : target.state.agent.persona,
      voice: { ...voice, profileId: profile?.id, ...(!hasSource && profile ? { voiceId: profile.voice, design: profile.voiceDesign } : {}) },
    })
  }

  private prepare(preset: StoredRolePreset): PreparedRole {
    if (!this.skinLabel(preset.skin)) throw new RolePresetError('这套方案的形象已被移除，原配置未改。')
    const actions = candidateActions(preset.skin, this.options.customSkins())
    if (preset.randomActions.some(action => !actions.includes(action))) throw new RolePresetError('这套方案里有已移除的动作，原配置未改。')
    const voice = this.store.voice(preset)
    if (voice.profileId && !this.options.voiceProfiles()?.profiles.some(item => item.id === voice.profileId && item.kind === 'tts')) {
      throw new RolePresetError('这套方案使用的语音配置已被移除，原配置未改。')
    }
    return { preset, voice, fields: { skinId: preset.skin, personality: preset.personality, voiceProfile: voice.voiceId ?? '', voiceDesign: voice.design ?? '' } }
  }

  private select(id: string): PreparedRole {
    const preset = this.store.list().find(item => item.id === id)
    if (!preset) throw new RolePresetError('没有找到这套角色方案，请关闭后重新打开列表。')
    return this.prepare(preset)
  }

  private applyLocal(id: string, { preset, voice }: PreparedRole): void {
    const current = this.options.settings()
    const characters = { ...current.characters, [id]: { skin: preset.skin, randomActions: [...preset.randomActions] } }
    const { voiceId = '', design = '', style = '', profileId = '', sampleFile = '', sampleMime = '' } = voice
    this.options.saveSettings(id === CHIEF_ROLE_ID ? {
      characters, agentVoiceId: voiceId, agentVoiceDesign: design, agentVoiceStyle: style,
      agentVoiceProfileId: profileId, agentVoiceSample: '', agentVoiceSampleFile: sampleFile, agentVoiceSampleMime: sampleMime,
    } : {
      characters, memberVoices: { ...current.memberVoices, [id]: { voiceId, design, style, profileId, sampleFile, sampleMime } },
    })
    try { this.options.changed(id) } catch { /* 落盘成功后，通知失败不会改动结果。 */ }
  }

  prepareMemberCreation(id: string): PreparedMemberRole {
    const { preset, fields } = this.select(id)
    return { fields, validate: () => { this.prepare(preset) }, apply: assistantId => this.applyLocal(assistantId, this.prepare(preset)) }
  }

  private async writeHost(target: Target, role: MemberFields, expectedRevision: number): Promise<number> {
    const path = target.member ? `${MEMBERS}/${memberPathIdentifier(target.id)}/role-style` : `${SETTINGS}/agent`
    const fields = target.member ? role : { ...target.state.agent, persona: role.personality }
    const response = await this.options.request('POST', path, { ...fields, expectedRevision })
    if (response.status === 409) throw new RolePresetError('助理配置刚有变化，请重新选择并应用，桌宠尚未切换。')
    if (response.status === 404) throw new RolePresetError('当前 DSH 插件不支持角色切换，请更新插件后再试。')
    const saved = (response.body as { revision?: unknown } | null)?.revision
    if (response.status !== 200 || saved !== expectedRevision + 1) {
      throw new RolePresetError('DSH 未确认角色切换，桌宠尚未切换；请核对配置后再试。')
    }
    return saved
  }

  async apply(assistantId: string, presetId: string): Promise<void> {
    if (this.applying) throw new RolePresetError('正在应用另一套方案，请稍候。')
    this.applying = true
    try {
      const { fields, preset } = this.select(presetId)
      const target = await this.target(assistantId)
      const original = target.member ? { personality: target.member.personality, skinId: target.member.skinId,
        voiceDesign: target.member.voiceDesign, voiceProfile: target.member.voiceProfile } : { ...fields, personality: target.state.agent.persona }
      const saved = await this.writeHost(target, fields, target.member?.revision ?? target.state!.revision)
      try { this.applyLocal(assistantId, this.prepare(preset)) }
      catch {
        try { await this.writeHost(target, original, saved) }
        catch { throw new RolePresetError('桌宠写入失败，DSH 也未确认恢复，请重新打开设置核对，不会自动重试。') }
        throw new RolePresetError('桌宠写入失败，已恢复原角色配置，请检查后再试。')
      }
    } finally { this.applying = false }
  }
}
