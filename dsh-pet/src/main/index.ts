/**
 * dsh-pet 主进程：铺满工作区的透明置顶角色窗口、IPC 桥接、形象切换、托盘常驻与运行时启动握手。
 *
 * 生命周期分成两层，别混在一起看：
 * - 窗口层（本文件）：建窗、鼠标穿透、自愈重载、退场动画。
 * - 壳层（`companion-host.ts`）：托盘、启动 dsh 团队运行时的分阶段握手、运行时所有权。
 * 壳层活着不代表角色可见，角色可见也不代表运行时连上了 —— 这两件事各自有各自的状态。
 */
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, net, safeStorage, screen, session, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ApprovalWindow } from './approval-window.ts'
import { registerReportWorkbench, type ReportWorkbenchHandle } from './report-workbench-window.ts'
import { createStreamingSession, pcm16Base64ToFloat32, streamingAvailable, transcribeWav, type StreamingSession } from './asr.ts'
import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from './audio.ts'
import { AudioPrefsStore, loginItemAction, type AudioPrefs } from './audio-prefs.ts'
import { kwsModelProblem, startKws, type KwsSession } from './kws.ts'
import { RendererPlayback, createSwitchingTransport, type RendererReceipt } from './tts-renderer-transport.ts'
import { TtsCache, voiceFingerprint } from './tts-cache.ts'
import { WAKE_GREETINGS, fixedPhrases, pickPhrase } from './greetings.ts'
import { CompanionHost } from './companion-host.ts'
import { createDocFileSystem } from './doc-fs.ts'
import { createPlaybackTap } from './doc-presenter.ts'
import { createDocViewController, type DocViewController, type DocViewHostEvent } from './doc-view-window.ts'
import { createWpsController, type WpsController } from './wps-control.ts'
import { WpsViewTarget } from './wps-view-target.ts'
import {
  askPrompt,
  describeOutline,
  detectDocIntent,
  DocumentLibrary,
  explainPrompt,
  isPdfName,
  MAX_DOC_BYTES,
  mentionsDocs,
  stemOf,
  type DocFile,
  type OpenResult,
  type Outline,
  type ParseResult,
} from './document.ts'
import { FirstRunService, toPlanView } from './first-run-service.ts'
import { intakeMinutes, intakeWindow, type EvidenceConfirmView, type EvidenceIntakeDeps } from './evidence-intake.ts'
import type { EvidenceIntakeOutcome, EvidenceIntakeRequest } from '../evidence-types.ts'
import { createWinActions, type WinDesktopActions } from './win-actions.ts'
import { settingsUri, type MediaAccessStatus } from './first-run.ts'
import { createMacActions } from './mac-actions.ts'
import type { DownloadConfirmation } from './model-resources.ts'
import { BridgeClient, type ChatReply } from './harness.ts'
import {
  addDocRoot,
  docSearchRoots,
  forgetDocDir,
  loadSettings,
  rememberDocDir,
  removeDocRoot,
  saveSettings,
  type PetId,
} from './settings.ts'
import { Narrator, spawnTtsEdgeWorker, type TtsWorkerEvent } from './tts.ts'
import { sniffAudioMime } from './tts-edge-worker.ts'
import { DEFAULT_TTS_VOICE, synthesizeSpeech } from './edge-tts.ts'
import { VoiceApiStore, synthesizeApi, transcribeApi } from './voice-api.ts'
import type { VoiceApiKind, VoiceApiResult, VoiceApiState, ResolvedVoiceApi } from '../voice-api-types.ts'
import { createMeetingRecorder, markAssistantSpeech, registerMeetingIpc, type MeetingRecorder } from './meeting-recorder.ts'
import { splitIntoSegments } from './speech.ts'
import { startWakeListener, stopWakeListener } from './wake.ts'
import { PointerWatcher } from './pointer-watch.ts'
import { kwsWakeDeviceVerified, loginItemSpec, loopbackCapability, platformOf, playAudioSpec, recordAudioSpec, supportsGlobalPointerWatch, supportsWakeWord, supportsWpsControl, wakeEngines } from './platform.ts'
import { resolveAppLayout } from './runtime-launch.ts'
import { isSessionCommand, shouldDismissOverlay, validBoxes, type OverlayBox } from './overlay-state.ts'
import type { CancelReceipt, SessionCommand, SessionSnapshot, SessionUpdate, SessionResult } from '../session-types.ts'
import type { SettingsPage } from '../renderer/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 桌面壳自身的目录布局（开发态 / 打包态的唯一差异点，见 `runtime-launch.ts`）。
 *
 * 打包后 `import.meta.url` 落在 `app.asar/dist/main` 里，而**外部读者**（PowerShell、worker
 * 线程、以 ELECTRON_RUN_AS_NODE 起的子进程）没有 asar 补丁，拿到 asar 内的路径只会报
 * "找不到文件"。`layout.scriptDir` 已经是解包后的真实目录，凡是交给外部读者的路径都用它。
 *
 * 逐字段做能力探测而不是直接读：主进程测试里 electron 是替身，替身不保证提供
 * `isPackaged` / `getAppPath`，在模块加载阶段硬读会让整个测试套件起不来。
 */
function resolveLayout() {
  const packaged = app.isPackaged === true
  return resolveAppLayout({
    mainDir: here,
    isPackaged: packaged,
    appPath: packaged && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined,
    resourcesPath: packaged ? process.resourcesPath : undefined,
  })
}

const layout = resolveLayout()

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

let win: BrowserWindow | null = null
let ignoreMouse = true
const bridge = new BridgeClient()
let sessionState: SessionSnapshot | null = null
let sessionRevision = 0
let overlayOpen = false
let managementOpen = false
let overlayBoxes: OverlayBox[] = []
let dismissAfter = 0
let contextMenuOpen = false
let submissionCount = 0

/**
 * 全局鼠标监听只在 Windows 上有实现（见 `platform.ts`）。
 *
 * 非 Windows 上**不启用**：`PointerWatcher` 会如实报"这个能力没有"，而界面会把那句报错
 * 弹成 toast —— 用户看到的是"宠物坏了"，实际只是"点面板外面收起"这一个便利功能缺了。
 * 这里静默降级，缺的能力在平台上本来就是已知的、无法修的，没有理由打扰用户。
 */
const pointerWatchSupported = supportsGlobalPointerWatch(platformOf())
function setPointerWatch(enabled: boolean): void {
  if (!pointerWatchSupported) return
  pointerWatcher.setEnabled(enabled)
}

const pointerWatcher = new PointerWatcher(path.join(layout.scriptDir, '..', 'assets', 'pointer-watch.ps1'), press => {
  if (!win || !win.isVisible()) return
  const point = screen.screenToDipPoint({ x: press.x, y: press.y })
  const bounds = win.getBounds()
  const internalWindow = press.pid === process.pid && BrowserWindow.getAllWindows().some(window => window !== win && window.isVisible())
  if (!shouldDismissOverlay({
    open: overlayOpen,
    running: submissionCount > 0 || sessionState?.status === 'running' || sessionState?.status === 'waiting',
    blocked: contextMenuOpen || managementOpen || internalWindow,
    after: dismissAfter,
    boxes: overlayBoxes,
  }, { x: point.x - bounds.x, y: point.y - bounds.y, time: press.time })) return
  overlayOpen = false
  setPointerWatch(managementOpen)
  win.webContents.setBackgroundThrottling(!managementOpen)
  sendToRenderer('overlay-dismiss', null)
}, message => sendToRenderer('overlay-error', message))

function acceptSession(update: SessionUpdate): void {
  if (sessionState?.bindingId === update.bindingId && update.cursor < sessionState.cursor) return
  const wasRunning = sessionState?.status === 'running' || sessionState?.status === 'waiting'
  const changed = sessionState?.bindingId !== update.bindingId
  if (sessionState && (changed || update.status === 'disconnected')) {
    interruptSpeech(false)
    interruptedSpeech = null
    stopDocTalk()
    pushDocState()
  }
  sessionState = update
  sessionRevision += 1
  if (changed || (wasRunning && update.status !== 'running' && update.status !== 'waiting')) dismissAfter = Date.now()
  sendToRenderer('session-update', update)
}

function openSettings(page: SettingsPage): void {
  if (!win) return
  managementOpen = true
  dismissAfter = Date.now()
  setPointerWatch(true)
  win.show()
  win.focus()
  sendToRenderer('settings-open', page)
}

function stageSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}

/**
 * 专用审批窗口。批准只能从这里签发。
 *
 * 舞台面板上没有"直接批准"这条 IPC 通道，只有一个 `approval-open`：它报出想批哪条提案，
 * 提案的内容由这里自己去桥接取，决定由专用窗口回来，回执还要过 `checkSender`。
 * 舞台渲染器上显示的是模型写的文本，让同一个渲染器能签发批准，等于让不可信内容
 * 有能力影响签发路径 —— 详见 `approval-window.ts` 的文件头。
 */
const approvals = new ApprovalWindow(bridge)
/** 日报工作台：只能请求打开专用审批窗口，自己不批准任何东西。 */
let reportWorkbench: ReportWorkbenchHandle | null = null
/** 壳层。app ready 之后才建（要用 userData 目录），所以这里是延迟赋值。 */
let host: CompanionHost | null = null
/**
 * 用户自配的 TTS / 语音识别服务（OpenAI 兼容）。密钥用系统密钥库（DPAPI）加密落盘，
 * 只在主进程里解开送给请求；页面拿到的列表里永远没有密钥本体。
 */
let voiceApiStore: VoiceApiStore | null = null

/**
 * 会议要采"对方的声音"（系统回环声）时，必须由主进程批准一次桌面采集。
 *
 * Electron 17 起，渲染层的 `getDisplayMedia` 不再自己弹框，而是问主进程的
 * `setDisplayMediaRequestHandler`；**没有这个处理器，请求直接失败**。
 * 也就是说：不写这段，会议永远只有麦克风一条轨，"对方的声音"在状态里一直是缺失 ——
 * 而用户看到的只是"对方没录到"，看不出是我们没实现。
 *
 * 三条约束：
 *
 * 1. **只在会议录制中批准**。这个应用别的地方不需要抓屏；一个常开的授予等于给页面
 *    随时抓屏的能力，而这里唯一正当的用途就是会议回环声。
 * 2. **只要音频，画面立刻在渲染层停掉**。会议不录屏：老板的屏幕上可能有别的东西，
 *    我们只承诺录声音。`video` 仍然要给 —— Electron 的 handler 要求带上一个源。
 * 3. macOS 13+ 才支持 `audio: 'loopback'`；更老的系统上它会静默拿不到音轨，
 *    渲染层据此如实上报缺失（不循环重试、不录空轨）。
 */
function configureDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const recording = meetingRecorder?.getState().recording === true
    if (!recording) {
      // 不在录会议：拒绝。给 null 而不是空对象，语义是"没有可批准的源"。
      callback({})
      return
    }
    void desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      const primary = sources[0]
      if (!primary) {
        callback({})
        return
      }
      callback({ video: primary, audio: 'loopback' })
    }).catch(() => callback({}))
  })
}

/**
 * 所有显示器拼成的桌面范围。窗口必须覆盖全部屏幕，宠物才能被拖到任意一块屏上；
 * 只建在主屏时，渲染层按窗口尺寸 clamp，拖到边缘就停住了。
 *
 * 用 workArea 而不是 bounds：Windows 11 的 DWM 对覆盖任务栏的置顶透明窗口更敏感，
 * 也避免宠物走到任务栏上挡住系统按钮。
 */
function stageBounds(): { x: number; y: number; width: number; height: number } {
  try {
    // 测试宿主只 mock 了 getPrimaryDisplay；真实 Electron 用所有显示器的并集。
    const displays = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : []
    const areas = displays.length > 0
      ? displays.map(display => display.workArea)
      : [screen.getPrimaryDisplay().workArea]
    const left = Math.min(...areas.map(area => area.x))
    const top = Math.min(...areas.map(area => area.y))
    const right = Math.max(...areas.map(area => area.x + area.width))
    const bottom = Math.max(...areas.map(area => area.y + area.height))
    // 异常 DPI / 虚拟显示器配置可能给出大得不合理的并集；夹住上限，避免创建超大透明窗口。
    return {
      x: left,
      y: top,
      width: Math.min(16384, Math.max(1, right - left)),
      height: Math.min(16384, Math.max(1, bottom - top)),
    }
  } catch (error) {
    console.error('[dsh-pet] stageBounds failed, using primary workArea', error)
    const area = screen.getPrimaryDisplay().workArea
    return { x: area.x, y: area.y, width: area.width, height: area.height }
  }
}

let screenEventsBound = false

process.on('uncaughtException', error => {
  // 透明置顶窗口在个别显卡/系统组合上会直接抛主进程异常；退出前留下可读的日志。
  console.error('[dsh-pet] uncaughtException', error)
  app.exit(1)
})
process.on('unhandledRejection', reason => {
  console.error('[dsh-pet] unhandledRejection', reason)
})
app.on('child-process-gone', (_event, details) => {
  // Windows 11 上透明置顶窗口偶发 GPU 进程崩溃；不记录的话表现就是一召唤就闪退。
  console.error('[dsh-pet] child process gone', details)
})

function createStageWindow(bounds: { x: number; y: number; width: number; height: number }): BrowserWindow {
  return new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
}

