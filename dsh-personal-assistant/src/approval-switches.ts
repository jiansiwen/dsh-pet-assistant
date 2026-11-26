/**
 * 免审批开关：设置页里逐项打开后，对应环节不再停下来等本人点批准、点确认，直接执行并如实回报结果。
 *
 * - 开关只能由本人在桌宠设置页修改（companion owner 凭据）；模型看不到凭据，也没有工具能改它。
 * - 关掉开关立即恢复原来的审批或核对流程；已经执行过的结果不会撤回。
 * - 插件侧开关存放在 `<dsh 目录>/personal-assistant/approval-switches.json`；会议录音完整性等
 *   桌宠侧开关由桌宠自己保存，在设置页里与这里的开关并排展示。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const APPROVAL_SWITCHES = [
  { key: 'helpScope', title: '读取目录与文件授权', description: '帮助授权、项目资料读取、资料发送给模型时直接生效，不再弹审批卡。' },
  { key: 'reportPublish', title: '日报与周报直接保存', description: '发布日报、周报时直接写入文件，不进审批窗口。' },
  { key: 'memoryWrite', title: '长期偏好与记忆直接写入', description: '记住、修改、整理长期偏好时直接执行（含日报工作台里的记忆改写）。' },
  { key: 'memberPermission', title: '子助理不再逐次询问', description: '权限设为「每次询问」的子助理也按自动审批运行，可直接用读写与命令工具。' },
  { key: 'teamActions', title: '团队写文件与执行命令', description: '团队副作用提案、帮助任务改动与验证命令提交后自动批准。' },
  { key: 'computerUse', title: '电脑操作与截图', description: '读取窗口、截图、点击输入、运行本机命令时自动批准（总助理和子助理）。' },
  { key: 'mailSend', title: '发送邮件', description: '发送邮件不再逐封批准，直接按草稿发出。' },
  { key: 'dataDeletion', title: '删除活动与资料', description: '删除活动记录、导入资料、导出文件、撤销日报版本时直接执行。' },
  { key: 'captureScope', title: '活动采集与工作事项确认', description: '开启活动记录、开启窗口标题、确认工作事项时直接生效。' },
  { key: 'companionTasks', title: '待办与任务控制', description: '新建或修改待办、任务状态时直接执行，不再等确认。' },
  { key: 'taskResults', title: '任务结果免验收', description: '子助理真实执行过的操作直接结单，不再停在「等复核」让你点确认完成。' },
  { key: 'memberMemory', title: '子助理记忆与技能直接生效', description: '子助理提交的记忆候选和技能直接生效，不再等本人核对。' },
] as const

export type ApprovalSwitchKey = (typeof APPROVAL_SWITCHES)[number]['key']
export type ApprovalSwitchState = Record<ApprovalSwitchKey, boolean>

export const APPROVAL_SWITCH_KEYS: readonly ApprovalSwitchKey[] = APPROVAL_SWITCHES.map(item => item.key)

/** 助理可信审批的提交主题 → 免审批开关。没有列出的主题一律照常审批。 */
const SUBJECT_SWITCH: ReadonlyArray<readonly [RegExp, ApprovalSwitchKey]> = [
  [/^help$/u, 'helpScope'],
  [/^(?:project-material|material-share):/u, 'helpScope'],
  [/^memories$/u, 'memoryWrite'],
  [/^mail$/u, 'mailSend'],
  [/^(?:activity-delete$|material-delete:|export-delete:|report-revoke:)/u, 'dataDeletion'],
  [/^(?:capture|work-items)$/u, 'captureScope'],
  [/^computer:/u, 'computerUse'],
]

export function switchForSubject(subject: string): ApprovalSwitchKey | null {
  return SUBJECT_SWITCH.find(([pattern]) => pattern.test(subject))?.[1] ?? null
}

export interface ApprovalSwitchView {
  key: ApprovalSwitchKey
  title: string
  description: string
  enabled: boolean
}

export class ApprovalSwitches {
  private state: ApprovalSwitchState
  private readonly file: string | null
  private readonly listeners = new Set<() => void>()

  /**
   * @param file 持久化文件；null 只在内存里（测试用）。
   * @param defaults 文件里没有的开关取这里的值（例如沿用配置里的 approvalMode: auto）。
   */
  constructor(file: string | null, defaults: Partial<ApprovalSwitchState> = {}) {
    this.file = file
    const base = Object.fromEntries(APPROVAL_SWITCH_KEYS.map(key => [key, defaults[key] === true])) as ApprovalSwitchState
    this.state = { ...base, ...this.readDisk() }
  }

  private readDisk(): Partial<ApprovalSwitchState> {
    if (!this.file) return {}
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { switches?: Record<string, unknown> }
      const saved: Partial<ApprovalSwitchState> = {}
      for (const key of APPROVAL_SWITCH_KEYS) {
        if (typeof raw.switches?.[key] === 'boolean') saved[key] = raw.switches[key] as boolean
      }
      return saved
    } catch {
      // 文件不存在或损坏：按默认值运行，不阻断插件启动；下次保存会写回完整内容。
      return {}
    }
  }

  private writeDisk(): void {
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ switches: this.state }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  enabled(key: ApprovalSwitchKey): boolean {
    return this.state[key] === true
  }

  /** 助理可信审批的提交主题是否已被用户设置为免审批。 */
  autoSubject(subject: string): boolean {
    const key = switchForSubject(subject)
    return key !== null && this.enabled(key)
  }

  view(): ApprovalSwitchView[] {
    return APPROVAL_SWITCHES.map(item => ({ key: item.key, title: item.title, description: item.description, enabled: this.enabled(item.key) }))
  }

  /** 只接受已知开关的布尔值；未知键或非布尔值整体拒绝，不做部分保存。 */
  update(patch: unknown): ApprovalSwitchView[] {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('开关设置格式不正确')
    const next = { ...this.state }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!APPROVAL_SWITCH_KEYS.includes(key as ApprovalSwitchKey)) throw new Error(`未知的开关：${key}`)
      if (typeof value !== 'boolean') throw new Error(`开关 ${key} 只能是开或关`)
      next[key as ApprovalSwitchKey] = value
    }
    const previous = this.state
    this.state = next
    try { this.writeDisk() } catch (error) {
      this.state = previous
      throw new Error(`开关未保存：${error instanceof Error ? error.message : String(error)}`)
    }
    for (const listener of this.listeners) {
      try { listener() } catch { /* 通知失败不影响已保存的开关 */ }
    }
    return this.view()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
