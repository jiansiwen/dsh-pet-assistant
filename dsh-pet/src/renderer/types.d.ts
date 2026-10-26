/**
 * 壳的生命周期状态。真源在主进程 `companion-host.ts`，这里只做类型转发 ——
 * 重抄一份形状的话，主进程加一个字段而界面不知道，界面就会拿着旧形状渲染。
 * 纯类型导入，运行时被擦除，不会把 electron 拖进渲染层的包。
 */
import type { CompanionState } from '../main/companion-host.js'
import type {
  MeetingConsentInput,
  MinutesRecord,
  TranscriptSegment,
} from '../main/meeting-store.js'
import type {
  LiveCaption,
  MeetingChunkMeta,
  MeetingMinutesView,
  MeetingRuntimeState,
  MeetingTrack,
  MinutesGenerateResult,
  MinutesItem,
  MinutesItemPatch,
  MinutesView,
  StructuredMinutes,
} from '../main/meeting-recorder.js'
import type { SkinOverrides } from './character-manifest.js'
import type { VoiceApiInput, VoiceApiKind, VoiceApiResult } from '../voice-api-types.js'
import type {
  DownloadPlanItemView,
  FirstRunDownloadResult,
  FirstRunReportResult,
} from '../main/first-run-service.js'
import type { DownloadConfirmation } from '../main/model-resources.js'
import type { EvidenceIntakeOutcome } from '../evidence-types.js'
import type { FirstRunReport, FirstRunStep } from '../main/first-run.js'
import type { SessionCommand, SessionResult, SessionUpdate } from '../session-types.js'
import type { Box } from './stage-layout.js'

export type SettingsPage = 'general' | 'team' | 'doc' | 'meeting'

export type { CompanionState, MeetingConsentInput, MeetingRuntimeState, MinutesRecord, SkinOverrides, TranscriptSegment }

export interface PetPosition {
  x: number
  y: number
}

/**
 * 右键菜单要改形象的那一个角色。
 *
 * 主进程不知道台上站着谁、也不知道每个角色此刻用的是哪套皮肤（那是插件下发与编制默认
 * 算出来的），所以由渲染层把这三样报上去。主进程仍然自己校验，并且本机存过的值优先。
 */
export interface CharacterMenuTarget {
  assistantId: string
  displayName: string
  /** 此刻生效的皮肤，用来定菜单里的选中态。 */
  skin: string
}

export interface OperationalState {
  connection: 'connected' | 'disconnected'
  listener: 'wake-requested' | 'dictation' | 'meeting' | 'idle' | 'unavailable'
  activity: { active: boolean; capturing: boolean; titles: boolean } | null
  meeting: string | null
  speaking: boolean
  execution: 'idle' | 'running' | 'waiting' | 'unknown'
}

export interface PetState {
  pet: string
  operations?: OperationalState
  voiceConversation?: boolean
  continuousVoice?: boolean
  readReplies?: boolean
  idleSleepMinutes?: number
  sleepMinutes?: number
  chatDock?: 'top' | 'auto'
  chatSize?: { width: number; height: number }
  /** 旧单宠物时代的位置，升级后由渲染层映射到对应角色。 */
  bounds?: PetPosition
  /** 各角色座位，键是 assistantId。 */
  positions?: Record<string, PetPosition>
  /** 用户在本机为每个角色挑的形象，键是 assistantId。 */
  characters?: SkinOverrides
  layoutVersion?: number
}

export interface PetSettingsPatch {
  voiceConversation?: boolean
  continuousVoice?: boolean
  readReplies?: boolean
  idleSleepMinutes?: number
  sleepMinutes?: number
  bounds?: PetPosition
  positions?: Record<string, PetPosition>
  chatDock?: 'top' | 'auto'
  chatSize?: { width: number; height: number }
}

/**
 * 任务状态。镜像插件侧 `team-domain.ts` 的 `TASK_STATUSES`。
 *
 * 渲染层不能直接 import 插件的类型 —— 那会把 electron 与宿主依赖链拖进 renderer 打包。
 * 代价是插件加状态时这里要跟着加，否则新状态会落到 default 分支被当成空闲。
 */
export type PetTaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'awaiting-user'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'unknown'

/**
 * 编制成员。桥接 `/team` 返回的 `MemberConfig` 的界面子集。
 *
 * 刻意不带 `persona`：那是喂给模型的人设文本，界面用不到，也没必要让它过一遍 IPC。
 * 所有字段都可选 —— 这是 HTTP JSON，TypeScript 保证不了运行时形状。
 */
