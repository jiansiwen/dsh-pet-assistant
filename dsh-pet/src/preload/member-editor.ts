/**
 * 成员编辑窗口的 preload：只暴露成员草稿与保存所需的固定方法。
 * 没有通用 invoke、没有宿主地址、没有凭据；保存仍由主进程复核来源并弹原生确认。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { MemberAction, MemberCommandInputs, MemberDraft, MemberEditorContext, MemberResult } from '../member-types.js'

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  context: () => ipcRenderer.invoke('member-editor-context') as Promise<MemberEditorContext | null>,
  close: () => ipcRenderer.invoke('member-editor-close') as Promise<{ ok: boolean }>,
  membersState: () => ipcRenderer.invoke('members-state') as Promise<MemberResult>,
  memberCommand: <A extends MemberAction>(action: A, input: MemberCommandInputs[A]) =>
    ipcRenderer.invoke('member-command', action, input) as Promise<MemberResult>,
  memberAssist: (input: { request: string; current?: MemberDraft }) =>
    ipcRenderer.invoke('member-assist', input) as Promise<MemberResult>,
  onContext: (callback: (context: MemberEditorContext) => void) => listen('member-editor-context', callback),
  onChanged: (callback: () => void) => listen('members-changed', callback),
}

contextBridge.exposeInMainWorld('memberEditorApi', api)
export type MemberEditorApi = typeof api
