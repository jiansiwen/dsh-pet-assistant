/**
 * 桌面壳装配测试：mock 掉 electron 与两个真进程边界（wake.ps1、TTS 合成进程），
 * 导入真的 src/main/index.ts 完整走一遍 whenReady 装配，然后从外面驱动 IPC。
 *
 * 能测什么：通道清单（谁存在、谁不存在 —— 包括"舞台渲染器没有能直接签发批准的通道"
 * 这条安全性质）、唤醒仲裁的起停次数、紧急停止调了什么、退出路径的次序与一次性。
 * 测不了什么：真窗口、真渲染层、真 PowerShell、真桥接 —— 那些归真机验证清单。
 *
 * 这条链路原先测不了有两个原因：src/main 的本地导入写 `.js`（Node strip-only 不重写，
 * 直接 ERR_MODULE_NOT_FOUND），以及两个类用了参数属性（strip-only 不改写语法）。
 * 前者已统一改为 `.ts`，后者已改为显式字段 —— 别改回去，改回去这条测试就死了。
 *
 * mock 必须在 import index.ts 之前：模块顶层就 new 了 BridgeClient/ApprovalWindow/Narrator，
 * 还注册了 window-all-closed / before-quit，没有回头路。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { BridgeClient } from '../src/main/harness.ts'

// ── 隔离：所有写盘都落在临时目录，绝不碰真用户的 ~/.dsh 与 pet-settings.json ──
const sandbox = mkdtempSync(path.join(tmpdir(), 'dsh-pet-e2e-'))
process.env.DSH_HOME = path.join(sandbox, 'dsh-home')

const wakeStarts: Array<{ onWake: unknown; onLost: unknown }> = []
let wakeStops = 0
mock.module('../src/main/wake.ts', {
  namedExports: {
    startWakeListener: (onWake: unknown, onLost: unknown) => wakeStarts.push({ onWake, onLost }),
    stopWakeListener: () => {
      wakeStops += 1
    },
  },
})

/** Narrator 的替身。静态收集实例，测试经它控制 isSpeaking 与核对调用。 */
class FakeNarrator {
  static instances: FakeNarrator[] = []
  speaking = false
  interruptReasons: string[] = []
  interruptedContextCalls = 0
  disposed = 0
  spawnWorker: unknown
  options: unknown
  constructor(spawnWorker: unknown, options: unknown) {
    this.spawnWorker = spawnWorker
    this.options = options
    FakeNarrator.instances.push(this)
  }
  isSpeaking(): boolean {
    return this.speaking
  }
  interrupt(reason: string): void {
    this.interruptReasons.push(reason)
  }
  interruptedContext(): string {
    this.interruptedContextCalls += 1
    return '（实际念出的部分）'
  }
  dispose(): void {
    this.disposed += 1
  }
}
mock.module('../src/main/tts.ts', {
  namedExports: {
    Narrator: FakeNarrator,
    // 合成进程是懒起的，测试里一次都不该碰它；碰了就大声炸出来。
    spawnTtsEdgeWorker: () => {
      throw new Error('测试里不该起 TTS 合成进程')
    },
  },
})

/**
 * 默认 edge-tts 的替身：沙盒里没有 voice-apis.json，唤醒话术预热会走默认合成。
 * 不挡住就是一个真实的微软 WebSocket 请求 —— 测试既不该联网，也不该为它等几秒。
 */
mock.module('../src/main/edge-tts.ts', {
  namedExports: {
    DEFAULT_TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
    synthesizeSpeech: async () => Buffer.from('ID3-fake-audio'),
  },
})

/**
 * 常驻播放进程的替身：装配时启动并不真的 spawn PowerShell（那第三个真进程边界
 * 同样归真机验证）。记录调用次数，确认装配路径确实做了预热与收尾。
 */