function createWindow(): void {
  try {
    win = createStageWindow(stageBounds())
  } catch (error) {
    // 多屏并集在某些 Windows 11 显卡/缩放组合上会创建失败；退回主屏也要让宠物能出来。
    console.error('[dsh-pet] createWindow failed, falling back to primary workArea', error)
    const area = screen.getPrimaryDisplay().workArea
    win = createStageWindow({ x: area.x, y: area.y, width: area.width, height: area.height })
  }
  try { win.setAlwaysOnTop(true, 'screen-saver') } catch (error) { console.error('[dsh-pet] setAlwaysOnTop failed', error) }
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (error) {
    console.error('[dsh-pet] setVisibleOnAllWorkspaces failed', error)
  }
  win.setIgnoreMouseEvents(true, { forward: true })
  // 插拔显示器或改分辨率后重新铺满桌面；只绑一次，避免窗口自愈重建时重复注册。
  // 测试宿主只 mock 了 getPrimaryDisplay，没有 screen.on。
  if (!screenEventsBound && typeof screen.on === 'function') {
    screenEventsBound = true
    const syncBounds = (): void => {
      if (!win || win.isDestroyed()) return
      win.setBounds(stageBounds())
    }
    screen.on('display-added', syncBounds)
    screen.on('display-removed', syncBounds)
    screen.on('display-metrics-changed', syncBounds)
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadFile(path.join(here, '../renderer/index.html'))
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log('[dsh-pet] renderer gone:', details.reason, details.exitCode)
    // 透明窗口的 GPU 合成在息屏等场景偶发硬崩溃：自愈重载，避免宠物直接消失
    if (win && !win.isDestroyed() && !exitRequested) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) void win.reload()
      }, 1000)
    }
  })
  win.on('closed', () => {
    overlayOpen = false
    managementOpen = false
    overlayBoxes = []
    setPointerWatch(false)
    win = null
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 显示/隐藏角色。
 *
 * 两个方向都是先通知渲染层、再改窗口可见性：隐藏时渲染层先把舞台卸掉，共享场景时钟的
 * 最后一个订阅者随之退订、定时器停掉 —— 藏起来的五个角色不该继续每 16ms 空转一圈；
 * 显示时舞台在窗口露出之前就挂好了，用户不会先看到一片空桌面再看到角色出现。
 */
/** 主动提醒评估要用的桌面状态：插件侧靠它实现"会议与免打扰不提醒"（design.md §2.7）。 */
let petStageVisible = true
let petFocusMode = false

function reportPetState(): void {
  // 会议进行中插件不评估主动提醒；状态以录制器为准，不靠界面猜。
  void bridge.reportPetState({ focus: petFocusMode, visible: petStageVisible, meeting: meetingRecorder?.getState().recording === true })
}

function applyStageVisible(visible: boolean): void {
  petStageVisible = visible
  reportPetState()
  sendToRenderer('stage-visible', visible)
  if (!win || win.isDestroyed()) return
  if (visible) {
    if (!win.isVisible()) win.showInactive()
  } else {
    overlayOpen = false
    managementOpen = false
    overlayBoxes = []
    setPointerWatch(false)
    if (win.isVisible()) win.hide()
  }
}

/**
 * 麦克风仲裁器：这台机器上只有一个默认录音设备，唤醒词监听与按键听写必须轮流用。
 *
 * 规则全在 `audio.ts` 的纯函数里，这里只做两件事 —— 把状态存住，把副作用执行掉。副作用是
 * 起/停唤醒监听与起/停插话监听：起两次会留下一个抢麦克风的孤儿进程（它拿静音流，日志还一切正常），
 * 所以"起停份数和持有者始终对得上"这条被穷举测试钉住了。
 *
 * M1-03 之后多一件事：每次转移后把"谁能订阅渲染层共享采集"下发给渲染层（`audio-grants`）。
 * 渲染层的听写 / 插话 / KWS / 会议麦克风轨只能凭它订阅，授权撤回即强制退订。
 */
let audioState: AudioState = INITIAL_AUDIO_STATE

/** 常驻与语音开关（唤醒 / 引擎 / 开机自启 / 外放插话）。懒建：userData 路径要等应用名定下来。 */
let audioPrefsStore: AudioPrefsStore | null = null
function audioPrefs(): AudioPrefs {
  if (audioPrefsStore === null) audioPrefsStore = new AudioPrefsStore(path.join(app.getPath('userData'), 'audio-prefs.json'), platformOf())
  return audioPrefsStore.get()
}

/** 正在跑的唤醒引擎。stop-wake 按它分派 —— 换引擎时 stop 停的是旧的、start 起的是新的。 */
let runningWake: 'system' | 'kws' | null = null
let kwsSession: KwsSession | null = null
/** 唤醒不可用的原因（给设置页看）。 */
let wakeProblem: string | null = null
/** 插话监听最近一次意外结束的原因。 */
let bargeProblem: string | null = null
/** 正在录的会议 id：会议麦克风轨的订阅令牌。 */
let meetingGrantId: string | null = null
let lastGrants = ''

function audioGrants(): { dictation: boolean; bargeIn: boolean; kws: boolean; meetingId: string | null; autoGainControl: boolean } {
  return {
    // 外放插话开着时关自动增益：否则回声残余被放大到人声量级，插话检测分不开（隔离验证实测）。
    autoGainControl: !audioPrefs().bargeIn,
    dictation: audioState.holder === 'dictation',
    bargeIn: audioState.holder === 'barge-in',
    kws: audioState.holder === 'wake' && runningWake === 'kws',
    meetingId: audioState.holder === 'meeting' ? meetingGrantId : null,
  }
}

function pushAudioGrants(): void {
  const grants = audioGrants()
  const key = JSON.stringify(grants)
  if (key === lastGrants) return
  lastGrants = key
  sendToRenderer('audio-grants', grants)
}

function applyAudio(event: AudioEvent): AudioTransition {
  const turn = nextAudio(audioState, event)
  audioState = turn.state
  if (event.type === 'meeting-requested' || event.type === 'meeting-finished') meetingGrantId = null
  if (audioState.holder === 'meeting' || (event.type === 'focus' && event.on)) {
    sendToRenderer('voice-conversation-stop', null)
    if (spokenRound?.voiceTurn) interruptSpeech()
  }
  for (const effect of turn.effects) {
    if (effect === 'start-wake') startWake()
    else if (effect === 'stop-wake') stopWake()
    // 插话监听本身在渲染层：起停就是授权里 bargeIn 的有无，下面统一下发。
  }
  pushAudioGrants()
  return turn
}

/**
 * 按当前引擎拉起唤醒。
 *
 * 能力或模型不存在时，**同步**把状态改掉，而不是走 onWakeLost 回调。
 * 走回调会造成同步重入：applyAudio → start → onLost → applyAudio。里层那次会看到"外层的
 * audioState 刚被写进去、但 effects 还没执行完"的中间态，状态机与进程的真实情况就分家了。
 * 这类分支的结论是确定的（能力 / 模型不存在，不用等任何事件），所以直接改状态最干净。
 */
function startWake(): void {
  const engine = audioPrefs().wakeEngine
  const unavailable = (reason: string): void => {
    audioState = { ...audioState, holder: null, wakeUnavailable: true }
    wakeProblem = reason
    console.log('[dsh-pet] 语音唤醒不可用（按键听写与快捷键不受影响）：', reason)
  }
  if (engine === 'system') {
    if (!supportsWakeWord(platformOf())) return unavailable('这个系统上没有 System.Speech 唤醒')
    runningWake = 'system'
    wakeProblem = null
    startWakeListener(onWakeWord, onWakeLost)
    return
  }
  if (engine === 'kws') {
    const problem = kwsModelProblem(app.getPath('userData'))
    if (problem !== null) return unavailable(problem)
    runningWake = 'kws'
    wakeProblem = null
    // KWS 吃渲染层共享采集：授权（kws=true）随后由 pushAudioGrants 下发，渲染层据此订阅并送 PCM。
    kwsSession = startKws({
      userDataDir: app.getPath('userData'),
      onWake: () => onWakeWord(),
      onLost: reason => { if (runningWake === 'kws') onWakeLost(reason) },
      onReady: loadMs => console.log(`[dsh-pet] 本地唤醒模型已加载（${loadMs}ms）`),
    })
    return
  }
  unavailable('这个系统上还没有可用的本地唤醒方案')
}

function stopWake(): void {
  if (runningWake === 'kws') {
    kwsSession?.stop()
    kwsSession = null
  } else {
    // 包括"没在跑"的情况：wake.ts 在意外退出时排了一个三秒后的自动重启，停一次才清得掉那个定时器。
    stopWakeListener()
  }
  runningWake = null
}

function onWakeWord(): void {
  // 诊断：唤醒链路每一步都要能在日志里看见。用户喊了没反应时，第一句就能定位卡在哪：
  // 路径根本没进来（识别没命中）／被下面某个条件挡住／进来了但在合成/播放阶段失败。
  console.log('[dsh-pet] 唤醒命中：',
    JSON.stringify({ holder: audioState.holder, speaking: narrator.isSpeaking(), spokenRound: spokenRound !== null, focus: audioState.focus }))
  if (spokenRound || narrator.isSpeaking() || audioState.holder === 'meeting') {
    console.log('[dsh-pet] 唤醒被忽略：正在播报或会议中（这不是故障，喊完等它说完再喊一次）')
    return
  }
  // 用户是冲着说话来的：角色藏着就先叫出来，别对着一个隐藏窗口说话。
  host?.setStageVisible(true)
  // 应答要**出声**：每次唤醒只说一句短的，并且换着说法（见 greetings.ts）。
  // 这句话走**独立的合成与播放**，不经过 Narrator 的会话播报队列：
  // 那个队列一次只吃一句、还要等 worker ready，任何一次状态残留都会让唤醒"听得见我叫它、
  // 却听不见它回我"。唤醒应答只是"我听见了"的信号，值得用一条不共享状态的短路径。
  const greeting = pickPhrase(WAKE_GREETINGS)
  if (greeting.length > 0) void speakWakeGreeting(greeting)
  sendToRenderer('wake-triggered', greeting)
}

/**
 * 念一句唤醒应答。
 *
 * 独立于 Narrator：一来不会被会话播报的"一次一句 / awaitingStop"卡住，二来它失败也只影响
 * 这一句，不该把正在进行的讲解或回答队列带崩。命中固定话术缓存时直接播本地音频。
 */
async function speakWakeGreeting(text: string): Promise<void> {
  try {
    const api = voiceApiStore?.resolve('tts') ?? null
    const voiceKey = api === null ? null : voiceFingerprint({
      provider: api.provider, endpoint: api.endpoint, model: api.model, voice: api.voice,
    })
    const key = voiceKey === null ? null : { voiceKey, text }
    const cached = key === null ? null : ttsCache.get(key)
    const startedAt = Date.now()
    const audio = cached ?? await synthesizeOneShot(text, api)
    if (cached === null && key !== null) ttsCache.put(key, audio)
    playOneShot(audio)
    // 把耗时打进日志：用户体感"喊完要等好几秒"时，这一行能直接分出是合成慢还是播放慢。
    console.log(`[dsh-pet] 唤醒应答已出声（${cached === null ? '新合成' : '缓存命中'}，${Date.now() - startedAt}ms）：「${text}」`)
    // 合成过的句子顺手补齐其余固定话术：下次抽到任何一句都能立刻出声。
    if (cached === null) void warmGreetingCache(api)
  } catch (error) {
    console.log('[dsh-pet] 唤醒应答没能出声：', error instanceof Error ? error.message : String(error))
  }
}

/** 合成一句（自定义服务优先，否则 edge-tts）。 */
async function synthesizeOneShot(text: string, api: ResolvedVoiceApi | null): Promise<Buffer> {
  if (api !== null) return synthesizeApi(api, text)
  return synthesizeSpeech({ text, voice: DEFAULT_TTS_VOICE, rate: '+0%', pitch: '+0Hz' })
}

/**
 * 把全部固定话术的音频补齐到缓存。
 *
 * 唤醒应答是随机挑的：只缓存"用过的那几句"等于每次都有概率抽到没缓存的，
 * 于是用户会感觉"有时候很快、有时候要等好几秒"。启动后和首次合成后各补齐一次，
 * 之后每句话都命中缓存，唤醒应答就是本地的、立刻出声。
 *
 * 串行是为了不和服务启动抢带宽；失败只记日志，下次启动再补。
 */
async function warmGreetingCache(api: ResolvedVoiceApi | null): Promise<void> {
  try {
    const voiceKey = api === null ? null : voiceFingerprint({
      provider: api.provider, endpoint: api.endpoint, model: api.model, voice: api.voice,
    })
    if (voiceKey === null) return
    for (const text of fixedPhrases()) {
      if (ttsCache.get({ voiceKey, text }) !== null) continue
      try {
        const audio = await synthesizeOneShot(text, api)
        ttsCache.put({ voiceKey, text }, audio)
      } catch {
        // 单句失败不影响其余句子；下次启动会再试。
      }
    }
    console.log('[dsh-pet] 唤醒应答音频已预热完成')
  } catch (error) {
    console.log('[dsh-pet] 预热唤醒应答失败：', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 直接播放一段音频字节。
 *
 * 用系统播放器（Windows 走 play.ps1 的 MCI、macOS 走 afplay），不经过渲染层：
 * 渲染层播放要先有音频上下文、还可能因为没有用户手势被自动播放策略挂起 ——
 * 唤醒应答必须"喊了就响"，不能赌这些条件。
 */
function playOneShot(audio: Buffer): void {
  const mime = sniffAudioMime(audio)
  const ext = mime === 'audio/wav' ? '.wav' : mime === 'audio/ogg' ? '.ogg' : '.mp3'
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-wake-'))
  const file = path.join(dir, `wake${ext}`)
  writeFileSync(file, audio)
  const spec = playAudioSpec(platformOf(), layout.scriptDir, file)
  if (spec === null) { rmSync(dir, { recursive: true, force: true }); return }
  const child = spawn(spec.command, [...spec.args], { windowsHide: true, stdio: 'ignore' })
  child.once('close', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 稍后清理 */ } })
  child.once('error', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 同上 */ } })
}

function onWakeLost(reason: string): void {
  wakeProblem = reason
  applyAudio({ type: 'wake-lost' })
  // 原因记进 wakeProblem 给设置页看；恢复入口是托盘"重新监听唤醒词"或设置页的重试。
  console.log('[dsh-pet] 唤醒词监听不可用（按键说话仍然可用）：', reason)
}

/**
 * 正在进行的那一轮语音问答。打字发起的轮次是 null。
 *
 * 取消会结束本地请求等待并阻止迟到播报；未取得服务端终止证据前，不声称后台任务已取消。
 */
interface SpokenRound {
  cancelled: boolean
  controller: AbortController
  utteranceId: string
  generationDone: boolean
  played: number
  voiceTurn?: import('../session-types.ts').VoiceTurn
}
let spokenRound: SpokenRound | null = null

function completeSpokenRound(): void {
  const round = spokenRound
  if (!round || !round.generationDone || narrator.isSpeaking()) return
  spokenRound = null
  if (round.voiceTurn) sendToRenderer('voice-turn-complete', {
    ...round.voiceTurn, outcome: !round.cancelled && round.played > 0 ? 'played' : 'stopped',
  })
}

/**
 * 静音（M1-06 三种动作之一）：停播放、丢弃本轮待播、暂停讲解链并解除本轮播报的本地等待。
 * 它**不向后台发取消**——后台请求与团队任务照常运行；要停后台用 cancelCommand 的定向取消。
 */
function interruptSpeech(remember = true): void {
  const chatRound = spokenRound !== null
  pauseDocTalk()
  if (spokenRound) {
    const round = spokenRound
    spokenRound = null
    round.cancelled = true
    round.controller.abort()
    narrator.dropFeed(round.utteranceId)
    narrator.generationEnded()
    if (round.voiceTurn) sendToRenderer('voice-turn-complete', { ...round.voiceTurn, outcome: 'stopped' })
  }
  const wasSpeaking = narrator.isSpeaking()
  narrator.interrupt('drop-queue')
  if (remember && wasSpeaking) {
    interruptedSpeech = narrator.interruptedContext()
    interruptedChat = chatRound
  }
}

function withInterruptedSpeech(text: string): string {
  const heard = interruptedSpeech
  interruptedSpeech = null
  interruptedChat = false
  return heard === null ? text : `（上一段讲解被打断了。${heard}。若我要你接着讲，请从这里往下。）\n${text}`
}

/** 语音/文字里的会议纪要指令。只在提到"会议"与"纪要/总结"时才命中，避免和普通总结混淆。 */
const MEETING_MINUTES_INTENT = /(会议|开会|录音|转写)/u
const MEETING_MINUTES_ACTION = /(纪要|总结|整理|归纳|摘要)/u

export function mentionsMeetingMinutes(text: string): boolean {
  return MEETING_MINUTES_INTENT.test(text) && MEETING_MINUTES_ACTION.test(text)
}

/**
 * 按语音/文字指令直接生成会议纪要。
 *
 * 与会议页按钮走同一入口（`meeting-minutes` 的 `generate`）：授权仍然由主进程原生对话框确认，
 * 语音口令只负责"把这次生成发起出来"，不能替代数据外发授权。
 */
async function summarizeMeetingByVoice(): Promise<ChatReply> {
  const recorder = meetingRecorder
  if (recorder === null) return { ok: false, error: '会议记录还没准备好，暂时不能生成纪要' }
  const state = recorder.getState()
  // 正在录的那场优先；否则取最近结束的一场（recent 已按时间倒序）。
  const current = state.meetingId
  const target = current !== null
    ? { meetingId: current, name: state.name ?? '当前会议', recording: true }
    : (() => {
        const last = state.recent.find(item => item.state !== 'recording')
        return last === undefined ? null : { meetingId: last.id, name: last.name, recording: false }
      })()
  if (target === null) return { ok: false, error: '还没有可整理纪要的会议记录：先开一场会议并结束它' }
  if (target.recording) return { ok: false, error: `《${target.name}》还在录制中，结束后我才能整理` }
  const result = await recorder.generateModelMinutes(target.meetingId, { userInitiated: true })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, reply: `已按《${target.name}》的转写生成会议纪要，可以在会议页查看、逐条修改。` }
}

async function sendChatReply(text: string, bindingId: string, spoken: boolean, assistantId?: string,
  voiceTurn?: import('../session-types.ts').VoiceTurn): Promise<ChatReply> {
  interruptSpeech()
  const outgoing = withInterruptedSpeech(text)
  const round: SpokenRound | null = spoken ? { cancelled: false, controller: new AbortController(),
    utteranceId: `session-${randomUUID()}`, generationDone: false, played: 0, voiceTurn } : null
  spokenRound = round
  if (round) {
    narrator.beginRound()
    narrator.generationStarted()
  }
  const current = () => bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
    && (round === null || (spokenRound === round && !round.cancelled))
  let fedChars = 0
  try {
    const reply = await bridge.chat(outgoing, assistantId, round?.controller.signal, round ? delta => {
      if (!current()) return
      fedChars += delta.length
      narrator.feed(round.utteranceId, delta)
    } : undefined, bindingId)
    if (bindingId !== sessionState?.bindingId || sessionState.status === 'disconnected') {
      return { ok: false, error: '会话已改变，原会话的回复已丢弃' }
    }
    if (!current()) return { ok: true }
    if (round) {
      if (reply.ok && reply.reply) {
        if (fedChars > 0) narrator.feedEnd(round.utteranceId)
        else narrator.speak({ utteranceId: round.utteranceId, text: reply.reply })
      } else {
        interruptSpeech()
      }
    }
    return reply
  } catch (error) {
    if (round && current()) interruptSpeech()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (round && spokenRound === round) {
      round.generationDone = true
      narrator.generationEnded()
      completeSpokenRound()
    }
  }
}