export interface TeamMemberSnapshot {
  assistantId: string
  displayName?: string | null
  roleId?: string | null
  skinId?: string | null
  enabled?: boolean
  /** `toolPolicy.mode`：read-only / side-effect。名牌上用来提示"这个人能动你的文件"。 */
  toolScope?: string | null
}

export interface TeamTaskSnapshot {
  taskId: string
  ownerId?: string | null
  goal?: string | null
  status?: PetTaskStatus | string | null
  artifacts?: readonly string[]
  deadlineAt?: number | null
  createdAt?: number
  updatedAt?: number
}

/** 待批准的副作用计划。批准凭据与聊天令牌互不通用，模型自己调不到审批端点。 */
export interface TeamProposalSnapshot {
  kind?: 'report' | 'team' | 'assistant'
  reportId?: string
  revision?: number
  digest?: string
  content?: string
  epoch?: string
  proposalId: string
  taskId?: string | null
  assistantId?: string | null
  summary?: string | null
  tool?: string | null
  target?: string | null
  risk?: 'low' | 'medium' | 'high' | string | null
  state?: 'pending' | 'approved' | 'rejected' | 'expired' | string | null
  expiresAt?: number
}

export interface TeamSnapshot {
  epoch?: string
  /** 团队模式是否开启。关闭时 members 为空，桌面退回单角色。 */
  team?: boolean
  members?: TeamMemberSnapshot[]
  tasks?: TeamTaskSnapshot[]
  running?: number
  proposals?: TeamProposalSnapshot[]
}

/** 桥接长轮询推来的一条事件。桌面按 type 分流，其余字段按事件类型可选。 */
export interface BridgeEventPayload {
  seq?: number
  epoch?: string
  type: string
  id?: string
  ok?: boolean
  reply?: string
  /** delta：本次增量文本片段，只用于气泡显示。 */
  text?: string
  /**
   * delta 的形态：`text` 正文、`think` 思考过程、`tool` 工具调用、`user` 输入。
   * 缺省按 `text` 处理。宠物要和 DSH 会话完全绑定，四类都要按发生顺序显示。
   */
  kind?: 'text' | 'think' | 'tool' | 'user'
  /** kind='tool' 时的工具名（如 `Read` / `Grep`）。 */
  name?: string
  /** kind='tool' 时的参数摘要（如 `dsh-pet/README.md`）。 */
  arg?: string
  error?: string
  /** task：来自子代理运行结果；interval：来自轮次区间，非因果归属。 */
  attribution?: 'task' | 'interval' | string
  assistantId?: string
  displayName?: string
  skinId?: string
  taskId?: string
  status?: PetTaskStatus | string
  artifacts?: readonly string[]
  blockers?: readonly string[]
  needsApproval?: readonly string[]
  payload?: unknown
  /** proactive：气泡正文（插件侧固定常量，不是模型生成的）。 */
  message?: string
}

export type ApprovalDecision = 'approve' | 'reject'

export interface DecideApprovalResult {
  ok: boolean
  approvalId?: string
  decision?: 'rejected'
  confirmed?: boolean
  savedPath?: string
  revision?: number
  digest?: string
  modeExited?: boolean
  message?: string
  error?: string
}

/**
 * 讲解播放状态。
 *
 * `error` 非空表示这台机器上念不出来（没有可用的合成音色、合成进程起不来或半路没了）。
 * 这是个听不见的故障：界面上不报一句，用户只会觉得"它没反应"。
 */
export interface SpeechStatus {
  readonly speaking: boolean
  readonly error?: string
}

/** 名字撞车时给用户挑的一条候选。 */
export interface DocChoice {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly mtimeMs: number
}

/** 提纲里的一段。正文不进来：提纲是目录，把正文再铺一遍就不是提纲了。 */
export interface DocSectionBrief {
  readonly index: number
  readonly heading: string | null
  readonly hasCode: boolean
  /** 这一段已经讲过了。续讲时用户要能看出上次停在哪儿。 */
  readonly spoken: boolean
}

/**
 * 文档讲解的状态。
 *
 * `choose` 是"重名待挑"（design.md §2.10：多个重名结果让用户选，禁止搜到第一个就打开）；
 * `outline` 是某一份文档已经解析出提纲，`next` 是下一段要讲的下标。
 * 讲完了、讲不下去这类一句话提示不放在这里，走 `onDocNotice` —— 它们紧接着就会有一次
 * `idle` 投影，混在一条通道上会被立刻覆盖，用户根本看不见。
 */