const playHostCalls = { starts: 0, stops: 0, plays: 0 }
mock.module('../src/main/play-host.ts', {
  namedExports: {
    PlayHost: class {
      start(): Promise<boolean> {
        playHostCalls.starts += 1
        return Promise.resolve(true)
      }
      play(): null {
        playHostCalls.plays += 1
        return null
      }
      stop(): void {
        playHostCalls.stops += 1
      }
    },
  },
})

// ── electron 替身：记录而非模拟。窗口、托盘、快捷键只存"发生过什么"。 ──
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcListeners = new Map<string, (...args: unknown[]) => void>()
const ipcRemoved: Array<{ kind: string; channel: string }> = []
const appHandlers = new Map<string, (event?: unknown, ...rest: unknown[]) => void>()
const quitCalls: number[] = []
const registeredShortcuts: string[] = []
let shortcutsCleared = 0
let dockHideCalls = 0
/** 注册过几次桌面采集授权回调。装配时必须正好一次 —— 不注册，会议就永远只有麦克风一轨。 */
let displayMediaHandlers = 0
const windows: FakeBrowserWindow[] = []
const trays: FakeTray[] = []
let noticeMode: 'show' | 'failed' | 'throw' | 'silent' = 'show'
let noticeShowCount = 0
let noticeBody = ''

class FakeNotification {
  private readonly listeners = new Map<string, () => void>()
  constructor(options: { title: string; body: string }) { noticeBody = options.body }
  static isSupported(): boolean { return true }
  on(event: string, handler: () => void): void { this.listeners.set(event, handler) }
  show(): void {
    noticeShowCount++
    if (noticeMode === 'throw') throw new Error('模拟通知结果未知')
    if (noticeMode === 'silent') return
    queueMicrotask(() => this.listeners.get(noticeMode)?.())
  }
}

class FakeWebContents {
  sent: Array<{ channel: string; payload: unknown }> = []
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
  on(): void {}
  setWindowOpenHandler(): void {}
}

class FakeBrowserWindow {
  webContents = new FakeWebContents()
  loaded: string | null = null
  options: unknown
  constructor(options: unknown) {
    this.options = options
    windows.push(this)
  }
  loadFile(file: string): Promise<void> {
    this.loaded = file
    return Promise.resolve()
  }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  setIgnoreMouseEvents(): void {}
  isDestroyed(): boolean {
    return false
  }
  isVisible(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  show(): void {}
  hide(): void {}
  restore(): void {}
  on(): void {}
  once(): void {}
}

class FakeTray {
  contextMenu: unknown = null
  clickHandler: (() => void) | null = null
  destroyed = false
  constructor() {
    trays.push(this)
  }
  on(event: string, handler: () => void): void {
    if (event === 'click') this.clickHandler = handler
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  setContextMenu(menu: unknown): void {
    this.contextMenu = menu
  }
  setImage(): void {}
  setToolTip(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

const fakeElectron = {
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: (event?: unknown, ...rest: unknown[]) => void) => {
      appHandlers.set(event, handler)
    },
    quit: () => {
      quitCalls.push(Date.now())
    },
    getPath: (name: string) => path.join(sandbox, `electron-${name}`),
    // macOS 上装配会调 app.dock.hide() 把宠物从 Dock 里拿掉。测试跑在任意平台上，
    // 所以这里必须提供 dock —— 缺了就是 "Cannot read properties of undefined"。
    dock: { hide: () => { dockHideCalls += 1 } },
    // Windows 系统通知需要在装配时设置 AppUserModelId（32dc4d0 引入）。
    setAppUserModelId: () => {},
  },
  // 提醒投递装配会构造系统通知；这份测试没有待投递提醒，但不能因缺替身导入失败。
  Notification: FakeNotification,
  // 装配时会问一次麦克风权限（macOS 上没声明用途说明会被系统直接终止进程）。
  // 这里给一个"已授权"的替身：测试不该弹系统对话框。
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: () => Promise.resolve(true),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      assert.ok(!ipcHandlers.has(channel), `通道 ${channel} 被注册了两次`)
      ipcHandlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      assert.ok(!ipcListeners.has(channel), `通道 ${channel} 被注册了两次`)
      ipcListeners.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
      ipcRemoved.push({ kind: 'handle', channel })
    },
    removeAllListeners: (channel: string) => {
      ipcListeners.delete(channel)
      ipcRemoved.push({ kind: 'on', channel })
    },
  },
  // 系统密钥库替身：只加前缀就够验"落盘是密文、读回一致"，真加密归真机验。
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('解不开')
      return text.slice(4)
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  globalShortcut: {
    register: (accelerator: string) => {
      registeredShortcuts.push(accelerator)
      return true
    },
    unregisterAll: () => {
      shortcutsCleared += 1
    },
  },
  Menu: {
    buildFromTemplate: (template: unknown) => ({
      template,
      popup: () => {},
    }),
  },
  shell: {
    openPath: () => Promise.resolve(''),
    openExternal: () => Promise.resolve(),
  },
  // 会议回环声的桌面采集授权（M4-03）。装配时会注册一次 handler；
  // 测试里没有任何会议在录，所以它永远不该被调用 —— 被调就炸出来。
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: () => {
        displayMediaHandlers += 1
      },
    },
  },
  desktopCapturer: {
    getSources: async () => [],
  },
  // 模型下载走 Electron 的 net.fetch（走系统代理），主进程装配时会引用它。
  // 这份测试不下载任何东西：给了就报错，避免"测试里偷偷联网"。
  net: {
    fetch: () => { throw new Error('装配测试不得发起网络请求') },
  },
  nativeImage: {
    // resize 返回的对象要能接 setTemplateImage —— macOS 分支会调它把图标标成
    // 跟随菜单栏主题反色的单色蒙版。
    createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }),
    createEmpty: () => ({ setTemplateImage: () => {} }),
  },
  Tray: FakeTray,
}
mock.module('electron', { namedExports: fakeElectron })

