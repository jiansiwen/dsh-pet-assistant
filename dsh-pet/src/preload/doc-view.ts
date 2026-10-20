/**
 * 阅读视图窗口的专用 preload。
 *
 * 与舞台的 petApi 分开：这个窗口只需要"拿会话描述、凭令牌取字节/取页许可、取随包字体资源、
 * 回报用户动作"，其他一概不给。尤其不给任何带路径的接口——渲染层永远说不出"给我读某个文件"，
 * 它只能出示主进程签发的那张令牌。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  DocViewBytes,
  DocViewDescriptor,
  DocViewGrant,
  DocViewProblem,
  DocViewReport,
  ViewCommand,
} from '../main/doc-presenter.js'

/** 主进程推给视图的指令：状态机的 ViewCommand，外加"令牌已作废"。 */
export type DocViewCommand = ViewCommand | { readonly type: 'invalidated'; readonly problem: DocViewProblem }

export type DocViewApi = {
  session(): Promise<DocViewDescriptor | null>
  bytes(token: string, fingerprint: string): Promise<DocViewBytes>
  page(token: string, fingerprint: string, page: number): Promise<DocViewGrant>
  resource(token: string, kind: string, filename: string): Promise<Uint8Array | null>
  report(token: string, report: DocViewReport): void
  onSessionChanged(callback: () => void): void
  onCommand(callback: (command: DocViewCommand) => void): void
}

contextBridge.exposeInMainWorld('docView', {
  session: () => ipcRenderer.invoke('doc-view-session') as Promise<DocViewDescriptor | null>,
  bytes: (token: string, fingerprint: string) =>
    ipcRenderer.invoke('doc-view-bytes', token, fingerprint) as Promise<DocViewBytes>,
  page: (token: string, fingerprint: string, page: number) =>
    ipcRenderer.invoke('doc-view-page', token, fingerprint, page) as Promise<DocViewGrant>,
  resource: (token: string, kind: string, filename: string) =>
    ipcRenderer.invoke('doc-view-resource', token, kind, filename) as Promise<Uint8Array | null>,
  report: (token: string, report: DocViewReport) => ipcRenderer.send('doc-view-report', token, report),
  onSessionChanged: (callback: () => void) => {
    ipcRenderer.removeAllListeners('doc-view-session-changed')
    ipcRenderer.on('doc-view-session-changed', () => callback())
  },
  onCommand: (callback: (command: DocViewCommand) => void) => {
    ipcRenderer.removeAllListeners('doc-view-command')
    ipcRenderer.on('doc-view-command', (_event, command: DocViewCommand) => callback(command))
  },
} satisfies DocViewApi)
