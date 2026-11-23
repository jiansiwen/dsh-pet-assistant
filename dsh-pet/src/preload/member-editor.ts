/**
 * 成员编辑窗口的 preload：只暴露成员草稿与保存所需的固定方法。
 * 没有通用 invoke、没有宿主地址、没有凭据；保存仍由主进程复核来源并弹原生确认。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { MemberAction, MemberCommandInputs, MemberDraft, MemberEditorContext, MemberResult } from '../member-types.js'
import type { RolePresetResult } from '../role-preset-types.js'

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  context: () => ipcRenderer.invoke('member-editor-context') as Promise<MemberEditorContext | null>,
  close: () => ipcRenderer.invoke('member-editor-close') as Promise<{ ok: boolean }>,
  membersState: () => ipcRenderer.invoke('members-state') as Promise<MemberResult>,
  memberCommand: <A extends MemberAction>(action: A, input: MemberCommandInputs[A], presetId?: string) =>
    ipcRenderer.invoke('member-command', action, input, presetId) as Promise<MemberResult>,
  rolePresets: () => ipcRenderer.invoke('role-presets-list') as Promise<RolePresetResult>,
  memberAssist: (input: { request: string; current?: MemberDraft; model?: { provider: string; model: string } }) =>
    ipcRenderer.invoke('member-assist', input) as Promise<MemberResult>,
  /** 按成员性格生成音色描述（复用主进程的主助理模型调用）。 */
  voiceDesignAssist: (input: { name?: string; personality: string; model?: { provider: string; model: string } }) =>
    ipcRenderer.invoke('voice-design-assist', input) as Promise<{ ok: true; description: string } | { ok: false; error: string }>,
  /** 已配置模型列表（与总助理会话模型下拉同源）；旧主进程没有该通道时返回空。 */
  modelOptions: () =>
    ipcRenderer.invoke('member-model-options') as Promise<Array<{ provider: string; model: string; label: string }>>,
  /** 语音设置里配好的 TTS 配置列表（成员级音色服务选择用）。 */
  ttsProfiles: () =>
    ipcRenderer.invoke('member-tts-profiles') as Promise<Array<{ id: string; name: string; model: string; provider: string }>>,
  /** 按编辑窗当前未保存的音色配置合成一句试听（与总助理试听同链路）。 */
  previewVoice: (input: { voiceId?: string; design?: string; style?: string; sampleFile?: string; sampleMime?: string; profileId?: string }) =>
    ipcRenderer.invoke('member-voice-preview', input) as Promise<{ ok: true; audio: string; mime: string } | { ok: false; error: string }>,
  /** 壳侧按成员存的音色（语气/克隆样本），与插件目录里的编号/描述合并生效。 */
  getVoice: (assistantId: string) =>
    ipcRenderer.invoke('member-voice-get', assistantId) as Promise<{ voiceId?: string; design?: string; style?: string; sampleFile?: string; sampleMime?: string; profileId?: string } | null>,
  saveVoice: (assistantId: string, voice: { style?: string; sampleFile?: string; sampleMime?: string; profileId?: string }) =>
    ipcRenderer.invoke('member-voice-save', assistantId, voice) as Promise<{ ok: boolean }>,
  pickVoiceSample: () =>
    ipcRenderer.invoke('member-voice-pick-sample') as Promise<{ ok: true; file: string; mime: string } | { ok: false }>,
  onContext: (callback: (context: MemberEditorContext) => void) => listen('member-editor-context', callback),
  onChanged: (callback: () => void) => listen('members-changed', callback),
}

contextBridge.exposeInMainWorld('memberEditorApi', api)
export type MemberEditorApi = typeof api
