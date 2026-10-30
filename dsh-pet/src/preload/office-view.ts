/**
 * Office 逐页阅读窗口的专用 preload。
 * 只暴露会话、字节、换页授权检查与关闭；页面拿不到任何文件路径或通用 IPC。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { OfficeSession } from '../main/office-view-window.ts'

export type OfficeViewCommand =
  | { readonly type: 'goto'; readonly page: number }
  | { readonly type: 'goto-section'; readonly sectionIndex: number; readonly pageNumber: number | null }
export type OfficeViewApi = {
  session(): Promise<OfficeSession | null>
  bytes(token: string, fingerprint: string): Promise<Uint8Array>
  image(token: string, fingerprint: string, index: number): Promise<Uint8Array>
  check(token: string, fingerprint: string): Promise<{ ok: true } | { ok: false; error: string }>
  close(): Promise<{ ok: boolean }>
  setFullscreen(on: boolean): Promise<{ ok: boolean }>
  onSessionChanged(callback: () => void): void
  onFullscreen(callback: (on: boolean) => void): void
  onCommand(callback: (command: OfficeViewCommand) => void): void
}

contextBridge.exposeInMainWorld('officeView', {
  session: () => ipcRenderer.invoke('office-view-session') as Promise<OfficeSession | null>,
  bytes: (token: string, fingerprint: string) => ipcRenderer.invoke('office-view-bytes', token, fingerprint) as Promise<Uint8Array>,
  image: (token: string, fingerprint: string, index: number) =>
    ipcRenderer.invoke('office-view-image', token, fingerprint, index) as Promise<Uint8Array>,
  check: (token: string, fingerprint: string) =>
    ipcRenderer.invoke('office-view-check', token, fingerprint) as Promise<{ ok: true } | { ok: false; error: string }>,
  close: () => ipcRenderer.invoke('office-view-close') as Promise<{ ok: boolean }>,
  setFullscreen: (on: boolean) => ipcRenderer.invoke('office-view-fullscreen', on) as Promise<{ ok: boolean }>,
  onSessionChanged: (callback: () => void) => {
    ipcRenderer.removeAllListeners('office-view-session-changed')
    ipcRenderer.on('office-view-session-changed', () => callback())
  },
  onFullscreen: (callback: (on: boolean) => void) => {
    ipcRenderer.removeAllListeners('office-view-fullscreen-changed')
    ipcRenderer.on('office-view-fullscreen-changed', (_event, on: boolean) => callback(on === true))
  },
  onCommand: (callback: (command: OfficeViewCommand) => void) => {
    ipcRenderer.removeAllListeners('office-view-command')
    ipcRenderer.on('office-view-command', (_event, command: OfficeViewCommand) => callback(command))
  },
} satisfies OfficeViewApi)
