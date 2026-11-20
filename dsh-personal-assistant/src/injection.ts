/**
 * 会话面的运行时开关：工具注册与系统提示词注入一起挂、一起撤。
 *
 * 为什么需要它：插件此前一旦被启用，`personal_assistant_*` 工具与「你是谁」人设块就常驻
 * 主会话。想关掉只能去插件管理器禁用整个插件，而桌宠的桥接也在这个插件里，宠物壳会一起
 * 消失。用户要的是「个人助理」这一个开关：关掉后模型看不到这些工具、也不按助理人设说话，
 * 但插件仍然加载、桥接仍然在，宠物壳照常出现。
 *
 * 纪律：
 * - 只包**会话面**（tools / systemPrompt / 会话事件订阅），不包桥接、命令、任务库。
 * - 撤回顺序与挂载相反；任何一次挂载失败都不阻断其它项，但会记一条日志。
 * - `add` 在已经开启后调用会立即挂载，供团队运行时这种「晚于开关创建」的模块使用。
 */
export type AssistantCaptureState = 'recording' | 'pending' | 'blocked' | 'off'

export interface AssistantPowerState {
  injection: 'on' | 'off'
  capture: AssistantCaptureState
  blocked: string | null
}

export interface AssistantPowerResult {
  /** 这次操作本身是否成功；采集没起来但工具开成了，也算成功（原因写在 text 里）。 */
  ok: boolean
  text: string
  capture: AssistantCaptureState
  /** 开关状态是否发生了翻转（用于回执措辞）。 */
  changed: boolean
}

/** 命令层只依赖这四件事：读状态、开、关、采集现状。 */
export interface AssistantPower {
  enabled(): boolean
  enable(): Promise<AssistantPowerResult>
  disable(): Promise<AssistantPowerResult>
  state(): AssistantPowerState
}

export interface InjectionGateOptions {
  log?(message: string): void
}

interface MountEntry {
  readonly label: string
  readonly mount: () => () => void
}

export class InjectionGate {
  private readonly entries: MountEntry[] = []
  private releases: Array<() => void> | null = null
  private readonly log?: (message: string) => void

  constructor(options: InjectionGateOptions = {}) {
    this.log = options.log
  }

  get enabled(): boolean {
    return this.releases !== null
  }

  add(label: string, mount: () => () => void): void {
    this.entries.push({ label, mount })
    if (this.releases !== null) this.mountOne({ label, mount }, this.releases)
  }

  enable(): void {
    if (this.releases !== null) return
    const releases: Array<() => void> = []
    for (const entry of this.entries) this.mountOne(entry, releases)
    this.releases = releases
  }

  disable(): void {
    const releases = this.releases
    if (releases === null) return
    this.releases = null
    while (releases.length > 0) {
      const release = releases.pop()!
      try { release() } catch (error) {
        this.log?.(`[warn] 会话面撤回失败（继续撤其余）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private mountOne(entry: MountEntry, releases: Array<() => void>): void {
    try {
      releases.push(entry.mount())
    } catch (error) {
      this.log?.(`[warn] ${entry.label} 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * `/assistant-state` 的回包。
 *
 * JSON 而不是「标题 | 值」：客户端要同时读开关与采集两个字段，还要区分「没在记录」的三种原因
 * （关着 / 被配置拦住 / 采样器没起来）。行文本协议做这件事会把"读不到"和"关着"又混成一句。
 */
export function formatAssistantState(state: AssistantPowerState): string {
  return JSON.stringify({
    injection: state.injection,
    capture: state.capture,
    ...(state.blocked === null ? {} : { blocked: state.blocked }),
  })
}
