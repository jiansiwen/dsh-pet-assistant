/**
 * 专用审批窗口的 preload。
 *
 * 与舞台那个 preload 分开，是这道保护的核心之一：舞台的 `petApi` 有二十来个方法，
 * 其中不少能改设置、发聊天、停运行时。审批窗口一个都不需要，也就一个都不给。
 * 这里只有四个接口，全部只围绕"当前这一张卡片"：读它、决定它、关掉它、被告知它换了。
 *
 * 刻意不暴露的东西：
 * - 通用 `ipcRenderer.invoke`：给了就等于这个页面能调主进程的任何 handler；
 * - 提案列表：这个窗口只批主进程登记给它的那一条，看得见别的提案没有任何好处；
 * - 任何写入或设置类接口。
 *
 * `proposalId` 由页面从 `read()` 拿到再原样回传。它不是"由渲染层指定批哪条"——
 * 主进程会拿它和自己登记的那条比对，不一致直接拒（见 `checkSender`）。回传的意义是
 * 抓住"卡片显示的是 A、主进程已经换成 B"这种陈旧状态，让它在签发之前失败。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalCardView } from '../main/approval-policy.js'
import type { DecideApprovalResult } from '../renderer/types.js'

export type ApprovalCardApi = {
  read(): Promise<ApprovalCardView | null>
  decide(proposalId: string, decision: 'approve' | 'reject'): Promise<DecideApprovalResult>
  close(): void
  onChanged(callback: () => void): void
}

contextBridge.exposeInMainWorld('approvalCard', {
  read: () => ipcRenderer.invoke('approval-card-read') as Promise<ApprovalCardView | null>,
  decide: (proposalId: string, decision: 'approve' | 'reject') =>
    ipcRenderer.invoke('approval-card-decide', proposalId, decision) as Promise<DecideApprovalResult>,
  close: () => ipcRenderer.send('approval-card-close'),
  onChanged: (callback: () => void) => {
    ipcRenderer.removeAllListeners('approval-card-changed')
    ipcRenderer.on('approval-card-changed', () => callback())
  },
} satisfies ApprovalCardApi)