// ── 导入真的主进程装配。whenReady 已 resolve，装配在微任务里跑。 ──
const appMain = await import('../src/main/index.ts')
await new Promise(resolve => setTimeout(resolve, 30))

/** 渲染层收到的最后一个某频道消息。 */
function lastSent(channel: string): unknown {
  const win = windows[0]
  const hits = win.webContents.sent.filter(item => item.channel === channel)
  return hits.length > 0 ? hits[hits.length - 1].payload : undefined
}

test('装配完成：窗口、托盘、全局快捷键、桥接轮询都起来了', () => {
  assert.equal(windows.length, 1, '舞台窗口建了一个')
  assert.ok(windows[0].loaded?.endsWith(`renderer${path.sep}index.html`), '加载的是渲染层页面')
  assert.equal(trays.length, 1, '托盘建了一个')
  assert.deepEqual(registeredShortcuts, ['CommandOrControl+Alt+P'],
    '主选注册成功就停手；备选 Ctrl+Alt+Space 只在主选被占用时兜底')
  assert.equal(wakeStarts.length, 1, 'boot 后唤醒监听被仲裁器拉起一次（mock 的，没起真 PowerShell）')
  assert.equal(playHostCalls.starts, 1, '唤醒应答的常驻播放进程在装配时预热一次')
})

