/**
 * 壳的生命周期状态。真源在主进程 `companion-host.ts`，这里只做类型转发 ——
 * 重抄一份形状的话，主进程加一个字段而界面不知道，界面就会拿着旧形状渲染。
 * 纯类型导入，运行时被擦除，不会把 electron 拖进渲染层的包。
 */
import type { CompanionState } from '../main/companion-host.js'
import type { SkinOverrides } from './character-manifest.js'

export type { CompanionState, SkinOverrides }

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

export interface PetState {
  pet: string
  /** 旧单宠物时代的位置，升级后由渲染层映射到对应角色。 */
  bounds?: PetPosition
  /** 各角色座位，键是 assistantId。 */
  positions?: Record<string, PetPosition>
  /** 用户在本机为每个角色挑的形象，键是 assistantId。 */
  characters?: SkinOverrides
  layoutVersion?: number
}

export interface PetSettingsPatch {
  bounds?: PetPosition
  positions?: Record<string, PetPosition>
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

export interface PetApi {
  getState(): Promise<PetState>
  saveSettings(patch: PetSettingsPatch): Promise<{ ok: boolean }>
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
  asrBegin(): Promise<{ ok: boolean; streaming?: boolean; error?: string }>
  /** 流式喂数：一帧 16kHz Int16 PCM（base64），返回当前累积的识别文本（实时回显）。 */
  asrStreamFeed(chunkBase64: string): Promise<{ text: string }>
  /** 流式收尾：取最终全文并归还麦克风给唤醒监听。 */
  asrStreamStop(): Promise<{ ok: boolean; text: string }>
  /** 听写第二拍：交 base64 编码的 wav 转写，顺带把麦克风还给唤醒监听。 */
  asrTranscribe(wavBase64: string): Promise<{ ok: boolean; text?: string; error?: string }>
  /** 听写回退：渲染层录音不可用时由主进程录音并转写。 */
  asrRecordFallback(): Promise<{ ok: boolean; text?: string; error?: string }>
  openReportDir(): Promise<{ ok: boolean }>
  /** 启动团队运行时。不传 profile 就用设置里存的那个。 */
  startRuntime(profile?: string): Promise<{ ok: boolean }>
  /** 停止由本壳启动的运行时。用户自己起的运行时不受影响。 */
  stopRuntime(): Promise<{ ok: boolean }>
  /** 显示/隐藏角色。隐藏后壳仍在：唤醒监听与启动入口都保留。 */
  setStageVisible(visible: boolean): void
  /** 切专注模式：角色还在桌面上，但不随机发言、不开群体娱乐。与隐藏是两件事。 */
  setFocusMode(on: boolean): void
  /** 某个角色的形象被改了（右键菜单）：主进程广播整张表，界面据此立刻换图。 */
  onCharactersChanged(callback: (characters: SkinOverrides) => void): void
  /** 主进程请求退场（会话销毁或用户右键退出）：渲染层播完退场动画后调用 exitDone。 */
  onExitRequested(callback: () => void): void
  /** 全局快捷键唤起输入模式。 */
  onSummon(callback: () => void): void
  /** 语音唤醒词命中（说"小潘"）：宠物回应并弹出输入框。 */
  onWake(callback: () => void): void
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
  /** 退场动画播完，通知主进程退出应用。 */
  exitDone(): void
}

declare global {
  interface Window {
    petApi: PetApi
  }
}

export {}