const CANCEL_STATE_LABEL: Record<CancelReceipt['state'], string> = {
  'not-executed': '未执行', cancelling: '取消中', terminated: '已终止', 'partially-executed': '已部分执行', unknown: '结果未知',
}
/** 多条回执里最需要用户关注的排前面：未知 > 部分执行 > 取消中 > 已终止 > 未执行。 */
const CANCEL_STATE_RANK: Record<CancelReceipt['state'], number> = {
  unknown: 0, 'partially-executed': 1, cancelling: 2, terminated: 3, 'not-executed': 4,
}

function receiptNotice(receipts: readonly CancelReceipt[]): string {
  if (receipts.length === 1) return `${CANCEL_STATE_LABEL[receipts[0].state]}：${receipts[0].message}`
  const sorted = [...receipts].sort((a, b) => CANCEL_STATE_RANK[a.state] - CANCEL_STATE_RANK[b.state])
  return `已定向取消 ${receipts.length} 条宠物请求：${sorted.map(item => `${CANCEL_STATE_LABEL[item.state]}（${item.message}）`).join('；')}`
}

/**
 * 停止类命令（M1-06）：三种动作分开，取消只按归属传到请求、播报与助理自己持有的任务。
 * - mute：静音，只停播放与本次播报的本地等待，不向后台发取消；
 * - pause / resume：暂停讲解与团队后续步骤（不再推进下一步），不中止在跑的运行；
 * - run（缺省）/ taskId / requestId：定向取消。有宠物发起、未结算的 /chat 请求时只取消它们，绝不顺带取消
 *   共享会话里网页发起的轮次；没有宠物请求时才走原生 cancel（与网页停止按钮相同）。
 * HTTP 返回不当成任务终止：回执原样带回，界面按 state 如实显示。
 */
async function cancelCommand(command: Extract<SessionCommand, { kind: 'cancel' }>): Promise<SessionResult> {
  const scope = command.scope ?? 'run'
  if (command.taskId) {
    const receipt = await bridge.cancelTeamTask(command.taskId)
    return { ok: true, receipt, receipts: [receipt], notice: receiptNotice([receipt]) }
  }
  if (command.requestId) {
    const receipt = await bridge.cancelChat(command.requestId)
    interruptSpeech()
    pushDocState()
    return { ok: true, receipt, receipts: [receipt], notice: receiptNotice([receipt]) }
  }
  if (scope === 'mute') {
    interruptSpeech()
    pushDocState()
    return { ok: true, notice: '已静音：只停止了播放，后台请求没有被取消' }
  }
  if (scope === 'pause' || scope === 'resume') {
    if (scope === 'pause') {
      interruptSpeech()
      pushDocState()
    }
    const team = await bridge.pauseTeam(scope === 'pause')
    const doc = scope === 'pause' ? '讲解已暂停并保留位置' : '讲解需说“继续讲解”才会接着讲'
    return { ok: true, notice: `${doc}；${team.message}` }
  }
  if (bridge.hasOutstandingChats) {
    // 先取回执再停播报：本地等待由回执解除，用户看到的是后台真实状态而不是「已停止等待」。
    const receipts = await bridge.cancelOutstandingChats()
    interruptSpeech()
    pushDocState()
    const receipt = [...receipts].sort((a, b) => CANCEL_STATE_RANK[a.state] - CANCEL_STATE_RANK[b.state])[0]
    return { ok: true, receipt, receipts, notice: receiptNotice(receipts) }
  }
  // 没有宠物发起的请求：这是网页或原生队列里的轮次，保持原生 cancel 的现状语义。
  return bridge.sessionCommand({ kind: 'cancel', bindingId: command.bindingId })
}

/**
 * 上一轮被打断的讲解，实际播出了什么。
 *
 * 计划 §2.8 要求打断之后交给模型的上下文只能是用户实际听到的内容。少了这一层，模型会以为
 * 结论已经送达而接着往下讲，用户听到的却是半句话加一段沉默。所以这里留一份，在用户下一次
 * 开口时随消息一起送过去，送完即清 —— 一直挂着，三轮之后的消息里还在解释第一轮被打断的事。
 */
let interruptedSpeech: string | null = null
/** 最近被打断的是普通回答（不是文档讲解）。与暂停的讲解同时存在时，一句"继续"不替用户猜。 */
let interruptedChat = false

/**
 * 文档查找与讲解（design.md §2.10）。
 *
 * 规则（授权边界、按名字挑、结构化提取、提示词）都在 `document.ts`，磁盘与系统关联在
 * `doc-fs.ts`，这里只做接线：把聊天里的文档意图接过来、把讲解进度投影到界面上。
 *
 * 授权目录每次现取：用户随时可能在面板上增删，缓存一份就等于撤销不生效。
 */
const documents = new DocumentLibrary(createDocFileSystem(), docSearchRoots)
/** 合成进程的 started/finished/cancelled 原样旁路给阅读视图：翻页只跟实际播放走，不跟生成速度。 */
const playbackTap = createPlaybackTap<TtsWorkerEvent>()
const docView = createDocViewController({ library: documents, subscribePlayback: playbackTap.subscribe, onHostEvent: event => onDocViewEvent(event) })
/** WPS 辅助脚本首次启动约 8 秒，用户第一次要求用 WPS 时才拉起。 */
let wpsController: WpsController | null = null
const wpsControl = (): WpsController => wpsController ??= createWpsController({ scriptDir: layout.scriptDir, ownerPids: [process.pid] })
const wpsView = createDocViewController({
  library: documents, subscribePlayback: playbackTap.subscribe, onHostEvent: event => onDocViewEvent(event),
  target: new WpsViewTarget({ wps: wpsControl, notify: message => sendToRenderer('doc-notice', message) }),
})
/** 阅读视图当前展示的是哪一条讲解链、经哪个视图；暂停/停止只作用于它，换文档时不误停新打开的视图。 */
let presentedSessionId: string | null = null
let presentedView: DocViewController | null = null

/**
 * 正在逐段讲解的那一份文档。打字或语音问一句普通问题是 null。
 *
 * 讲解必须一段一段来：每讲一段都要先请模型讲一遍，再把回答念出来。一次把整份文档塞进
 * 朗读队列做不到这件事，而一次把整份文档塞给模型正是 §2.10 明令不要的。
 */
interface DocTalk {
  readonly path: string
  readonly name: string
  readonly outline: Outline
  /**
   * 解析这份文档时的内容摘要。
   *
   * 朗读位置按摘要索引而不是按路径索引：文档改过之后摘要就变了，旧位置自然对不上，
   * 续讲会从头开始 —— 这正是 §2.10 要的"旧定位失效"，不需要额外去清一遍。
   */
  readonly fingerprint: string
  /** 讲这份文档时点名给谁。没点名就由总助理接待。 */
  readonly assistantId?: string
  /** 讲解跟随哪个视图：内置阅读视图，或用户点名的 WPS。WPS 不可用时如实说明，不悄悄换成阅读视图。 */
  readonly via: 'reading' | 'wps'
  /**
   * 这条链要不要出声。
   *
   * 打字要来的讲解只在面板上铺文字：壳里已有的规矩是"打字问的话突然出声，是用户没要求过的
   * 行为"，讲解也不例外。而且不出声就没有"念完了"这个节拍，一段接一段会连着打十几次模型，
   * 没有任何东西给它限速。
   */
  readonly spoken: boolean
  /** 下一段要讲的下标。 */
  next: number
  readonly sessionId: string
  readonly bindingId?: string
  readonly completed: Set<number>
  readonly explanations: Map<number, string>
  /** 用户按了停止、换了话题或者合成失败就置起来，别让链条在后台自己往下走。 */
  stopped: boolean
}

let docTalk: DocTalk | null = null
/** 链条推进中。onSpeaking 可能连着触发，不挡住就会并行讲两段。 */
let docTalkBusy = false
let docRevision = 0
let docRequest: AbortController | null = null
let meetingRecorder: MeetingRecorder | null = null
let assistantSpeechStartedAt: number | null = null

function pauseDocTalk(): void {
  docRevision += 1
  if (docTalk !== null) docTalk.stopped = true
  docRequest?.abort()
  docRequest = null
  if (docTalk !== null && docTalk.sessionId === presentedSessionId) presentedView?.pause()
}

function stopDocTalk(): void {
  pauseDocTalk()
  if (docTalk !== null && docTalk.sessionId === presentedSessionId) {
    presentedView?.stop('user')
    presentedSessionId = null
  }
  docTalk = null
}

/** 视图报上来的事：用户脱离/选择，或推进已停止。由这里决定讲解怎么办，不静默继续。 */
function onDocViewEvent(event: DocViewHostEvent): void {
  const talk = docTalk
  const ours = talk !== null && talk.sessionId === presentedSessionId
  if (event.type === 'detached') {
    sendToRenderer('doc-notice', talk?.via === 'wps'
      ? `你在 WPS 里翻到了第 ${event.page} 页，页面不再自动跟随讲解；说“继续讲解”会回到讲解位置`
      : `已离开讲解位置（看到第 ${event.page} 页）：可在阅读视图里选择回到讲解位置，或从这一页讲`)
    return
  }
  if (event.type === 'choice') {
    if (event.choice === 'return') { presentedView?.reattach(); return }
    if (!ours || !talk) return
    if (event.section === null) { sendToRenderer('doc-notice', `第 ${event.page} 页没有可讲解的文字`); return }
    void explainDocByPath(talk.path, event.section, true, talk.assistantId, true, talk.via)
      .then(result => { if (!result.ok && result.error) sendToRenderer('doc-notice', result.error) })
    return
  }
  // 自己叫停（用户停止、讲完、换文档）不再回头处理。
  if (event.reason === 'user' || event.reason === 'completed' || event.reason === 'replaced') return
  presentedSessionId = null
  if (event.reason === 'file-changed' || event.reason === 'unauthorized') {
    if (ours) stopDocTalk()
    pushDocState()
    sendToRenderer('doc-notice', event.reason === 'file-changed'
      ? '文档内容变了，讲解已停止；请重新打开后再讲'
      : '文档已不在授权范围，讲解已停止')
    return
  }
  if (ours) interruptSpeech()
  pushDocState()
  // WPS 的暂停原因已由视图目标单独提示，这里不再重复一条笼统的话。
  if (talk?.via !== 'wps') {
    sendToRenderer('doc-notice', event.reason === 'view-closed'
      ? '阅读视图已关闭，讲解已暂停；说“继续讲解”可接着讲'
      : '阅读视图出错，讲解已暂停')
  }
}

/**
 * 给出声的 PDF 讲解打开视图。阅读视图打不开只提示一句、讲解照常；用户点名 WPS 时打不开就返回原因，
 * 由调用方停下来问用户，不能静默换成阅读视图后报 WPS 成功。
 */
async function presentDocView(talk: DocTalk): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!talk.spoken || !isPdfName(talk.path)) {
    return talk.via === 'wps' && talk.spoken ? { ok: false, error: 'WPS 同步讲解目前只支持 PDF' } : { ok: true }
  }
  if (talk.via === 'wps' && !supportsWpsControl(platformOf())) return { ok: false, error: '这个系统上不支持控制 WPS' }
  const view = talk.via === 'wps' ? wpsView : docView
  const shown = await view.present({ path: talk.path, fingerprint: talk.fingerprint, sessionId: talk.sessionId, startSection: talk.next })
  if (shown.ok) {
    presentedSessionId = talk.sessionId
    presentedView = view
    return { ok: true }
  }
  if (talk.via === 'wps') return { ok: false, error: `${shown.problem.message}。要改用内置阅读视图讲解吗？说“讲讲${stemOf(talk.name)}”即可` }
  sendToRenderer('doc-notice', `阅读视图没能打开（${shown.problem.message}），讲解照常进行`)
  return { ok: true }
}

function docUtteranceId(talk: DocTalk, index: number): string {
  return `doc:${talk.sessionId}:${talk.fingerprint}:${index}`
}

/** 讲解进度投影到界面。界面只是投影，位置的真值在这里。 */
function pushDocState(): void {
  const talk = docTalk
  if (talk === null) {
    sendToRenderer('doc-state', { kind: 'idle' })
    return
  }
  sendToRenderer('doc-state', {
    kind: 'outline',
    path: talk.path,
    title: talk.outline.title,
    estMinutes: talk.outline.estMinutes,
    total: talk.outline.sections.length,
    next: talk.next,
    sections: talk.outline.sections.map((section) => ({
      index: section.index,
      pageNumber: section.pageNumber,
      heading: section.heading,
      hasCode: section.hasCode,
      spoken: talk.completed.has(section.index),
    })),
  })
}

/**
 * 装上这条讲解链并投影到界面，不出声。
 *
 * 打字要来的讲解走这条：提纲铺在面板上，用户点某一段或者点"开始朗读"再由 `startDocTalk` 接手。
 */
function installDocTalk(talk: DocTalk): void {
  stopDocTalk()
  interruptSpeech()
  docTalk = talk
  pushDocState()
}

/**
 * 从某一段开始逐段讲解。段号越界或者文档读不出结构时什么都不做，由调用方先报过原因。
 *
 * `prelude` 是开讲之前要先说的那一句（"共几段、大约几分钟"）。它必须夹在装链和推进之间
 * 入队：装链那一步会 drop-queue，先入队就被丢掉了；而推进要先等模型回话，晚一步入队
 * 也仍然排在第一段前面。这个顺序不写在这里，调用方迟早会写反。
 */
function startDocTalk(talk: DocTalk, prelude?: { utteranceId: string; text: string }): void {
  installDocTalk(talk)
  if (prelude !== undefined) {
    // 开场白单独算一轮：它被打断时该报的是"范围还没说完"，跟第一段讲了多少无关。
    narrator.beginRound()
    narrator.speak(prelude)
  }
  void advanceDocTalk()
}

/**
 * 讲下一段。
 *
 * 用循环而不是一段一返回：只有代码、没有正文的段念不出声音，播放器不会再报一次"念完了"，
 * 停在那儿等就是整条链断在这里。跳过它继续往下，直到真的排上了一段或者讲完为止。
 */
async function advanceDocTalk(): Promise<void> {
  if (docTalkBusy) return
  const talk = docTalk
  // 不出声的链条不自动往下走。它只是把提纲装在面板上，而 onSpeaking 是别人的语音轮次
  // 结束时也会触发的 —— 捡起来就是一条没有播放节拍限速的链，几十段连着打几十次模型。
  if (talk === null || talk.stopped || !talk.spoken || narrator.isSpeaking()) return
  docTalkBusy = true
  try {
    while (docTalk === talk && !talk.stopped && talk.next < talk.outline.sections.length) {
      const index = talk.next
      if (talk.outline.sections[index].text === '') {
        talk.next++
        pushDocState()
        continue
      }
      let explanation = talk.explanations.get(index)
      if (explanation === undefined) {
        const prompt = explainPrompt(talk.name, talk.outline, index)
        const request = new AbortController()
        docRequest = request
        const reply = await bridge.chat(prompt, talk.assistantId, request.signal, undefined, talk.bindingId)
        if (docRequest === request) docRequest = null
        if (docTalk !== talk || talk.stopped || request.signal.aborted || talk.bindingId !== sessionState?.bindingId) return
        if (!reply.ok || !reply.reply) {
          sendToRenderer('doc-notice', reply.error ? `第 ${index + 1} 段讲不下去：${reply.error}` : `第 ${index + 1} 段没有讲出内容`)
          pauseDocTalk()
          pushDocState()
          return
        }
        explanation = reply.reply
        talk.explanations.set(index, explanation)
        sendToRenderer('doc-reply', { index, text: explanation })
      }
      const utteranceId = docUtteranceId(talk, index)
      if (talk.sessionId === presentedSessionId) presentedView?.explanation(index, explanation, talk.sessionId)
      narrator.beginRound()
      narrator.speak({
        utteranceId,
        text: explanation,
        fromIndex: narrator.resumeFrom(utteranceId),
        origin: { docPath: talk.path, paragraph: index },
      })
      if (narrator.isSpeaking()) return
      if (talk.completed.has(index)) continue
      pauseDocTalk()
      pushDocState()
      sendToRenderer('doc-notice', '讲解未能播放，已保留位置；请检查语音后继续。')
      return
    }
    if (docTalk === talk && !talk.stopped) {
      sendToRenderer('doc-notice', `《${talk.outline.title}》讲完了`)
      if (talk.sessionId === presentedSessionId) { presentedView?.stop('completed'); presentedSessionId = null }
      stopDocTalk()
      pushDocState()
    }
  } finally {
    docTalkBusy = false
    // 等模型的时候用户换了文档：新链条在 startDocTalk 里被 busy 挡回去了，旧链条退出后
    // 没人再推它，而它等的那个"念完了"永远不会来。这里补一次。
    const next = docTalk
    if (next !== null && !next.stopped && !narrator.isSpeaking()) void advanceDocTalk()
  }
}

