import { contextBridge, ipcRenderer } from 'electron'
import type {
  BridgeEventPayload,
  CharacterMenuTarget,
  CompanionState,
  DocReplyResult,
  DocRoots,
  DocState,
  PetSettingsPatch,
  PetState,
  SkinOverrides,
  SpeechStatus,
  TeamSnapshot,
} from '../renderer/types.js'

/** 订阅主进程事件：先清空旧监听再注册，避免 React effect 重复注册导致回调堆积。 */
function subscribe(channel: string, callback: (...args: unknown[]) => void): void {
  ipcRenderer.removeAllListeners(channel)
  ipcRenderer.on(channel, (_event, ...args) => callback(...args))
}

contextBridge.exposeInMainWorld('petApi', {
  getState: () => ipcRenderer.invoke('get-state') as Promise<PetState>,
  saveSettings: (patch: PetSettingsPatch) => ipcRenderer.invoke('save-settings', patch) as Promise<{ ok: boolean }>,
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
  /** 语音唤醒词命中（说"小潘"）。 */
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
  exitDone: () => ipcRenderer.send('exit-done'),
})
