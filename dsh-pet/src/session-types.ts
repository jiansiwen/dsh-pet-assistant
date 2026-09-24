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
}

export type SessionCommand =
  | { kind: 'prompt'; bindingId: string; text: string; spoken?: boolean }
  | { kind: 'cancel'; bindingId: string }
  | { kind: 'model'; bindingId: string; provider: string; model: string; reasoningEffort?: string }
  | { kind: 'permission'; bindingId: string; value: string }

export interface SessionUpdate extends SessionSnapshot {
  reset?: boolean
}