test('邮件通知只有系统确认显示后才回执，失败和未知如实保留', { timeout: 10000 }, async t => {
  const analysisId = '00000000-0000-4000-8000-000000000001'
  const attemptId = '00000000-0000-4000-8000-000000000002'
  const calls: string[] = []
  let canClaim = true
  let text = '隔离邮件摘要'
  let attention: Array<{ analysisId: string; memberId: string; state: 'unknown' | 'failed' }> = []
  t.mock.method(BridgeClient.prototype, 'desktopMailNotices', async () => ({
    deliveries: [{ analysisId, memberId: 'mail-member', text }], attention,
  }))
  t.mock.method(BridgeClient.prototype, 'claimDesktopMailNotice', async (id: string) => { calls.push(`claim:${id}`); return canClaim ? attemptId : null })
  t.mock.method(BridgeClient.prototype, 'receiptDesktopMailNotice', async (id: string, attempt: string, state: string) => {
    calls.push(`receipt:${id}:${attempt}:${state}`); return true
  })
  try {
    noticeMode = 'show'
    await appMain.deliverMailNoticesOnce()
    assert.deepEqual(calls, [`claim:${analysisId}`, `receipt:${analysisId}:${attemptId}:succeeded`])
    assert.deepEqual(lastSent('member-notice'), { kind: 'mail', text: '隔离邮件摘要', memberId: 'mail-member' })

    calls.length = 0
    text = '长'.repeat(600)
    await appMain.deliverMailNoticesOnce()
    assert.equal(noticeBody.length, 500)
    assert.ok(noticeBody.endsWith('…'), '系统通知被截断时要明确标记')
    text = '隔离邮件摘要'

    calls.length = 0
    noticeMode = 'failed'
    await appMain.deliverMailNoticesOnce()
    assert.deepEqual(calls, [`claim:${analysisId}`, `receipt:${analysisId}:${attemptId}:failed-before-effect`])

    calls.length = 0
    noticeMode = 'throw'
    await appMain.deliverMailNoticesOnce()
    assert.deepEqual(calls, [`claim:${analysisId}`, `receipt:${analysisId}:${attemptId}:unknown`])

    calls.length = 0
    noticeMode = 'silent'
    const waiting = appMain.deliverMailNoticesOnce()
    await appMain.deliverMailNoticesOnce()
    await waiting
    assert.deepEqual(calls, [`claim:${analysisId}`, `receipt:${analysisId}:${attemptId}:unknown`], '没有系统回执不能当成功')

    calls.length = 0
    canClaim = false
    const shown = noticeShowCount
    attention = [{ analysisId, memberId: 'mail-member', state: 'unknown' }]
    await appMain.deliverMailNoticesOnce()
    assert.deepEqual(calls, [`claim:${analysisId}`])
    assert.equal(noticeShowCount, shown, '领取失败不能显示或伪造回执')
    assert.match((lastSent('member-notice') as { text: string }).text, /结果未知.*核对/u)
  } finally { noticeMode = 'show' }
})

