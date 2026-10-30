import { contextBridge, ipcRenderer } from 'electron'
import type { CompanionTasksApi } from '../companion-types.ts'

export const COMPANION_TASK_PRELOAD_CHANNELS = {
  list: 'companion-tasks:list', detail: 'companion-tasks:detail', reminders: 'companion-tasks:reminders',
  defaults: 'companion-tasks:defaults', setInterval: 'companion-tasks:set-interval',
  create: 'companion-tasks:create', control: 'companion-tasks:control', respond: 'companion-tasks:respond',
  requestReview: 'companion-tasks:request-review', changed: 'companion-tasks:changed',
} as const
const channels = COMPANION_TASK_PRELOAD_CHANNELS
contextBridge.exposeInMainWorld('companionTasks', {
  list: () => ipcRenderer.invoke(channels.list),
  defaults: () => ipcRenderer.invoke(channels.defaults),
  setInterval: draft => ipcRenderer.invoke(channels.setInterval, draft),
  detail: taskId => ipcRenderer.invoke(channels.detail, taskId),
  reminders: taskId => ipcRenderer.invoke(channels.reminders, taskId),
  create: draft => ipcRenderer.invoke(channels.create, draft),
  control: draft => ipcRenderer.invoke(channels.control, draft),
  respond: draft => ipcRenderer.invoke(channels.respond, draft),
  requestReview: taskId => ipcRenderer.invoke(channels.requestReview, taskId),
  onChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on(channels.changed, listener)
    return () => { ipcRenderer.removeListener(channels.changed, listener) }
  },
} satisfies CompanionTasksApi)
