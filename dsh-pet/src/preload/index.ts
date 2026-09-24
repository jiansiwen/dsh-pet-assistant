import { contextBridge, ipcRenderer } from 'electron'
import type { SessionCommand, SessionResult, SessionUpdate } from '../session-types.js'
import type { SettingsPage } from '../renderer/types.js'
import type { Box } from '../renderer/stage-layout.js'
import type { VoiceApiInput, VoiceApiKind, VoiceApiResult } from '../voice-api-types.js'
import type {
  BridgeEventPayload,
  CharacterMenuTarget,
  CompanionState,
  DocReplyResult,
  DocRoots,
  DocState,
  MeetingConsentInput,
  MeetingEditResult,
  MeetingMinutesResult,
  MeetingRuntimeState,
  MeetingSpeakersResult,
  MeetingStartResult,
  MeetingStartedPayload,
  PetSettingsPatch,
  PetState,
  SimpleOkResult,
  SkinOverrides,
  SpeechStatus,
  TeamSnapshot,
} from '../renderer/types.js'

/** 订阅主进程事件：先清空旧监听再注册，避免 React effect 重复注册导致回调堆积。 */
function subscribe(channel: string, callback: (...args: unknown[]) => void): void {
  ipcRenderer.removeAllListeners(channel)
  ipcRenderer.on(channel, (_event, ...args) => callback(...args))
}

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('petApi', {
  getState: () => ipcRenderer.invoke('get-state') as Promise<PetState>,
  getSession: (beforeSeq?: number, bindingId?: string) => ipcRenderer.invoke('session-get', beforeSeq, bindingId) as Promise<SessionResult>,
  sessionCommand: (command: SessionCommand) => ipcRenderer.invoke('session-command', command) as Promise<SessionResult>,
  onSessionUpdate: (callback: (update: SessionUpdate) => void) => listen('session-update', callback),
  onSessionConnection: (callback: (status: string) => void) => listen('bridge-status', callback),
  onSettingsOpen: (callback: (page: SettingsPage) => void) => listen('settings-open', callback),
  onOverlayDismiss: (callback: () => void) => listen('overlay-dismiss', callback),
  onOverlayError: (callback: (message: string) => void) => listen('overlay-error', callback),
  overlayState: (open: boolean, boxes: Box[], settingsOpen: boolean) => ipcRenderer.send('overlay-state', { open, boxes, settingsOpen }),
  saveSettings: (patch: PetSettingsPatch) => ipcRenderer.invoke('save-settings', patch) as Promise<{ ok: boolean }>,
  voiceApiState: () => ipcRenderer.invoke('voice-api-state') as Promise<VoiceApiResult>,
  voiceApiSave: (input: VoiceApiInput) => ipcRenderer.invoke('voice-api-save', input) as Promise<VoiceApiResult>,
  voiceApiRemove: (id: string) => ipcRenderer.invoke('voice-api-remove', id) as Promise<VoiceApiResult>,
  voiceApiSelect: (kind: VoiceApiKind, id: string | null) =>
    ipcRenderer.invoke('voice-api-select', kind, id) as Promise<VoiceApiResult>,
  mouseState: (interactive: boolean) => ipcRenderer.send('mouse-state', interactive),
  contextMenu: (target: CharacterMenuTarget) => ipcRenderer.send('context-menu', target),
  chat: (text: string, assistantId?: string, spoken?: boolean) =>
    ipcRenderer.invoke('chat-send', text, assistantId, spoken === true) as Promise<{
      ok: boolean
      reply?: string
      error?: string
    }>,
  /** 让角色闭嘴：掐掉当前这句并丢掉排队的那些。 */
  stopSpeech: () => ipcRenderer.send('speech-stop'),
  getTeam: () => ipcRenderer.invoke('team-get') as Promise<TeamSnapshot | null>,
  // 舞台只能请求打开专用审批窗口，不能直接签发批准：决定要从那个窗口回来，
  // 回执还要过主进程的 checkSender。这条通道留在这里就等于把核验全绕过去了。
  openApproval: (proposalId: string) =>
    ipcRenderer.invoke('approval-open', proposalId) as Promise<{ ok: boolean; error?: string }>,
  /** 听写第一拍：申请麦克风并开流式会话。streaming=true 时走逐帧喂数。 */
  asrBegin: () => ipcRenderer.invoke('asr-begin') as Promise<{ ok: boolean; streaming?: boolean; error?: string }>,
  /** 流式喂数：一帧 16kHz Int16 PCM（base64），返回当前累积的识别文本。 */
  asrStreamFeed: (chunkBase64: string) =>
    ipcRenderer.invoke('asr-stream-feed', chunkBase64) as Promise<{ text: string }>,
  /** 流式收尾：取最终全文并归还麦克风给唤醒监听。 */
  asrStreamStop: () =>
    ipcRenderer.invoke('asr-stream-stop') as Promise<{ ok: boolean; text: string }>,
  /**
   * 听写第二拍：收渲染层已转好的 base64 wav 去转写；无论成败都顺带归还麦克风。
   * 参数必须是字符串——ArrayBuffer 跨 contextBridge 的参数拷贝本身就会抛
   * Illegal invocation，转换必须发生在渲染层调用侧（dictation.ts 的 arrayBufferToBase64）。
   */
  asrTranscribe: (wavBase64: string) =>
    ipcRenderer.invoke('asr-transcribe', wavBase64) as Promise<{ ok: boolean; text?: string; error?: string }>,
  /** 听写回退：渲染层录不了时由主进程录音并转写（仲裁也在这条里完成）。 */
  asrRecordFallback: () =>
    ipcRenderer.invoke('asr-record-fallback') as Promise<{ ok: boolean; text?: string; error?: string }>,
  openReportDir: () => ipcRenderer.invoke('open-report-dir') as Promise<{ ok: boolean }>,
  startRuntime: (profile?: string) => ipcRenderer.invoke('runtime-start', profile) as Promise<{ ok: boolean }>,
  stopRuntime: () => ipcRenderer.invoke('runtime-stop') as Promise<{ ok: boolean }>,
  setStageVisible: (visible: boolean) => ipcRenderer.send('stage-set-visible', visible),
  setFocusMode: (on: boolean) => ipcRenderer.send('stage-set-focus', on),
  onCharactersChanged: (callback: (characters: SkinOverrides) => void) => {
    subscribe('characters-changed', characters => callback((characters ?? {}) as SkinOverrides))
  },
  onExitRequested: (callback: () => void) => {
    subscribe('pet-exit-requested', () => callback())
  },
  /** 全局快捷键唤起输入模式。 */
  onSummon: (callback: () => void) => {
    subscribe('pet-summon', () => callback())
  },
  /** 语音唤醒词命中（说"小潘小潘"）。 */
  onWake: (callback: () => void) => {
    subscribe('wake-triggered', () => callback())
  },
  /** 桥接事件：成员、任务、提案的变化都从这里来，界面只是投影。 */
  onTeamEvent: (callback: (event: BridgeEventPayload) => void) => {
    subscribe('team-event', event => callback(event as BridgeEventPayload))
  },
  onCompanionState: (callback: (state: CompanionState) => void) => {
    subscribe('companion-state', state => callback(state as CompanionState))
  },
  onStageVisible: (callback: (visible: boolean) => void) => {
    subscribe('stage-visible', visible => callback(visible === true))
  },
  /** 主动提醒气泡（design.md §2.7）：文案由插件侧固定常量给出，这里只送到界面。 */
  onProactive: (callback: (payload: { message: string; suggestDisable: boolean }) => void) => {
    subscribe('proactive-remind', payload =>
      callback(payload as { message: string; suggestDisable: boolean }))
  },
  /** 回执主动提醒的用户选择：好 / 不用 / 关闭提醒 / 重新打开。 */
  respondProactive: (kind: 'accept' | 'decline' | 'disable' | 'enable') =>
    ipcRenderer.send('proactive-respond', kind),
  /** 讲解播放状态：是否在出声，以及合成不可用时的原因。 */
  onSpeechState: (callback: (status: SpeechStatus) => void) => {
    subscribe('speech-state', status => callback(status as SpeechStatus))
  },
  /** 会话流水（正文/思考/工具/输入）：按发生顺序显示，归属与出错以 chat 的返回值为准。 */
  onChatDelta: (callback: (delta: BridgeEventPayload) => void) => {
    subscribe('chat-delta', payload => callback(payload as BridgeEventPayload))
  },
  /** 语音识别的流式增量：mimo 等服务边识别边出字，最终文本以 asrTranscribe 返回值为准。 */
  onAsrDelta: (callback: (delta: { text: string }) => void) => {
    subscribe('asr-delta', payload => callback(payload as { text: string }))
  },
  openDoc: (path: string) => ipcRenderer.invoke('doc-open', path) as Promise<DocReplyResult>,
  explainDoc: (path: string, from?: number, speak?: boolean, assistantId?: string) =>
    ipcRenderer.invoke('doc-explain', path, from ?? 0, speak !== false, assistantId) as Promise<DocReplyResult>,
  askDoc: (path: string, index: number, question: string, assistantId?: string) =>
    ipcRenderer.invoke('doc-ask', path, index, question, assistantId) as Promise<DocReplyResult>,
  docRoots: () => ipcRenderer.invoke('doc-roots') as Promise<DocRoots>,
  addDocRoot: () => ipcRenderer.invoke('doc-add-root') as Promise<DocRoots>,
  removeDocRoot: (path: string) => ipcRenderer.invoke('doc-remove-root', path) as Promise<DocRoots>,
  forgetDocDir: (path: string) => ipcRenderer.invoke('doc-forget-dir', path) as Promise<DocRoots>,
  onDocState: (callback: (state: DocState) => void) => {
    subscribe('doc-state', state => callback(state as DocState))
  },
  onDocReply: (callback: (reply: { index: number; text: string }) => void) => {
    subscribe('doc-reply', reply => callback(reply as { index: number; text: string }))
  },
  onDocNotice: (callback: (message: string) => void) => {
    subscribe('doc-notice', message => callback(typeof message === 'string' ? message : ''))
  },
  // ===== 会议闭环（P6）=====
  // 音频采集在渲染层（getUserMedia），主进程只做加密落盘、仲裁与转写。
  // 停止是两段式：meeting-stop 让渲染层停流并冲刷最后一块，渲染层推完再调
  // meeting-flush-done 触发结算——顺序反了会丢会议最后几秒。
  meetingStart: (consent: MeetingConsentInput) =>
    ipcRenderer.invoke('meeting-start', consent) as Promise<MeetingStartResult>,
  meetingStop: (meetingId?: string) =>
    ipcRenderer.invoke('meeting-stop', meetingId) as Promise<SimpleOkResult>,
  /** 渲染层推一块 base64 PCM（16kHz mono Int16），到主进程立即加密落盘。 */
  meetingChunk: (meetingId: string, chunkBase64: string) =>
    ipcRenderer.invoke('meeting-chunk', meetingId, chunkBase64) as Promise<SimpleOkResult>,
  /** 某条音轨拿不到（loopback 采集失败）时如实上报，主进程标缺失、不伪造静音。 */
  meetingTrackMissing: (meetingId: string, kind: 'mic' | 'loopback') =>
    ipcRenderer.invoke('meeting-track-missing', meetingId, kind) as Promise<SimpleOkResult>,
  /** 渲染层停流并推完最后一块后回报，触发结算与转写。 */
  meetingFlushDone: (meetingId: string) =>
    ipcRenderer.invoke('meeting-flush-done', meetingId) as Promise<SimpleOkResult>,
  meetingState: () => ipcRenderer.invoke('meeting-state') as Promise<MeetingRuntimeState>,
  meetingTranscribe: (meetingId: string) =>
    ipcRenderer.invoke('meeting-transcribe', meetingId) as Promise<SimpleOkResult>,
  meetingSpeakers: (meetingId: string) =>
    ipcRenderer.invoke('meeting-speakers', meetingId) as Promise<MeetingSpeakersResult>,
  meetingSpeakerRename: (meetingId: string, speaker: string, label: string) =>
    ipcRenderer.invoke('meeting-speaker-rename', meetingId, speaker, label) as Promise<MeetingEditResult>,
  meetingSpeakerMerge: (meetingId: string, fromSpeaker: string, intoSpeaker: string) =>
    ipcRenderer.invoke('meeting-speaker-merge', meetingId, fromSpeaker, intoSpeaker) as Promise<MeetingEditResult>,
  meetingSpeakerSplit: (meetingId: string, indexes: number[], label: string) =>
    ipcRenderer.invoke('meeting-speaker-split', meetingId, indexes, label) as Promise<MeetingEditResult>,
  meetingMinutes: (meetingId: string) =>
    ipcRenderer.invoke('meeting-minutes', meetingId) as Promise<MeetingMinutesResult>,
  meetingMinutesConfirm: (meetingId: string) =>
    ipcRenderer.invoke('meeting-minutes-confirm', meetingId) as Promise<MeetingEditResult>,
  /** 会议开始：渲染层据此开 getUserMedia 采音。 */
  onMeetingStarted: (callback: (payload: MeetingStartedPayload) => void) => {
    subscribe('meeting-started', payload => callback(payload as MeetingStartedPayload))
  },
  /** 主进程请求停流：渲染层停 getUserMedia、冲刷最后一块后调 meetingFlushDone。 */
  onMeetingStopping: (callback: (payload: { meetingId: string }) => void) => {
    subscribe('meeting-stopping', payload => callback(payload as { meetingId: string }))
  },
  /** 会议运行时状态投影（录音/停止/转写进度/最近会议）。 */
  onMeetingState: (callback: (state: MeetingRuntimeState) => void) => {
    subscribe('meeting-state-changed', state => callback(state as MeetingRuntimeState))
  },
  exitDone: () => ipcRenderer.send('exit-done'),
})
