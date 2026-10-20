/**
 * 日报工作台窗口的专用 preload。
 *
 * 只暴露"读视图、提交逐条修订、请求发布、请求删除、导入文件、请求允许发送资料"这几件事，
 * 而且没有一件能签发批准：请求发布与请求删除在插件那边只会生成待批提案，主进程随后打开的是
 * 现有的专用审批窗口——批准只能在那里点。这里刻意不给：
 * - 任何批准/决定接口（approval-card-decide 之类）；
 * - 通用 ipcRenderer.invoke；
 * - 任何带路径的接口：导入文件由主进程弹系统文件框，页面说不出路径。
 *
 * 通道名与主进程 report-workbench-window.ts 的 REPORT_WORKBENCH_CHANNELS 一一对应（测试核对）；
 * 这里不 import 主进程模块：那会把主进程代码打进沙箱 preload。
 */
import { contextBridge, ipcRenderer } from 'electron'

export const REPORT_WORKBENCH_PRELOAD_CHANNELS = {
  load: 'report-workbench:load',
  edit: 'report-workbench:edit',
  requestPublish: 'report-workbench:request-publish',
  deletionPreview: 'report-workbench:deletion-preview',
  requestDeletion: 'report-workbench:request-deletion',
  importMaterial: 'report-workbench:import-material',
  requestShare: 'report-workbench:request-share',
  changed: 'report-workbench:changed',
} as const

/** 主进程回给页面的结果：成功时 data 是插件的原样回复；请求审批时附带审批窗口是否打开。 */
export interface WorkbenchReply {
  ok: boolean
  status: number
  code?: string
  error?: string
  data: Record<string, any> | null
  approvalWindow?: { ok: boolean; error?: string }
}

export interface WorkbenchEditOp {
  type: 'rewrite' | 'delete' | 'add'
  line?: number
  expectedText?: string
  text?: string
  afterLine?: number
}

export type ReportWorkbenchApi = {
  load(date?: string): Promise<WorkbenchReply>
  edit(payload: { date: string; baseRevision: number; baseDigest: string; op: WorkbenchEditOp; workItemId?: string; dryRun?: boolean }): Promise<WorkbenchReply>
  /** 带上你正在看的那一版：修订号、摘要、保存路径。只请求打开专用审批窗口，不批准。 */
  requestPublish(payload: { date: string; revision: number; digest: string; targetPath: string }): Promise<WorkbenchReply>
  deletionPreview(payload: { category: string; params: Record<string, unknown> }): Promise<WorkbenchReply>
  requestDeletion(payload: { category: string; params: Record<string, unknown>; previewDigest: string }): Promise<WorkbenchReply>
  importMaterial(meta: { kind: 'chat_excerpt' | 'import_text' | 'note'; objectLabel?: string; coveredFrom?: number; coveredTo?: number; date?: string }): Promise<WorkbenchReply>
  requestShare(materialId: string): Promise<WorkbenchReply>
  onChanged(callback: () => void): void
}

const channels = REPORT_WORKBENCH_PRELOAD_CHANNELS

contextBridge.exposeInMainWorld('reportWorkbench', {
  load: date => ipcRenderer.invoke(channels.load, date),
  edit: payload => ipcRenderer.invoke(channels.edit, payload),
  requestPublish: payload => ipcRenderer.invoke(channels.requestPublish, payload),
  deletionPreview: payload => ipcRenderer.invoke(channels.deletionPreview, payload),
  requestDeletion: payload => ipcRenderer.invoke(channels.requestDeletion, payload),
  importMaterial: meta => ipcRenderer.invoke(channels.importMaterial, meta),
  requestShare: materialId => ipcRenderer.invoke(channels.requestShare, materialId),
  onChanged: callback => {
    ipcRenderer.removeAllListeners(channels.changed)
    ipcRenderer.on(channels.changed, () => callback())
  },
} satisfies ReportWorkbenchApi)
