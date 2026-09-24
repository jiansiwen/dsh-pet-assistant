/**
 * 主动提醒气泡的按钮与文案（design.md §2.7）。
 *
 * 文案放纯逻辑不进 .tsx：这些字是用户要照着做决定的，措辞错了界面就是在撒谎，
 * 这类问题要能被测试钉住。气泡正文那句话不在这里 —— 它由插件侧的固定常量推来，
 * 界面上没有可被模型填充的资料位，这是"不回应就不读取更多资料"成立的方式之一。
 */

/** 用户可以按的每一个按钮，以及按下后走哪条回执。 */
export interface ProactiveButton {
  kind: 'accept' | 'decline' | 'disable'
  label: string
}

/**
 * suggestDisable=true 时这条气泡其实在问"要不要干脆关掉"——按钮也换掉：
 * 主按钮变成"关掉提醒"，另一个出口是"先不用"（继续拒绝，不关闭）。
 */
export function proactiveButtons(suggestDisable: boolean): ProactiveButton[] {
  if (suggestDisable) {
    return [
      { kind: 'disable', label: '关掉提醒' },
      { kind: 'decline', label: '先不用' },
    ]
  }
  return [
    { kind: 'accept', label: '好' },
    { kind: 'decline', label: '不用' },
  ]
}

/** 用户点「好」后替他发出的那句话：进入帮助流程的是这句话，模型从这里接手确认范围。 */
export const PROACTIVE_ACCEPT_MESSAGE = '我愿意一起排查当前工作。请先问我遇到的问题、项目或文件范围；我确认范围之前不要读取更多资料，也不要修改文件或运行命令。'
