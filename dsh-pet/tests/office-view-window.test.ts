import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const handlers = new Map<string, (...args: any[]) => any>()
let failLoad = false
let current: FakeWindow
class FakeWindow {
  destroyed = false
  webContents = {
    mainFrame: { url: '' },
    getURL: () => this.webContents.mainFrame.url,
    send() {}, on() {}, setWindowOpenHandler() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } },
  }
  constructor() { current = this }
  setMenuBarVisibility() {}
  once() {}
  on() {}
  show() {}
  focus() {}
  close() { this.destroyed = true }
  isDestroyed() { return this.destroyed }
  async loadFile(file: string) {
    if (failLoad) throw new Error('隔离模拟窗口加载失败')
    this.webContents.mainFrame.url = pathToFileURL(file).href
  }
}
mock.module('electron', { namedExports: {
  BrowserWindow: FakeWindow,
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
} })

const { OfficeViewWindow } = await import('../src/main/office-view-window.ts')
const file = 'D:\\隔离测试\\read.md'
const doc = { path: file, name: 'read.md', fingerprint: '摘要', format: 'markdown' as const, pageCount: null,
  sections: [{ index: 0, heading: '标题', text: '内容', pageNumber: null }] }
const options = { open: async () => ({ ok: true as const, doc }), read: async () => Buffer.from('# 标题\n内容'),
  check: async () => ({ ok: true as const }) }

test('阅读窗口保留最新段号与受控原文读取', async () => {
  failLoad = false
  const view = new OfficeViewWindow(options)
  const dispose = view.registerIpc()
  try {
    assert.equal((await view.show(file, { index: 0, pageNumber: null })).ok, true)
    view.gotoSection(2, null)
    const event = { sender: current.webContents, senderFrame: current.webContents.mainFrame }
    const session = await handlers.get('office-view-session')!(event)
    assert.equal(session.initialSection.index, 2)
    const bytes = await handlers.get('office-view-bytes')!(event, session.token, session.fingerprint)
    assert.equal(Buffer.from(bytes).toString('utf8'), '# 标题\n内容')
  } finally { view.close(); dispose() }
})

test('阅读窗口加载失败向调用方返回错误，不冒充已打开', async () => {
  failLoad = true
  const view = new OfficeViewWindow(options)
  const result = await view.show(file)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /加载失败/u)
  assert.equal(view.isOpen(), false)
})
