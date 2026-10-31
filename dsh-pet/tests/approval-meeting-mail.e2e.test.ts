/** 专用审批窗口的 Electron 替身；不发送邮件、不显示真实窗口。 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const handlers = new Map<string, (...args: any[]) => unknown>()
const dialogs: Array<Record<string, unknown>> = []
let noticeFails = false
class FakeWindow extends EventEmitter {
  static current: FakeWindow
  destroyed = false
  readonly webContents = {
    id: 21, mainFrame: { url: '' }, send() {}, setWindowOpenHandler() {}, on() {},
  }
  constructor(_options: unknown) { super(); FakeWindow.current = this }
  setAlwaysOnTop(): void {}
  setMenuBarVisibility(): void {}
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return false }
  show(): void {}
  focus(): void {}
  close(): void { this.destroyed = true; this.emit('closed') }
  async loadFile(file: string): Promise<void> {
    this.webContents.mainFrame.url = pathToFileURL(file).href
    queueMicrotask(() => this.emit('ready-to-show'))
  }
}
mock.module('electron', { namedExports: {
  BrowserWindow: FakeWindow,
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    on: () => {}, removeHandler: (name: string) => handlers.delete(name), removeAllListeners: () => {} },
  dialog: { showMessageBox: async (...args: any[]) => {
    const options = args.at(-1) as Record<string, unknown>
    dialogs.push(options)
    if (options.type === 'info' && noticeFails) throw new Error('模拟结果提示不可用')
    return { response: options.type === 'warning' ? 1 : 0 }
  } },
} })
const { ApprovalWindow } = await import('../src/main/approval-window.ts')

test('会议邮件批准后，真实审批入口分别提示待登记与未知，不把提示故障伪装成发信失败', async () => {
  for (const outcome of ['pending', 'unknown', 'notice-fails'] as const) {
    dialogs.length = 0
    noticeFails = outcome === 'notice-fails'
    let decisions = 0
    const proposal = { kind: 'assistant' as const, proposalId: `p-${outcome}`, revision: 1, digest: 'a'.repeat(64),
      content: '固定会议纪要与提醒范围', target: '测试邮箱', epoch: 'e1', state: 'pending',
      tool: 'personal_assistant_send_meeting_minutes', risk: 'high', expiresAt: Date.now() + 60_000 }
    const bridge = { getTeam: async () => ({ epoch: 'e1', proposals: [proposal], members: [] }),
      decideApproval: async () => { decisions++; return { ok: true, confirmed: true,
        ...(outcome === 'unknown' ? {} : { meetingMail: { state: 'pending', intentId: 'mail-1', acceptedAt: 1_800_000_000_000 } }) } } }
    const window = new ApprovalWindow(bridge as never)
    window.registerIpc()
    try {
      assert.equal((await window.request(proposal.proposalId)).ok, true)
      await new Promise<void>(resolve => setImmediate(resolve))
      const current = FakeWindow.current
      const event = { sender: current.webContents, senderFrame: current.webContents.mainFrame }
      const result = await handlers.get('approval-card-decide')!(event, proposal.proposalId, 'approve') as { ok: boolean }
      assert.equal(result.ok, true)
      assert.equal(decisions, 1)
      assert.equal(dialogs.length, 2, '原生确认后必须提供结果提示')
      assert.equal(dialogs[1]!.type, 'info')
      if (outcome === 'unknown') assert.match(String(dialogs[1]!.message), /未确认/u)
      else assert.match(String(dialogs[1]!.message), /已接受.*未登记/u)
      assert.match(String(dialogs[1]!.detail), /不要/u)
    } finally { window.dispose() }
  }
})