export type DocState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'choose'; readonly name: string; readonly hits: readonly DocChoice[] }
  | {
      readonly kind: 'outline'
      readonly path: string
      readonly title: string
      readonly estMinutes: number
      readonly total: number
      readonly next: number
      readonly sections: readonly DocSectionBrief[]
    }

/** 授权目录与最近用系统关联打开过的目录。两块都在查找范围内，两块都能撤。 */
export interface DocRoots {
  readonly roots: readonly string[]
  readonly recent: readonly string[]
}

/**
 * 文档操作的回执。
 *
 * `reply` 是一句能直接显示给用户的话（提纲、"已经打开了"），`error` 是该拒绝或该报故障时
 * 的那句话。两者不会同时有。
 */
export interface DocReplyResult {
  readonly ok: boolean
  readonly reply?: string
  readonly error?: string
}

// ===== 会议闭环（P6）=====

/** 分轨协议（M4-02）：音轨、每块的时间轴信息、临时字幕。真源在 meeting-recorder.ts。 */
export type { LiveCaption, MeetingChunkMeta, MeetingTrack }
export type { MeetingMinutesView, MinutesGenerateResult, MinutesItem, MinutesItemPatch, MinutesView, StructuredMinutes }

/** 通用回执。error 非空时是给用户看的那句拒绝/故障原因。 */
export interface SimpleOkResult {
  readonly ok: boolean
  readonly error?: string
  readonly seq?: number
}

export interface MeetingStartResult {
  readonly ok: boolean
  readonly meetingId?: string
  readonly error?: string
}

/** 主进程通知渲染层"开始采音"的载荷。 */
export interface MeetingStartedPayload {
  readonly meetingId: string
  readonly sources: 'mic' | 'mic+loopback'
  readonly name: string
  /** 渲染层必须按这个采样率重采样后推块（主进程拼 wav 头时写死它）。 */
  readonly sampleRate: number
  /** 会议开始的墙钟毫秒：两路时间轴共同的零点，每块起点按它换算成"相对会议开始的毫秒"。 */
  readonly startedAt: number
}

export interface MeetingSpeakerBrief {
  readonly speaker: string
  readonly label: string
  readonly count: number
}

export interface MeetingSpeakersResult {
  readonly ok: boolean
  readonly error?: string
  readonly revision?: number
  readonly segments?: TranscriptSegment[]
  readonly speakers?: MeetingSpeakerBrief[]
  /** 最近一次机器转写的分人模式与说明；userEdited = 之后有过人工修订。旧会议为 null。 */
  readonly transcript?: { readonly mode: 'diarized' | 'partial' | 'undiarized'; readonly note: string | null; readonly userEdited: boolean } | null
}

/** 常驻与语音开关（M1-02 / M1-05）的实际状态。真源在主进程：audio-prefs.ts + 仲裁器 + 壳层。 */
export interface ResidencyState {
  readonly platform: 'win32' | 'darwin' | 'linux'
  /** 托盘常驻（隐藏角色后仍保留壳与唤醒监听）。 */
  readonly trayResident: boolean
  readonly wake: {
    readonly enabled: boolean
    readonly engine: 'system' | 'kws' | null
    readonly engines: ReadonlyArray<'system' | 'kws'>
    /** 仲裁器当前是否把麦克风交给了唤醒。 */
    readonly listening: boolean
    /** 不可用的原因（模型没装、没麦克风、权限被拒…）；可用为 null。 */
    readonly problem: string | null
    /** KWS 是否在真实环境验证过（目前都没有，界面标"实验性"）。 */
    readonly kwsVerified: boolean
  }
  readonly launchAtLogin: { readonly enabled: boolean; readonly supported: boolean }
  readonly bargeIn: { readonly enabled: boolean; readonly problem: string | null; readonly lastMetrics: ReadonlyArray<{ onsetToDetectMs: number; detectToSilenceMs: number | null }> }
  /** 麦克风当前持有者。 */
  readonly holder: 'wake' | 'dictation' | 'meeting' | 'barge-in' | null
}

export interface ResidencyPatch {
  readonly trayResident?: boolean
  readonly wakeEnabled?: boolean
  readonly wakeEngine?: 'system' | 'kws'
  readonly launchAtLogin?: boolean
  readonly bargeIn?: boolean
  /** 唤醒失败后用户手动重试。 */
  readonly retryWake?: boolean
}

