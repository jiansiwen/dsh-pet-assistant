export interface SessionEntry {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'think' | 'tool'
  text: string
  name?: string
  result?: string
  status?: string
  streaming?: boolean
  turn?: number
}

export interface SessionModel {
  provider: string
  model: string
  label: string
  reasoningEffort?: string
}

export interface SessionSnapshot {
  sessionId: string | null
  bindingId: string
  cursor: number
  title: string
  status: 'idle' | 'running' | 'waiting' | 'disconnected'
  entries: SessionEntry[]
  hasMore: boolean
  beforeSeq?: number
  model: SessionModel | null
  models: SessionModel[]
  permissions: Array<{ value: string; label: string }>
  permission: string | null
  capabilities: { prompt: boolean; cancel: boolean; models: boolean; permissions: boolean; history: boolean }
  error?: string
}

export interface SessionResult {
  ok: boolean
  state?: SessionSnapshot
  error?: string
  notice?: string
  /** 定向取消的结构化回执（M1-06）；多条请求一起取消时取最需要关注的一条，全部见 receipts。 */
  receipt?: CancelReceipt
  receipts?: CancelReceipt[]
}

/**
 * 取消回执的状态：描述被取消那次运行的真实状态，不是 HTTP 请求的结果。
 * not-executed 未执行 / cancelling 取消中 / terminated 已终止 / partially-executed 已部分执行 / unknown 结果未知。
 */
export type CancelState = 'not-executed' | 'cancelling' | 'terminated' | 'partially-executed' | 'unknown'

/** 插件 /chat/cancel、/team/cancel 返回的结构化回执；桌面本地无法取得回执时也用同一形状如实报未知。 */
export interface CancelReceipt {
  state: CancelState
  evidence: { kind: string; at?: number; requestId?: string; taskId?: string; detail?: string; [key: string]: unknown }
  message: string
}

export interface VoiceTurn {
  bindingId: string
  generation: number
  roundId: string
}

export interface VoiceTurnCompletion extends VoiceTurn {
  outcome: 'played' | 'stopped' | 'excluded'
}

export type SessionCommand =
  | { kind: 'prompt'; bindingId: string; text: string; spoken?: boolean; voiceTurn?: VoiceTurn }
  /**
   * 停止类命令（M1-06）。scope 缺省为 run：
   * - run：有宠物发起、尚未结束的请求时只定向取消它们；没有时才走原生 cancel（停止共享会话当前轮次）；
   * - mute：只停播放与本次播报，不向后台发取消；
   * - pause / resume：暂停 / 恢复后续步骤（文档讲解与团队任务不再推进下一步），不中止在跑的运行。
   * 带 taskId 时定向取消该团队任务；带 requestId 时定向取消该宠物请求。
   */
  | { kind: 'cancel'; bindingId: string; scope?: 'run' | 'mute' | 'pause' | 'resume'; taskId?: string; requestId?: string }
  | { kind: 'model'; bindingId: string; provider: string; model: string; reasoningEffort?: string }
  | { kind: 'permission'; bindingId: string; value: string }

export interface SessionUpdate extends SessionSnapshot {
  reset?: boolean
}
