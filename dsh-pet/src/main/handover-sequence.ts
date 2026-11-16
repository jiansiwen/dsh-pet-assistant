/**
 * 交接时序：真人助理是怎么交接的，这里就怎么排。
 *
 * 真实场景（用户描述的）：
 *   总助对老板说「这事我交给小张了」→ 转头叫「小张，老板叫你」→ 小张应一句
 *   → 小张出来对老板说第一句 → ……干活/讲解…… → 小张退场前说一句 → 总助接回来
 *
 * 三条规则来自"真人会怎么做"：
 *
 * 1. **只在"真的换人"时触发**，不是定时、不是每次刷新：
 *    上一刻不是这个成员在台上、这一刻变成它在台上，才算一次交接。
 *    这正好对应"总助把活派出去"这个动作本身 —— 派活是原因，上台是结果。
 * 2. **同一个成员连续活动不重复开场**：他在讲第二段时不该再自我介绍一遍。
 * 3. **总助不在时不要他说话**：如果这一刻本来就没人在台上，直接由成员开口，
 *    不硬插一句"我这就来"——真人交接也是有人在场才有对话。
 */

export interface HandoverLines {
  chiefToUser: string
  chiefToMember: string
  memberToChief: string
  memberToUser: string
  memberFarewell: string
}

export type HandoverSpeaker = 'chief' | 'member'

export interface HandoverStep {
  speaker: HandoverSpeaker
  text: string
}

/** 舞台上谁在活动（对应 doc-state 的 active + assistantId）。 */
export interface StageActivity {
  active: boolean
  assistantId: string | null
}

/**
 * 这次状态变化算不算"一次交接"。
 *
 * @param previous 上一次的舞台状态
 * @param next 这一次的舞台状态
 * @param chiefId 总助理自己的 assistantId（他自己上台不算交接）
 */
export function isHandoverStart(previous: StageActivity | null, next: StageActivity, chiefId: string): boolean {
  if (!next.active || !next.assistantId) return false
  if (next.assistantId === chiefId) return false
  // 已经是他/她在台上：不是交接，是同一个人继续干。
  if (previous?.active && previous.assistantId === next.assistantId) return false
  return true
}

/**
 * 开场：叫人 → 应声 → 成员开口。
 *
 * 总助对用户的交代（chiefToUser）**不演**：总助的真实回复里已经说过"交给谁了"，
 * 再念一遍固定台词等于重复播报，还拖慢开讲。chiefToUser 只作生成字段保留。
 * `chiefPresent` 为 false 时省掉叫人/应声（没人在场就没有对话）。
 */
export function handoverOpening(lines: HandoverLines, options: { chiefPresent: boolean }): HandoverStep[] {
  const opening: HandoverStep[] = []
  if (options.chiefPresent) {
    opening.push({ speaker: 'chief', text: lines.chiefToMember })
    opening.push({ speaker: 'member', text: lines.memberToChief })
  }
  opening.push({ speaker: 'member', text: lines.memberToUser })
  return opening.filter(step => step.text.trim() !== '')
}

/**
 * 收场：成员道别 → 总助接回来。
 *
 * 只有成员**自己汇报**（speechBy=self 或 reportMode=self）时才由他道别；
 * 否则那句"我先退下了"应该由总助代说，避免"人没出声却说要走"。
 */
export function handoverClosing(lines: HandoverLines, options: { memberSpeaks: boolean }): HandoverStep[] {
  const closing: HandoverStep[] = []
  closing.push({ speaker: options.memberSpeaks ? 'member' : 'chief', text: lines.memberFarewell })
  return closing.filter(step => step.text.trim() !== '')
}