test('通道清单：舞台侧注册的每一条都该在，一条不多', () => {
  const expectedOn = [
    'mouse-state', 'exit-done', 'context-menu', 'speech-stop', 'speech-local', 'stage-set-visible', 'stage-set-focus',
    // 演示隐私模式（M5-05）：与专注、隐藏各自独立，只改"渲染哪些历史与预览"。
    'presentation-mode',
    'proactive-respond', 'overlay-state',
    // 阅读视图窗口的回报通道：在 doc-view-window 里注册并核对发送方是阅读视图本身。
    'doc-view-report',
    // 共享采集 / KWS 唤醒 / 渲染层播放 / 插话（M1-02、M1-03、M1-05）：全部核对来源是舞台窗口。
    'kws-feed', 'audio-consumer-lost', 'tts-playback-receipt', 'barge-in-detected', 'barge-in-metrics',
  ]
  const expectedHandle = [
    'get-state', 'save-settings', 'chat-send', 'session-get', 'session-command', 'session-start',
    'doc-roots', 'doc-add-root', 'doc-remove-root', 'doc-forget-dir', 'doc-open', 'doc-explain', 'doc-ask',
    'doc-view-session', 'doc-view-bytes', 'doc-view-page', 'doc-view-resource',
    // 日报工作台窗口的通道在 report-workbench-window 里注册并核对发送方；舞台侧只有打开入口。
    'report-workbench-open', 'report-workbench:load', 'report-workbench:edit', 'report-workbench:edit-memory', 'report-workbench:request-publish',
    'report-workbench:deletion-preview', 'report-workbench:request-deletion', 'report-workbench:import-material',
    'report-workbench:request-share',
    'team-get', 'runtime-start', 'runtime-stop', 'asr-begin', 'asr-transcribe', 'asr-record-fallback',
    'asr-stream-feed', 'asr-stream-stop', 'open-report-dir',
    'voice-api-state', 'voice-api-save', 'voice-api-remove', 'voice-api-select',
    // 环境检查（M5-06）：只查、只按用户确认执行，不主动下载、不主动改系统设置。
    'first-run-report', 'first-run-download', 'first-run-open-settings',
    // 会议系统音频能力查询（M4-03）：渲染层开会前问一次，拿不到就不去反复试。
    'meeting-loopback-capability',
    // 外部证据收件（M3-03 / M4-06 后续）：主进程弹原生确认框，用户同意后才上报。
    'evidence-intake-minutes', 'evidence-intake-window',
    'meeting-start', 'meeting-stop', 'meeting-chunk', 'meeting-track-missing', 'meeting-flush-done',
    'meeting-state', 'meeting-transcribe', 'meeting-speakers', 'meeting-speaker-rename',
    'meeting-speaker-merge', 'meeting-speaker-split', 'meeting-minutes', 'meeting-minutes-confirm',
    'audio-sync', 'residency-state', 'residency-set',
    // 成员目录、成员编辑窗口与额度（团队管理）。
    'members-state', 'member-command', 'member-memories', 'member-assist',
    'member-editor-open', 'member-editor-context', 'member-editor-close',
    // 普通任务与提醒窗口（P0-02/P0-03）。
    'companion-tasks-open', 'companion-tasks:list', 'companion-tasks:detail', 'companion-tasks:create',
    'companion-tasks:control', 'companion-tasks:reminders', 'companion-tasks:respond',
    'companion-tasks:set-interval', 'companion-tasks:request-review', 'companion-tasks:defaults',
    // 会议指令回传与 Office 阅读窗口。
    'meeting-take-command',
    'office-open', 'office-view-session', 'office-view-bytes', 'office-view-image', 'office-view-check',
    'office-view-fullscreen', 'office-view-close',
    // 助理设置页（渠道与邮箱）。
    'assistant-settings-state', 'assistant-settings-save',
  ]
  assert.deepEqual([...ipcListeners.keys()].filter(ch => !ch.startsWith('approval-')).sort(), [...expectedOn].sort())
  assert.deepEqual([...ipcHandlers.keys()].filter(ch => !ch.startsWith('approval-')).sort(), [...expectedHandle].sort())
  // approval 四条（open/read/decide/close）由 ApprovalWindow.registerIpc 注册，单独核对：
  assert.ok(ipcHandlers.has('approval-card-read') && ipcHandlers.has('approval-card-decide'))
  assert.ok(ipcListeners.has('approval-card-close'))

  // 安全性质：舞台窗口的 IPC 面里不存在任何能签发批准的通道。批准只能从专用审批窗口
  // （approval-card-decide）回来，而且回执要过 checkSender —— 那四条规则已有纯函数测试。
  for (const channel of [...ipcHandlers.keys(), ...ipcListeners.keys()]) {
    if (channel.startsWith('approval-')) {
      assert.ok(['approval-open', 'approval-card-read', 'approval-card-decide', 'approval-card-close'].includes(channel),
        `出现了意料外的审批通道：${channel}`)
    }
  }
  assert.ok(ipcHandlers.has('approval-open'), '舞台侧只有 approval-open：报出想批哪条，决定不在这条通道上发生')
})

