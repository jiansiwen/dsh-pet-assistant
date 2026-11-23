export const CHIEF_ROLE_ID = 'member-tangseng'
export const ROLE_PRESET_NAME_LIMIT = 48
export const ROLE_PERSONALITY_LIMIT = 8000

/** 仅供界面预览的投影；不含语音样本路径、密钥或助理的权限和会话。 */
export interface RolePresetView {
  id: string
  name: string
  skinLabel: string
  actions: string[]
  personality: string
  voiceLabel: string
}

export type RolePresetResult = { ok: true; presets: RolePresetView[] } | { ok: false; error: string }

export interface RolePresetApi {
  rolePresets(): Promise<RolePresetResult>
  saveRolePreset(assistantId: string, name: string): Promise<RolePresetResult>
  applyRolePreset(assistantId: string, presetId: string): Promise<RolePresetResult>
}
