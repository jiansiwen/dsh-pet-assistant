/**
 * 形象与音色工作室 preload：只暴露本窗口固定 IPC，无通用 invoke、无凭据读取。
 */
import { contextBridge, ipcRenderer } from 'electron'

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

type Result = { ok: true; value?: unknown } | { ok: false; error: string }

const invoke = (channel: string, input?: unknown): Promise<Result> => ipcRenderer.invoke(channel, input)

const api = {
  state: () => invoke('asset-studio-state'),
  saveProviders: (config: unknown, secrets?: Record<string, string>) => invoke('asset-studio-save-providers', { config, secrets }),
  testProvider: (kind: string, id: string) => invoke('asset-studio-test-provider', { kind, id }),
  startJob: (input: unknown) => invoke('asset-studio-start-job', input),
  cancelJob: (id: string) => invoke('asset-studio-cancel-job', { id }),
  rerunPost: (id: string) => invoke('asset-studio-rerun-post', { id }),
  applySkin: (skinId: string, assistantId: string) => invoke('asset-studio-apply-skin', { skinId, assistantId }),
  deleteSkin: (id: string) => invoke('asset-studio-delete-skin', { id }),
  pickAudio: () => invoke('asset-studio-pick-audio'),
  startClone: (input: unknown) => invoke('asset-studio-start-clone', input),
  applyVoice: (id: string) => invoke('asset-studio-apply-voice', { id }),
  revokeVoice: (id: string) => invoke('asset-studio-revoke-voice', { id }),
  onChanged: (callback: () => void) => {
    const offs = ['asset-jobs-changed', 'custom-skins-changed', 'voices-changed'].map(ch => listen(ch, callback))
    return () => offs.forEach(off => off())
  },
}

contextBridge.exposeInMainWorld('assetStudioApi', api)
export type AssetStudioApi = typeof api