/** 解析结果里"讲不了"的原因。能讲就是空串 —— 调用方据此判断要不要报。 */
function parseProblem(parsed: ParseResult): string {
  if (parsed.kind === 'outline') return ''
  return parsed.kind === 'empty' ? '里面没有念得出的正文' : parsed.reason
}

/**
 * 讲不了、打不开的原因，翻成一句能说给用户听的话。
 *
 * document.ts 已经把每种失败都分了类，这里只负责措辞。分类报出来是有用处的：用户听到
 * "不在授权目录里"会去加目录，听到"读不出来"只会觉得这东西坏了。
 */
function unparseable(result: OpenResult): string {
  switch (result.kind) {
    case 'denied':
      return '它不在授权目录里'
    case 'missing':
      return '它已经不在原来的位置了'
    case 'too-big': {
      const mb = (size: number): string => (size / (1024 * 1024)).toFixed(1)
      return `它有 ${mb(result.size)}MB，超过 ${mb(MAX_DOC_BYTES)}MB 的解析上限`
    }
    case 'unreadable':
      return `读不出来（${result.reason}）`
    case 'opened':
      return parseProblem(result.doc.parsed)
  }
}

/** 重名不自己挑（§2.10："多个重名结果让用户选，禁止全盘搜到第一个就打开"）。 */
function pushDocChoices(name: string, hits: readonly DocFile[]): void {
  sendToRenderer('doc-state', {
    kind: 'choose',
    name,
    hits: hits.map((hit) => ({ path: hit.path, name: hit.name, size: hit.size, mtimeMs: hit.mtimeMs })),
  })
}

/** 查找这一步的三种收场：拿到了文件、要用户挑、或者已经有一句该说的话。 */
type DocLookup =
  | { readonly kind: 'file'; readonly hit: DocFile }
  | { readonly kind: 'reply'; readonly reply: ChatReply }

async function lookupDoc(name: string): Promise<DocLookup> {
  const search = await documents.search(name)
  switch (search.kind) {
    case 'found':
      return { kind: 'file', hit: search.hit }
    case 'ambiguous':
      pushDocChoices(name, search.hits)
      return {
        kind: 'reply',
        reply: { ok: true, reply: `找到 ${search.hits.length} 份名字相近的文档，你在面板上挑一份。` },
      }
    case 'missing':
      return { kind: 'reply', reply: { ok: false, error: `在授权目录里没找到"${name}"。` } }
    case 'denied':
      return { kind: 'reply', reply: { ok: false, error: `"${name}"不在授权目录里，不能打开。` } }
  }
}

/**
 * 「打开某文档」：交给系统的文件关联，不拼 shell 命令（§2.10）。
 *
 * 打开成功顺手解析一次：一是能说清楚这份文档能不能讲，二是把结果留在库里，用户接着说
 * "讲讲"就不用再读一遍磁盘。
 */
async function openDocByName(name: string): Promise<ChatReply> {
  const lookup = await lookupDoc(name)
  if (lookup.kind === 'reply') return lookup.reply
  return openDocByPath(lookup.hit.path)
}

/** 「用 WPS 打开某文档」：按 WPS 安装登记指定打开并核验窗口身份，不走系统默认关联。 */
async function openDocInWps(name: string): Promise<ChatReply> {
  if (!supportsWpsControl(platformOf())) return { ok: false, error: '这个系统上不支持指定用 WPS 打开' }
  const lookup = await lookupDoc(name)
  if (lookup.kind === 'reply') return lookup.reply
  const allowed = await documents.authorizedForApp(lookup.hit.path)
  if (!allowed.ok) return { ok: false, error: `打不开：${allowed.error}` }
  const opened = await wpsControl().open(allowed.path)
  const title = path.basename(allowed.path)
  if (!opened.ok) return { ok: false, error: `WPS 没能打开《${title}》：${opened.error.guidance ?? opened.error.message}` }
  rememberDocDir(path.dirname(allowed.path))
  const position = opened.value.position
  return { ok: true, reply: `已用 WPS 打开《${title}》${position ? `（第 ${position.page} / ${position.total} 页）` : ''}。想听讲解就说"用 WPS 讲讲${stemOf(title)}"。` }
}

async function openDocByPath(target: string): Promise<ChatReply> {
  const revealed = await documents.reveal(target, rememberDocDir)
  if (!revealed.ok) return { ok: false, error: `打不开：${revealed.error}` }
  const parsed = await documents.open(target)
  // 能开不等于能讲，分开报：只说"打开了"，用户下一步会说"讲讲"，然后被一句失败糊在脸上。
  return parsed.kind === 'opened' && parsed.doc.parsed.kind === 'outline'
    ? { ok: true, reply: `已经打开《${parsed.doc.name}》。想听讲解就说"讲讲${stemOf(parsed.doc.name)}"。` }
    : { ok: true, reply: `已经打开《${path.basename(target)}》。${unparseable(parsed)}，只能打开给你看。` }
}

/**
 * 「讲讲某文档」：先给提纲和估计时长，再逐段讲（§2.10）。
 *
 * 提纲是本地算出来的，不花一次模型调用 —— 让模型去复述文档结构，等于先把整份文档塞给它，
 * 正是那一节明令不要的做法。
 */
async function explainDocByName(name: string, from: number, speak: boolean, assistantId?: string, via: DocTalk['via'] = 'reading'): Promise<ChatReply> {
  const lookup = await lookupDoc(name)
  if (lookup.kind === 'reply') return lookup.reply
  return explainDocByPath(lookup.hit.path, from, speak, assistantId, false, via)
}

async function explainDocByPath(
  target: string,
  from: number,
  speak: boolean,
  assistantId?: string,
  strictSection = false,
  via: DocTalk['via'] = 'reading',
): Promise<ChatReply> {
  const bindingId = sessionState?.bindingId
  const revision = docRevision
  const opened = await documents.open(target)
  if (bindingId !== sessionState?.bindingId || revision !== docRevision) return { ok: false, error: '会话已改变或讲解已停止，未开始原文档讲解' }
  if (opened.kind !== 'opened') return { ok: false, error: `《${path.basename(target)}》讲不了：${unparseable(opened)}` }
  if (opened.doc.parsed.kind !== 'outline') {
    return { ok: false, error: `《${opened.doc.name}》讲不了：${parseProblem(opened.doc.parsed)}` }
  }

  const outline = opened.doc.parsed.outline
  // 界面点出来的段号必须原样有效：夹一下等于用户点了第 3 段却听第 12 段，还以为文档就是这么写的。
  if (strictSection && (!Number.isInteger(from) || from < 0 || from >= outline.sections.length)) {
    return { ok: false, error: `段号 ${String(from)} 不存在：本文共 ${outline.sections.length} 段，请重新选择。` }
  }
  const talk: DocTalk = {
    path: opened.doc.path,
    name: opened.doc.name,
    outline,
    fingerprint: opened.doc.fingerprint,
    assistantId,
    via,
    spoken: speak,
    next: clampSection(from, outline.sections.length),
    sessionId: randomUUID(),
    bindingId,
    completed: new Set(),
    explanations: new Map(),
    stopped: false,
  }
  // 视图先装上新讲解计划再装链：装链会停掉旧链，停的只能是旧视图会话（见 presentedSessionId）。
  if (speak) {
    const shown = await presentDocView(talk)
    if (bindingId !== sessionState?.bindingId || revision !== docRevision) {
      if (presentedSessionId === talk.sessionId) { presentedView?.stop('replaced'); presentedSessionId = null }
      return { ok: false, error: '会话已改变或讲解已停止，未开始原文档讲解' }
    }
    if (!shown.ok) return { ok: false, error: shown.error }
  }
  // 提纲算一次，两处共用：语音那条路念它的第一行，回执铺它的全部。
  const described = describeOutline(outline)
  if (speak) {
    startDocTalk(talk, {
      utteranceId: `doc-outline:${opened.doc.fingerprint}`,
      // 提纲不逐行念（四十行标题念完用户早走了），但"共几段、大约几分钟"必须先说出口：
      // §2.10 要的是先给范围再逐段讲，而语音这条路上面板可能根本没打开，这句就是唯一的展示。
      text: described.split('\n')[0],
    })
  } else {
    installDocTalk(talk)
  }

  const lines = [described]
  // 改过就要说一声：用户记着的"上次讲到第三段"在新版本里指的是别的内容（§2.10：旧定位失效）。
  if (opened.changed) lines.push('这份文档改过了，之前讲到的位置对不上了，重新从头算。')
  lines.push(
    speak
      ? `从第 ${talk.next + 1} 段开始讲，说"停"或者按停止就停下。`
      : `点提纲里的某一段就从那儿开始讲；这一份不会自己出声。`,
  )
  return { ok: true, reply: lines.join('\n') }
}

/** 段号夹进有效范围。用户说"讲第 99 段"而文档只有 12 段时，讲最后一段比报错有用。 */
function clampSection(from: number, total: number): number {
  if (!Number.isFinite(from) || from <= 0) return 0
  return Math.min(Math.floor(from), Math.max(total - 1, 0))
}

/**
 * 针对某一段追问（§2.10："定位到第三页这个概念"）。
 *
 * 只接受界面上点出来的段号，不从消息里猜。把一段原文附上，比让模型凭标题瞎想要靠谱，
 * 也比把整份文档再塞一遍便宜。
 */
async function resumeDocTalk(spoken: boolean): Promise<ChatReply> {
  const talk = docTalk
  if (!talk) return { ok: false, error: '没有可继续的文档讲解，请先选择文档。' }
  if (!talk.spoken && !spoken) return { ok: false, error: '当前是文字提纲，请在文档页选择段落开始朗读。' }
  interruptSpeech()
  const revision = docRevision
  const opened = await documents.open(talk.path)
  if (docTalk !== talk || revision !== docRevision) return { ok: false, error: '文档讲解已切换或停止。' }
  if (opened.kind !== 'opened' || opened.doc.fingerprint !== talk.fingerprint) {
    if (talk.sessionId === presentedSessionId) presentedView?.fileChanged()
    stopDocTalk()
    pushDocState()
    return { ok: false, error: '文档已变化或不在授权范围，请重新解析后讲解。' }
  }
  if (!talk.spoken) return explainDocByPath(talk.path, talk.next, true, talk.assistantId, false, talk.via)
  talk.stopped = false
  // 视图还开着就接着推进；用户关过视图则重新打开到当前段，不静默只出声。
  if (talk.sessionId === presentedSessionId) presentedView?.resume()
  else {
    const shown = await presentDocView(talk)
    if (!shown.ok) { talk.stopped = true; return { ok: false, error: shown.error } }
  }
  if (docTalk !== talk || talk.stopped) return { ok: false, error: '文档讲解已切换或停止。' }
  void advanceDocTalk()
  return { ok: true, reply: `继续《${talk.name}》，从上次未完整播放的句子接着讲。` }
}

async function askAboutDoc(target: string, index: number, question: string, assistantId?: string, spoken = false): Promise<ChatReply> {
  const talk = docTalk
  const bindingId = sessionState?.bindingId
  interruptSpeech()
  pushDocState()
  const revision = docRevision
  const opened = await documents.open(target)
  if (bindingId !== sessionState?.bindingId || docTalk !== talk || revision !== docRevision) return { ok: false, error: '会话或文档讲解已切换或停止。' }
  if (opened.kind !== 'opened' || opened.doc.parsed.kind !== 'outline'
    || (talk?.path === opened.doc.path && talk.fingerprint !== opened.doc.fingerprint)) {
    return { ok: false, error: `《${path.basename(target)}》的定位已经失效了，请重新解析再问。` }
  }
  if (!Number.isInteger(index) || index < 0 || index >= opened.doc.parsed.outline.sections.length) {
    return { ok: false, error: '该段落不存在，请重新选择提纲中的段落。' }
  }
  const request = new AbortController()
  if (!spoken) docRequest = request
  const prompt = askPrompt(opened.doc.name, opened.doc.parsed.outline, index, question)
  try {
    const result = spoken && bindingId
      ? await sendChatReply(prompt, bindingId, true, assistantId)
      : await bridge.chat(withInterruptedSpeech(prompt), assistantId, request.signal, undefined, bindingId)
    if (request.signal.aborted || bindingId !== sessionState?.bindingId || docTalk !== talk) {
      return { ok: false, error: '追问已停止或会话已切换，旧回答已丢弃。' }
    }
    return result.ok && result.reply
      ? { ...result, reply: `${result.reply}\n\n要继续原来的讲解，可以说“继续讲解”；也可以选择其他段落或结束。` }
      : result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (docRequest === request) docRequest = null
  }
}

/**
 * 候选文件的短缓存。
 *
 * "讲讲今天干了啥"里没有文件名，可"讲"这个动词已经足够触发一次全目录扫描。半分钟内复用
 * 上一次的结果：刚存进授权目录的文件最多晚半分钟才能被点名，换来的是常见闲聊不再每次都
 * 走一遍磁盘。
 */
const DOC_CANDIDATES_TTL = 30_000
let docCandidatesAt = 0
let docCandidatesCache: readonly DocFile[] = []

async function docCandidates(): Promise<readonly DocFile[]> {
  const now = Date.now()
  if (now - docCandidatesAt < DOC_CANDIDATES_TTL) return docCandidatesCache
  const files = await documents.candidates()
  docCandidatesCache = files
  docCandidatesAt = now
  return files
}

/**
 * 让用户亲手挑一个目录。
 *
 * 授权目录只能从这里来：这是分级授权里"允许查找并讲解"的那一级，不能由模型、文档内容
 * 或者任何一个 IPC 参数替用户选（§2.11）。
 */
async function pickDirectory(): Promise<string | null> {
  const title = '选择允许查找和讲解文档的目录'
  const picked =
    win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
}

/** 授权目录与最近目录分开报：最近目录是打开文档时自动记下的，撤销授权只撤前者。 */
function docRootsPayload(): { roots: string[]; recent: string[] } {
  const settings = loadSettings()
  return { roots: settings.docRoots ?? [], recent: settings.docRecentDirs ?? [] }
}

/**
 * 讲解播放器：语音发起的那一轮回答，以及文档逐段讲解的每一段，都从这里念出来。
 *
 * 分句、播放游标、四层打断的规则在 `speech.ts`，跟合成进程打交道的胶水在 `tts.ts`，这里只做
 * 三件事 —— 决定哪一轮该出声、把停止请求转成打断、把播出状态投影到界面上。
 *
 * 合成进程是懒起的：没用过语音的用户不该为一个常驻的合成进程买单（计划 §11.2 给五个角色
 * 的闲暇开销定了硬指标，一个空转的进程就吃掉不少）。
 */
/**
 * 合成传输的选择（M1-05）：
 * - 缺省（"外放插话"关）：`spawnTtsEdgeWorker` 原样 —— 合成进程自己用 play.ps1 / afplay 播。
 * - 打开：合成进程只合成，音频交给渲染层 WebAudio 播（Chromium 回声消除才拿得到参考信号），
 *   实际开始 / 播完 / 停下的回执按原 TtsTransport 协议转报，Narrator 与阅读视图不需要知道。
 * 开关在两次讲话之间生效：下一句派发时发现模式变了才换传输，正在播的那句不受影响。
 */