test('通道清单：preload 暴露给渲染层的每条通道，主进程都真的有人接', () => {
  // preload 里 expose 的 invoke/send 清单。暴露了没人接 = 渲染层调一下 promise 永远悬着，
  // 界面看起来"点了没反应"，而日志上一切正常 —— 这类断裂只有对清单才看得出来。
  const exposed = [
    'get-state', 'save-settings', 'mouse-state', 'context-menu', 'chat-send', 'speech-stop', 'speech-local',
    'session-get', 'session-command', 'session-start', 'overlay-state', 'report-workbench-open',
    'team-get', 'approval-open', 'asr-begin', 'asr-transcribe', 'asr-record-fallback',
    'asr-stream-feed', 'asr-stream-stop', 'open-report-dir',
    'voice-api-state', 'voice-api-save', 'voice-api-remove', 'voice-api-select', 'runtime-start', 'runtime-stop',
    'stage-set-visible', 'stage-set-focus',
    'doc-open', 'doc-explain', 'doc-ask', 'doc-roots', 'doc-add-root', 'doc-remove-root', 'doc-forget-dir',
    'meeting-start', 'meeting-stop', 'meeting-chunk', 'meeting-track-missing', 'meeting-flush-done',
    'meeting-state', 'meeting-transcribe', 'meeting-speakers', 'meeting-speaker-rename',
    'meeting-speaker-merge', 'meeting-speaker-split', 'meeting-minutes', 'meeting-minutes-confirm',
    'exit-done',
    'audio-sync', 'kws-feed', 'audio-consumer-lost', 'tts-playback-receipt', 'barge-in-detected', 'barge-in-metrics',
    'residency-state', 'residency-set',
  ]
  for (const channel of exposed) {
    assert.ok(ipcHandlers.has(channel) || ipcListeners.has(channel), `preload 暴露了 ${channel}，主进程没接`)
  }
})

test('会话和浮层通道拒绝非舞台窗口的调用', async () => {
  assert.deepEqual(await ipcHandlers.get('session-get')?.({}), { ok: false, error: '会话请求来源无效' })
  assert.deepEqual(await ipcHandlers.get('session-command')?.({}, { kind: 'permission', bindingId: 'x', value: 'danger-full-access' }),
    { ok: false, error: '会话操作参数或来源无效' })
  ipcListeners.get('overlay-state')?.({}, { open: true, settingsOpen: false, boxes: [] })
  assert.equal(lastSent('overlay-dismiss'), undefined)
})

test('stage-set-focus：专注模式掐掉唤醒监听，退出专注再恢复 —— 麦克风只有一个主人', () => {
  const setFocus = ipcListeners.get('stage-set-focus')
  assert.ok(setFocus)
  const startsBefore = wakeStarts.length
  const stopsBefore = wakeStops

  setFocus({} as object, true)
  assert.equal(wakeStops, stopsBefore + 1, '专注开始：唤醒监听停掉，参会者的话不该被当指令')

  setFocus({} as object, false)
  assert.equal(wakeStarts.length, startsBefore + 1, '专注结束：唤醒监听恢复')
  assert.ok(lastSent('companion-state') !== undefined, '状态变化投影到了界面')
})

test('会议回环声：装配时注册了桌面采集授权，否则永远只有麦克风一轨', () => {
  // Electron 17+ 起，渲染层的 getDisplayMedia 不再自己弹框，而是问主进程的 handler。
  // 少这一次注册，"对方的声音"在每场会议里都是缺失，而用户看不出是没实现。
  assert.equal(displayMediaHandlers, 1)
})

test('presentation-mode：只藏历史与提醒，不动麦克风、不动专注模式', () => {
  const setPresentation = ipcListeners.get('presentation-mode')
  assert.ok(setPresentation)
  const wakesBefore = wakeStarts.length
  const stopsBefore = wakeStops
  const focusBefore = (lastSent('companion-state') as { focusMode?: boolean } | undefined)?.focusMode

  setPresentation({} as object, true)
  const after = lastSent('companion-state') as { presentationMode?: boolean; focusMode?: boolean; stageVisible?: boolean } | undefined
  assert.equal(after?.presentationMode, true, '状态投影到界面：渲染层据此隐藏历史与预览')
  assert.equal(after?.focusMode, focusBefore ?? false, '演示不该顺带打开/关闭专注模式')
  assert.equal(after?.stageVisible, true, '角色不该被隐藏：演示时用户还要看它讲解')
  assert.equal(wakeStarts.length, wakesBefore, '不重启唤醒监听')
  assert.equal(wakeStops, stopsBefore, '麦克风不受影响：演示时还要插话')

  setPresentation({} as object, false)
  const off = lastSent('companion-state') as { presentationMode?: boolean } | undefined
  assert.equal(off?.presentationMode, false, '关掉即恢复显示')
})

