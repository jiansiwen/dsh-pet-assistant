/**
 * 运行时连接状态 → 界面文案与语气。
 *
 * 单独成文件有两个原因：
 * - 主进程给的是**事实**（link、lastStage、lastFailed），措辞是界面的事，不该塞回 CompanionState；
 * - 这几条映射有顺序规则（失败优先于已连接、稳态不显示进展播报），写在 JSX 里就没人看得见，也没法测。
 *
 * `Record<CompanionState['link'], string>` 是刻意的：主进程将来加一种连接状态，
 * 这里会直接编译不过，而不是悄悄落到 default 分支显示成"未连接"。
 */
import type { CompanionState } from './types.js'

/** 语气驱动配色。文字本身也说明状态，颜色不是唯一载体。 */
export type RuntimeTone = 'ok' | 'busy' | 'idle' | 'error'

export const RUNTIME_LABEL: Record<CompanionState['link'], string> = {
  none: '未连接助理团队',
  starting: '正在启动助理团队…',
  booted: '运行时已启动，等待会话召唤',
  'attached-external': '助理团队已连接（你自己启动的运行时）',
  'attached-own': '助理团队已连接',
}

/**
 * 失败优先于一切：连上了但契约核对没过（比如那是改造前的构建），
 * 界面要是显示"已连接"，用户就会对着一个没有团队模式的运行时一直等下去。
 */
export function runtimeTone(state: CompanionState): RuntimeTone {
  if (state.lastFailed) return 'error'
  if (state.link === 'attached-own' || state.link === 'attached-external') return 'ok'
  if (state.link === 'starting' || state.link === 'booted') return 'busy'
  return 'idle'
}

export function runtimeLabel(state: CompanionState): string {
  return RUNTIME_LABEL[state.link]
}

/**
 * 要不要把主进程那句话摊开给用户看。
 *
 * 只在三种情况显示：出了错（那句话里带着补救动作）、正在启动（进度值得看）、
 * 运行时起来了但还没人召唤助理（那是待办，不写出来用户不知道下一步该干什么）。
 * 稳态下不显示 —— "已找到 dsh 0.1.1-rc.2 与插件 0.1.0"这种播报长期挂在面板上只是噪音。
 */
export function runtimeDetail(state: CompanionState): string | null {
  if (state.lastFailed || state.link === 'starting' || state.lastStage === 'await-bridge') {
    return state.lastMessage
  }
  return null
}

/** 已连接时不该再给"启动"按钮：点了只会重新附着一次，用户以为自己在重启。 */
export function runtimeCanStart(state: CompanionState): boolean {
  return state.link !== 'starting' && state.link !== 'attached-own' && state.link !== 'attached-external'
}