/** 固定话术的语音缓存（唤醒应答等）：合成一次，之后按音色复用。 */
const ttsCache = new TtsCache(app.getPath('userData'))

const rendererPlayback = new RendererPlayback(
  deliver => spawnTtsEdgeWorker(deliver as (event: TtsWorkerEvent) => void, { synthOnly: true }),  {
    play: (id, b64) => {
      if (!win || win.isDestroyed()) return false
      win.webContents.send('tts-play', { id, b64 })
      return true
    },
    stop: id => sendToRenderer('tts-stop', { id }),
  },
  { log: message => console.log('[dsh-pet] ' + message) },
)
const openTtsTransport = createSwitchingTransport<'process' | 'renderer'>(
  () => (audioPrefs().bargeIn ? 'renderer' : 'process'),
  { process: deliver => spawnTtsEdgeWorker(deliver), renderer: rendererPlayback.open },
)

/** 插话监听的释放要缓一拍：流式回答的句与句之间 Narrator 会短暂报"没在说"，不能每个空档都起停一次唤醒。 */
let bargeReleaseTimer: NodeJS.Timeout | null = null
let bargeHandoverTimer: NodeJS.Timeout | null = null
/** 最近的插话埋点（只在内存，只有时间没有音频）。 */
const bargeMetrics: Array<{ onsetToDetectMs: number; detectToSilenceMs: number | null }> = []

function noteSpeakingForBargeIn(speaking: boolean): void {
  if (speaking) {
    if (bargeReleaseTimer) { clearTimeout(bargeReleaseTimer); bargeReleaseTimer = null }
    if (audioPrefs().bargeIn) applyAudio({ type: 'barge-in-requested' })
    return
  }
  if (audioState.holder !== 'barge-in' || bargeReleaseTimer) return
  bargeReleaseTimer = setTimeout(() => {
    bargeReleaseTimer = null
    if (!narrator.isSpeaking()) {
      applyAudio({ type: 'barge-in-finished' })
      // 插话监听交回麦克风后必须确保唤醒真的回来了：朗读期间它一直被插话占着，
      // 用户这时候喊"小潘同学"没反应，正是因为他们以为唤醒一直开着。
      ensureWakeRunning()
    }
  }, 1500)
  bargeReleaseTimer.unref()
}

/**
 * 唤醒监听是否还在跑；没跑而设置又允许时重新拉起。
 *
 * 为什么要单独兜一层：麦克风是独占的 —— 听写、会议、外放插话都会把它从唤醒手里拿走。
 * 任何一条归还路径漏了，用户看到的就是"喊了没反应"，而且没有任何提示。
 * 这里在每次归还之后做一次幂等检查，而不是依赖每个分支各自记得恢复。
 *
 * `wakeUnavailable` 也会被这里清掉：那个标志原本是"粘住等用户点重试"，可实际最常见的
 * 起因是设备被短暂占用、识别引擎瞬时异常 —— 一次失败就让常驻的宠物永远不再听，用户
 * 感受到的就是"有时候没反应"。看门狗每 20 秒给它一次机会，是真的取不到设备才会一直失败
 * （那种情况下 `startWake` 会再次把标志置回，不会反复打印）。
 */
function ensureWakeRunning(): void {
  const prefs = audioPrefs()
  if (!prefs.wakeEnabled || prefs.wakeEngine === null) return
  if (audioState.focus || audioState.holder !== null) return
  if (runningWake !== null) return
  if (audioState.wakeUnavailable) {
    // 先清掉粘住的失败标志，再按正常路径重试；仍失败会重新标记，不会无限刷日志。
    applyAudio({ type: 'wake-retry' })
    return
  }
  applyAudio({ type: 'wake-config', enabled: true })
}

const narrator = new Narrator(playbackTap.wrap(openTtsTransport), {
  onSpoken: record => {
    if (spokenRound?.utteranceId === record.segment.utteranceId) {
      if (record.complete) spokenRound.played++
      else spokenRound.cancelled = true
    }
    const talk = docTalk
    const index = record.segment.origin?.paragraph
    if (!talk || !record.complete || index === undefined
      || record.segment.utteranceId !== docUtteranceId(talk, index)) return
    const text = talk.explanations.get(index)
    if (text === undefined) return
    const count = splitIntoSegments({ utteranceId: record.segment.utteranceId, text }).length
    if (record.segment.index === count - 1) {
      talk.completed.add(index)
      talk.next = index + 1
      pushDocState()
    }
  },
  onSpeaking: (speaking) => {
    sendToRenderer('speech-state', { speaking })
    noteSpeakingForBargeIn(speaking)
    // 助理播报区间记进会议：纪要里这些段单列，不算真人发言。
    const startedAt = meetingRecorder?.getState().startedAt ?? null
    if (speaking) {
      if (assistantSpeechStartedAt === null && startedAt !== null) assistantSpeechStartedAt = Date.now()
    } else if (assistantSpeechStartedAt !== null) {
      if (startedAt !== null) markAssistantSpeech(assistantSpeechStartedAt - startedAt, Date.now() - startedAt)
      assistantSpeechStartedAt = null
    }
    // 上一段念完了，接着讲下一段。打字问答不受影响：docTalk 为 null 时这里什么都不做。
    if (!speaking) {
      completeSpokenRound()
      void advanceDocTalk()
    }
  },
  onVoice: voice => console.log('[dsh-pet] 语音合成音色：', voice),
  onError: reason => {
    console.log('[dsh-pet] 语音合成不可用：', reason)    // 念不出来是个听不见的故障：不报一句，用户只会觉得"它没反应"，然后去重启整个壳。
    sendToRenderer('speech-state', { speaking: false, error: reason })
    if (spokenRound) {
      spokenRound.cancelled = true
      spokenRound.controller.abort()
      narrator.dropFeed(spokenRound.utteranceId)
    }
    // 失败不推进下一段，保留已生成的讲解和实际播放位置。
    pauseDocTalk()
    pushDocState()
  },
  onCancelGeneration: () => {
    if (spokenRound) {
      spokenRound.cancelled = true
      spokenRound.controller.abort()
    }
  },
}, {
  // 派发每一句时才取配置：用户中途换服务，下一句就走新的，不用重启播放器。
  ttsApi: (): ResolvedVoiceApi | null => voiceApiStore?.resolve('tts') ?? null,
  // 固定话术（唤醒应答等）合成一次就落盘复用；换音色自动失效重合成。
  cache: ttsCache,
})

let exitFallbackTimer: NodeJS.Timeout | null = null
let exitRequested = false

/**
 * 请求渲染层播退场动画（漩涡通道 + 挥手告别）。
 * 动画播完后渲染层会回发 `exit-done`；若渲染层 7s 内没有回应（崩溃/窗口被关），
 * 兜底定时器强制退出，避免应用卡在"正在告别"状态。
 */
function requestPetExit(): void {
  exitRequested = true
  // 先把嘴闭上。退场动画有四秒多，等到 before-quit 才停，角色都已经在漩涡里挥手告别了
  // 还在念上一句回答。dispose 是幂等的，退出收尾时再调一次不要紧。
  narrator.dispose()
  if (!win || win.isDestroyed()) {
    app.quit()
    return
  }
  sendToRenderer('pet-exit-requested', null)
  if (exitFallbackTimer) clearTimeout(exitFallbackTimer)
  exitFallbackTimer = setTimeout(() => app.quit(), 7000)
  exitFallbackTimer.unref()
}

/** 右键的是哪一个角色。主进程不知道台上站着谁，由渲染层报上来。 */
interface MenuTarget {
  readonly assistantId: string
  readonly displayName: string
  readonly skin: string
}

function menuTargetOf(raw: unknown): MenuTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { assistantId?: unknown; displayName?: unknown; skin?: unknown }
  if (typeof value.assistantId !== 'string' || !value.assistantId) return null
  return {
    assistantId: value.assistantId,
    // 名字只当菜单标题用。截断防的是一个异常长的字符串把原生菜单撑出屏幕。
    displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 24) : '',
    skin: typeof value.skin === 'string' ? value.skin : '',
  }
}

const PET_OPTIONS: Array<{ id: PetId; label: string }> = [
  { id: 'panda', label: '国宝熊猫' },
  { id: 'girl-glasses', label: '眼镜女生（Q版）' },
  { id: 'boy-glasses', label: '眼镜男生（Q版）' },
]

/**
 * 把某个角色的形象写进设置，并广播整张表。
 *
 * 读-改-写要在主进程这一侧做完：渲染层手里的表可能是上一帧的，两个角色连着点的话
 * 后一次会把前一次冲掉。
 */
function setCharacterSkin(target: MenuTarget, skin: PetId): void {
  const current = loadSettings().characters ?? {}
  const next = { ...current, [target.assistantId]: { skin } }
  saveSettings({ characters: next })
  sendToRenderer('characters-changed', next)
}

function buildContextMenu(target: MenuTarget | null): Menu {
  const stored = target ? loadSettings().characters?.[target.assistantId]?.skin : undefined
  // 本机存过的优先；没有就用渲染层报的当前生效皮肤（插件下发的或编制默认的）。
  const current = stored ?? target?.skin ?? ''
  const items: Array<MenuItemConstructorOptions> = []
  if (target) {
    items.push({
      label: `换个形象：${target.displayName || '这个角色'}`,
      submenu: PET_OPTIONS.map(option => ({
        label: option.label,
        type: 'radio' as const,
        checked: current === option.id,
        click: () => setCharacterSkin(target, option.id),
      })),
    })
    items.push({ type: 'separator' })
  }
  items.push(
    { label: '宠物设置', click: () => openSettings('general') },
    { label: '团队管理', click: () => openSettings('team') },
    { label: '文档管理', click: () => openSettings('doc') },
    { label: '会议', click: () => openSettings('meeting') },
    { label: '日报工作台', click: () => reportWorkbench?.open() },
    { label: '日报文件夹', click: () => { void shell.openPath(path.join(dshHome(), 'personal-assistant', 'reports')) } },
    { type: 'separator' },
    { label: '隐藏角色（截图 / 录屏）', click: () => host?.setStageVisible(false) },
    { label: '退出桌面宠物', click: () => requestPetExit() },
  )
  return Menu.buildFromTemplate(items)
}

/**
 * 开启或恢复助理会话。已在线就沿用（不抢网页会话）；插件已加载但未绑定就请它新建或恢复；
 * 连运行时都没有时先按壳的规则附着或启动自有运行时。首次活动采集仍要走可信审批，这里不开采集。
 */