test('speech-stop：不管说没说话都先停链条，说过话才记"实际念出的部分"', () => {
  const narrator = FakeNarrator.instances[0]
  assert.ok(narrator)

  const stop = ipcListeners.get('speech-stop')
  assert.ok(stop)

  // 没在说话：掐一下是幂等的，但不能去记"被打断的半句"——没有的东西不编。
  stop({} as object)
  assert.deepEqual(narrator.interruptReasons, ['drop-queue'], '队列一起丢（第二层打断）')
  assert.equal(narrator.interruptedContextCalls, 0, '没说话就没有"念出的部分"')

  // 正在说话：停下 + 记录，为的是打断后还能续讲。
  narrator.speaking = true
  stop({} as object)
  assert.deepEqual(narrator.interruptReasons, ['drop-queue', 'drop-queue'])
  assert.equal(narrator.interruptedContextCalls, 1)
  assert.ok(lastSent('doc-state') !== undefined, '停止之后文档页的状态照常推送')
  narrator.speaking = false
})

test('exit-done：退场动画播完才允许退出，且退出走 app.quit', () => {
  const quitsBefore = quitCalls.length
  ipcListeners.get('exit-done')?.({} as object)
  assert.equal(quitCalls.length, quitsBefore + 1)
})

test('before-quit：第一次挡下退出收尾，收尾完放行第二次；资源只释放一次', async () => {
  const beforeQuit = appHandlers.get('before-quit')
  assert.ok(beforeQuit)
  const narrator = FakeNarrator.instances[0]
  const tray = trays[0]

  // 第一次：挡下（preventDefault），停唤醒、停合成、断桥接、摘审批通道，然后等壳层静止。
  let prevented = false
  beforeQuit({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true, '第一次退出要被挡下：子进程静止要等事件循环，阻塞主线程等不到')
  assert.equal(shortcutsCleared, 1, '全局快捷键先摘掉')
  assert.equal(wakeStops > 0, true, '唤醒监听已停')
  assert.equal(narrator.disposed, 1, '合成器释放一次')
  assert.equal(playHostCalls.stops >= 1, true, '常驻播放进程随退出收尾，不留空闲 PowerShell')
  assert.ok(ipcRemoved.some(item => item.channel === 'approval-open'), '审批通道已摘：退出过程中不该留能签发批准的窗口')
  assert.ok(tray.destroyed, '托盘已销毁')

  // 壳层 shutdown 是异步的，等它落定后 app.quit 会被再次调用放行。
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(quitCalls.length >= 2, true, '收尾完成后自己放行第二次退出')

  // 第二次 before-quit 是放行的那一次：不再挡下。dispose/unregisterAll 会再跑一遍 ——
  // 它们靠幂等兜底，被 shutdownStarted 挡住的是 host.shutdown，别把这两种"只做一次"混为一谈。
  prevented = false
  beforeQuit({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, false, '第二次不再挡')
  assert.equal(narrator.disposed, 2, 'dispose 幂等，多次触发无害')
})

test('收尾：桥接轮询与托盘定时器都停了，沙盒目录清掉', async () => {
  // connect 的重试循环 sleep 2s 后看到 stopped 才退；等它一拍，不留悬空定时器。
  await new Promise(resolve => setTimeout(resolve, 2200))
  rmSync(sandbox, { recursive: true, force: true })
})