export interface ResidencyResult {
  readonly ok: boolean
  readonly error?: string
  readonly state?: ResidencyState
}

/** 说话人修订与纪要确认的回执。revision 是修订后的段版本号。 */
export interface MeetingEditResult {
  readonly ok: boolean
  readonly error?: string
  readonly revision?: number
  readonly confirmedAt?: number
}

export interface MeetingMinutesResult {
  readonly ok: boolean
  readonly error?: string
  /** 纪要（本地模板版或模型草稿；模型版带结构化条目与来源）。 */
  readonly minutes?: MinutesView | null
  readonly egress?: MeetingMinutesView['egress']
  readonly model?: MeetingMinutesView['model']
  readonly revision?: number
}

/** 导出定稿的回执：只有已确认且仍是当前版本的纪要才给 content。 */
export interface MeetingMinutesExportResult {
  readonly ok: boolean
  readonly error?: string
  readonly content?: string
  readonly digest?: string
  readonly confirmedAt?: number
  readonly kind?: 'local' | 'model'
}

/** 改一条纪要的回执。digest 是改后的新版本（旧确认已失效）。 */
export interface MeetingMinutesEditResult {
  readonly ok: boolean
  readonly error?: string
  readonly digest?: string
}

export interface PetApi {
  getState(includeOperations?: boolean): Promise<PetState>
  getSession(beforeSeq?: number, bindingId?: string): Promise<SessionResult>
  sessionCommand(command: SessionCommand): Promise<SessionResult>
  /** 开启或恢复助理会话；已在线时原样返回，不抢网页会话。 */
  startSession(): Promise<SessionResult & { outcome?: string }>
  onSessionUpdate(callback: (update: SessionUpdate) => void): () => void
  onSessionConnection(callback: (status: string) => void): () => void
  onSettingsOpen(callback: (page: SettingsPage) => void): () => void
  onOverlayDismiss(callback: () => void): () => void
  onOverlayError(callback: (message: string) => void): () => void
  overlayState(open: boolean, boxes: Box[], settingsOpen: boolean): void
  saveSettings(patch: PetSettingsPatch): Promise<{ ok: boolean }>
  voiceApiState(): Promise<VoiceApiResult>
  voiceApiSave(input: VoiceApiInput): Promise<VoiceApiResult>
  voiceApiRemove(id: string): Promise<VoiceApiResult>
  voiceApiSelect(kind: VoiceApiKind, id: string | null): Promise<VoiceApiResult>
  /** 首次使用检查：环境清单 + 模型下载计划（只读，不发请求）。 */
  firstRunReport(): Promise<FirstRunReportResult>
  /** 按用户确认的那一项下载模型。确认三要素由计划视图原样带回，不能自己拼。 */
  firstRunDownload(confirmation: DownloadConfirmation): Promise<FirstRunDownloadResult>
  /** 打开系统麦克风权限设置页（URI 由主进程拼，渲染层只能指定这个目标）。 */
  firstRunOpenSettings(target: 'microphone'): Promise<{ ok: boolean; error?: string }>
  mouseState(interactive: boolean): void
  /** 在某个角色上弹原生菜单（换形象、隐藏、退出）。 */
  contextMenu(target: CharacterMenuTarget): void
  /**
   * 点名某个成员时传 assistantId；不传则由总助理接待。
   *
   * `spoken` 表示这一轮要不要把回答念出来。只有语音发起的那一轮该置真 ——
   * 打字问的话突然出声，是用户没要求过的行为。
   */
  chat(text: string, assistantId?: string, spoken?: boolean): Promise<{ ok: boolean; reply?: string; error?: string }>
  /** 让角色闭嘴：掐掉当前这句并丢掉排队的那些。 */
  stopSpeech(): void
  /** 只在本机念一句（不进会话、不调模型）。 */
  speakLocal(text: string): void
  /** 拉一次团队快照。未连接或未开启团队模式时返回 null。 */
  getTeam(): Promise<TeamSnapshot | null>
  /**
   * 请求主进程打开专用审批窗口。
   *
   * 注意这不是"批准"：舞台渲染器上没有签发批准的能力，它只能报出想批哪条提案。
   * 提案内容由主进程自己去桥接取，决定从专用窗口回来（见 `main/approval-window.ts`）。
   * 返回 ok=false 时 error 是要显示给用户的那句话，通常是"这条提案已经不在待批列表里"。
   */
  openApproval(proposalId: string): Promise<{ ok: boolean; error?: string }>
  /** 听写第一拍：申请麦克风并开流式会话。streaming=true 时走逐帧喂数。 */
  onVoiceTurnComplete(callback: (event: import('../session-types.js').VoiceTurnCompletion) => void): () => void
  onVoiceConversationStop(callback: () => void): () => void
  asrBegin(): Promise<{ ok: boolean; streaming?: boolean; error?: string }>
  // ===== 共享采集 / 唤醒 / 插话（M1-02、M1-03、M1-05）=====
  onAudioGrants(callback: (grants: import('./barge-in.ts').AudioGrantsPayload) => void): () => void
  audioSync(): Promise<import('./barge-in.ts').AudioGrantsPayload>
  kwsFeed(chunkBase64: string): void
  audioConsumerLost(kind: 'kws' | 'barge-in', reason: string): void
  onCaptureResume(callback: () => void): () => void
  onTtsPlay(callback: (payload: { id: string; b64: string }) => void): () => void
  onTtsStop(callback: (payload: { id: string }) => void): () => void
  ttsPlaybackReceipt(receipt: import('./playback.ts').PlaybackReceiptPayload): void
  bargeInDetected(payload: { onsetAtMs: number; detectedAtMs: number; playing: boolean }): void
  bargeInMetrics(metrics: import('./barge-in.ts').BargeInMetrics): void
  residencyState(): Promise<ResidencyState>
  residencySet(patch: ResidencyPatch): Promise<ResidencyResult>
  /** 流式喂数：一帧 16kHz Int16 PCM（base64），返回当前累积的识别文本（实时回显）。 */
  asrStreamFeed(chunkBase64: string): Promise<{ text: string }>
  /** 流式收尾：取最终全文并归还麦克风给唤醒监听。 */
  asrStreamStop(): Promise<{ ok: boolean; text: string }>
  /** 听写第二拍：交 base64 编码的 wav 转写，顺带把麦克风还给唤醒监听。 */
  asrTranscribe(wavBase64: string): Promise<{ ok: boolean; text?: string; error?: string }>
  /** 听写回退：渲染层录音不可用时由主进程录音并转写。 */
  asrRecordFallback(): Promise<{ ok: boolean; text?: string; error?: string }>
  openReportDir(): Promise<{ ok: boolean }>
  /** 打开日报工作台（独立窗口；发布与删除仍只在专用审批窗口里决定）。 */
  openReportWorkbench(): Promise<{ ok: boolean }>
  /** 启动团队运行时。不传 profile 就用设置里存的那个。 */
  startRuntime(profile?: string): Promise<{ ok: boolean }>
  /** 停止由本壳启动的运行时。用户自己起的运行时不受影响。 */
  stopRuntime(): Promise<{ ok: boolean }>
  /** 显示/隐藏角色。隐藏后壳仍在：唤醒监听与启动入口都保留。 */
  setStageVisible(visible: boolean): void
  /** 切专注模式：角色还在桌面上，但不随机发言、不开群体娱乐。与隐藏是两件事。 */
  setFocusMode(on: boolean): void
  /** 演示隐私模式：隐藏历史与预览、压制提醒；讲解与插话照常。只影响显示，不删数据。 */
  setPresentationMode(on: boolean): void
  /** 某个角色的形象被改了（右键菜单）：主进程广播整张表，界面据此立刻换图。 */
  onCharactersChanged(callback: (characters: SkinOverrides) => void): void
  /** 主进程请求退场（会话销毁或用户右键退出）：渲染层播完退场动画后调用 exitDone。 */
  onExitRequested(callback: () => void): void
  /** 全局快捷键唤起输入模式。 */
  onSummon(callback: () => void): void
  /** 语音唤醒词命中（说"小潘同学"）：宠物回应并弹出输入框。参数是这次说了哪句应答（已由主进程朗读）。 */
  onWake(callback: (greeting?: string) => void): void
  /** 桥接事件：成员/任务/提案变化都从这里来，界面只是投影。 */
  onTeamEvent(callback: (event: BridgeEventPayload) => void): void
  /** 壳的生命周期状态：启动握手的阶段、失败原因、角色可见性、专注模式。 */
  onCompanionState(callback: (state: CompanionState) => void): void
  /** 角色该不该显示。false 时界面把整个舞台卸掉，场景时钟随之停下。 */
  onStageVisible(callback: (visible: boolean) => void): void
  /**
   * 主动提醒气泡（design.md §2.7）。文案是插件侧的固定常量，不是模型生成的；
   * suggestDisable=true 表示连续拒绝已达阈值，这一条其实在问"要不要干脆关掉"。
   */
  onProactive(callback: (payload: { message: string; suggestDisable: boolean }) => void): void
  /** 回执主动提醒的用户选择：好 / 不用 / 关闭提醒 / 重新打开。 */
  respondProactive(kind: 'accept' | 'decline' | 'disable' | 'enable'): void
  /** 讲解播放状态：是否在出声（界面据此显示停止按钮），以及念不出来时的原因。 */
  onSpeechState(callback: (status: SpeechStatus) => void): void
  /**
   * 会话流水：正文 / 思考过程 / 工具调用 / 用户输入，**按发生顺序**推来。
   *
   * 与 `chat` 的返回值分工：流水负责「发生了什么」（含网页侧发起的轮次），
   * 返回值负责「这条回复归属谁、有没有出错」。宿主不吐增量时一次都不会触发，
   * 界面必须能接受整段回复一次到达。
   */
  onChatDelta(callback: (delta: BridgeEventPayload) => void): void
  /**
   * 语音识别的流式增量。
   *
   * mimo 等服务在识别过程中逐字返回文本；本地识别（sherpa-onnx）走 asrStreamFeed 不经过这里。
   * 最终文本以 `asrTranscribe` 的返回值为准（到达时整体替换），增量只用于实时显示。
   */
  onAsrDelta(callback: (delta: { text: string }) => void): void
  /** 用系统关联的应用打开一份文档。返回的 reply 是一句能直接显示的话。 */
  openDoc(path: string): Promise<DocReplyResult>
  /**
   * 从某一段开始逐段讲解。
   *
   * `speak` 默认真：点提纲里的某一段就是要听它讲。传 false 只把提纲装到面板上不出声，
   * 那是聊天里打字要来的讲解走的路。
   */
  explainDoc(path: string, from?: number, speak?: boolean, assistantId?: string): Promise<DocReplyResult>
  /** 就某一段追问。段号来自界面上点的那一条，不从消息里猜。 */
  askDoc(path: string, index: number, question: string, assistantId?: string): Promise<DocReplyResult>
  docRoots(): Promise<DocRoots>
  /** 弹原生目录选择框加一个授权目录。目录只能由用户亲手挑，不能由参数指定。 */
  addDocRoot(): Promise<DocRoots>
  removeDocRoot(path: string): Promise<DocRoots>
  /** 忘掉一个自动记下的最近目录。它也在查找范围内，所以同样要能交回去。 */
  forgetDocDir(path: string): Promise<DocRoots>
  /** 讲解进度：待挑的重名候选、当前文档的提纲与讲到第几段。 */
  onDocState(callback: (state: DocState) => void): void
  /** 某一段的讲解正文。逐段推过来，界面按段号铺开。 */
  onDocReply(callback: (reply: { index: number; text: string }) => void): void
  /** 一句话提示（讲完了、某段讲不下去）。它不属于状态，显示完就过去。 */
  onDocNotice(callback: (message: string) => void): void
  /**
   * 开一场会议录制。consent 必填项缺一个都会被拒：名字、来源、知情同意文本、
   * 勾选状态、保留天数。拒绝原因在 error 里，是要显示给用户的那句话。
   */
  meetingStart(consent: MeetingConsentInput): Promise<MeetingStartResult>
  /** 请求停止当前会议：主进程先让渲染层停流冲刷，再结算转写。 */
  meetingStop(meetingId?: string): Promise<SimpleOkResult>
  /**
   * 推一块 base64 PCM（16kHz mono Int16）。主进程收到立即加密落盘。
   * meta 是分轨时间轴（音轨、轨内序号、起点、原始采样率、16k 帧数）；不带就按旧协议当麦克风块。
   */
  meetingChunk(meetingId: string, chunkBase64: string, meta?: MeetingChunkMeta): Promise<SimpleOkResult>
  /** 某条音轨拿不到（loopback 采集失败）时如实上报，不伪造静音块。 */
  meetingTrackMissing(meetingId: string, kind: 'mic' | 'loopback', reason?: string): Promise<SimpleOkResult>
  /**
   * 系统音频能不能采。麦克风权限与系统音频权限是两件事，这条只回答后者。
   * `available: false` 时不要尝试采集（会被反复拒绝），直接把 reason 作为缺失原因上报。
   */
  meetingLoopbackCapability(): Promise<{ available: boolean; reason: string | null }>
  /** 渲染层停流并推完最后一块后回报，触发结算与转写。 */
  meetingFlushDone(meetingId: string): Promise<SimpleOkResult>
  /** 拉一次会议运行时状态（录音中/停止中/转写进度/最近会议）。 */
  meetingState(): Promise<MeetingRuntimeState>
  /** 手动重跑转写（转写失败后的重试入口）。录音始终保留；已有人工修订时只重试失败片段。 */
  meetingTranscribe(meetingId: string): Promise<SimpleOkResult>
  /** 只重试转写失败的片段：成功的替换占位段，其余段（含用户改过的名字）不动。 */
  meetingRetryFailed(meetingId: string): Promise<SimpleOkResult>
  /** 说话人修订列表：段 + 说话人汇总 + 当前 revision。 */
  meetingSpeakers(meetingId: string): Promise<MeetingSpeakersResult>
  /** 说话人改名/合并/拆分。每次修订 bump revision，并让已确认的纪要退回草稿。 */
  meetingSpeakerRename(meetingId: string, speaker: string, label: string): Promise<MeetingEditResult>
  meetingSpeakerMerge(meetingId: string, fromSpeaker: string, intoSpeaker: string): Promise<MeetingEditResult>
  meetingSpeakerSplit(meetingId: string, indexes: number[], label: string): Promise<MeetingEditResult>
  /** 取纪要（本地模板版或模型草稿）、本场会议的数据去向授权状态、模型是否可用。 */
  meetingMinutes(meetingId: string): Promise<MeetingMinutesResult>
  /**
   * 用模型生成纪要。主进程先弹原生对话框说明将发送哪些文字、发给谁，用户同意才发送；
   * 拒绝时一个字都不发。输出逐条校验来源，校验不过的条目标"已剔除"、不进入定稿。
   */
  meetingMinutesGenerate(meetingId: string): Promise<MinutesGenerateResult>
  /** 撤销本场会议的数据去向授权（之后再生成要重新同意）。 */
  meetingMinutesRevokeEgress(meetingId: string): Promise<SimpleOkResult>
  /** 改模型纪要的一条：文字、负责人、期限（null = 清回待确认）。旧确认随之失效。 */
  meetingMinutesEditItem(meetingId: string, itemId: string, patch: MinutesItemPatch): Promise<MeetingMinutesEditResult>
  /** 取已确认的定稿正文（与确认时预览的那份一致）。 */
  meetingMinutesExport(meetingId: string): Promise<MeetingMinutesExportResult>
  /**
   * 把已确认的会议纪要交给个人助理，成为日报可引用的证据。
   * 主进程先弹原生对话框（正文预览 + 去向）；取消则一个请求都不发。
   */
  evidenceIntakeMinutes(meetingId: string): Promise<EvidenceIntakeOutcome>
  /** 把当前窗口的文字记为工作证据（同样先弹原生确认框；macOS 尚未实现，会如实报错）。 */
  evidenceIntakeWindow(): Promise<EvidenceIntakeOutcome>
  /** 放弃模型草稿，改回本地模板版（不经模型）。 */
  meetingMinutesUseLocal(meetingId: string): Promise<SimpleOkResult>
  /** 确认纪要。只有用户亲手点这个按钮才会置 confirmed；段修订过、或 digest 与预览对不上会被拒；重复确认幂等。 */
  meetingMinutesConfirm(meetingId: string, digest?: string): Promise<MeetingEditResult>
  /** 会议开始：渲染层收到后开 getUserMedia 采音并逐块推 meetingChunk。 */
  onMeetingStarted(callback: (payload: MeetingStartedPayload) => void): void
  /** 主进程请求停流：渲染层停轨、冲刷最后一块后调 meetingFlushDone。 */
  onMeetingStopping(callback: (payload: { meetingId: string }) => void): void
  /** 会议运行时状态变更的推送投影。 */
  onMeetingState(callback: (state: MeetingRuntimeState) => void): void
  /** 退场动画播完，通知主进程退出应用。 */
  exitDone(): void
}

declare global {
  interface Window {
    petApi: PetApi
  }
}

export {}