async function startAssistantSession(): Promise<SessionResult & { outcome?: string }> {
  if (sessionState && sessionState.status !== 'disconnected' && sessionState.capabilities.prompt) {
    return { ok: true, state: sessionState, outcome: 'existing' }
  }
  if (!bridge.connected) {
    if (!host) return { ok: false, error: '没有找到助理运行时：请先启动 dsh 并加载助理插件' }
    await host.startRuntime()
    const deadline = Date.now() + 15_000
    while (!bridge.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
    if (!bridge.connected) return { ok: false, error: '助理运行时没有就绪：请看设置页“运行时与诊断”里的最新提示' }
  }
  const started = await bridge.startSession()
  if (!started.ok) {
    return { ok: false, error: started.code === 'agents-unavailable'
      ? '当前 dsh 运行时不支持由桌面开启会话，请在 dsh 会话里说“召唤宠物”'
      : started.error }
  }
  if (!sessionState || sessionState.status === 'disconnected') return { ok: false, error: '会话已开启，但还没有同步到会话状态，请稍后重试' }
  const notice = started.resumeError ? `已新建助理会话（上次的会话没能恢复：${started.resumeError}）` : undefined
  return { ok: true, state: sessionState, outcome: started.outcome, notice }
}

async function dispatchPrompt(command: Extract<SessionCommand, { kind: 'prompt' }>, assistantId?: string): Promise<SessionResult & ChatReply> {
  let voiceTurn = command.voiceTurn
  if (voiceTurn && (voiceTurn.bindingId !== command.bindingId || !Number.isSafeInteger(voiceTurn.generation)
    || typeof voiceTurn.roundId !== 'string' || voiceTurn.roundId.length > 128 || !command.spoken)) {
    return { ok: false, error: '连续对话轮次无效' }
  }
  if (voiceTurn && (!loadSettings().voiceConversation || !loadSettings().continuousVoice)) {
    return { ok: false, error: '连续对话选项已关闭' }
  }
  // 真正走文档、斜杠或专家路径时退出连续对话，不让文档自身的逐段推进被续听打断。
  // 只含"讲/说说"这类动词但没对上文档的普通问句仍按连续对话处理。
  const exclude = () => {
    if (voiceTurn) sendToRenderer('voice-turn-complete', { ...voiceTurn, outcome: 'excluded' })
    else sendToRenderer('voice-conversation-stop', null)
    voiceTurn = undefined
  }
  if (assistantId || docTalk || command.text.trim().startsWith('/')
    || /^(继续讲解|接着讲|继续讲|停止讲解|暂停讲解|结束讲解)/u.test(command.text.trim())) exclude()
  if (command.text.trim().startsWith('/')) return bridge.sessionCommand({ ...command, voiceTurn: undefined, spoken: false })
  const current = () => command.bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
  const text = command.text.trim().replace(/[。！!，,\s]+$/u, '')
  let local: ChatReply | null = null
  if (!assistantId) {
    if (text === '继续' && docTalk !== null && interruptedChat && interruptedSpeech !== null) {
      // 两件事都停在半路：讲解和刚才的回答。只有一件时才替用户接着做。
      local = { ok: true, reply: `有两件被打断的事：《${docTalk.name}》的讲解，和刚才的回答。说“继续讲解”接着讲文档，说“接着说”继续刚才的回答。` }
    } else if (/^(继续讲解|接着讲|继续讲)$/.test(text) || (text === '继续' && docTalk !== null)) {
      interruptedChat = false
      local = await resumeDocTalk(command.spoken === true)
    } else if (/^(停止讲解|暂停讲解|结束讲解)$/.test(text) || (text === '停一下' && docTalk !== null)) {
      interruptSpeech()
      if (text === '结束讲解') stopDocTalk()
      pushDocState()
      local = { ok: true, reply: text === '结束讲解' ? '已结束讲解。' : '已暂停讲解并保留位置。' }
    } else if (mentionsDocs(text)) {
      const intent = detectDocIntent(text, await docCandidates())
      if (!current()) return { ok: false, error: '会话已改变，文档请求未继续执行' }
      if (intent.kind !== 'none') exclude()
      // 点名 WPS 就按指定应用处理；WPS 不可用时如实说明，不悄悄换成系统关联或阅读视图。
      const viaWps = /wps/iu.test(text)
      if (intent.kind === 'open') local = viaWps ? await openDocInWps(intent.mention.file.name) : await openDocByName(intent.mention.file.name)
      if (intent.kind === 'explain') {
        // 语音发起的讲解直接开讲；打字发起时按“朗读回复”设置决定是否出声（用户明确打开过就该念）。
        // 不出声时仍要打开文档面板：否则用户只看到一句提纲，既没有文档也没有讲解入口。
        const wantSpeak = command.spoken === true || loadSettings().readReplies === true
        local = await explainDocByName(intent.mention.file.name, 0, wantSpeak, undefined, viaWps ? 'wps' : 'reading')
        if (local.ok && viaWps && !wantSpeak) {
          const shown = await openDocInWps(intent.mention.file.name)
          local = { ...local, reply: `${local.reply ?? ''}\n${shown.ok ? shown.reply ?? '' : shown.error ?? ''}` }
        }
        if (local.ok && command.spoken !== true) {
          // PDF 在出声时会由阅读视图显示；不出声或其他格式没有视图，至少把文档面板打开。
          if (!wantSpeak || !isPdfName(intent.mention.file.name)) sendToRenderer('settings-open', 'doc')
        }
      }
      // 文档结果属于对话：展开会话框把这件事说出来；不出声时上面已把文档面板一起打开。
      if (local?.ok && current()) sendToRenderer('summon', null)
    } else if (mentionsMeetingMinutes(text)) {
      // 「总结会议纪要」直接触发模型纪要，不必再手动去会议页点按钮。
      // 数据外发仍然要过原生对话框确认（授权不能由语音口令替代），这里只负责把流程跑起来。
      exclude()
      local = await summarizeMeetingByVoice()
      if (current()) sendToRenderer('summon', null)
    }
    if (!local && docTalk && /[？?]|什么|怎么|为什么|如何|哪|吗|呢|多少|是不是|能不能|这段|这里|这句|这个|刚才/u.test(text)) {
      const talk = docTalk
      local = await askAboutDoc(talk.path, talk.next, command.text, undefined, command.spoken === true)
    }
  }
  if (!current()) return { ok: false, error: '会话已改变，请核对原会话的操作结果' }
  if (local) {
    if (local.reply) sendToRenderer('doc-notice', local.reply)
    return { ...local, notice: local.reply?.split('\n')[0] }
  }
  // 朗读回复打开时，打字发出的消息也把回答念出来（原来只有语音发起的那一轮会念）。
  const readReplies = loadSettings().readReplies === true
  if (command.spoken || assistantId || readReplies) {
    return sendChatReply(command.text, command.bindingId, command.spoken === true || readReplies, assistantId, voiceTurn)
  }
  interruptSpeech()
  return bridge.sessionCommand({ ...command, text: withInterruptedSpeech(command.text), spoken: false })
}

function registerIpc(): void {
  meetingRecorder = createMeetingRecorder({
    userDataDir: app.getPath('userData'),
    audio: applyAudio,
    notifyRenderer: (channel: string, payload: unknown) => {
      // 会议开始：先把会议麦克风轨的授权（令牌 = 会议 id）下发，再通知渲染层开采 —— 顺序反了它订阅不上。
      if (channel === 'meeting-started' && payload !== null && typeof payload === 'object'
        && typeof (payload as { meetingId?: unknown }).meetingId === 'string') {
        meetingGrantId = (payload as { meetingId: string }).meetingId
        pushAudioGrants()
      }
      sendToRenderer(channel, payload)
      if (channel === 'meeting-state-changed' || channel === 'meeting-started') reportPetState()
    },
    // 密钥包装手段按平台分派（`dpapi.ts`）：Windows 走 DPAPI，macOS/Linux 走 safeStorage。
    // 这里把 safeStorage 递进去 —— dpapi.ts 自己不许 import electron（要能被 node --test 导入）。
    storeDeps: { dpapi: { safeStorage } },
    // 纪要草稿经当前会话的模型生成。会议文字会进入该会话的上下文与历史：这一点写进授权说明，由用户决定。
    summarize: (prompt, signal) => bridge.chat(prompt, undefined, signal, undefined, sessionState?.bindingId),
    // 数据去向授权只走主进程原生对话框：用户在会议页点按钮后才会被调用，模型够不到这条路。
    confirmEgress: async summary => {
      try {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: '发送会议文字给模型？',
          message: '用模型生成会议纪要需要发送会议文字',
          detail: `${summary}\n\n这些文字会进入当前 dsh 会话的对话历史。`,
          buttons: ['同意发送', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        return response === 0
      } catch {
        return false
      }
    },
    egressTarget: '当前 dsh 会话所用的模型服务商',
  })
  registerMeetingIpc({ ipc: ipcMain, recorder: meetingRecorder })

  /**
   * 系统音频（会议里的"对方的声音"）现在能不能采。
   *
   * 渲染层在开会前问一次，拿不到就不去尝试 —— 无权限时反复调 `getDisplayMedia` 只会
   * 一次次被拒，日志刷满而用户什么也得不到；更糟的是循环重试会让人误以为"等一会儿就好了"。
   *
   * **麦克风权限与系统音频权限是两件事**（macOS 上尤其明显：前者在"麦克风"页，
   * 后者在"屏幕与系统录音"页）。所以这里只回答后者，麦克风由 `getUserMedia` 自己报。
   */
  ipcMain.handle('meeting-loopback-capability', () => {
    const platform = platformOf()
    let screenAccess = 'unknown'
    if (platform === 'darwin') {
      try {
        // Electron 里屏幕采集状态就用 'screen' 这个 key（没有单独的"系统音频"项）。
        screenAccess = systemPreferences.getMediaAccessStatus('screen')
      } catch {
        // 读不到就当未知：放行去试，真拿不到时渲染层会如实上报缺失。
        screenAccess = 'unknown'
      }
    }
    return loopbackCapability(platform, screenAccess)
  })

  // ===== 外部证据收件（M3-03 / M4-06 后续）=====
  //
  // 两件事共用一套流程：取内容 → 原生对话框确认（显示真实正文预览）→ 上报插件。
  // 编排在 `evidence-intake.ts` 里，这里只负责把"读窗口""取纪要""弹框""上报"接上真东西。
  //
  // Windows 的动作辅助进程按需创建：只有用了「记录当前窗口」才会拉起，
  // 平时不为了一个可能用不到的功能常驻一个 PowerShell。
  let evidenceActions: WinDesktopActions | null = null
  const readForegroundForEvidence = async (): Promise<{ ok: true; text: string; title: string } | { ok: false; error: string }> => {
    if (platformOf() !== 'win32') {
      // 诚实说明做不到，而不是给一个点了没反应的按钮。
      return {
        ok: false,
        error: 'macOS 上还没有实现「记录当前窗口」：系统需要按应用逐个适配辅助功能接口，这部分代码未完成。可以先在会话里让助理读取项目文件作为证据',
      }
    }
    try {
      evidenceActions ??= createWinActions({ scriptDir: layout.scriptDir })
      const result = await evidenceActions.readForegroundText({
        authorized: true,
        reason: '用户主动要求把当前窗口内容记为工作证据',
        maxChars: 20_000,
      })
      if (!result.ok) return { ok: false, error: `读不到当前窗口：${result.error.message}` }
      return { ok: true, text: result.value.text, title: result.value.identity.title || '（无标题窗口）' }
    } catch (error) {
      return { ok: false, error: `读取当前窗口失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const evidenceDeps: EvidenceIntakeDeps = {
    confirm: async (view: EvidenceConfirmView): Promise<boolean> => {
      // 用主进程原生对话框：渲染层弹的框可以被页面自己的样式伪装，
      // 而"这段文字要不要交出去"必须由不可伪造的一方来问。
      const detail = [
        view.kind === 'meeting_minutes' ? `会议：${view.title}` : `窗口：${view.title}`,
        `内容：${view.sizeText}`,
        '',
        '将记下的内容（开头部分）：',
        view.preview,
        '',
        `去向：${view.destination}`,
      ].join('\n')
      const choice = await dialog.showMessageBox({
        type: 'question',
        buttons: ['取消', view.confirmLabel],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '记为工作证据',
        message: view.kind === 'meeting_minutes' ? '把这场会议的纪要交给个人助理？' : '把这段窗口文字记为工作证据？',
        detail,
      })
      return choice.response === 1
    },
    post: (request: EvidenceIntakeRequest) => bridge.postEvidenceIntake(request),
    readWindowText: readForegroundForEvidence,
    exportMinutes: async (meetingId: string) => {
      const recorder = meetingRecorder
      if (!recorder) return { ok: false as const, error: '会议库还没就绪' }
      const exported = recorder.exportMinutes(meetingId)
      return exported.ok
        ? { ok: true as const, content: exported.content, digest: exported.digest, confirmedAt: exported.confirmedAt }
        : { ok: false as const, error: exported.error }
    },
    meetingName: async (meetingId: string) => meetingRecorder?.meetingName(meetingId) ?? null,
    now: () => Date.now(),
  }

  ipcMain.handle('evidence-intake-minutes', (_event, meetingId: unknown): Promise<EvidenceIntakeOutcome> => {
    if (typeof meetingId !== 'string' || meetingId.trim() === '') {
      return Promise.resolve({ ok: false, error: '缺少会议编号' })
    }
    return intakeMinutes(meetingId, evidenceDeps)
  })

  ipcMain.handle('evidence-intake-window', (): Promise<EvidenceIntakeOutcome> => intakeWindow(evidenceDeps))

  meetingRecorder.sweepRetention()
  setInterval(() => meetingRecorder?.sweepRetention(), 6 * 3_600_000).unref()

  // 用户自配的 TTS / 语音识别服务。密钥用系统密钥库（DPAPI）加密落盘；页面永远拿不到密钥本体。
  voiceApiStore = new VoiceApiStore(path.join(app.getPath('userData'), 'voice-apis.json'), {
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，无法保存 API 密钥')
      return safeStorage.encryptString(value)
    },
    decrypt: (value: Buffer) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，无法读取已保存的 API 密钥')
      return safeStorage.decryptString(value)
    },
  })
  const apis = voiceApiStore
  const voiceApiCall = (fn: () => VoiceApiState): VoiceApiResult => {
    try {
      return { ok: true, state: fn() }
    } catch (error) {
      // 配置文件损坏、密钥解不开都走这里：如实说，不静默清空用户存过的东西。
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  ipcMain.handle('voice-api-state', () => voiceApiCall(() => apis.snapshot()))
  ipcMain.handle('voice-api-save', (_event, input: unknown) => voiceApiCall(() => apis.save(input)))
  ipcMain.handle('voice-api-remove', (_event, id: unknown) => voiceApiCall(() => apis.remove(id)))
  ipcMain.handle('voice-api-select', (_event, kind: unknown, id: unknown) => voiceApiCall(() => apis.select(kind as VoiceApiKind, id)))

  // ===== 首次使用检查（M5-06 界面部分）=====
  //
  // 主进程只做"查"和"在用户确认后执行"，不主动下载、不主动申请权限：每一个会改动系统设置
  // 或写盘的动作用户都要在界面上点一次（`firstRunReport` 里的 nextSteps 就是那些入口）。
  //
  // fetch 用 Electron 的 `net.fetch` 而不是全局 fetch：它走系统代理设置，公司网络下这是
  // 唯一能通的那条路。注意它只在 app ready 之后可用 —— 这个 handler 只在用户点开检查时才调。
  const firstRun = new FirstRunService({
    userDataDir: app.getPath('userData'),
    platform: platformOf(),
    layout,
    dshHome: dshHome(),
    profile: () => loadSettings().runtimeProfile || 'web',
    mediaAccess: () => {
      try {
        return systemPreferences.getMediaAccessStatus('microphone') as MediaAccessStatus
      } catch {
        // Windows 上这个接口对 microphone 也返回结果，但旧版本可能抛错 —— 读不到就如实说读不到。
        return 'unknown'
      }
    },
    macPermissions: async () => {
      if (platformOf() !== 'darwin') return {}
      const status = await createMacActions({}).checkPermissions()
      // 探测本身失败时返回 unknown，而不是把"没查成"说成"没授权"。
      return status.ok ? status.value : {}
    },
    voiceApi: () => {
      // 「用户在设置里自配了自建服务」看的是选中的那一项，不是有没有配过别的。
      // 存储可能还没建起来（装配顺序），那就按"没有自配"算 —— 报告里会显示走默认云端朗读。
      const state = voiceApiStore?.snapshot()
      return { asr: state?.selected.asr != null, tts: state?.selected.tts != null }
    },
    mirror: () => loadSettings().modelMirror ?? null,
    fetchImpl: (url, init) => net.fetch(url, init),
  })

  ipcMain.handle('first-run-report', async () => {
    try {
      const snapshot = await firstRun.snapshot()
      return {
        ok: true as const,
        report: snapshot.report,
        plan: snapshot.plan ? toPlanView(snapshot.plan) : null,
        planError: snapshot.planError,
        modelRoot: snapshot.modelRoot,
        modelCheckTimedOut: snapshot.modelCheckTimedOut,
      }
    } catch (error) {
      // 检查失败（磁盘、权限）如实回报，界面可以给"重试"；不要把异常吞成一份"全部就绪"的报告。
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('first-run-download', async (_event, confirmation: unknown) => {
    if (!confirmation || typeof confirmation !== 'object') {
      return { ok: false as const, error: '缺少下载确认信息' }
    }
    const raw = confirmation as Partial<DownloadConfirmation>
    if (typeof raw.modelId !== 'string' || typeof raw.url !== 'string' || typeof raw.destinationDir !== 'string') {
      return { ok: false as const, error: '下载确认信息不完整' }
    }
    try {
      const outcome = await firstRun.download({
        modelId: raw.modelId as DownloadConfirmation['modelId'],
        url: raw.url,
        destinationDir: raw.destinationDir,
      })
      return { ok: true as const, outcome }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 打开系统隐私设置页。只接受白名单目标，URI 在主进程拼：
   * 渲染层不该有能力让主进程打开任意地址。
   */
  ipcMain.handle('first-run-open-settings', async (_event, target: unknown) => {
    if (target !== 'microphone') return { ok: false as const, error: '只支持打开麦克风权限设置页' }
    const uri = settingsUri(platformOf(), 'microphone')
    if (uri === null) return { ok: false as const, error: '这个平台没有可打开的设置页' }
    try {
      // openExternal 对 URI scheme 会走系统关联；失败时它 reject（返回 void 的那个 openPath 才用返回值）。
      await shell.openExternal(uri)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on('mouse-state', (_event, interactive: boolean) => {
    if (!win || ignoreMouse === !interactive) return
    ignoreMouse = !interactive
    if (interactive) {
      win.setIgnoreMouseEvents(false)
    } else {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  ipcMain.handle('get-state', async (event, includeOperations?: unknown) => {
    const settings = loadSettings()
    const activity = includeOperations === true && stageSender(event) ? await bridge.getActivityState() : null
    const meeting = meetingRecorder?.getState()
    return {
      operations: {
        connection: sessionState && sessionState.status !== 'disconnected' ? 'connected' : 'disconnected',
        listener: audioState.holder === 'wake' ? 'wake-requested'
          : audioState.holder === 'barge-in' ? 'dictation'
          : audioState.holder ?? (audioState.wakeUnavailable ? 'unavailable' : 'idle'),
        activity,
        meeting: meeting ? (meeting.stopping ? 'stopping' : meeting.recording ? 'recording' : meeting.transcribe) : null,
        speaking: narrator.isSpeaking(),
        execution: sessionState?.status === 'disconnected' ? 'unknown' : sessionState?.status ?? 'unknown',
      },
      pet: settings.pet,
      voiceConversation: settings.voiceConversation === true,
      continuousVoice: settings.continuousVoice === true,
      readReplies: settings.readReplies === true,
      bounds: settings.bounds,
      positions: settings.positions,
      characters: settings.characters,
      layoutVersion: settings.layoutVersion,
      idleSleepMinutes: settings.idleSleepMinutes,
      sleepMinutes: settings.sleepMinutes,
      chatDock: settings.chatDock ?? 'top',
      chatSize: settings.chatSize,
    }
  })

  ipcMain.handle(
    'save-settings',
    (_event, patch: { bounds?: { x: number; y: number }; positions?: Record<string, { x: number; y: number }>; voiceConversation?: boolean; continuousVoice?: boolean; readReplies?: boolean; idleSleepMinutes?: number; sleepMinutes?: number; chatDock?: 'top' | 'auto'; chatSize?: { width: number; height: number } }) => {
      if (!patch || typeof patch !== 'object') return { ok: false }
      // 设置只接受明确的整数分钟；不让无效输入被默默保存成默认值。
      for (const key of ['idleSleepMinutes', 'sleepMinutes'] as const) {
        if (!(key in patch)) continue
        const value = patch[key]
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120) return { ok: false }
      }
      const chatSize = patch.chatSize
      if (chatSize !== undefined && (!chatSize || !Number.isFinite(chatSize.width) || !Number.isFinite(chatSize.height))) {
        return { ok: false }
      }
      saveSettings({
        ...(patch.bounds ? { bounds: patch.bounds } : {}),
        ...(patch.positions ? { positions: patch.positions } : {}),
        ...(typeof patch.voiceConversation === 'boolean' ? { voiceConversation: patch.voiceConversation } : {}),
        ...(typeof patch.continuousVoice === 'boolean' ? { continuousVoice: patch.continuousVoice } : {}),
        ...(typeof patch.readReplies === 'boolean' ? { readReplies: patch.readReplies } : {}),
        ...(patch.idleSleepMinutes !== undefined ? { idleSleepMinutes: patch.idleSleepMinutes } : {}),
        ...(patch.sleepMinutes !== undefined ? { sleepMinutes: patch.sleepMinutes } : {}),
        ...(patch.chatDock === 'top' || patch.chatDock === 'auto' ? { chatDock: patch.chatDock } : {}),
        ...(chatSize ? { chatSize } : {}),
      })
      if (patch.voiceConversation === false || patch.continuousVoice === false) {
        sendToRenderer('voice-conversation-stop', null)
        if (spokenRound?.voiceTurn) interruptSpeech()
      }
      return { ok: true }
    },
  )

  // 退场动画播完：渲染层确认可以退出
  ipcMain.on('exit-done', () => {
    if (exitFallbackTimer) {
      clearTimeout(exitFallbackTimer)
      exitFallbackTimer = null
    }
    app.quit()
  })

  ipcMain.on('context-menu', (event, target: unknown) => {
    if (!win || !stageSender(event)) return
    contextMenuOpen = true
    buildContextMenu(menuTargetOf(target)).popup({ window: win, callback: () => {
      contextMenuOpen = false
      dismissAfter = Date.now()
    } })
  })

  ipcMain.on('overlay-state', (event, value: unknown) => {
    if (!stageSender(event) || !value || typeof value !== 'object') return
    const state = value as { open?: unknown; boxes?: unknown; settingsOpen?: unknown }
    if (typeof state.open !== 'boolean' || typeof state.settingsOpen !== 'boolean' || !validBoxes(state.boxes)) return
    const changed = overlayOpen !== state.open || managementOpen !== state.settingsOpen
    if (state.open && !overlayOpen) dismissAfter = Date.now()
    overlayOpen = state.open
    managementOpen = state.settingsOpen
    overlayBoxes = state.boxes
    if (changed) {
      setPointerWatch(overlayOpen || managementOpen)
      win?.webContents.setBackgroundThrottling(!overlayOpen && !managementOpen)
    }
  })

  ipcMain.handle('session-get', async (event, beforeSeq?: unknown, bindingId?: unknown): Promise<SessionResult> => {
    if (!stageSender(event)) return { ok: false, error: '会话请求来源无效' }
    if (beforeSeq !== undefined && (typeof beforeSeq !== 'number' || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      return { ok: false, error: '历史位置无效' }
    }
    if (bindingId !== undefined && typeof bindingId !== 'string') return { ok: false, error: '会话绑定无效' }
    const revision = sessionRevision
    const result = await bridge.getSession(beforeSeq as number | undefined, bindingId as string | undefined)
    if (beforeSeq === undefined && result.state && revision === sessionRevision) acceptSession({ ...result.state, reset: true })
    return result
  })

  ipcMain.handle('session-command', async (event, value: unknown): Promise<SessionResult> => {
    if (!stageSender(event) || !isSessionCommand(value)) return { ok: false, error: '会话操作参数或来源无效' }
    if (!sessionState || value.bindingId !== sessionState.bindingId) return { ok: false, error: '会话已改变，请重新同步后操作' }
    submissionCount += 1
    try {
      const result = value.kind === 'prompt'
        ? await dispatchPrompt(value)
        : value.kind === 'cancel'
          ? await cancelCommand(value)
          : await bridge.sessionCommand(value)
      if (value.bindingId !== sessionState?.bindingId) return { ok: false, error: '会话已改变，请核对原会话的操作结果' }
      if (result.state?.bindingId === value.bindingId) acceptSession(result.state)
      return result
    } finally {
      submissionCount -= 1
      dismissAfter = Date.now()
    }
  })

  ipcMain.handle('chat-send', async (event, text: unknown, assistantId?: unknown, spoken?: unknown) => {
    const command = { kind: 'prompt', bindingId: sessionState?.bindingId, text, spoken }
    if (!stageSender(event) || !isSessionCommand(command) || command.kind !== 'prompt'
      || (assistantId !== undefined && (typeof assistantId !== 'string' || assistantId.length > 256))) {
      return { ok: false, error: '对话参数或来源无效' }
    }
    submissionCount += 1
    try {
      return await dispatchPrompt(command, typeof assistantId === 'string' && assistantId ? assistantId : undefined)
    } finally {
      submissionCount -= 1
      dismissAfter = Date.now()
    }
  })

  ipcMain.on('speech-stop', () => {
    interruptSpeech()
    pushDocState()
  })

  /**
   * 只在本机说一句话：不进会话、不调模型。
   *
   * 用于"用户又只喊了一句名字"这种本地应答 —— 它只是确认"我听见了"，
   * 没有任何需要模型参与的内容；塞进会话就等于凭空多出一条用户消息。
   */
  ipcMain.on('speech-local', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 200) return
    void speakWakeGreeting(text.trim())
  })

  // 主动提醒的用户选择（design.md §2.7）。白名单之外的一律丢掉：
  // 这个通道只改提醒节奏，别让它变成一个能把任意字符串发给桥接的洞。
  ipcMain.on('proactive-respond', (_event, kind: unknown) => {
    if (kind === 'accept' || kind === 'decline' || kind === 'disable' || kind === 'enable') {
      void bridge.respondProactive(kind)
    }
  })

  // ===== 文档面板（design.md §2.10） =====
  //
  // 面板上来的路径一律重新过一遍授权判断（DocumentLibrary 的 open/reveal 内部就做了）：
  // 界面上点过是用户点的，IPC 上来的一个字符串不是证据（§2.11："不能伪造 UI 批准"同理）。

  ipcMain.handle('doc-roots', () => docRootsPayload())

  ipcMain.handle('doc-add-root', async () => {
    const picked = await pickDirectory()
    if (picked !== null) addDocRoot(picked)
    docCandidatesAt = 0
    docCandidatesCache = []
    return docRootsPayload()
  })

  ipcMain.handle('doc-remove-root', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') {
      removeDocRoot(target)
      interruptSpeech()
      pushDocState()
      docCandidatesAt = 0
      docCandidatesCache = []
      // 撤销授权当场重查阅读视图里那份文档：不在范围内就停，不等下一次翻页才发现。
      void docView.recheck()
      void wpsView.recheck()
    }
    return docRootsPayload()
  })

  // 最近目录是"打开成功"自动加进查找范围的，用户没点过头，所以也得能撤。
  ipcMain.handle('doc-forget-dir', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') {
      forgetDocDir(target)
      interruptSpeech()
      pushDocState()
      docCandidatesAt = 0
      docCandidatesCache = []
      void docView.recheck()
      void wpsView.recheck()
    }
    return docRootsPayload()
  })

  ipcMain.handle('doc-open', async (_event, target: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    return openDocByPath(target)
  })

  ipcMain.handle('doc-explain', async (_event, target: unknown, from: unknown, speak: unknown, assistantId: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    const who = typeof assistantId === 'string' && assistantId ? assistantId : undefined
    // 提纲是点名 WPS 要来的，就在面板上点"开始讲"时仍跟随 WPS，不悄悄换成阅读视图。
    const via = docTalk !== null && docTalk.path === target ? docTalk.via : 'reading'
    // 段号来自界面上点的那一条，无效就如实拒绝，不夹到别的段去讲。
    return explainDocByPath(target, typeof from === 'number' ? from : 0, speak !== false, who, true, via)
  })

  /**
   * 就某一段追问。
   *
   * 段号来自界面上点的那一条，不从消息里猜 —— 猜错就是把另一段的原文塞给模型，然后让它
   * 一本正经地答非所问。
   */
  ipcMain.handle('doc-ask', async (_event, target: unknown, index: unknown, question: unknown, assistantId: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    if (typeof question !== 'string' || question.trim() === '') return { ok: false, error: '还没有要问的内容' }
    const who = typeof assistantId === 'string' && assistantId ? assistantId : undefined
    return askAboutDoc(target, typeof index === 'number' ? index : 0, question.trim(), who)
  })

  ipcMain.handle('team-get', async () => {
    try {
      return await bridge.getTeam()
    } catch {
      return null
    }
  })

  // 舞台不再有"直接批准"这条通道：它只能请求打开专用审批窗口。
  // approval-open / approval-card-read / approval-card-decide / approval-card-close
  // 都在 ApprovalWindow 里注册，回执核验也在那边（checkSender）。
  approvals.registerIpc()
  reportWorkbench = registerReportWorkbench({ openApproval: id => approvals.request(id) })
  ipcMain.handle('report-workbench-open', event => {
    if (!stageSender(event)) return { ok: false }
    reportWorkbench?.open()
    return { ok: true }
  })
  // 阅读视图的五条通道（会话/字节/页许可/资源/回报）都在控制器里注册并核对发送方。
  docView.registerIpc()
  wpsView.registerIpc()

  ipcMain.handle('runtime-start', async (_event, profile?: unknown) => {
    if (!host) return { ok: false }
    await host.startRuntime(typeof profile === 'string' && profile ? profile : undefined)
    return { ok: true }
  })

  ipcMain.handle('session-start', async (event): Promise<SessionResult & { outcome?: string }> => {
    if (!stageSender(event)) return { ok: false, error: '会话操作来源无效' }
    return startAssistantSession()
  })

  ipcMain.handle('runtime-stop', async () => {
    if (!host) return { ok: false }
    await host.stopOwnRuntime()
    return { ok: true }
  })

  ipcMain.on('stage-set-visible', (_event, visible: unknown) => {
    host?.setStageVisible(visible === true)
  })

  ipcMain.on('stage-set-focus', (_event, on: unknown) => {
    host?.setFocusMode(on === true)
  })

  // 演示隐私模式（M5-05）：只改"渲染哪些历史与预览"，不动麦克风、不动窗口、不动专注模式。
  // 演示时用户往往还要讲解、还要插话，把它们一起掐掉就成了"关掉宠物"。
  ipcMain.on('presentation-mode', (_event, on: unknown) => {
    host?.setPresentationMode(on === true)
  })

  // 听写拆成两拍：begin 只做麦克风仲裁（渲染层录音时唤醒监听已停），transcribe 收 wav
  // 去识别并在收尾时归还麦克风。识别期间录音已结束，不占设备。
  // 保险丝：听写被授予后 120 秒没收尾就强制释放——渲染层任何 bug 都不该把麦克风
  // 永久锁死，那之后用户看到的会是每一次点击都被拒（仲裁器的"这一次听完再按"）。
  let dictationSafety: NodeJS.Timeout | null = null
  const armDictationSafety = (): void => {
    if (dictationSafety) clearTimeout(dictationSafety)
    dictationSafety = setTimeout(() => {
      dictationSafety = null
      streamSession = null
      applyAudio({ type: 'dictation-finished' })
    }, 120_000)
    dictationSafety.unref()
  }
  const disarmDictationSafety = (): void => {
    if (dictationSafety) {
      clearTimeout(dictationSafety)
      dictationSafety = null
    }
  }

  /** 本场流式听写的识别会话；null = 整句模式或未开始。 */
  let streamSession: StreamingSession | null = null

  /**
   * 听写转写：用户挑了自定义识别服务就把这段音频送到那里，没挑走本地识别。
   *
   * 会议转写不走这条路 —— 会议音频承诺只留在这台机器上，要送到别处得先让用户重新知情，
   * 不能因为顺手复用一个函数就悄悄改变了承诺。
   */
  const transcribeDictation = async (wav: ArrayBuffer, onDelta?: (text: string) => void): Promise<{ ok: boolean; text?: string; error?: string }> => {
    try {
      const api = voiceApiStore?.resolve('asr') ?? null
      return api ? await transcribeApi(api, wav, undefined, onDelta) : await transcribeWav(wav, app.getPath('userData'))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  ipcMain.handle('asr-begin', () => {
    const granted = applyAudio({ type: 'dictation-requested' })
    if (granted.denied) return { ok: false, error: granted.denied }
    armDictationSafety()
    // 用户挑的自定义服务是"整段上传"的接口，没有实时部分文本：这时不开本地流式会话。
    let apiAsr: ResolvedVoiceApi | null = null
    try {
      apiAsr = voiceApiStore?.resolve('asr') ?? null
    } catch (error) {
      applyAudio({ type: 'dictation-finished' })
      disarmDictationSafety()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // 流式模型装了就开一场会话：渲染层逐帧送 PCM，识别文本实时回显输入框。
    let streaming = false
    try {
      if (apiAsr === null && streamingAvailable(app.getPath('userData'))) {
        streamSession = createStreamingSession(app.getPath('userData'))
        streaming = true
      }
    } catch (error) {
      console.log('[dsh-pet] 流式识别器创建失败，退回整句识别：', error instanceof Error ? error.message : error)
      streamSession = null
      streaming = false
    }
    return { ok: true, streaming }
  })

  /** 流式喂数：帧 PCM 进识别器，返回当前累积文本（渲染层实时回显）。 */
  ipcMain.handle('asr-stream-feed', (_event, chunkB64: unknown) => {
    if (!streamSession || typeof chunkB64 !== 'string' || chunkB64.length === 0) return { text: '' }
    try {
      return { text: streamSession.feed(pcm16Base64ToFloat32(chunkB64)) }
    } catch (error) {
      console.log('[dsh-pet] 流式喂数失败：', error instanceof Error ? error.message : error)
      return { text: '' }
    }
  })

  ipcMain.handle('asr-stream-stop', () => {
    const session = streamSession
    streamSession = null
    disarmDictationSafety()
    applyAudio({ type: 'dictation-finished' })
    if (!session) return { ok: false, text: '' }
    try {
      return { ok: true, text: session.finalize() }
    } catch (error) {
      console.log('[dsh-pet] 流式收尾失败：', error instanceof Error ? error.message : error)
      return { ok: false, text: '' }
    }
  })

  ipcMain.handle('asr-transcribe', (_event, wav: unknown) => {
    // preload 把 wav 编成 base64 传过来（ArrayBuffer 穿不过 contextBridge）。
    if (typeof wav !== 'string' || wav.length === 0) {
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
      return { ok: false, error: '没有听到说话内容' }
    }
    const buffer = Buffer.from(wav, 'base64')
    if (buffer.length === 0) {
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
      return { ok: false, error: '没有听到说话内容' }
    }
    return transcribeDictation(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      (text) => sendToRenderer('asr-delta', { text }),
    ).finally(() => {
      // 超时与正常结束都可能走到这里，仲裁器对重复收尾是幂等的。
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
    })
  })

  // 听写回退：渲染层 Web Audio 录不了时（页面拿不到麦克风接口、音频回调不来等），
  // 主进程录固定窗口，再走同一条转写链路。仲裁的申请与归还都在这条里完成。
  //
  // 录音命令按平台分派：Windows 用 MCI（record.ps1），其他系统上 `recordAudioSpec` 返回 null，
  // 这条回退就如实不可用 —— 不假装录了。主路径（渲染层 getUserMedia）在 macOS 上是通的，
  // 所以这只影响"浏览器音频接口也拿不到"的边角情况。
  ipcMain.handle('asr-record-fallback', async () => {
    const granted = applyAudio({ type: 'dictation-requested' })
    if (granted.denied) return { ok: false, error: granted.denied }
    armDictationSafety()
    const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-dic-'))
    const wavPath = path.join(tmp, 'dictation.wav')
    try {
      const spec = recordAudioSpec(platformOf(), layout.scriptDir, wavPath, 12000)
      if (spec === null) return { ok: false, error: '这个系统上还没有录音回退实现，请检查麦克风权限后重试' }
      const code = await new Promise<number>((resolve) => {
        const child = spawn(spec.command, [...spec.args], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
        child.on('error', () => resolve(-1))
        child.on('exit', (exitCode) => resolve(exitCode ?? -1))
      })
      if (code !== 0 || !existsSync(wavPath)) return { ok: false, error: '录音失败：麦克风可能被占用或不可用' }
      const wav = readFileSync(wavPath)
      return await transcribeDictation(
        wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      )
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ }
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
    }
  })

  registerAudioIpc()

  ipcMain.handle('open-report-dir', async () => {
    const reportDir = path.join(dshHome(), 'personal-assistant', 'reports')
    await shell.openPath(reportDir)
    return { ok: true }
  })
}

/** 设置页上"常驻与语音"一节的实际状态。 */
function residencyState(): import('../renderer/types.js').ResidencyState {
  const prefs = audioPrefs()
  const platform = platformOf()
  return {
    platform,
    trayResident: loadSettings().trayResident === true,
    wake: {
      enabled: prefs.wakeEnabled,
      engine: prefs.wakeEngine,
      engines: [...wakeEngines(platform)],
      listening: audioState.holder === 'wake',
      problem: prefs.wakeEnabled ? (audioState.wakeUnavailable ? (wakeProblem ?? '唤醒监听不可用') : wakeProblem) : null,
      kwsVerified: kwsWakeDeviceVerified(platform),
    },
    launchAtLogin: { enabled: prefs.launchAtLogin, supported: loginItemSpec(platform, false, { isPackaged: true, execPath: '', appPath: '' }) !== null },
    bargeIn: { enabled: prefs.bargeIn, problem: prefs.bargeIn ? bargeProblem : null, lastMetrics: bargeMetrics.slice(-10) },
    holder: audioState.holder,
  }
}

/**
 * 共享采集 / 唤醒 / 插话 / 常驻开关的 IPC（M1-02、M1-03、M1-05）。
 * 渲染层发来的每一条都先核对来源是舞台窗口：别的窗口（审批卡、阅读视图）不该能喂麦克风数据或改开关。
 */
function registerAudioIpc(): void {
  const fromStage = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => stageSender(event)

  ipcMain.handle('audio-sync', event => (fromStage(event) ? audioGrants() : { dictation: false, bargeIn: false, kws: false, meetingId: null, autoGainControl: true }))

  ipcMain.on('kws-feed', (event, chunk: unknown) => {
    if (!fromStage(event) || typeof chunk !== 'string' || chunk.length === 0) return
    if (audioState.holder !== 'wake' || runningWake !== 'kws') return
    kwsSession?.feed(pcm16Base64ToFloat32(chunk))
  })

  ipcMain.on('audio-consumer-lost', (event, kind: unknown, reason: unknown) => {
    if (!fromStage(event)) return
    const text = typeof reason === 'string' && reason !== '' ? reason : '麦克风采集中断'
    if (kind === 'kws') {
      if (audioState.holder === 'wake' && runningWake === 'kws') onWakeLost(text)
    } else if (kind === 'barge-in') {
      bargeProblem = text
      console.log('[dsh-pet] 插话监听中断：', text)
      if (audioState.holder === 'barge-in') applyAudio({ type: 'barge-in-finished', force: true })
    }
  })

  ipcMain.on('tts-playback-receipt', (event, receipt: unknown) => {
    if (!fromStage(event) || receipt === null || typeof receipt !== 'object') return
    const value = receipt as RendererReceipt
    if (typeof value.id !== 'string' || !['started', 'finished', 'cancelled', 'error'].includes(value.kind)) return
    rendererPlayback.receipt(value)
  })

  ipcMain.on('barge-in-detected', (event) => {
    if (!fromStage(event) || audioState.holder !== 'barge-in') return
    // 渲染层已经在本地止声（不等这里）。这里停掉整段播报（含排队的句子与还在生成的回答），
    // 把设备留给紧接着的听写；听写迟迟不来就按超时归还，不一直占着麦克风。
    applyAudio({ type: 'barge-in-detected' })
    interruptSpeech()
    if (bargeHandoverTimer) clearTimeout(bargeHandoverTimer)
    bargeHandoverTimer = setTimeout(() => {
      bargeHandoverTimer = null
      // 只在仍处于"检出后等听写"时才强制归还：听写已经接手、又开始了新一句的插话监听，就不该被这个旧定时器掐掉。
      if (audioState.holder === 'barge-in' && audioState.bargeHandover) applyAudio({ type: 'barge-in-finished', force: true })
    }, 4000)
    bargeHandoverTimer.unref()
  })

  ipcMain.on('barge-in-metrics', (event, metrics: unknown) => {
    if (!fromStage(event) || metrics === null || typeof metrics !== 'object') return
    const value = metrics as { onsetToDetectMs?: unknown; detectToSilenceMs?: unknown }
    if (typeof value.onsetToDetectMs !== 'number') return
    const entry = { onsetToDetectMs: Math.round(value.onsetToDetectMs), detectToSilenceMs: typeof value.detectToSilenceMs === 'number' ? Math.round(value.detectToSilenceMs) : null }
    bargeMetrics.push(entry)
    if (bargeMetrics.length > 50) bargeMetrics.shift()
    console.log(`[dsh-pet] 插话埋点：开口→检出 ${entry.onsetToDetectMs}ms，检出→静音 ${entry.detectToSilenceMs ?? '—'}ms`)
  })

  ipcMain.handle('residency-state', event => (fromStage(event) ? residencyState() : null))

  ipcMain.handle('residency-set', (event, raw: unknown) => {
    if (!fromStage(event)) return { ok: false, error: '设置来源无效' }
    if (raw === null || typeof raw !== 'object') return { ok: false, error: '设置格式不对' }
    const patch = raw as Record<string, unknown>
    try {
      if (typeof patch.trayResident === 'boolean') host?.setTrayResident(patch.trayResident)
      audioPrefs()
      const store = audioPrefsStore!
      const { previous, next } = store.update(patch)
      if (previous.wakeEngine !== next.wakeEngine) applyAudio({ type: 'wake-engine-changed' })
      if (previous.wakeEnabled !== next.wakeEnabled) {
        if (!next.wakeEnabled) wakeProblem = null
        applyAudio({ type: 'wake-config', enabled: next.wakeEnabled })
      }
      if (patch.retryWake === true) {
        wakeProblem = null
        applyAudio({ type: 'wake-retry' })
      }
      if (previous.bargeIn !== next.bargeIn) {
        bargeProblem = null
        pushAudioGrants()
        if (!next.bargeIn && audioState.holder === 'barge-in') applyAudio({ type: 'barge-in-finished', force: true })
      }
      // 开机自启：只在开关真的变了时碰系统登录项；关着的时候启动、读设置都不会写启动项。
      const action = loginItemAction(previous.launchAtLogin, next.launchAtLogin)
      if (action !== 'none') {
        const spec = loginItemSpec(platformOf(), action === 'enable', { isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() })
        if (spec === null) {
          store.update({ launchAtLogin: previous.launchAtLogin })
          return { ok: false, error: '这个系统上不支持开机自启', state: residencyState() }
        }
        app.setLoginItemSettings(spec)
      }
      return { ok: true, state: residencyState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), state: residencyState() }
    }
  })
}

/**
 * 平台专属的启动收尾。
 *
 * 两件事，都是"macOS 上不做就会显得很怪"的那类：
 *
 * 1. **隐藏 Dock 图标**。窗口建的时候带了 `skipTaskbar: true`，但那是 Windows/Linux 的语义；
 *    macOS 上要藏 Dock 图标得单独调 `app.dock.hide()`。一只常驻桌面的宠物在 Dock 里占一格
 *    是多余的 —— 它的入口是托盘，不是 Dock。
 * 2. **主动请求麦克风权限**。macOS 10.14+ 起，没在 Info.plist 里声明
 *    `NSMicrophoneUsageDescription` 就调 `getUserMedia` 会**被系统直接终止进程**（不是报错）。
 *    声明了之后还得让用户点一次授权，否则第一次听写会静默失败。这里提前问，
 *    把"授权"这件事发生在用户按下说话键之前。
 *
 * 两处都包了 try：Dock 隐藏失败、权限接口在旧 Electron 上不存在，都不该挡住启动。
 */
function applyPlatformWindowTweaks(): void {
  if (platformOf() !== 'darwin') return
  try {
    app.dock?.hide()
  } catch (error) {
    console.log('[dsh-pet] 隐藏 Dock 图标失败（不影响使用）:', error instanceof Error ? error.message : String(error))
  }
  void requestMicrophoneAccess()
}

/**
 * 请求麦克风权限。只在 macOS 上有意义。
 *
 * 刻意**不 await** 它：授权对话框是模态的，等它会卡住启动。用户点不点都不影响窗口先出来 ——
 * 真正要用麦克风的时候（听写 / 会议）会再走一次 `getUserMedia`，那时权限已经是明确的了。
 * 拒绝也只是让语音功能不可用，不该拖累整个壳。
 */
async function requestMicrophoneAccess(): Promise<void> {
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return
    // not-determined 才会弹系统对话框；denied 之后再调是 no-op，只能用户自己去系统设置开。
    if (status === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
  } catch (error) {
    console.log('[dsh-pet] 请求麦克风权限失败（语音功能可能不可用）:', error instanceof Error ? error.message : String(error))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
    }
  })

  void app.whenReady().then(() => {
    applyPlatformWindowTweaks()
    // 会议回环声的桌面采集授权：必须在任何 getDisplayMedia 之前注册（见函数注释）。
    configureDisplayMedia()
    registerIpc()
    createWindow()

    host = new CompanionHost(
      {
        onState: state => sendToRenderer('companion-state', state),
        onStageVisible: applyStageVisible,
        // 会议里不该让唤醒词把参会者的话当指令，所以专注模式要能掐掉唤醒监听。
        onFocusMode: on => {
          petFocusMode = on
          reportPetState()
          applyAudio({ type: 'focus', on })
        },
        onRetryWake: () => applyAudio({ type: 'wake-retry' }),
        onExit: () => requestPetExit(),
        readSettings: () => {
          const settings = loadSettings()
          return { trayResident: settings.trayResident, runtimeProfile: settings.runtimeProfile }
        },
        saveSettings: patch => {
          saveSettings(patch)
        },
      },
      { mainDir: here, dshHome: dshHome(), instanceId: randomUUID(), layout },
    )
    host.start()

    // 全局快捷键：任何时候按下都唤起输入框。
    //
    // 修饰键按平台挑：macOS 上 `CommandOrControl` 会映射成 **Ctrl**，而 Mac 用户的手指
    // 记的是 Cmd —— 给一个 Ctrl+Option+P 的组合，等于给了个没人会按的快捷键。
    // 所以 macOS 上直接用 `Command`，Windows/Linux 上仍走 `CommandOrControl`。
    // 主选被占用时退到空格那一组；两组都占不到就静默放弃（托盘与角色点击仍可用）。
    const primary = platformOf() === 'darwin' ? 'Command+Alt+P' : 'CommandOrControl+Alt+P'
    const fallback = platformOf() === 'darwin' ? 'Command+Alt+Space' : 'CommandOrControl+Alt+Space'
    for (const accelerator of [primary, fallback]) {
      if (globalShortcut.register(accelerator, () => {
        // 经壳层叫出来，托盘上的"角色：显示中/已隐藏"才和桌面上看到的一致。
        host?.setStageVisible(true)
        sendToRenderer('pet-summon', null)
      })) break
    }

    // 常驻语音唤醒：听到"小潘同学"就回应并弹出输入框。起不起由仲裁器按当前设置决定，
    // 之后每一次起停也都从它那里出 —— 设备只有一个主人。
    // 唤醒开关先落进状态（不产生副作用）：Windows 缺省开（既有行为），macOS 缺省关（开着就是持续采集）。
    audioState = { ...audioState, wakeEnabled: audioPrefs().wakeEnabled }
    applyAudio({ type: 'boot' })
    // 启动后把固定话术的音频补齐到缓存（延后几秒，别和启动抢带宽）。
    // 没有这一步，唤醒应答随机抽到"没缓存过的句子"就要当场联网合成，用户会感觉
    // "有时候立刻响、有时候要等好几秒"。
    const warmTimer = setTimeout(() => { void warmGreetingCache(voiceApiStore?.resolve('tts') ?? null) }, 5_000)
    warmTimer.unref()
    // 自愈：唤醒是独占麦克风的，任何一次占用（听写/会议/外放插话）归还时漏了恢复，
    // 用户看到的就是"喊了没反应，而且完全没有提示"。每 8 秒做一次幂等核对，
    // 发现该听却没在听就拉回来 —— 只在空闲、且设置允许时才动手。
    const wakeWatchdog = setInterval(() => { ensureWakeRunning() }, 8_000)
    wakeWatchdog.unref()
    // 休眠恢复：设备句柄多半失效了。共享采集开着就重开（帧上标缺口）；System.Speech 唤醒在跑就重起一次。
    // 动态取 powerMonitor：主进程装配测试里的 electron 替身没有它，缺了只是少这一条恢复路径。
    void import('electron').then(({ powerMonitor }) => powerMonitor?.on('resume', () => {
      sendToRenderer('capture-resume', null)
      if (audioState.holder === 'wake' && runningWake === 'system') {
        stopWakeListener()
        startWakeListener(onWakeWord, onWakeLost)
      }
    })).catch(() => undefined)

    // 连接会话桥接：宠物可能先于"召唤"启动，这里持续重试直到桥接出现。
    void bridge.connect({
      onStatus: status => {
        sendToRenderer('bridge-status', status)
        if (status === 'disconnected' && sessionState) {
          acceptSession({ ...sessionState, entries: [], status: 'disconnected', error: '会话连接已断开' })
        }
        host?.noteBridgeChange()
        // 断开之后审批凭据与代次都失效了，卡片上那条提案不可能再被批准：关掉它。
        if (status === 'disconnected') approvals.clear()
      },
      onSessionEnded: () => {
        approvals.clear()
        // 托盘常驻是用户明确启用的一项：启用了，会话结束就只收起角色，壳、唤醒监听、
        // 以及用户自己起的那个运行时都原样留着（下次召唤还能接回来）。
        // 没启用就沿用旧单宠行为 —— 播退场动画然后整个退出。
        if (loadSettings().trayResident) host?.setStageVisible(false)
        else requestPetExit()
      },
      // 事件逐条转发：界面是团队状态的投影，不是自己猜出来的。
      onEvent: event => {
        if (event.type === 'session/update') {
          acceptSession(event.payload as SessionUpdate)
          return
        }
        sendToRenderer('team-event', event)
        // 提案被别处决定（或到期）之后，专用窗口里那张卡片要跟着撤：
        // 留着它，用户会去批一条已经不存在的提案，然后收到一句看不懂的失败。
        if (event.type === 'proposal/decided' && typeof event.id === 'string') {
          approvals.retire(event.id)
          // 发布或删除被决定后，工作台按新事实重读，不沿用决定前的版本。
          reportWorkbench?.refresh()
        }
      },
      // 会话流水（正文 / 思考 / 工具调用 / 输入）：按发生顺序推给界面，
      // 让宠物的对话框和 DSH 会话完全绑定 —— 那边出什么、进来什么，这边同步什么。
      onChatDelta: item => {
        sendToRenderer('chat-delta', item)
      },
      // 主动提醒（design.md §2.7）：插件侧只推候选与文案，显不显示、怎么回应由这边的
      // 专注/可见状态决定 —— 界面是唯一知道用户此刻在不在会议里的一方。
      onProactive: payload => {
        // 会议中到达的提醒直接丢弃：评估侧也会因会议状态跳过，这里兜住上报前后的时间差。
        if (meetingRecorder?.getState().recording === true) return
        sendToRenderer('proactive-remind', payload)
      },
    })
  })
}

app.on('window-all-closed', () => {
  if (exitRequested) {
    app.quit()
  } else {
    // 渲染层崩溃连带关窗时自愈重建
    win = null
    createWindow()
  }
})

/** 退出收尾只做一次：第二次 before-quit 是收尾完成后自己放行的那一次。 */
let shutdownStarted = false

app.on('before-quit', event => {
  globalShortcut.unregisterAll()
  pointerWatcher.dispose()
  stopWakeListener()
  // KWS 唤醒是进程内的 worker 线程：随进程退出，这里先停掉，退出过程中不再解码。
  kwsSession?.stop()
  kwsSession = null
  runningWake = null
  // 窗口被关这类退出路径不经过 requestPetExit，漏在这儿就是一个杀不掉的合成进程孤儿。
  narrator.dispose()
  docView.dispose()
  wpsView.dispose()
  wpsController?.dispose()
  bridge.dispose()
  // 退出过程中不该再留着一个能签发批准的窗口：IPC 摘掉、卡片关掉。
  approvals.dispose()
  reportWorkbench?.dispose()
  // 会议库句柄要关：Windows 上文件锁会一直挂着，进程退了目录都删不干净。
  // 放在 host 判空之前 —— 没开助理也得关。
  const closingMeeting = meetingRecorder?.close() ?? Promise.resolve()
  if (shutdownStarted || !host) {
    void closingMeeting
    return
  }
  // 停自有运行时要等它静止，而同步等是等不到的：子进程的 exit 事件靠事件循环派发，
  // 阻塞主线程期间 exitCode 永远不会被置位。所以先挡下这次退出，收尾完再放行。
  shutdownStarted = true
  event.preventDefault()
  const closing = host
  host = null
  void Promise.allSettled([closing.shutdown(), closingMeeting]).then(() => app.quit())
})

