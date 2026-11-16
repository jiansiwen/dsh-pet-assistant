/**
 * dsh-pet 主进程：铺满工作区的透明置顶角色窗口、IPC 桥接、形象切换、托盘常驻与运行时启动握手。
 *
 * 生命周期分成两层，别混在一起看：
 * - 窗口层（本文件）：建窗、鼠标穿透、自愈重载、退场动画。
 * - 壳层（`companion-host.ts`）：托盘、启动 dsh 团队运行时的分阶段握手、运行时所有权。
 * 壳层活着不代表角色可见，角色可见也不代表运行时连上了 —— 这两件事各自有各自的状态。
 */
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, net, Notification, safeStorage, screen, session, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { ApprovalWindow } from './approval-window.ts'
import { registerReportWorkbench, type ReportWorkbenchHandle } from './report-workbench-window.ts'
import { registerCompanionTasks, type CompanionTasksHandle } from './companion-task-window.ts'
import { registerAssistantSettings } from './assistant-settings.ts'
import { registerAssistantMail } from './assistant-mail.ts'
import { FastReplyService, type FastReplyInput } from './fast-reply.ts'
import { registerMemberManagement } from './member-management.ts'
import { MemberEditorWindow } from './member-editor-window.ts'
import { createStreamingSession, pcm16Base64ToFloat32, streamingAvailable, transcribeWav, warmSenseVoiceAsr, warmStreamingAsr, type StreamingSession } from './asr.ts'
import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from './audio.ts'
import { AudioPrefsStore, loginItemAction, type AudioPrefs } from './audio-prefs.ts'
import { isPresenting, shouldIgnoreWakeDuringSpeech, shouldPassWithoutVoiceprint } from './wake-scene.ts'
import { kwsModelProblem, startKws, type KwsSession } from './kws.ts'
import { DEFAULT_WAKE_NAME } from './wake-name.ts'
import { clearVoiceprint, enrollVoiceprint, loadVoiceprint, voiceprintModelPath, voiceprintModelTag, voiceprintStatus, type VoiceprintStatus } from './voiceprint.ts'
import { getDataKey } from './dpapi.ts'
import { RendererPlayback, createSwitchingTransport, type RendererReceipt } from './tts-renderer-transport.ts'
import { TtsCache, voiceFingerprint } from './tts-cache.ts'
import { WAKE_GREETINGS, fixedPhrases, pickPhrase } from './greetings.ts'
import { CompanionHost } from './companion-host.ts'
import { createDocFileSystem } from './doc-fs.ts'
import { chooseDocVia, createPlaybackTap } from './doc-presenter.ts'
import { createDocViewController, type DocViewController, type DocViewHostEvent } from './doc-view-window.ts'
import { OfficeViewWindow } from './office-view-window.ts'
import { exportPptxSlides } from './office-export.ts'
import { cachedWpsProbe, createWpsController, nextWpsProbe, type WpsController, type WpsProbeCache } from './wps-control.ts'
import { WpsViewTarget } from './wps-view-target.ts'
import {
  askPrompt,
  describeOutline,
  detectDocIntent,
  docSpeechPlan,
  DocumentLibrary,
  extensionOf,
  explainPrompt,
  isPdfName,
  MAX_DOC_BYTES,
  mentionsDocs,
  presentationContext,
  sectionMoveIntent,
  stemOf,
  type DocFile,
  type OpenedDoc,
  type OpenResult,
  type Outline,
  type ParseResult,
} from './document.ts'
import { FirstRunService, toPlanView } from './first-run-service.ts'
import { initialFollowup, isExplicitContinue, reduceFollowup, type FollowupState } from './followup-window.ts'
import { intakeMinutes, intakeWindow, type EvidenceConfirmView, type EvidenceIntakeDeps } from './evidence-intake.ts'
import { createMeetingTodoHandler } from './meeting-todo.ts'
import type { EvidenceIntakeOutcome, EvidenceIntakeRequest } from '../evidence-types.ts'
import { createWinActions, type WinDesktopActions } from './win-actions.ts'
import { createDesktopTaskExecutor } from './desktop-task-executor.ts'
import { createTargetLock, winActionsTargetLockIO } from './target-lock.ts'
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
import { AssetPipeline } from './asset-pipeline.ts'
import { MediaProviderStore } from './media-providers.ts'
import { VoiceCloneService } from './voice-clone.ts'
import { AssetStudio } from './asset-studio-window.ts'
import { registerPetAssetProtocol } from './asset-protocol.ts'
import { listCustomSkins } from './custom-skins.ts'
import { agentVoicePayload } from './agent-voice.ts'
import { handoverClosing, handoverOpening, type HandoverLines } from './handover-sequence.ts'
import { hasSpeakerVoice, normalizePresetId, speakerOverlay, speakerRequestFields, type SpeakerVoice } from '../shared/speaker-voice.ts'
import { ttsVoiceKey } from './tts-cache.ts'
import { modelForIntent } from '../shared/agent-voice-rule.ts'
import type { VoiceApiKind, VoiceApiResult, VoiceApiState, ResolvedVoiceApi } from '../voice-api-types.ts'
import { createMeetingRecorder, markAssistantSpeech, registerMeetingIpc, type MeetingRecorder } from './meeting-recorder.ts'
import type { MeetingConsentInput, MeetingPresentationRecord, MeetingPresentationState } from './meeting-store.ts'
import { configureSpeech, splitIntoSegments } from './speech.ts'
import { HISTORY_MAX_LIMIT, meetingHistoryRows } from './meeting-history.ts'
import { startWakeListener, stopWakeListener } from './wake.ts'
import { PointerWatcher } from './pointer-watch.ts'
import { PlayHost } from './play-host.ts'
import { kwsWakeDeviceVerified, loginItemSpec, loopbackCapability, platformOf, playAudioSpec, recordAudioSpec, supportsGlobalPointerWatch, supportsWakeWord, supportsWpsControl, wakeEngines } from './platform.ts'
import { resolveAppLayout } from './runtime-launch.ts'
import { isSessionCommand, shouldDismissOverlay, validBoxes, type OverlayBox } from './overlay-state.ts'
import type { CancelReceipt, SessionCommand, SessionSnapshot, SessionUpdate, SessionResult } from '../session-types.ts'
import type { SettingsPage } from '../renderer/types.js'
import { RANDOM_CANDIDATES, DEFAULT_RANDOM_ACTIONS } from '../renderer/character-manifest.ts'

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
let speechActive = false

/** 朗读生命周期日志：只记 id/模式/原因，不记用户文本；出问题时凭它一次查准。 */
let speechLogPath: string | null = null
function speechLog(message: string): void {
  try {
    if (speechLogPath === null) speechLogPath = path.join(app.getPath('userData'), 'speech-debug.log')
    appendFileSync(speechLogPath, `${new Date().toISOString()} ${message}\n`)
  } catch { /* 日志失败不影响主流程 */ }
}

// 主进程心跳 + 事件循环延迟：卡死/同步阻塞时心跳会停或 lag 飙升，凭它区分"主进程冻住"和"渲染层没发事件"。
let lastBeat = Date.now()
setInterval(() => {
  const now = Date.now()
  speechLog(`hb lag=${now - lastBeat - 2000}ms`)
  lastBeat = now
}, 2000).unref()

/** 出声或录音期间不节流渲染层：渲染层播放/回声消除一旦被后台节流挂起，主回复就会哑巴。 */
function applyThrottling(): void {
  if (!win || win.isDestroyed()) return
  const keepAwake = overlayOpen || managementOpen || speechActive || meetingRecorder?.getState().recording === true
  win.webContents.setBackgroundThrottling?.(!keepAwake)
}

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
  applyThrottling()
  sendToRenderer('overlay-dismiss', null)
}, message => sendToRenderer('overlay-error', message))

function acceptSession(update: SessionUpdate): void {
  if (sessionState?.bindingId === update.bindingId && update.cursor < sessionState.cursor) return
  const wasRunning = sessionState?.status === 'running' || sessionState?.status === 'waiting'
  const changed = sessionState?.bindingId !== update.bindingId
  if (sessionState && (changed || update.status === 'disconnected')) {
    cancelIndependentDocument('会话已切换或断开，独立讲解不会继续。')
    cancelMeetingPresentation('会话已切换或断开，讲解不会继续')
    if (pendingMeetingStart) cancelDesktopCommand({ id: pendingMeetingStart.id })
    if (pendingMeetingReady) cancelDesktopCommand({ id: pendingMeetingReady.id })
    interruptSpeech(false)
    interruptedSpeech = null
    stopDocTalk()
    pushDocState()
  }
  sessionState = update
  sessionRevision += 1
  if (changed || (wasRunning && update.status !== 'running' && update.status !== 'waiting')) dismissAfter = Date.now()
  sendToRenderer('session-update', update)
  if (update.status !== 'running' && update.status !== 'waiting') {
    void maybeStartMeetingPresentation()
    void maybeStartIndependentDocument()
  }
}

/** 工作台可以被"从 DSH 打开"的页面：与渲染层 settings-nav.ts 的九项 id 对齐。 */
const WORKBENCH_PAGES = ['todo', 'meeting', 'report', 'team', 'doc', 'general'] as const

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
/** 普通任务与提醒窗口：读取走聊天令牌，创建/回应只在原生确认后用本机凭据。 */
let companionTasks: CompanionTasksHandle | null = null
let reminderTimer: NodeJS.Timeout | null = null
let reminderInFlight = false
let mailNoticeInFlight = false
const reportedMailNoticeIssues = new Set<string>()

/**
 * 领取一条到期的桌面提醒：先 claim（保证只投递一次），再显示系统通知并回执。
 * 关机、退出或领不到时什么都不做；不在这里调用模型。
 */
async function deliverRemindersOnce(): Promise<void> {
  if (reminderInFlight) return
  reminderInFlight = true
  try {
    const delivery = await bridge.nextDesktopReminder()
    if (!delivery || !(await bridge.claimDesktopReminder(delivery.deliveryId))) return
    const shown = await new Promise<boolean>(resolve => {
      try {
        const notification = new Notification({ title: delivery.title || '小潘提醒', body: delivery.message })
        notification.on('click', () => companionTasks?.open())
        notification.on('failed', () => resolve(false))
        notification.show()
        resolve(true)
      } catch {
        resolve(false)
      }
    })
    await bridge.receiptDesktopReminder(
      delivery.deliveryId,
      shown ? 'succeeded' : 'failed-before-effect',
      shown ? [`notification:${delivery.deliveryId}`] : [],
    )
  } finally {
    reminderInFlight = false
  }
}

/** 先领取再显示，只有系统确认显示后才回执；未知结果留给用户核查。 */
export async function deliverMailNoticesOnce(): Promise<void> {
  if (mailNoticeInFlight) return
  mailNoticeInFlight = true
  try {
    const pending = await bridge.desktopMailNotices()
    if (!pending) return
    for (const issue of pending.attention) {
      const key = `${issue.analysisId}:${issue.state}`
      if (reportedMailNoticeIssues.has(key) || !win || win.isDestroyed()) continue
      sendToRenderer('member-notice', { kind: 'mail', memberId: issue.memberId,
        text: issue.state === 'unknown' ? '有邮件通知结果未知，不会自动重发；请打开邮件助理会话核对。' : '有邮件通知未能显示；请打开邮件助理会话核对。' })
      reportedMailNoticeIssues.add(key)
      if (reportedMailNoticeIssues.size > 200) reportedMailNoticeIssues.delete(reportedMailNoticeIssues.values().next().value!)
    }
    const notice = pending.deliveries[0]
    if (!notice) return
    const attemptId = await bridge.claimDesktopMailNotice(notice.analysisId)
    if (!attemptId) return
    const result = await new Promise<'succeeded' | 'failed-before-effect' | 'unknown'>(resolve => {
      let settled = false
      const finish = (state: 'succeeded' | 'failed-before-effect' | 'unknown'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(state)
      }
      const timer = setTimeout(() => finish('unknown'), 5000)
      try {
        if (!Notification.isSupported()) { finish('failed-before-effect'); return }
        const body = notice.text.length > 500 ? `${notice.text.slice(0, 499)}…` : notice.text
        const notification = new Notification({ title: '邮件值守', body })
        notification.on('show', () => finish('succeeded'))
        notification.on('failed', () => finish('failed-before-effect'))
        notification.on('click', () => openSettings('team'))
        notification.show()
      } catch { finish('unknown') }
    })
    if (result === 'succeeded') sendToRenderer('member-notice', { kind: 'mail', text: notice.text, memberId: notice.memberId })
    await bridge.receiptDesktopMailNotice(notice.analysisId, attemptId, result)
  } catch (error) {
    console.error('[dsh-pet] 邮件通知领取或回执失败：', error)
  } finally {
    mailNoticeInFlight = false
  }
}
/** 壳层。app ready 之后才建（要用 userData 目录），所以这里是延迟赋值。 */
let host: CompanionHost | null = null
/**
 * 用户自配的 TTS / 语音识别服务（OpenAI 兼容）。密钥用系统密钥库（DPAPI）加密落盘，
 * 只在主进程里解开送给请求；页面拿到的列表里永远没有密钥本体。
 */
let voiceApiStore: VoiceApiStore | null = null
let assetStudio: AssetStudio | null = null

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

/** 崩溃留证：闪退时终端日志拿不到，落盘才能在事后查到栈。 */
function crashLog(kind: string, error: unknown): void {
  try {
    appendFileSync(path.join(app.getPath('userData'), 'crash.log'),
      `${new Date().toISOString()} ${kind} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  } catch { /* 落盘失败不改变退出行为 */ }
}

process.on('uncaughtException', error => {
  // 透明置顶窗口在个别显卡/系统组合上会直接抛主进程异常；退出前留下可读的日志。
  crashLog('uncaughtException', error)
  console.error('[dsh-pet] uncaughtException', error)
  app.exit(1)
})
process.on('unhandledRejection', reason => {
  crashLog('unhandledRejection', reason)
  console.error('[dsh-pet] unhandledRejection', reason)
})
app.on('render-process-gone', (_event, details) => {
  crashLog('render-process-gone', new Error(JSON.stringify(details)))
})
app.on('child-process-gone', (_event, details) => {
  crashLog('child-process-gone', new Error(JSON.stringify(details)))
})
// 个别 Win11 显卡驱动在透明置顶窗口上会让 GPU 进程崩溃（表现为一召唤就闪退）。
// 这类机器可以设 DSH_PET_DISABLE_GPU=1 强制软件渲染；默认仍走 GPU 以保证动画流畅。
if (process.env.DSH_PET_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  console.error('[dsh-pet] hardware acceleration disabled by DSH_PET_DISABLE_GPU')
}
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
  // 渲染层带 [dsh-pet] 前缀的日志转发到主进程 stdout（落 launch.log），便于真机取证随机动作等调度。
  if (typeof win.webContents.on === 'function') {
    win.webContents.on('console-message', (_event: unknown, _level: unknown, message: unknown) => {
      if (typeof message === 'string' && message.startsWith('[dsh-pet]')) console.log(new Date().toISOString(), message)
    })
  }
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
let petLocked = false
let petPresentation = false
let targetLockHandle: import('./target-lock.ts').TargetLockHandle | null = null

function reportPetState(): void {
  // 会议进行中插件不评估主动提醒；状态以录制器为准，不靠界面猜。
  void bridge.reportPetState({ focus: petFocusMode, visible: petStageVisible, meeting: meetingRecorder?.getState().recording === true, locked: petLocked, screenSharing: petPresentation })
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
    bargeIn: audioState.holder === 'barge-in' || (audioState.meetingActive && audioState.bargeInMeeting),
    // 唤醒与会议/听写可并存（共享采集多消费者）；只要 KWS 唤醒在跑就授权，不再绑定 holder。
    kws: runningWake === 'kws',
    // 听写交接时 holder 暂时改变，但会议仍须保留自己的共享采集授权。
    meetingId: audioState.meetingActive ? meetingGrantId : null,
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
    // 只让"连续对话"退场，**不掐断正在念的回答**。
    // 用户常说一句话同时触发"开会 + 讲解"，此刻总助理的复述还在念；
    // 在这里 interruptSpeech 就是"只听到开头一句、正文没了"（真机已复现：applyAudio <- startMeeting）。
    // 助理播报会被 markAssistantSpeech 标记并从纪要里排除，不需要靠静音来避污染。
    sendToRenderer('voice-conversation-stop', null)
  }
  for (const effect of turn.effects) {
    if (effect === 'start-wake') startWake()
    else if (effect === 'stop-wake') stopWake()
    // 插话监听本身在渲染层：起停就是授权里 bargeIn 的有无，下面统一下发。
  }
    /*
      记下每次仲裁结果：会议/听写/唤醒抢设备时，靠这行日志判断是谁把谁停了。
      以前这类问题只能靠猜，因为日志里只有播报事件，没有"设备归谁"。
    */
    speechLog(`audio holder=${audioState.holder ?? 'none'} meeting=${audioState.meetingActive} wake=${runningWake ?? 'off'} effects=${turn.effects.join('|') || '-'}`)
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
  // 幂等：会议/听写收尾恢复唤醒时可能已有监听在跑，先停再起，保证份数始终 1。
  if (runningWake !== null) stopWake()
  const prefs = audioPrefs()
  const engine = prefs.wakeEngine
  const wakeName = prefs.wakeName
  const unavailable = (reason: string): void => {
    audioState = { ...audioState, holder: null, wakeUnavailable: true }
    wakeProblem = reason
    console.log('[dsh-pet] 语音唤醒不可用（按键听写与快捷键不受影响）：', reason)
  }
  if (engine === 'system') {
    if (!supportsWakeWord(platformOf())) return unavailable('这个系统上没有 System.Speech 唤醒')
    if (wakeName !== DEFAULT_WAKE_NAME) {
      return unavailable(`System.Speech 只支持默认唤醒词「${DEFAULT_WAKE_NAME}」；自定义唤醒词请把唤醒引擎切到本地唤醒模型（KWS）`)
    }
    runningWake = 'system'
    wakeProblem = null
    startWakeListener(onWakeWord, onWakeLost)
    return
  }
  if (engine === 'kws') {
    const problem = kwsModelProblem(app.getPath('userData'), wakeName)
    if (problem !== null) return unavailable(problem)
    let voiceprint: { model: string; embeddings: number[][]; threshold: number } | null = null
    if (prefs.wakeVoiceprint) {
      try {
        const record = loadVoiceprint(app.getPath('userData'), voiceprintKey)
        if (record === null) return unavailable('已开启声纹唤醒，但还没有注册声纹：请先在设置页录制 3 次唤醒词')
        const modelPath = voiceprintModelPath(app.getPath('userData'))
        const modelTag = voiceprintModelTag(modelPath)
        if (record.model !== undefined && modelTag !== null && record.model !== modelTag) {
          return unavailable('声纹是用旧模型录的，和当前声纹模型不匹配：请到设置页重新录制')
        }
        voiceprint = {
          model: modelPath,
          embeddings: record.embeddings.map(embedding => [...embedding]),
          threshold: prefs.wakeVoiceprintThreshold,
        }
      } catch (error) {
        return unavailable(`声纹读不出来：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    runningWake = 'kws'
    wakeProblem = null
    // KWS 吃渲染层共享采集：授权（kws=true）随后由 pushAudioGrants 下发，渲染层据此订阅并送 PCM。
    kwsSession = startKws({
      userDataDir: app.getPath('userData'),
      keywordName: wakeName,
      ...(voiceprint ? { voiceprint } : {}),
      onWake: () => onWakeWord(),
      onRejected: (score, reason) => {
        // 声纹未通过时要不要放行，只看场景（判定在 wake-scene.ts）：
        // 讲解是公开场合 —— 听众喊一句"这里为什么这么设计"正是产品要的，不该被声纹挡住；
        // 回答播报是私密场合 —— 旁人或电视说话不能把正在念的回答打断。
        // 只判"讲解会话还在"，不判 stopped：插话会 pause（stopped=true），
        // 而"暂停中的讲解"依然是公开场合 —— 第二、第三个听众还得能喊进来。
        if (shouldPassWithoutVoiceprint({ presenting: isPresenting(docTalk) })) {
          console.log(`[dsh-pet] 讲解中非主人唤醒放行（score=${score.toFixed(3)}${reason ? `，${reason}` : ''}）`)
          onWakeWord()
          return
        }
        console.log(`[dsh-pet] 唤醒词命中但声纹未通过（score=${score.toFixed(3)}${reason ? `，${reason}` : ''}）`)
      },
      onLost: reason => { if (runningWake === 'kws') onWakeLost(reason) },
      onReady: loadMs => console.log(`[dsh-pet] 本地唤醒模型已加载（${loadMs}ms${voiceprint ? '，含声纹验证' : ''}）`),
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
  // 唤醒应答会抢焦点：先把唤醒前的前台身份锁住，供"刚才那个窗口"类任务引用。
  void targetLockHandle?.captureTargetLock(Date.now())
  // 诊断：唤醒链路每一步都要能在日志里看见。用户喊了没反应时，第一句就能定位卡在哪：
  // 路径根本没进来（识别没命中）／被下面某个条件挡住／进来了但在合成/播放阶段失败。
  console.log('[dsh-pet] 唤醒命中：',
    JSON.stringify({ holder: audioState.holder, speaking: narrator.isSpeaking(), spokenRound: spokenRound !== null, focus: audioState.focus }))
  // 会议中仍然不接唤醒：麦克风被会议采集占着，独立的 wake.ps1 这时候本来也拿不到音频
  // （见 record-stop-command.ts 的注释），会议里的语音停止走 ASR 指令那条路。
  if (audioState.holder === 'meeting') {
    console.log('[dsh-pet] 唤醒被忽略：会议录音中（录音期间的语音指令走会议转写）')
    return
  }
  // 播报中默认不响应唤醒：用户没在等它，别人（或电视）说话不该把正在念的回答打断。
  // 讲解中是例外 —— 那本来就是"讲给听众听、随时被打断"的场合。
  // 判定在 wake-scene.ts（纯函数，能单测）；开关是 audio-prefs 的 wakeDuringSpeech。
  // 同 onRejected：暂停中的讲解仍算讲解（见 wake-scene.ts 的 isPresenting）。
  const presentingNow = isPresenting(docTalk)
  if (shouldIgnoreWakeDuringSpeech({
    presenting: presentingNow,
    wakeDuringSpeech: audioPrefs().wakeDuringSpeech,
    speaking: narrator.isSpeaking() || spokenRound !== null,
  })) {
    console.log('[dsh-pet] 唤醒被忽略：正在播报（可在设置里关掉"播报中忽略唤醒"）')
    return
  }
  // 用户是冲着说话来的：角色藏着就先叫出来，别对着一个隐藏窗口说话。
  host?.setStageVisible(true)
  // 应答要**出声**：每次唤醒只说一句短的，并且换着说法（见 greetings.ts）。
  // 播放走 Narrator —— 和回复、快嘴共用同一条传输（`openTtsTransport` 会在进程内播放器与
  // 渲染层 Web Audio 之间切换）。旧实现自己开一条系统播放器通道，于是"唤醒应答"和"回答"
  // 是两个设备、两种音量，录音时尤其明显；音色一致比"独立通道"重要得多。
  // 唤醒优先级高：Narrator 正在播讲解/回答时，`speakWakeGreeting` 会先把它停掉再应答。
  // 合成服务只解析一次：选句（要查哪些句子已有缓存）和播放必须用同一个音色指纹。
  const api = voiceApiStore?.resolve('tts') ?? null
  const greeting = pickGreeting(api)
  if (greeting.length > 0) void speakWakeGreeting(greeting)
  sendToRenderer('wake-triggered', greeting)
}

/** edge-tts 音色名（如 zh-CN-XiaoxiaoNeural、en-US-AriaNeural）：成员音色档案可直接填。 */
function isEdgeTtsVoiceName(name: string): boolean {
  return /^[a-z]{2,3}(-[A-Z][a-zA-Z]*)?-[A-Za-z]+Neural$/u.test(name)
}

/** 缓存键：自定义服务按服务+模型+音色（含设计/语气/样本），默认 edge-tts 也要有稳定的键，否则永远不预热。 */
function greetingVoiceKey(api: ResolvedVoiceApi | null): string {
  if (api === null) {
    return voiceFingerprint({ provider: 'edge-tts', model: 'edge-tts', voice: DEFAULT_TTS_VOICE })
  }
  return ttsVoiceKey(withAgentVoice(api) as ResolvedVoiceApi)
}

/**
 * 优先挑一句**已经有本地音频**的应答。
 *
 * 预热没跑完（或刚换了音色）时，随机抽到未缓存的句子就要当场等一次云端合成，
 * 用户听到的是"喊完一两秒才回话"。缓存里有哪句就先说哪句，全部没缓存时才退回随机 ——
 * "喊了就响"优先于"每次都换着说"；预热完成后所有句子都在缓存里，随机性自然恢复。
 */
function pickGreeting(api: ResolvedVoiceApi | null): string {
  const voiceKey = greetingVoiceKey(api)
  const cached = WAKE_GREETINGS.filter(text => ttsCache.has({ voiceKey, text }))
  return pickPhrase(cached.length > 0 ? cached : WAKE_GREETINGS)
}

/** 唤醒应答：等合成进程开口的最长宽限。超了就退回系统播放器（见 fallbackWakeGreeting）。 */
const WAKE_GREETING_START_TIMEOUT_MS = 1_500
/** 唤醒应答的硬超时：界面等着这句播完才开麦，不能因为它卡住而永远不听。 */
const WAKE_GREETING_TIMEOUT_MS = 8_000

/** 正在播出的那句唤醒应答。只用来在播完/失败/被打断时解锁界面。 */
let wakeGreeting: { utteranceId: string; text: string; startedAt: number } | null = null
let wakeGreetingStartTimer: NodeJS.Timeout | null = null
let wakeGreetingTimer: NodeJS.Timeout | null = null

/** 收尾：清定时器并通知界面开麦。重复调用安全，靠 utteranceId 认领。 */
function finishWakeGreeting(utteranceId: string, reason: string): void {
  const current = wakeGreeting
  if (current === null || current.utteranceId !== utteranceId) return
  wakeGreeting = null
  if (wakeGreetingStartTimer) { clearTimeout(wakeGreetingStartTimer); wakeGreetingStartTimer = null }
  if (wakeGreetingTimer) { clearTimeout(wakeGreetingTimer); wakeGreetingTimer = null }
  console.log(`[dsh-pet] 唤醒应答${reason}（共 ${Date.now() - current.startedAt}ms），开始听写`)
  // 成功、失败、播放器不可用都要解锁界面，否则唤醒后永远不开始听。
  sendToRenderer('wake-greeting-finished', null)
}

/**
 * 念一句唤醒应答。
 *
 * **走 Narrator**：它和回复、快嘴共用同一条传输（`openTtsTransport` 平时是进程内播放器，
 * 插话/讲解/录音时切到渲染层 Web Audio）。旧实现自己开一条系统播放器通道，于是唤醒应答和
 * 回答是两个设备、两种音量 —— 用户一耳朵就听出来不是同一个人在说话。
 *
 * 固定话术的音频仍然吃 `ttsCache` 的缓存（`warmGreetingCache` 预热，Narrator 派发前会查），
 * 所以换成 Narrator 之后"喊了就响"也没丢：命中缓存时直接把音频交给播放器，不联网。
 * `ephemeral`：这只是"我听见了"，不进会话 / 记忆 / 纪要。
 */
async function speakWakeGreeting(text: string): Promise<void> {
  const said = text.trim()
  if (said === '') return
  // 唤醒优先级高：用户喊它就是想让当前的声音停下（讲解、上一轮回答都让位）。
  if (narrator.isSpeaking() || spokenRound !== null) interruptSpeech()
  const previous = wakeGreeting
  if (previous !== null) finishWakeGreeting(previous.utteranceId, '被新的唤醒应答取代')
  const utteranceId = `wake-${randomUUID()}`
  const startedAt = Date.now()
  wakeGreeting = { utteranceId, text: said, startedAt }
  console.log(`[dsh-pet] 唤醒应答开始播放：「${said}」`)
  narrator.beginRound()
  narrator.speak({ utteranceId, text: said, ephemeral: true })
  // 合成进程或渲染层没起来时不能把界面永远锁着，也不能让用户"喊了没反应"：
  // 1.5 秒还没开口就退回系统播放器 —— 那一刻"能出声"优先于"音色统一"，日志会写明走了兜底。
  wakeGreetingStartTimer = setTimeout(() => {
    wakeGreetingStartTimer = null
    if (wakeGreeting?.utteranceId !== utteranceId || narrator.isSpeaking()) return
    void fallbackWakeGreeting(utteranceId, said).catch(error => {
      console.log('[dsh-pet] 唤醒应答兜底也失败：', error instanceof Error ? error.message : String(error))
      finishWakeGreeting(utteranceId, '没能出声')
    })
  }, WAKE_GREETING_START_TIMEOUT_MS)
  wakeGreetingStartTimer.unref()
  wakeGreetingTimer = setTimeout(() => finishWakeGreeting(utteranceId, '超时未播完'), WAKE_GREETING_TIMEOUT_MS)
  wakeGreetingTimer.unref()
}

/** Narrator 在这段时间内没能开口时的兜底：用系统播放器把缓存里的音频放出去。 */
async function fallbackWakeGreeting(utteranceId: string, text: string): Promise<void> {
  if (wakeGreeting?.utteranceId !== utteranceId) return
  console.log('[dsh-pet] 唤醒应答没能在 1.5 秒内开口，回退系统播放器（这句的音色可能与回复不一致）')
  // 先把它从 Narrator 队列里摘掉，否则兜底播完之后 Narrator 可能又念一遍。
  narrator.interrupt('drop-queue')
  const api = voiceApiStore?.resolve('tts') ?? null
  const key = { voiceKey: greetingVoiceKey(api), text }
  const cached = ttsCache.get(key)
  const audio = cached ?? await synthesizeOneShot(text, api)
  if (cached === null) ttsCache.put(key, audio)
  if (wakeGreeting?.utteranceId !== utteranceId) return
  await playOneShot(audio)
  finishWakeGreeting(utteranceId, '播放结束（系统播放器兜底）')
}

/** 总助理的音色配置（克隆样本 > 设计描述 > 预置音色，语气单独叠）。 */
function chiefSpeakerVoice(): SpeakerVoice {
  const s = loadSettings()
  return {
    voiceId: s.agentVoiceId ?? '',
    design: s.agentVoiceDesign ?? '',
    style: s.agentVoiceStyle ?? '',
    sampleFile: s.agentVoiceSampleFile ?? '',
    sampleMime: s.agentVoiceSampleMime ?? '',
    sample: s.agentVoiceSample ?? '',
  }
}

/**
 * 总助理音色叠到语音服务配置上：唤醒、快答、回复、预热、兜底**所有**入口共用。
 * 模型与互斥字段由 speakerOverlay 统一裁决，不再各写一套。
 */
function withAgentVoice(api: ResolvedVoiceApi | null): ResolvedVoiceApi | null {
  if (api === null) return null
  return { ...api, ...speakerOverlay(api.provider, api.model, chiefSpeakerVoice()) }
}

/** 合成一句（自定义服务优先，否则 edge-tts）。 */
async function synthesizeOneShot(text: string, api: ResolvedVoiceApi | null): Promise<Buffer> {
  const merged = withAgentVoice(api)
  if (merged !== null) return synthesizeApi(merged, text)
  return synthesizeSpeech({ text, voice: DEFAULT_TTS_VOICE, rate: '+0%', pitch: '+0Hz' })
}

/** 同一次预热不重复跑；换成同一音色且已完成时直接跳过。 */
let warmGreetingTask: { voiceKey: string; promise: Promise<void> } | null = null
let warmedGreetingVoice: string | null = null

/**
 * 把全部固定话术的音频补齐到缓存。
 *
 * 唤醒应答是随机挑的：只缓存"用过的那几句"等于每次都有概率抽到没缓存的，
 * 于是用户会感觉"有时候很快、有时候要等好几秒"。启动后和首次合成后各补齐一次，
 * 之后每句话都命中缓存，唤醒应答就是本地的、立刻出声。
 *
 * 三路并发：串行合成 18 句在云端服务上要十几秒，这段时间里唤醒仍可能抽到没缓存的句子。
 * 并发数刻意压得低，不和正在进行的会话播报抢带宽。失败只记日志，下次启动再补。
 */
function warmGreetingCache(api: ResolvedVoiceApi | null): Promise<void> {
  const voiceKey = greetingVoiceKey(api)
  if (warmedGreetingVoice === voiceKey) return Promise.resolve()
  if (warmGreetingTask?.voiceKey === voiceKey) return warmGreetingTask.promise
  const promise = runWarmGreetingCache(api, voiceKey).finally(() => {
    if (warmGreetingTask?.promise === promise) warmGreetingTask = null
  })
  warmGreetingTask = { voiceKey, promise }
  return promise
}

async function runWarmGreetingCache(api: ResolvedVoiceApi | null, voiceKey: string): Promise<void> {
  try {
    const pending = fixedPhrases().filter(text => !ttsCache.has({ voiceKey, text }))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const text = pending[next++]
        if (text === undefined) return
        try {
          const audio = await synthesizeOneShot(text, api)
          ttsCache.put({ voiceKey, text }, audio)
        } catch {
          // 单句失败不影响其余句子；下次启动会再试。
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
    if (pending.length > 0) warmedGreetingVoice = voiceKey
    console.log(`[dsh-pet] 唤醒应答音频已预热完成（新合成 ${pending.length} 句）`)
  } catch (error) {
    console.log('[dsh-pet] 预热唤醒应答失败：', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 直接播放一段音频字节。
 *
 * 用系统播放器（Windows 走 MCI、macOS 走 afplay），不经过渲染层：
 * 渲染层播放要先有音频上下文、还可能因为没有用户手势被自动播放策略挂起 ——
 * 唤醒应答必须"喊了就响"，不能赌这些条件。
 *
 * Windows 上优先走常驻的 play-host.ps1：省掉每次 2 秒以上的 PowerShell 冷启动与
 * Add-Type 编译。常驻进程没预热好或已退出时，回退到一次性 spawn 的 play.ps1。
 */
async function playOneShot(audio: Buffer): Promise<boolean> {
  const mime = sniffAudioMime(audio)
  const ext = mime === 'audio/wav' ? '.wav' : mime === 'audio/ogg' ? '.ogg' : '.mp3'
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-wake-'))
  const file = path.join(dir, `wake${ext}`)
  writeFileSync(file, audio)
  const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 稍后清理 */ } }

  // 启动后头几秒就可能被唤醒：常驻进程还在编译，给它一个短暂窗口再决定回退。
  // 窗口比一次性脚本的 2.5 秒短，等到就赚，等不到也只是多 1.5 秒。
  if (!playHost.isReady()) await playHost.waitReady(1_500)
  const shared = playHost.play(file)
  if (shared !== null) return shared.finally(cleanup)

  console.log('[dsh-pet] 常驻播放器未就绪，这次回退一次性 play.ps1（会慢约 2 秒）')
  const spec = playAudioSpec(platformOf(), layout.scriptDir, file)
  if (spec === null) { cleanup(); return Promise.resolve(false) }
  return new Promise(resolve => {
    let settled = false
    const finish = (played: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(played)
    }
    const child = spawn(spec.command, [...spec.args], { windowsHide: true, stdio: 'ignore' })
    child.once('close', code => finish(code === 0))
    child.once('error', () => finish(false))
  })
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
 * 快速应答旁路（"快嘴"）：与主会话双轨并行。
 *
 * 用户说完话，主脑可能要跑几分钟任务才出第一句；旁路先用一句人设化短应答
 * （用户自配的 OpenAI 兼容模型）让用户知道它在听。产出只交本地 TTS 与宠物气泡，
 * 从不经过 bridge.chat，不进 DSH 会话/记忆/纪要；主回复首句一到立刻打断接管，
 * 超时或失败静默丢弃，任何情况下不挡主轨。
 */
interface FastAckRound {
  utteranceId: string
  controller: AbortController
  cancelled: boolean
  /** 是否已交给合成器播过：接管时据此决定要不要掐音频。 */
  spoken: boolean
}
let activeAck: FastAckRound | null = null
let fastReply: FastReplyService | null = null

/** 总助理的名字与性格：快嘴按它说话。缓存一分钟，取不到就用默认人设。 */
let chiefContextCache: { at: number; name: string; persona: string } | null = null
async function chiefContext(): Promise<{ name: string; persona: string }> {
  if (chiefContextCache && Date.now() - chiefContextCache.at < 60_000) return chiefContextCache
  try {
    const result = await bridge.companionRequest('GET', '/companion/v1/settings', undefined, 'owner', 5000)
    if (result.status !== 200) return chiefContextCache ?? { name: '', persona: '' }
    const agent = (result.body as { agent?: { name?: unknown; persona?: unknown } } | null)?.agent
    chiefContextCache = {
      at: Date.now(),
      name: typeof agent?.name === 'string' ? agent.name : '',
      persona: typeof agent?.persona === 'string' ? agent.persona : '',
    }
    return chiefContextCache
  } catch {
    return chiefContextCache ?? { name: '', persona: '' }
  }
}

/** 成员名字缓存：讲解委派要在回复和面板里点名，不能只给内部 id。 */
let memberNamesCache: { at: number; names: Map<string, string>; voices: Map<string, SpeakerVoice>; meta: Map<string, { persona: string; speechBy: string }> } | null = null
async function memberDisplayName(assistantId: string): Promise<string> {
  // 命中缓存才用缓存；查无此 id 就重取——目录可能刚变，空缓存不能把新成员挡一分钟。
  if (!memberNamesCache || Date.now() - memberNamesCache.at >= 60_000 || !memberNamesCache.names.has(assistantId)) {
    try {
      const result = await bridge.companionRequest('GET', '/companion/v1/members', undefined, 'owner', 5000)
      const body = result.status === 200
        ? result.body as { members?: Array<{ profile?: { assistantId?: unknown; displayName?: unknown; voiceProfile?: unknown; voiceDesign?: unknown; persona?: unknown; speechBy?: unknown } }> } | null
        : null
      const names = new Map<string, string>()
      const voices = new Map<string, SpeakerVoice>()
      const meta = new Map<string, { persona: string; speechBy: string }>()
      for (const item of body?.members ?? []) {
        const p = item.profile
        if (typeof p?.assistantId === 'string' && typeof p?.displayName === 'string') {
          names.set(p.assistantId, p.displayName)
          voices.set(p.assistantId, {
            voiceId: typeof p.voiceProfile === 'string' ? p.voiceProfile : '',
            design: typeof p.voiceDesign === 'string' ? p.voiceDesign : '',
          })
          meta.set(p.assistantId, {
            persona: typeof p.persona === 'string' ? p.persona : '',
            speechBy: typeof p.speechBy === 'string' ? p.speechBy : 'self',
          })
        }
      }
      memberNamesCache = { at: Date.now(), names, voices, meta }
    } catch { /* 取不到就沿用旧缓存或空名，不挡讲解 */ }
  }
  return memberNamesCache?.names.get(assistantId) ?? ''
}

/**
 * 某个说话人该用谁的嗓子：壳侧按成员存的音色优先（成员编辑窗写入），
 * 其次是插件目录里的 voiceProfile/voiceDesign，都没配就沿用总助理的默认音色。
 */
async function speakerForAssistant(assistantId: string | undefined): Promise<SpeakerVoice> {
  const chief = chiefSpeakerVoice()
  if (assistantId === undefined || assistantId.trim() === '') return chief
  await memberDisplayName(assistantId)
  const fromDirectory = memberNamesCache?.voices.get(assistantId) ?? { voiceId: '', design: '' }
  const override = loadSettings().memberVoices?.[assistantId]
  const merged: SpeakerVoice = {
    voiceId: normalizePresetId(override?.voiceId || fromDirectory.voiceId || ''),
    design: override?.design || fromDirectory.design || '',
    style: override?.style ?? '',
    sampleFile: override?.sampleFile ?? '',
    sampleMime: override?.sampleMime ?? '',
    profileId: override?.profileId ?? '',
  }
  return hasSpeakerVoice(merged) ? merged : chief
}

/**
 * 同步版：讲解这类**逐段连续出声**的场合用它。
 *
 * 为什么要有同步版：文档讲解一口气要念几十段，如果在每段前面都 await 一次
 * 成员名字、成员音色，段与段之间会冒出可听见的空档，停顿变得忽长忽短。
 * 名字缓存没热时退化成"只有壳侧覆盖的音色"，宁可少一层来源，也不要断句。
 */
function speakerForAssistantSync(assistantId: string | undefined): SpeakerVoice {
  const chief = chiefSpeakerVoice()
  if (assistantId === undefined || assistantId.trim() === '') return chief
  const fromDirectory = memberNamesCache?.voices.get(assistantId) ?? { voiceId: '', design: '' }
  const override = loadSettings().memberVoices?.[assistantId]
  const merged: SpeakerVoice = {
    voiceId: normalizePresetId(override?.voiceId || fromDirectory.voiceId || ''),
    design: override?.design || fromDirectory.design || '',
    style: override?.style ?? '',
    sampleFile: override?.sampleFile ?? '',
    sampleMime: override?.sampleMime ?? '',
    profileId: override?.profileId ?? '',
  }
  return hasSpeakerVoice(merged) ? merged : chief
}

/** 讲解正文用谁的嗓子：成员设置"由总助理代念"时用总助理，否则成员自己。 */
function presentationSpeakerVoice(assistantId: string | undefined): SpeakerVoice {
  if (assistantId && memberNamesCache?.meta.get(assistantId)?.speechBy === 'chief') return chiefSpeakerVoice()
  return speakerForAssistantSync(assistantId)
}

const handoverLinesCache = new Map<string, HandoverLines>()
/** 兜底台词：中性称谓。用户没设置过"老板"这类称呼，不能把举例当配置写死。 */
function fixedHandoverLines(who: string): HandoverLines {
  return {
    chiefToUser: `这件事我交给${who}了，接下来由${who}给你讲。`,
    chiefToMember: `${who}，来一下，这边需要你。`,
    memberToChief: '好，我这就来。',
    memberToUser: `你好，接下来由我来给你讲！`,
    memberFarewell: '那我先退下了。',
  }
}
/** 派工时预取按性格生成的交接台词；取不到就用固定台词，不挡讲解时序。 */
function prefetchHandoverLines(assistantId: string, task: string): void {
  if (handoverLinesCache.has(assistantId)) return
  void (async () => {
    try {
      await memberDisplayName(assistantId)
      const meta = memberNamesCache?.meta.get(assistantId)
      const chief = await chiefContext()
      const response = await bridge.companionRequest('POST', '/companion/v1/members/handover', {
        chiefName: chief.name, chiefPersona: chief.persona,
        memberName: memberNamesCache?.names.get(assistantId) ?? '', memberPersona: meta?.persona ?? '', task,
      }, 'owner', 8000)
      if (response.status !== 200) return
      const lines = (response.body as { lines?: Record<string, unknown> } | null)?.lines
      if (!lines) return
      const str = (k: string): string => (typeof lines[k] === 'string' ? (lines[k] as string).slice(0, 300) : '')
      handoverLinesCache.set(assistantId, {
        chiefToUser: str('chiefToUser'), chiefToMember: str('chiefToMember'), memberToChief: str('memberToChief'),
        memberToUser: str('memberToUser'), memberFarewell: str('memberFarewell'),
      })
    } catch { /* 固定台词兜底 */ }
  })()
}

/** 讲完收场：成员道别（设了代念则由总助说），随后舞台换回总助。 */
function speakMemberClosing(assistantId: string | undefined): void {
  if (loadSettings().memberHandover === false) return
  if (assistantId === undefined || assistantId === '') return
  const who = memberNamesCache?.names.get(assistantId) ?? ''
  const lines = handoverLinesCache.get(assistantId) ?? fixedHandoverLines(who === '' ? '成员' : who)
  const memberSpeaks = memberNamesCache?.meta.get(assistantId)?.speechBy !== 'chief'
  for (const step of handoverClosing(lines, { memberSpeaks })) {
    narrator.beginRound()
    narrator.speak({
      utteranceId: `handover-close-${step.speaker}-${randomUUID()}`,
      text: step.text,
      ephemeral: true,
      ...speakerRequestFields(step.speaker === 'chief' ? chiefSpeakerVoice() : speakerForAssistantSync(assistantId)),
    })
  }
}

/** 取消还在生成/排队的快嘴。音频由调用方的打断统一处理，这里只管生成与缓冲。 */
function cancelFastAck(): void {
  const ack = activeAck
  if (!ack) return
  activeAck = null
  ack.cancelled = true
  ack.controller.abort()
  narrator.dropFeed(ack.utteranceId)
}

/** 主回复首句到达：掐掉旁路音频（若有），随后主回复接管队列。 */
function handoffFastAck(): void {
  const ack = activeAck
  if (!ack) return
  speechLog(`handoff ack->main spoken=${ack.spoken}`)
  cancelFastAck()
  if (ack.spoken) narrator.dropUtterance(ack.utteranceId)
}

function startFastAck(userText: string, bindingId: string, assistantId?: string): void {
  const service = fastReply
  if (!service || !service.load().enabled) return
  cancelFastAck()
  const ack: FastAckRound = { utteranceId: `ack-${randomUUID()}`, controller: new AbortController(), cancelled: false, spoken: false }
  activeAck = ack
  void (async () => {
    const text = await service.generate(userText, ack.controller.signal)
    if (text === null || ack.cancelled || activeAck !== ack) return
    if (bindingId !== sessionState?.bindingId || sessionState.status === 'disconnected') return
    if (spokenRound === null) return
    ack.spoken = true
    narrator.speak({ utteranceId: ack.utteranceId, text, ephemeral: true, ...speakerRequestFields(await speakerForAssistant(assistantId)) })
    sendToRenderer('fast-ack', { text })
  })().catch(() => {
    // 快嘴是锦上添花：任何异常都不影响主轨。
  })
}

/**
 * 静音（M1-06 三种动作之一）：停播放、丢弃本轮待播、暂停讲解链并解除本轮播报的本地等待。
 * 它**不向后台发取消**——后台请求与团队任务照常运行；要停后台用 cancelCommand 的定向取消。
 */
function interruptSpeech(remember = true): void {
  const chatRound = spokenRound !== null
  speechLog(`interrupt remember=${remember} round=${chatRound}`)
  cancelFastAck()
  // 唤醒应答被打断时同样要解锁界面：那句"我听见了"没播完也不该把开麦永远卡住。
  if (wakeGreeting !== null) finishWakeGreeting(wakeGreeting.utteranceId, '被打断')
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

/**
 * 讲解进行中的普通聊天（包括评委插话）带上文档上下文。
 *
 * 讲解链平时由桌面端逐段投递原文，模型手里只有当前段；用户插一句"下一段呢"时，模型没有
 * 任何途径看到下一段，只能回答"没有原文"，这在演示现场是致命的。短文档随消息附全文，
 * 长文档附当前段两侧滑窗，至少让它能如实回答关于相邻段的问题。
 *
 * 明确要求"讲下一段/第 N 段"的话不走这里：那是推进讲解，由 `moveDocTalk` 在本地完成。
 */
function presentationChatContext(): string {
  const talk = docTalk
  if (talk === null) return ''
  const sections = talk.outline.sections
  const section = sections[Math.min(Math.max(talk.next, 0), sections.length - 1)]
  if (section === undefined) return ''
  return [
    `（讲解上下文，只作资料：正在讲解《${talk.name}》，共 ${sections.length} 段，当前定位第 ${section.index + 1} 段「${section.heading ?? '无标题'}」。下面附的内容不要朗读，也不要据此主动往下讲；只在回答我的问题时参考。）`,
    presentationContext(talk.outline, section.index),
    '',
    '我的消息：',
  ].join('\n')
}

function withPresentationContext(text: string): string {
  const contextual = withInterruptedSpeech(text)
  const context = presentationChatContext()
  return context === '' ? contextual : `${context}\n${contextual}`
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

/** 桌面命令回执：只经 owner 凭据回传，失败只记日志，不反向影响本地操作。 */
async function replyDesktopCommand(id: string, ok: boolean, result?: unknown, error?: string): Promise<boolean> {
  try {
    const response = await bridge.companionRequest('POST', '/companion/v1/desktop/result',
      { id, ok, ...(ok ? { result } : { error: error ?? '桌面操作失败' }) }, 'owner')
    if (response.status !== 200) console.error(`[dsh-pet] desktop command result rejected: ${response.status}`)
    return response.status === 200
  } catch (cause) {
    console.error('[dsh-pet] desktop command result failed:', cause instanceof Error ? cause.message : String(cause))
    return false
  }
}

function meetingStatusView(): Record<string, unknown> | null {
  const state = meetingRecorder?.getState()
  if (!state) return null
  return { recording: state.recording, stopping: state.stopping, meetingId: state.meetingId, name: state.name,
    sources: state.sources, startedAt: state.startedAt, missingTracks: state.missingTracks,
    transcribe: state.transcribe, integrity: state.integrity, lastMeetingId: state.lastMeetingId,
    recent: state.recent.slice(0, 5).map(item => ({ id: item.id, name: item.name, startedAt: item.startedAt, state: item.state, integrity: item.integrity })) }
}

async function startMeetingFromDesktop(id: string, payload: Record<string, unknown>, expiresAt: number, presentationId?: string, confirmed: 'manual' | 'auto' | false = false): Promise<void> {
  const recorder = meetingRecorder
  if (!recorder) throw new Error('会议记录还没准备好')
  if (!win) throw new Error('舞台窗口不可用，不能打开会议页')
  const state = recorder.getState()
  if (state.recording || state.stopping) throw new Error('已有会议正在录制')
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error('会议名称需为 1-80 字且不含控制字符')
  const sources = payload.sources === 'mic' ? 'mic' : 'mic+loopback'
  const retentionDays = typeof payload.retentionDays === 'number' && Number.isSafeInteger(payload.retentionDays) ? payload.retentionDays : 30
  if (retentionDays < 1 || retentionDays > 3650) throw new Error('录音保留天数必须是 1-3650 的整数')
  if (pendingMeetingStart || pendingMeetingReady) throw new Error('已有一条会议启动请求正在等待桌面处理')
  const consent: MeetingConsentInput = { name, sources, retentionDays, consented: true,
    consentText: `本人于 ${new Date().toLocaleString('zh-CN')} ${confirmed === 'auto' ? '按会议和文档自动审批设置请求' : presentationId || confirmed ? '通过原生确认窗口同意' : '通过桌面指令要求'}开始本场会议录音；录音加密保存在本机，参会者应知情。` }
  const timer = setTimeout(() => {
    if (pendingMeetingStart?.id !== id) return
    pendingMeetingStart = null
    failMeetingPresentation(presentationId, '会议页未在时限内开始录音')
    void replyDesktopCommand(id, false, undefined, '会议页没有在时限内开始录音')
  }, Math.max(1, Math.min(15_000, expiresAt - Date.now())))
  timer.unref?.()
  pendingMeetingStart = { id, consent, timer, expiresAt, presentationId, autoApproved: confirmed === 'auto' }
  // 不自动弹设置页：命令接收与采集在 App 层常驻，无页面也能开录；
  // 会议页只在需要人审阅纪要或核查失败时打开。
  sendToRenderer('meeting-command', { requestId: id, consent })
}

async function stopMeetingFromDesktop(id: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  const recorder = meetingRecorder
  if (!recorder) throw new Error('会议记录还没准备好')
  const state = recorder.getState()
  const target = typeof payload.meetingId === 'string' && payload.meetingId ? payload.meetingId : state.meetingId ?? state.lastMeetingId
  if (!target) throw new Error('没有正在录制的会议')
  if (state.recording || state.stopping) {
    signal?.throwIfAborted()
    const result = recorder.requestStop(target)
    if (!result.ok) throw new Error(result.error)
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const integrity = recorder.getRecordingIntegrity(target)
    if (integrity?.status === 'complete') {
      await replyDesktopCommand(id, true, { meetingId: target, transcribe: recorder.getState().transcribe, integrity })
      return
    }
    if (integrity === null || integrity.status === 'incomplete' || integrity.status === 'unknown') {
      throw new Error(`会议已停止，但录音不完整或停止结果未知：${integrity?.reasons.join('；') || '没有可靠的停止回执'}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('已请求停止，但桌面没有在 30 秒内完成冲刷；请在会议页核对')
}

/** 新工具只接受发起时绑定的本人桌面会话，不把模型参数当成授权。 */
function independentBinding(payload: Record<string, unknown>): string {
  const bindingId = payload.bindingId
  if (typeof bindingId !== 'string' || !bindingId || bindingId !== sessionState?.bindingId || sessionState.status === 'disconnected') {
    throw new Error('桌面会话已变化或未连接，未执行操作')
  }
  return bindingId
}

async function startIndependentRecording(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  const bindingId = independentBinding(payload)
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const sources = payload.sources
  const days = payload.retentionDays
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)
    || (sources !== 'mic' && sources !== 'mic+loopback') || typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new Error('录音名称、范围或保留天数无效')
  }
  if (!meetingRecorder || meetingRecorder.getState().recording || meetingRecorder.getState().stopping) throw new Error('会议录音不可用或已有会议正在录制')
  const auto = loadSettings().meetingDocumentAutoApprove === true
  const confirmed = auto ? { response: 0 } : await dialog.showMessageBox({ type: 'question', title: '开始会议录音？',
    message: `开始录制 ${JSON.stringify(name)}？`,
    detail: `将采集${sources === 'mic' ? '麦克风' : '麦克风和系统回环'}音频，加密保存在本机，保留 ${days} 天；请确认参会者已知情。不会因此打开或讲解文档。`,
    buttons: ['同意开始', '取消'], defaultId: 1, cancelId: 1, noLink: true })
  signal.throwIfAborted()
  if (confirmed.response !== 0) throw new Error('本人未同意，录音没有开始')
  if (Date.now() >= expiresAt || independentBinding(payload) !== bindingId) throw new Error('录音请求已过期或会话已变化，未开录')
  await startMeetingFromDesktop(id, { name, sources, retentionDays: days }, expiresAt, undefined, auto ? 'auto' : 'manual')
}

async function stopIndependentRecording(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  const bindingId = independentBinding(payload)
  const recorder = meetingRecorder
  const before = recorder?.getState()
  if (!recorder || !before?.meetingId || (!before.recording && !before.stopping)) throw new Error('没有正在录制的会议')
  if (payload.meetingId !== undefined && (typeof payload.meetingId !== 'string' || payload.meetingId !== before.meetingId)) {
    throw new Error('会议编号已变化，未停止其他会议')
  }
  const confirmed = loadSettings().meetingDocumentAutoApprove === true ? { response: 0 } : await dialog.showMessageBox({ type: 'question', title: '停止会议录音？',
    message: '停止当前会议录音并核验冲刷结果？', detail: '只停止录音，不会因此停止独立文档讲解；纪要和发送仍需单独确认。',
    buttons: ['确认停录', '取消'], defaultId: 1, cancelId: 1, noLink: true })
  signal.throwIfAborted()
  if (confirmed.response !== 0) throw new Error('本人未同意停止，录音状态不变')
  if (Date.now() >= expiresAt || independentBinding(payload) !== bindingId || recorder.getState().meetingId !== before.meetingId) {
    throw new Error('停录请求已过期或会议已变化，未停止其他会议')
  }
  await stopMeetingFromDesktop(id, { meetingId: before.meetingId }, signal)
}

async function minutesFromDesktop(id: string, payload: Record<string, unknown>): Promise<void> {
  const recorder = meetingRecorder
  if (!recorder) throw new Error('会议记录还没准备好')
  const state = recorder.getState()
  if (state.recording || state.stopping) throw new Error('会议还在录制中，结束后才能生成纪要')
  const target = typeof payload.meetingId === 'string' && payload.meetingId ? payload.meetingId : state.lastMeetingId
  if (!target) throw new Error('还没有可整理纪要的会议记录')
  const integrity = recorder.getRecordingIntegrity(target)
  if (integrity === null && recorder.meetingName(target) === null) throw new Error('没有这场会议')
  if (integrity?.status !== 'complete') throw new Error('录音不完整或停止结果未知，不能由桌面任务自动生成完整纪要；请到会议页核对')
  const result = await recorder.generateModelMinutes(target, { userInitiated: true })
  if (!result.ok) { await replyDesktopCommand(id, false, undefined, result.error); return }
  await replyDesktopCommand(id, true, { meetingId: target, ...result })
}

async function documentListFromDesktop(id: string): Promise<void> {
  const files = await documents.candidates()
  await replyDesktopCommand(id, true, { roots: await documents.authorizedRoots(),
    files: files.slice(0, 100).map(file => ({ name: file.name, path: file.path, size: file.size, mtimeMs: file.mtimeMs })) })
}

async function openDocumentFromDesktop(payload: Record<string, unknown>): Promise<OpenedDoc> {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const explicitPath = typeof payload.path === 'string' ? payload.path.trim() : ''
  const target = explicitPath || name || docTalk?.path || ''
  if (!target) throw new Error('请给出文档名，或先在文档面板打开一份文档')
  let path = target
  if (!explicitPath && name) {
    const search = await documents.search(name)
    if (search.kind === 'found') path = search.hit.path
    else if (search.kind === 'ambiguous') throw new Error(`找到 ${search.hits.length} 份名字相近的文档；请先在文档面板选定一份`)
    else if (search.kind === 'denied') throw new Error('这份文档不在授权目录里，不能读取')
    else throw new Error('授权目录里没找到这份文档')
  }
  const opened = await documents.open(path)
  if (opened.kind === 'denied') throw new Error('这份文档不在授权目录里，不能读取')
  if (opened.kind === 'missing') throw new Error('文档已不在原来的位置')
  if (opened.kind === 'too-big') throw new Error('文档超过解析上限，不能读取')
  if (opened.kind === 'unreadable') throw new Error(`文档读不出来：${opened.reason}`)
  if (opened.doc.parsed.kind !== 'outline') throw new Error(`《${opened.doc.name}》没有可讲解的文字：${opened.doc.parsed.kind === 'empty' ? '内容为空' : '格式不支持或解析失败'}`)
  return opened.doc
}

async function documentReadFromDesktop(id: string, payload: Record<string, unknown>): Promise<void> {
  const doc = await openDocumentFromDesktop(payload)
  if (doc.parsed.kind !== 'outline') throw new Error('文档没有可讲解的提纲')
  const outline = doc.parsed.outline
  const section = typeof payload.section === 'number' && Number.isInteger(payload.section) ? payload.section : null
  if (section !== null && (section < 0 || section >= outline.sections.length)) throw new Error(`段号 ${section} 不存在；本文共 ${outline.sections.length} 段`)
  const maxChars = typeof payload.maxChars === 'number' && Number.isSafeInteger(payload.maxChars) ? Math.min(Math.max(payload.maxChars, 500), 20_000) : 12_000
  const selected = section === null ? outline.sections : [outline.sections[section]]
  const sections: Array<{ index: number; heading: string | null; pageNumber: number | null; hasCode: boolean; text: string }> = []
  let remaining = maxChars
  for (const item of selected) {
    const text = item.text.slice(0, Math.max(0, remaining))
    sections.push({ index: item.index, heading: item.heading, pageNumber: item.pageNumber ?? null, hasCode: item.hasCode, text })
    remaining -= text.length
    if (remaining <= 0) break
  }
  await replyDesktopCommand(id, true, { name: doc.name, title: outline.title, path: doc.path,
    fingerprint: doc.fingerprint, charCount: outline.charCount, estMinutes: outline.estMinutes,
    truncated: outline.truncated || remaining <= 0, sections })
}

/** 文档讲解只确认文档和模型去向；不创建会议、不申请音轨。 */
async function startIndependentDocument(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  const bindingId = independentBinding(payload)
  if (independentDocument && !['completed', 'partial', 'cancelled', 'failed'].includes(independentDocument.state)) {
    throw new Error('已有独立讲解正在准备或进行，请先结束')
  }
  if (docTalk && !docTalk.stopped) throw new Error('已有文档讲解正在进行，请先结束')
  const name = payload.documentName, file = payload.documentPath, from = payload.from ?? 0
  if ((name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 4096))
    || (file !== undefined && (typeof file !== 'string' || !file.trim() || file.length > 4096))
    || (name !== undefined && file !== undefined) || typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) {
    throw new Error('文档名称、路径或段号无效')
  }
  const presentation: IndependentDocumentPresentation = { id: randomUUID(), requestId: id, bindingId,
    path: '', name: '', fingerprint: '', from, total: 0, next: from, completed: [], talkId: null, assistantId: null,
    expiresAt, waitUntil: 0, receiptConfirmed: false, autoApproved: false, state: 'authorizing', error: null, timer: null }
  independentDocument = presentation
  const stillAuthorizing = () => independentDocument === presentation && presentation.state === 'authorizing'
    && !signal.aborted && Date.now() < expiresAt && sessionState?.bindingId === bindingId && sessionState.status !== 'disconnected'
  try {
    const doc = await openDocumentFromDesktop({ ...(typeof file === 'string' ? { path: file } : {}), ...(typeof name === 'string' ? { name } : {}) })
    if (!stillAuthorizing()) throw new Error('讲解请求已取消、过期或会话已变化')
    if (doc.parsed.kind !== 'outline' || from >= doc.parsed.outline.sections.length) throw new Error('讲解段号不存在')
    if (doc.parsed.outline.sections.length > 100) throw new Error('文档超过 100 段，请先拆分后再讲解')
    const display = (value: string) => JSON.stringify(value).replace(/[\u202a-\u202e\u2066-\u2069]/gu,
      character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
    const auto = loadSettings().meetingDocumentAutoApprove === true
    presentation.autoApproved = auto
    const confirmed = auto ? { response: 0 } : await dialog.showMessageBox({ type: 'question', title: '讲解文档？',
      message: `讲解 ${display(doc.name)}？`,
      detail: `文档：${display(doc.path)}\n文档摘要：${doc.fingerprint}\n共 ${doc.parsed.outline.sections.length} 段。` +
        '\n讲解会将文档片段发送给当前会话的模型服务商，并进入会话历史；逐段讲解和重试可能产生额外费用。讲解时会监听麦克风以支持插话，不会启动或停止会议录音。',
      buttons: ['同意讲解', '取消'], defaultId: 1, cancelId: 1, noLink: true })
    signal.throwIfAborted()
    if (confirmed.response !== 0) throw new Error('本人未同意，文档讲解没有开始')
    if (!stillAuthorizing()) throw new Error('讲解请求已取消、过期或会话已变化')
    const current = await documents.open(doc.path)
    signal.throwIfAborted()
    if (!stillAuthorizing() || (auto && loadSettings().meetingDocumentAutoApprove !== true) || current.kind !== 'opened' || current.doc.fingerprint !== doc.fingerprint) {
      throw new Error('文档、授权或会话已变化，未开始讲解')
    }
    presentation.path = doc.path
    presentation.name = doc.name
    presentation.fingerprint = doc.fingerprint
    presentation.total = doc.parsed.outline.sections.length
    presentation.assistantId = (await presentationMember()) ?? null
    const delegateName = presentation.assistantId ? await memberDisplayName(presentation.assistantId) : ''
    presentation.state = 'waiting-to-present'
    presentation.waitUntil = Date.now() + PRESENT_WAIT_CAP_MS
    armIndependentDocumentDeadline(presentation)
    const delivered = await replyDesktopCommand(id, true, { presentationId: presentation.id, state: presentation.state,
      documentName: presentation.name, total: presentation.total,
      notice: `${auto ? '已按设置自动审批' : '本人已确认'}；${delegateName ? `交给「${delegateName}」，` : ''}等待当前会话和播报结束后再开讲，不代表已经讲完。` })
    if (!delivered) { failIndependentDocument(presentation, '讲解回执未确认，未自动开讲，请在桌面核查。'); return }
    if (!signal.aborted && independentDocument === presentation && presentation.state === 'waiting-to-present') {
      presentation.receiptConfirmed = true
      void maybeStartIndependentDocument()
    }
  } catch (error) {
    failIndependentDocument(presentation, error instanceof Error ? error.message : String(error))
    throw error
  }
}

function armIndependentDocumentDeadline(presentation: IndependentDocumentPresentation): void {
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = setTimeout(() => failIndependentDocument(presentation, '等待开讲超过 10 分钟上限，请重新发起。'),
    Math.max(1, presentation.waitUntil - Date.now()))
  presentation.timer.unref?.()
}

/** 等当前模型轮次和播报结束；录音状态不参与讲解准入。 */
/**
 * 交接表演：总助交棒 → 成员接棒。
 *
 * 为什么要在**派活那一刻**就演，而不是等讲解真的开讲：
 * 开讲闸门要等会话空闲，忙的时候可能等很久甚至超时；一旦超时，用户从头到尾
 * 既没听到小会开口、也没看到它登场，只看见总助说了句"我交给小会了"。
 * 所以交接必须绑在"话已经说出口"这个时刻，和讲不讲得成解耦。
 *
 * `key` 用来去重：同一件事只演一次，讲解真正开始时不会再念一遍。
 */
/*
  按"成员 + 时间"再去一次重：派工与开讲用的是两套 key（presentation.id / talk.sessionId），
  只按 key 去重会把同一段交接台词念两遍——用户听到的就是"说了两次"。
*/
let lastHandoverMember = ''
let lastHandoverAt = 0
const HANDOVER_REPEAT_MS = 10 * 60_000
const handoverPerformed = new Set<string>()

function speakMemberHandover(assistantId: string | undefined, key: string): boolean {
  if (loadSettings().memberHandover === false) return false
  if (assistantId === undefined || assistantId === '') return false
  if (lastHandoverMember === assistantId && Date.now() - lastHandoverAt < HANDOVER_REPEAT_MS) return false
  if (handoverPerformed.has(key)) return false
  lastHandoverMember = assistantId
  lastHandoverAt = Date.now()
  handoverPerformed.add(key)
  const who = memberNamesCache?.names.get(assistantId) ?? ''
  const lines = handoverLinesCache.get(assistantId) ?? fixedHandoverLines(who === '' ? '成员' : who)
  // 总助交代 → 叫人 → 成员应声 → 成员开口；舞台换人由 doc-state 的 active/assistantId 驱动。
  for (const step of handoverOpening(lines, { chiefPresent: true })) {
    narrator.beginRound()
    narrator.speak({
      utteranceId: `handover-${step.speaker}-${randomUUID()}`,
      text: step.text,
      ephemeral: true,
      ...speakerRequestFields(step.speaker === 'chief' ? chiefSpeakerVoice() : speakerForAssistantSync(assistantId)),
    })
  }
  return true
}

async function maybeStartIndependentDocument(): Promise<void> {
  const presentation = independentDocument
  if (!presentation || !presentation.receiptConfirmed || (presentation.state !== 'waiting-to-present' && presentation.state !== 'waiting-to-resume')) return
  /*
    先演交接，再看闸门。
    闸门要等会话空闲，忙的时候会一直等甚至超时；把交接绑在开讲上，
    超时的时候用户只会听到总助说"交给小会了"，从头到尾没有小会登场。
    所以这里先播交接台词，播完下一拍再判断能不能开讲。
  */
  if (!narrator.isSpeaking() && !spokenRound && submissionCount === 0
    && speakMemberHandover(presentation.assistantId ?? undefined, presentation.id)) return
  if (Date.now() >= presentation.waitUntil || sessionState?.bindingId !== presentation.bindingId || sessionState.status === 'disconnected'
    || (presentation.autoApproved && loadSettings().meetingDocumentAutoApprove !== true)) {
    failIndependentDocument(presentation, '等待开讲超时或会话已变化，未继续。')
    return
  }
    if (sessionState.status !== 'idle' || submissionCount > 0 || spokenRound || narrator.isSpeaking()) return
  const resuming = presentation.state === 'waiting-to-resume'
  presentation.state = 'starting'
  const allowed = () => independentDocument === presentation && presentation.state === 'starting'
      && Date.now() < presentation.waitUntil && sessionState?.bindingId === presentation.bindingId && sessionState.status === 'idle'
    && submissionCount === 0 && !spokenRound && !narrator.isSpeaking()
    && (!presentation.autoApproved || loadSettings().meetingDocumentAutoApprove === true)
  try {
    const result = resuming ? await resumeDocTalk(true)
      : await explainDocByPath(presentation.path, presentation.from, true, presentation.assistantId ?? undefined, true, 'auto',
        { fingerprint: presentation.fingerprint, allowed })
    if (independentDocument !== presentation || presentation.state !== 'starting') return
    if (!result.ok || !docTalk || docTalk.path !== presentation.path || docTalk.fingerprint !== presentation.fingerprint) {
      failIndependentDocument(presentation, result.error ?? '文档讲解未能开始，请在桌面核查。')
      return
    }
    presentation.talkId = docTalk.sessionId
    presentation.state = 'presenting'
    if (presentation.timer) clearTimeout(presentation.timer)
    presentation.timer = null
  } catch (error) { failIndependentDocument(presentation, `文档讲解未能开始：${error instanceof Error ? error.message : String(error)}`) }
}

function independentDocumentStatus(): Record<string, unknown> {
  const presentation = independentDocument
  if (!presentation) return { state: 'idle', notice: '当前没有通过独立工具发起的讲解。' }
  const talk = presentation.talkId && docTalk?.sessionId === presentation.talkId ? docTalk : null
  return { presentationId: presentation.id, documentName: presentation.name,
    state: talk?.stopped && presentation.state === 'presenting' ? 'paused' : presentation.state,
    next: talk?.next ?? presentation.next, total: presentation.total,
    completed: talk ? [...talk.completed].sort((a, b) => a - b) : presentation.completed, error: presentation.error,
    notice: '开始或等待状态不代表已完整播放；录音状态独立。' }
}

async function controlIndependentDocument(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  const bindingId = independentBinding(payload)
  const action = payload.action
  if (!['pause', 'resume', 'stop', 'status'].includes(String(action))) throw new Error('讲解操作无效')
  const presentation = independentDocument
  if (payload.presentationId !== undefined && (typeof payload.presentationId !== 'string' || !payload.presentationId
    || payload.presentationId.length > 200 || payload.presentationId !== presentation?.id)) throw new Error('讲解编号不匹配')
  if (presentation && presentation.bindingId !== bindingId) throw new Error('讲解属于旧会话，不能继续')
  signal.throwIfAborted()
  if (action === 'status') { await replyDesktopCommand(id, true, independentDocumentStatus()); return }
  if (!presentation || ['completed', 'partial', 'cancelled', 'failed'].includes(presentation.state)) throw new Error('没有可控制的独立文档讲解')
  if (action === 'stop') {
    cancelIndependentDocument('本人已结束独立讲解；会议录音状态不变。')
  } else if (action === 'pause') {
    if (presentation.state === 'authorizing') cancelIndependentDocument('本人已取消等待确认的讲解。')
    else {
      presentation.state = 'paused'
      clearDocAutoResume()
      if (presentation.talkId && docTalk?.sessionId === presentation.talkId) {
        if (!docTalk.stopped) { if (spokenRound) pauseDocTalk(); else interruptSpeech(false) }
        pushDocState()
      }
    }
  } else {
    if (presentation.state !== 'paused') throw new Error('讲解没有处于暂停状态')
    if (!presentation.talkId && Date.now() >= presentation.waitUntil) throw new Error('原讲解等待已超时，请重新发起')
    if (presentation.talkId) presentation.expiresAt = expiresAt
    presentation.waitUntil = Date.now() + PRESENT_WAIT_CAP_MS
    presentation.receiptConfirmed = false
    presentation.state = presentation.talkId ? 'waiting-to-resume' : 'waiting-to-present'
    armIndependentDocumentDeadline(presentation)
  }
  const delivered = await replyDesktopCommand(id, true, independentDocumentStatus())
  if (action === 'resume' && independentDocument === presentation) {
    if (delivered && !signal.aborted && (presentation.state === 'waiting-to-present' || presentation.state === 'waiting-to-resume')) {
      presentation.receiptConfirmed = true
      void maybeStartIndependentDocument()
    } else if (presentation.state === 'waiting-to-present' || presentation.state === 'waiting-to-resume') {
      presentation.state = 'paused'
    }
  }
}

/** 原生确认锁定会议与文档；音轨就绪前只开启采集，不开讲。 */
async function startMeetingPresentationFromDesktop(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  if (!meetingRecorder || !sessionState || sessionState.status === 'disconnected') throw new Error('会议或助理会话尚未就绪')
  if (meetingRecorder.getState().recording || meetingRecorder.getState().stopping) throw new Error('已有会议正在录制')
  if (meetingPresentation && !['completed', 'partial', 'awaiting-review', 'cancelled', 'failed'].includes(meetingPresentation.state)) throw new Error('已有会议讲解正在进行')
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error('会议名称需为 1-80 字且不含控制字符')
  const retentionDays = typeof payload.retentionDays === 'number' && Number.isSafeInteger(payload.retentionDays) ? payload.retentionDays : 30
  if (retentionDays < 1 || retentionDays > 3650) throw new Error('录音保留天数必须是 1-3650 的整数')
  const documentPath = typeof payload.documentPath === 'string' ? payload.documentPath.trim() : ''
  const documentName = typeof payload.documentName === 'string' ? payload.documentName.trim() : ''
  if (!documentPath && !documentName) throw new Error('请明确选择要讲解的文档')
  const bindingId = sessionState.bindingId
  const stillBound = (): boolean => sessionState?.bindingId === bindingId && sessionState.status !== 'disconnected'
  const doc = await openDocumentFromDesktop({ ...(documentPath ? { path: documentPath } : { name: documentName }) })
  signal.throwIfAborted()
  if (doc.parsed.kind !== 'outline' || doc.parsed.outline.sections.length > 100) {
    throw new Error('会议讲解最多支持 100 段，请先拆分文档；尚未开始录音')
  }
  if (Date.now() >= expiresAt || !stillBound()) throw new Error('会议请求已过期或会话已切换')
  if (meetingPresentation && !['completed', 'partial', 'awaiting-review', 'cancelled', 'failed'].includes(meetingPresentation.state)) throw new Error('已有会议讲解正在进行')
  const presentation: MeetingPresentation = { id: randomUUID(), requestId: id, bindingId, meetingName: name,
    documentName: doc.name, documentPath: doc.path, fingerprint: doc.fingerprint, expiresAt, waitUntil: 0,
    meetingId: null, talkId: null, assistantId: null, finishRequestId: null, recordRevision: 0, state: 'authorizing', lectureOutcome: null, error: null, next: 0,
    total: doc.parsed.kind === 'outline' ? doc.parsed.outline.sections.length : 0, completed: [], timer: null }
  meetingPresentation = presentation
  try {
    const display = (value: string): string => JSON.stringify(value).replace(/[\u202a-\u202e\u2066-\u2069]/gu,
      character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
    const outline = doc.parsed.kind === 'outline' ? doc.parsed.outline : null
    const limited = outline && (outline.truncated || outline.sections.some(section => section.text.trim() === '' || section.hasCode))
    const auto = loadSettings().meetingDocumentAutoApprove === true
    const confirmed = auto ? { response: 0 } : await dialog.showMessageBox({ type: 'question', title: '开始会议并讲解文档？',
      message: `开始录制 ${display(name)} 并讲解 ${display(doc.name)}？`,
      detail: `将采集麦克风和系统回环音频，加密保存在本机，保留 ${retentionDays} 天；请确认参会者已知情。\n` +
        `文档共 ${doc.parsed.outline.sections.length} 段，预计 ${doc.parsed.outline.estMinutes} 分钟；逐段讲解、重试和插话可能多次调用模型。\n` +
        `文档：${display(doc.path)}\n文档摘要：${doc.fingerprint}\n讲解会将文档片段发送给当前会话的模型服务商，并进入会话历史。` +
        (limited ? '\n文档含截断、不可提取段落或代码，系统只能讲解可提取文字，不会声称完整覆盖。' : '') +
        '\n纪要确认、保存和邮件外发仍需另行确认。',
      buttons: ['同意开始', '取消'], defaultId: 1, cancelId: 1, noLink: true })
    signal.throwIfAborted()
    if (meetingPresentation !== presentation || presentation.state !== 'authorizing') throw new Error('会议讲解请求已取消')
    if (confirmed.response !== 0) { cancelMeetingPresentation('本人未同意，会议没有开始'); throw new Error('本人未同意，会议没有开始') }
    if (Date.now() >= expiresAt || !stillBound() || (auto && loadSettings().meetingDocumentAutoApprove !== true)) throw new Error('会议请求已过期、会话已切换或自动审批已关闭')
    const current = await documents.open(doc.path)
    signal.throwIfAborted()
    if (meetingPresentation !== presentation || presentation.state !== 'authorizing') throw new Error('会议讲解请求已取消')
    if (current.kind !== 'opened' || current.doc.fingerprint !== doc.fingerprint) throw new Error('文档或授权在确认期间已变化，会议没有开始')
    if (Date.now() >= expiresAt || !stillBound() || (auto && loadSettings().meetingDocumentAutoApprove !== true)) throw new Error('会议请求已过期、会话已切换或自动审批已关闭')
    presentation.assistantId = (await presentationMember()) ?? null
    presentation.state = 'opening'
    if (!persistMeetingPresentation(presentation)) throw new Error(presentation.error ?? '会议讲解状态无法保存')
    await startMeetingFromDesktop(id, { name, sources: 'mic+loopback', retentionDays }, expiresAt, presentation.id, auto ? 'auto' : 'manual')
  } catch (error) {
    failMeetingPresentation(presentation.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** 等原会话回答和播报真正结束，避免讲解反过来取消自己的发起请求。 */
async function maybeStartMeetingPresentation(): Promise<void> {
  const presentation = meetingPresentation
  if (!presentation || presentation.state !== 'waiting-to-present') return
  if (presentation.finishRequestId) return
  if (Date.now() >= presentation.waitUntil) { failMeetingPresentation(presentation.id, '等待开讲超过 10 分钟上限；会议可能仍在录音，请在会议页核查。'); return }
  if (!sessionState || sessionState.bindingId !== presentation.bindingId || sessionState.status === 'disconnected') {
    failMeetingPresentation(presentation.id, '会话已变化，未开始讲解；请在会议页核查录音。')
    return
  }
  if (sessionState.status !== 'idle' || submissionCount > 0 || spokenRound || narrator.isSpeaking()) return
  const ready = (): boolean => {
    const state = meetingRecorder?.getState()
    return meetingPresentation === presentation && presentation.state === 'starting' && Date.now() < presentation.waitUntil
      && sessionState?.bindingId === presentation.bindingId && sessionState.status === 'idle' && submissionCount === 0
      && !spokenRound && !narrator.isSpeaking() && state?.meetingId === presentation.meetingId && state.recording && !state.stopping
      && state.sources === 'mic+loopback' && state.missingTracks.length === 0
      && ['mic', 'loopback'].every(track => state.tracks.some(item => item.track === track && item.chunks > 0))
  }
  presentation.state = 'starting'
  if (!persistMeetingPresentation(presentation)) return
  if (!ready()) { failMeetingPresentation(presentation.id, '双轨或会话已变化，未开始讲解；请在会议页核查。'); return }
  try {
    const result = await explainDocByPath(presentation.documentPath, 0, true, presentation.assistantId ?? undefined, false, 'auto',
      { fingerprint: presentation.fingerprint, allowed: ready })
    const stateAfterAwait = (): MeetingPresentationState => presentation.state
    if (meetingPresentation === presentation && stateAfterAwait() === 'paused' && result.ok && docTalk?.path === presentation.documentPath) {
      presentation.talkId = docTalk.sessionId
      persistMeetingPresentation(presentation)
      return
    }
    if (meetingPresentation !== presentation || presentation.state !== 'starting') return
    if (!result.ok || !docTalk || docTalk.path !== presentation.documentPath) {
      failMeetingPresentation(presentation.id, result.error ?? '文档讲解没有开始，请在会议页核查录音。')
      return
    }
    presentation.talkId = docTalk.sessionId
    presentation.state = 'presenting'
    if (presentation.timer) clearTimeout(presentation.timer)
    presentation.timer = null
    if (!persistMeetingPresentation(presentation)) { interruptSpeech(false); stopDocTalk(); pushDocState() }
  } catch (error) { failMeetingPresentation(presentation.id, `文档讲解未开始：${error instanceof Error ? error.message : String(error)}`) }
}

function waitForMeetingStep<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error: Error | null, value?: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const abort = (): void => finish(new Error('会议后续步骤已取消'))
    const timer = setTimeout(() => finish(new Error('等待会议步骤超时，请在会议页核查')), Math.max(1, timeoutMs))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(value => finish(null, value), error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

/** 停录和转写有各自回执；只打开草稿等待审阅，不自动确认、保存或外发。 */
async function finishMeetingPresentationFromDesktop(id: string, payload: Record<string, unknown>, expiresAt: number, signal: AbortSignal): Promise<void> {
  const presentation = meetingPresentation
  const recorder = meetingRecorder
  if (!presentation || !recorder || typeof payload.presentationId !== 'string' || payload.presentationId !== presentation.id || !presentation.meetingId) {
    throw new Error('会议讲解编号不匹配，请在会议页核查')
  }
  if (presentation.finishRequestId) throw new Error('本场会议已有结束请求正在处理')
  if (sessionState?.bindingId !== presentation.bindingId || sessionState.status === 'disconnected') throw new Error('会话已切换，请在会议页核查')
  presentation.finishRequestId = id
  let stopRequested = false
  try {
    const confirmed = loadSettings().meetingDocumentAutoApprove === true ? { response: 0 } : await dialog.showMessageBox({ type: 'question', title: '结束会议录音？',
      message: `停止「${presentation.meetingName}」的录音并转写？`,
      detail: `${presentation.state === 'completed' ? '' : '当前讲解未完整完成，停录后不会自动续讲。\n'}将先冲刷并核验两条音轨，再等待转写。纪要需要本人审阅确认；不会自动保存文件或发送邮件。`,
      buttons: ['停止并转写', '取消'], defaultId: 1, cancelId: 1, noLink: true })
    signal.throwIfAborted()
    if (confirmed.response !== 0) throw new Error('本人未同意停止，会议录音状态不变')
    if (Date.now() >= expiresAt || meetingPresentation !== presentation || sessionState?.bindingId !== presentation.bindingId) {
      throw new Error('结束请求已过期或会话已切换，未请求停录')
    }
    const current = recorder.getState()
    if (current.meetingId && current.meetingId !== presentation.meetingId) throw new Error('当前会议已切换，未停止其他会议')
    presentation.lectureOutcome = presentation.state === 'completed' ? 'completed' : presentation.state === 'partial' ? 'partial' : 'interrupted'
    presentation.state = 'stopping'
    if (presentation.timer) clearTimeout(presentation.timer)
    presentation.timer = null
    if (!persistMeetingPresentation(presentation)) {
      if (docTalk && presentation.talkId === docTalk.sessionId) { interruptSpeech(false); stopDocTalk(); pushDocState() }
      throw new Error(presentation.error ?? '会议步骤无法保存，未请求停录')
    }
    if (docTalk && presentation.talkId === docTalk.sessionId) { interruptSpeech(false); stopDocTalk(); pushDocState() }
    const stopped = recorder.requestStop(presentation.meetingId)
    if (!stopped.ok) throw new Error(stopped.error)
    stopRequested = true
    const deadline = Math.min(expiresAt, Date.now() + 30_000)
    for (;;) {
      signal.throwIfAborted()
      const integrity = recorder.getRecordingIntegrity(presentation.meetingId)
      if (integrity?.status === 'complete') break
      if (!integrity || integrity.status === 'incomplete' || integrity.status === 'unknown') {
        throw new Error(`停录不完整或结果未知：${integrity?.reasons.join('；') || '没有可靠的冲刷回执'}`)
      }
      if (Date.now() >= deadline) throw new Error('已请求停录，但没有在时限内收到完整冲刷回执')
      await waitForMeetingStep(new Promise<void>(resolve => setTimeout(resolve, 200)), signal, Math.min(1000, deadline - Date.now()))
    }
    presentation.state = 'transcribing'
    if (!persistMeetingPresentation(presentation)) throw new Error(presentation.error ?? '转写状态无法保存')
    await waitForMeetingStep(recorder.whenSettled(), signal, Math.min(300_000, expiresAt - Date.now()))
    signal.throwIfAborted()
    if (meetingPresentation !== presentation || sessionState?.bindingId !== presentation.bindingId || Date.now() >= expiresAt) {
      throw new Error('会话已变化或请求超时，转写结果请在会议页核查')
    }
    const status = recorder.transcriptionStatus(presentation.meetingId)
    if (!status.ok || !status.complete) throw new Error(status.ok ? status.issue ?? '转写未完成' : status.error)
    const minutes = recorder.getMinutes(presentation.meetingId)
    if (!minutes.ok || !minutes.minutes || minutes.minutes.stale || minutes.minutes.undecryptable || minutes.revision !== status.revision) {
      throw new Error('转写已结束，但当前纪要草稿无法核验，请在会议页核查')
    }
    presentation.state = 'awaiting-review'
    presentation.error = null
    if (!persistMeetingPresentation(presentation)) throw new Error(presentation.error ?? '会后状态无法保存')
    openSettings('meeting')
    sendToRenderer('doc-notice', '录音和转写已核验，请在会议页审阅纪要；尚未确认、保存文件或发送邮件。')
    await replyDesktopCommand(id, true, { presentationId: presentation.id, meetingId: presentation.meetingId,
      state: 'awaiting-review', lectureOutcome: presentation.lectureOutcome, revision: status.revision, minutesState: minutes.minutes.state,
      notice: '已核验停录及转写；请本人审阅纪要，确认并选择目录保存后，再单独批准邮件和提醒。' })
  } catch (error) {
    if (signal.aborted) cancelMeetingPresentation('会议后续步骤已取消；停录或转写是否完成请在会议页核查。')
    else {
      const reason = error instanceof Error ? error.message : String(error)
      if (stopRequested || presentation.state === 'stopping' || presentation.state === 'transcribing') {
        failMeetingPresentation(presentation.id, `${stopRequested ? '停录已请求，但后续未完成' : '未能确认停录'}：${reason}`)
        openSettings('meeting')
      }
    }
    throw error
  } finally {
    if (presentation.finishRequestId === id) presentation.finishRequestId = null
    if (presentation.state === 'waiting-to-present') void maybeStartMeetingPresentation()
  }
}

async function handleDesktopCommand(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const value = raw as { id?: unknown; command?: unknown; payload?: unknown; expiresAt?: unknown }
  if (typeof value.id !== 'string' || typeof value.command !== 'string') return
  if (typeof value.expiresAt !== 'number' || value.expiresAt < Date.now()) return
  if (desktopCommandControllers.has(value.id)) return
  const controller = new AbortController()
  desktopCommandControllers.set(value.id, controller)
  const payload = value.payload !== null && typeof value.payload === 'object' && !Array.isArray(value.payload)
    ? value.payload as Record<string, unknown> : {}
  try {
    // 命令事件可在重连时重放，执行前必须向宿主领取一次且核对完整参数。
    const claimed = await bridge.companionRequest('POST', '/companion/v1/desktop/claim', value, 'owner')
    if (claimed.status !== 200 || (claimed.body as { claimed?: unknown } | null)?.claimed !== true
      || controller.signal.aborted || value.expiresAt <= Date.now()) return
    switch (value.command) {
      case 'meeting.start': await startMeetingFromDesktop(value.id, payload, value.expiresAt); return
      case 'meeting.recording.start': await startIndependentRecording(value.id, payload, value.expiresAt, controller.signal); return
      case 'meeting.recording.stop': await stopIndependentRecording(value.id, payload, value.expiresAt, controller.signal); return
      case 'document.presentation.start': await startIndependentDocument(value.id, payload, value.expiresAt, controller.signal); return
      case 'document.presentation.control': await controlIndependentDocument(value.id, payload, value.expiresAt, controller.signal); return
      case 'meeting.presentation.start': await startMeetingPresentationFromDesktop(value.id, payload, value.expiresAt, controller.signal); return
      case 'meeting.presentation.finish': await finishMeetingPresentationFromDesktop(value.id, payload, value.expiresAt, controller.signal); return
      case 'meeting.presentation.status': {
        const live = meetingPresentationStatus()
        if (payload.presentationId !== undefined && (typeof payload.presentationId !== 'string' || !payload.presentationId || payload.presentationId.length > 200)) {
          throw new Error('会议讲解编号无效')
        }
        const requested = typeof payload.presentationId === 'string' ? payload.presentationId : undefined
        const status = requested && live?.id !== requested ? meetingRecorder?.savedPresentationStatus(requested) ?? null
          : live ?? meetingRecorder?.savedPresentationStatus() ?? null
        if (!status) throw new Error('没有这条会议讲解记录或记录不可解密')
        await replyDesktopCommand(value.id, true, status)
        return
      }
      case 'meeting.stop': await stopMeetingFromDesktop(value.id, payload); return
      case 'meeting.minutes': await minutesFromDesktop(value.id, payload); return
      case 'meeting.artifact.list': {
        if (!meetingRecorder) throw new Error('会议记录还没准备好')
        const meetingId = typeof payload.meetingId === 'string' && payload.meetingId ? payload.meetingId : meetingRecorder.getState().lastMeetingId
        if (!meetingId || meetingRecorder.meetingName(meetingId) === null) throw new Error('没有这场会议')
        await replyDesktopCommand(value.id, true, { meetingId, artifacts: meetingRecorder.listMinutesArtifacts(meetingId),
          notice: '列表不代表文件仍有效；准备发送和批准后都会重新核验。' })
        return
      }
      case 'meeting.artifact.read': {
        if (!meetingRecorder || typeof payload.artifactId !== 'string' || !payload.artifactId) throw new Error('纪要产物参数无效')
        const artifact = meetingRecorder.readMinutesArtifact(payload.artifactId)
        if (!artifact.ok) throw new Error(artifact.error)
        if (artifact.content.length > 50_000) throw new Error('纪要超过邮件正文上限，未交接；请先人工处理')
        await replyDesktopCommand(value.id, true, artifact)
        return
      }
      case 'workbench.open': {
        // 插件的工作台快捷入口（待办 / 会议 / 日报 / 助理团）用它把窗口叫到对应页。
        // 只做"打开并切页"：不写库、不改任何业务状态，页面参数在白名单里校验。
        const page = typeof payload?.page === 'string' ? payload.page : ''
        if (!WORKBENCH_PAGES.includes(page as (typeof WORKBENCH_PAGES)[number])) {
          await replyDesktopCommand(value.id, false, undefined, '要打开工作台的哪一页？')
          return
        }
        openSettings(page as SettingsPage)
        await replyDesktopCommand(value.id, true, { page })
        return
      }
      case 'meeting.count': {
        // 插件工作台的"今天几场会"。只读：不解密会议名、不碰录音状态，只按 startedAt 计数。
        // from/to 由调用方给（今天 0 点到 now+1）；缺省时按"至今全部"处理，便于手工排查。
        if (!meetingRecorder) throw new Error('会议记录还没准备好')
        const from = typeof payload?.from === 'number' && Number.isFinite(payload.from) ? payload.from : 0
        const to = typeof payload?.to === 'number' && Number.isFinite(payload.to) ? payload.to : Date.now()
        const meetings = meetingRecorder.listMeetings(50)
        const count = meetings.filter(meeting => meeting.startedAt >= from && meeting.startedAt < to).length
        await replyDesktopCommand(value.id, true, { count, scanned: meetings.length, from, to })
        return
      }
      case 'meeting.list': {
        // 插件工作台的会议列表（时间 | 名称 | 状态）。只读：不改状态、不解密以外的事。
        // 名称沿用会议记录里的展示名；解不开的记录由 store 给占位文本，这里原样带出去，
        // 让用户至少看见"有一场会"而不是整行消失。
        if (!meetingRecorder) throw new Error('会议记录还没准备好')
        const from = typeof payload?.from === 'number' && Number.isFinite(payload.from) ? payload.from : 0
        const to = typeof payload?.to === 'number' && Number.isFinite(payload.to) ? payload.to : Date.now()
        const limit = typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? Math.min(Math.max(Math.floor(payload.limit), 1), 50) : 10
        const meetings = meetingRecorder.listMeetings(50)
          .filter(meeting => meeting.startedAt >= from && meeting.startedAt < to)
          .slice(0, limit)
          .map(meeting => ({ startedAt: meeting.startedAt, name: meeting.name, state: meeting.state }))
        await replyDesktopCommand(value.id, true, { meetings })
        return
      }
      case 'settings.summary': {
        // 插件工作台「设置」tab 要显示的三行真值。
        //
        // **纯读**：只 `audioPrefs()` / `loadSettings()` 取当前值，然后原样带出去。
        // 不调 `applyAudio`（那会起停采集）、不写文件、不改任何内存状态 ——
        // 一条"让我看看设置"的命令绝不该有副作用。
        //
        // 只回三项：唤醒 / 播报 / 讲解模式。「悬停工具栏」在主进程没有持久化设置
        // （它是渲染层 localStorage），这里**不编值**，由前端那一格继续显示占位。
        const prefs = audioPrefs()
        const settings = loadSettings()
        await replyDesktopCommand(value.id, true, {
          wakeEnabled: prefs.wakeEnabled === true,
          wakeVoiceprint: prefs.wakeVoiceprint === true,
          wakeDuringSpeech: prefs.wakeDuringSpeech === true,
          bargeIn: prefs.bargeIn === true,
          readReplies: settings.readReplies === true,
          docSpeechMode: settings.docSpeechMode === 'ai' ? 'ai' : 'source',
        /* 音色（描述 / 克隆 ID / 复刻样本）也必须回读：缺了它设置页就永远显示空白。 */
        agentVoiceDesign: settings.agentVoiceDesign ?? '',
        agentVoiceId: settings.agentVoiceId ?? '',
        agentVoiceSample: settings.agentVoiceSample ?? '',
        agentVoiceSampleMime: settings.agentVoiceSampleMime ?? '',
        agentVoiceStyle: settings.agentVoiceStyle ?? '',
          petScale: settings.petScale,
          petOpacity: settings.petOpacity,
        })
        return
      }
      case 'meeting.history': {
        // 工作台「会议」tab 的历史列表。纯读：不解密音频、不改任何会议状态。
        // 映射规则（四种转写状态、limit 夹取）在 `meeting-history.ts`，那边有逐条单测。
        if (!meetingRecorder) throw new Error('会议记录还没准备好')
        await replyDesktopCommand(value.id, true, {
          meetings: meetingHistoryRows(meetingRecorder.listMeetings(HISTORY_MAX_LIMIT), payload?.limit),
        })
        return
      }
      case 'settings.set': {
        // 插件工作台「设置」tab 的写入口。**只有三项**，值域白名单，非法一律不落盘。
        //
        // 写盘走的是与设置页完全相同的那条路径（audioPrefsStore.update / saveSettings），
        // 所以"页面改完、设置页没变"这种事不会发生。改完**立刻回读**确认，回读不一致就报错，
        // 绝不回 applied:true 假装成功。
        const rawKey: unknown = payload?.key
        const rawValue: unknown = payload?.value
        const key = typeof rawKey === 'string' ? rawKey : ''
        const next = typeof rawValue === 'string' ? rawValue : ''
        // 先落到 const 上再用：`value.id` 的窄化在闭包里会失效（对象属性可能在闭包执行前被改），
        // 直接在 `refuse` 里用会退化成 unknown。
        const commandId = value.id
        const refuse = async (reason: string): Promise<void> => {
          await replyDesktopCommand(commandId, false, undefined, reason)
        }
        if (key === 'wake') {
          if (next !== 'on' && next !== 'off') { await refuse('不支持的设置项'); return }
          const want = next === 'on'
          if (audioPrefs().wakeEnabled !== want) {
            audioPrefsStore!.update({ wakeEnabled: want })
            if (!want) wakeProblem = null
            // 与设置页同一个动作：让监听真的起/停。
            applyAudio({ type: 'wake-config', enabled: want })
          }
          if (audioPrefs().wakeEnabled !== want) { await refuse('设置没能写入磁盘，请重试'); return }
          // 开启时确认"真的能用"：能力/模型缺失这类失败是同步就确定的（见 startWake），
          // 如实把原因带回去，不吞掉。
          if (want && audioState.wakeUnavailable) {
            await refuse(`唤醒没能启动：${wakeProblem ?? '原因未知'}`)
            return
          }
          await replyDesktopCommand(commandId, true, { key, value: next, applied: true })
          return
        }
        if (key === 'broadcast') {
          if (next !== 'all' && next !== 'voice') { await refuse('不支持的设置项'); return }
          const wantRead = next === 'all'
          saveSettings({ readReplies: wantRead })
          if ((loadSettings().readReplies === true) !== wantRead) { await refuse('设置没能写入磁盘，请重试'); return }
          await replyDesktopCommand(commandId, true, { key, value: next, applied: true })
          return
        }
        if (key === 'docSpeech') {
          if (next !== 'source' && next !== 'ai') { await refuse('不支持的设置项'); return }
          saveSettings({ docSpeechMode: next })
          if (loadSettings().docSpeechMode !== next) { await refuse('设置没能写入磁盘，请重试'); return }
          await replyDesktopCommand(commandId, true, { key, value: next, applied: true })
          return
        }
        await refuse('不支持的设置项')
        return
      }
      case 'meeting.status': {
        const status = meetingStatusView()
        if (!status) throw new Error('会议记录还没准备好')
        await replyDesktopCommand(value.id, true, status)
        return
      }
      case 'document.list': await documentListFromDesktop(value.id); return
      case 'document.read': await documentReadFromDesktop(value.id, payload); return
      default: await replyDesktopCommand(value.id, false, undefined, '不支持的桌面命令')
    }
  } catch (error) {
    if (!controller.signal.aborted) await replyDesktopCommand(value.id, false, undefined, error instanceof Error ? error.message : String(error))
  } finally { if (desktopCommandControllers.get(value.id) === controller) desktopCommandControllers.delete(value.id) }
}

async function sendChatReply(text: string, bindingId: string, spoken: boolean, assistantId?: string,
  voiceTurn?: import('../session-types.ts').VoiceTurn, preserveOriginal = false, withDocContext = true,
  ackUserText?: string): Promise<ChatReply> {
  interruptSpeech()
  const contextual = withDocContext ? withPresentationContext(text) : withInterruptedSpeech(text)
  // 复合委托必须按原话交接；仍消费旧中断上下文，避免它污染下一条请求。
  const outgoing = preserveOriginal ? text : contextual
  const round: SpokenRound | null = spoken ? { cancelled: false, controller: new AbortController(),
    utteranceId: `session-${randomUUID()}`, generationDone: false, played: 0, voiceTurn } : null
  spokenRound = round
  speechLog(`round start spoken=${spoken} ack=${ackUserText !== undefined && ackUserText.trim() !== ''} recording=${meetingRecorder?.getState().recording === true}`)
  if (round) {
    narrator.beginRound()
    narrator.generationStarted()
    // 快嘴必须在 interruptSpeech 之后起步，否则刚开口就被上面的静音掐掉。
    if (ackUserText !== undefined && ackUserText.trim() !== '') startFastAck(ackUserText, bindingId, assistantId)
  }
  const current = () => bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
    && (round === null || (spokenRound === round && !round.cancelled))
  const speaker = await speakerForAssistant(assistantId)
  let fedChars = 0
  const roundStartedAt = Date.now()
  /** 正文是否已交给语音（或确认没有正文）。决定 finally 能不能提前收尾这一轮。 */
  let bodyQueued = false
  try {
    const reply = await bridge.chat(outgoing, assistantId, round?.controller.signal, round ? delta => {
      if (!current()) return
      if (fedChars === 0) {
        handoffFastAck()
        speechLog(`first-delta +${Date.now() - roundStartedAt}ms（首句增量到达，随即逐句合成）`)
      }
      fedChars += delta.length
      narrator.feed(round.utteranceId, delta, speaker)
    } : undefined, bindingId)
    speechLog(`reply-resolved +${Date.now() - roundStartedAt}ms fedChars=${fedChars}`)
    if (!reply.ok) {
      failMeetingPresentationForReply(bindingId, '发起会话或插话回答失败，会议讲解不会自动推进；请在会议页核查录音。')
      failIndependentDocumentForReply(bindingId, '发起会话失败，文档讲解不会自动开始。')
    }
    if (bindingId !== sessionState?.bindingId || sessionState.status === 'disconnected') {
      return { ok: false, error: '会话已改变，原会话的回复已丢弃' }
    }
    if (!current()) return { ok: true }
    if (round) {
      if (reply.ok && reply.reply) {
        if (fedChars > 0) narrator.feedEnd(round.utteranceId)
        else {
          handoffFastAck()
          narrator.speak({
            utteranceId: round.utteranceId, text: reply.reply,
            ...speakerRequestFields(speaker),
          })
        }
      } else {
        interruptSpeech()
      }
      // 无论入了队还是走了打断，这一轮都已经有结局：正文在哪都知道，不必在 finally 里猜。
      bodyQueued = true
    }
    if (reply.ok && reply.reply && docAutoResume?.bindingId === bindingId) {
      // 答完不自动接着念：先反问一句「还有其他问题吗」，再看 5 秒窗口里还有没有人说话。
      // 是否真的续讲由 followup 窗口决定（有人还在说就等，明确说"继续"就立刻讲）。
      const talk = docAutoResume
      beginDocFollowup(talk, bindingId)
    }
    return reply
  } catch (error) {
    failMeetingPresentationForReply(bindingId, '会话回复异常，会议讲解不会自动推进；请在会议页核查录音。')
    failIndependentDocumentForReply(bindingId, '发起会话异常，文档讲解不会自动开始。')
    if (round && current()) interruptSpeech()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (round && spokenRound === round) {
      round.generationDone = true
      narrator.generationEnded()
      // **不能在这里无条件 completeSpokenRound()**：正文可能刚 narrator.speak 入队、
      // 还没真正开始播，此刻 isSpeaking() 仍是 false，守卫会放行并把 spokenRound 清空。
      // 清空之后 startDocTalk 就看不到"这一轮还没播完"（它的判据正是 spokenRound 非空），
      // 于是直接 interruptSpeech 把正文顶掉 —— 真机表现就是"只听到开头那句快嘴，正文一个字没有"。
      // 已入队的正文交给 onSpeaking(false) 收尾；只有确定没有下文（异常/提前 return）才在这里收。
      // 队列被失败/打断清空时（isSpeaking 已假）也要收，否则本轮挂死、后续委派全被挡。
      if (!bodyQueued || !narrator.isSpeaking()) completeSpokenRound()
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
  if (!command.taskId && !command.requestId) {
    if (scope === 'pause' || scope === 'mute') { pauseMeetingPresentation(); pauseWaitingIndependentDocument() }
    else if (scope !== 'resume') {
      cancelMeetingPresentation('讲解已取消；若会议仍在录音，请在会议页明确停录。')
      cancelIndependentDocument('讲解已取消，录音状态不变。')
    }
  }
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
const officeView = new OfficeViewWindow({
  open: async target => {
    const opened = await documents.open(target)
    if (opened.kind === 'denied') return { ok: false, error: '这份文档不在授权目录里，不能逐页阅读' }
    if (opened.kind === 'missing') return { ok: false, error: '文档已不在原来的位置' }
    if (opened.kind === 'too-big') return { ok: false, error: '文档超过 8MB 解析上限，不能逐页阅读' }
    if (opened.kind === 'unreadable') return { ok: false, error: `文档读不出来：${opened.reason}` }
    if (opened.doc.parsed.kind !== 'outline') return { ok: false, error: '文档里没有可阅读的文字' }
    const extension = extensionOf(opened.doc.name)
    if (extension !== '.docx' && extension !== '.pptx' && extension !== '.md' && extension !== '.markdown') return { ok: false, error: '阅读视图不支持该文档格式' }
    const sections = opened.doc.parsed.outline.sections.map(section => ({ index: section.index, heading: section.heading,
      text: section.text.slice(0, 200), pageNumber: section.pageNumber ?? null }))
    if (extension === '.pptx') {
      try {
        const exported = await exportPptxSlides(opened.doc.path)
        return { ok: true, doc: { path: opened.doc.path, name: opened.doc.name, fingerprint: opened.doc.fingerprint,
          format: 'pptx', mode: 'images', images: exported.images, sections, pageCount: exported.images.length } }
      } catch (error) {
        // 没有 PowerPoint 或导出失败时退回前端库；若库也渲染不了，阅读窗口会如实报错。
        console.log('[dsh-pet] PowerPoint 导出失败，退回本地预览:', error instanceof Error ? error.message : String(error))
      }
    }
    return { ok: true, doc: { path: opened.doc.path, name: opened.doc.name, fingerprint: opened.doc.fingerprint,
      format: extension === '.docx' ? 'docx' : extension === '.pptx' ? 'pptx' : 'markdown', mode: 'library', sections,
      pageCount: extension === '.pptx' ? opened.doc.parsed.outline.sections.length : null } }
  },
  read: async doc => {
    const snapshot = await documents.snapshot(doc.path, doc.fingerprint)
    if (snapshot.kind !== 'snapshot') throw new Error('文档已变化或授权已撤销，请重新打开')
    return snapshot.bytes
  },
  check: async doc => {
    const snapshot = await documents.snapshot(doc.path, doc.fingerprint)
    return snapshot.kind === 'snapshot' ? { ok: true } : { ok: false, error: '文档已变化或授权已撤销，请重新打开' }
  },
})
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

/**
 * WPS 可用性探测（**当前没有调用点**）。
 *
 * 讲解的 `auto` 现在恒走内置阅读视图（见 chooseDocVia），探测结论不再影响任何决策，
 * 所以主路径不再调用它 —— 探测要拉起辅助进程（首次约 8 秒），为无用结论付这代价不值得。
 * 保留它是因为「用 WPS 打开这个文档」这条显式能力还在（openDocInWps），
 * 将来若某个 WPS 版本能读回页码、恢复自动跟页时，这里就是现成的探针。
 *
 * WPS 可用性缓存：探测要拉起辅助进程，结果在一段时间内复用，避免每次讲解都等一次启动。
 * 成功与失败的复用时长不同（见 `cachedWpsProbe` / `nextWpsProbe`）：**失败不长期缓存** ——
 * 用户很可能先启动桌宠、后打开 WPS，把"不可用"缓存十分钟会让它一直认为没有 WPS。
 */
let wpsProbe: WpsProbeCache | null = null
async function wpsAvailable(): Promise<boolean> {
  if (!supportsWpsControl(platformOf())) return false
  const cached = cachedWpsProbe(wpsProbe, Date.now())
  if (cached !== null) return cached
  try {
    const located = await wpsControl().locate()
    wpsProbe = nextWpsProbe(located, Date.now())
  } catch {
    // 探测抛异常同样只记一个 3 秒的抖动窗口，过期重探。
    wpsProbe = nextWpsProbe(null, Date.now())
  }
  return wpsProbe.available
}

/**
 * 会议与文档讲解优先交给同时具备 meeting+document 能力的成员（用户可配置成"小会"这样的子助理）；
 * 没有这样的成员，或团队模式没开，就返回 undefined，仍由总助理接待。
 *
 * 每次讲解开始查一次：成员可能在两场讲解之间被改名、禁用或删掉，缓存一份 id 反而会把讲解
 * 交给已经不存在的成员。本地 HTTP 查询的延迟远小于一次模型请求。
 */
async function presentationMember(): Promise<string | undefined> {
  try {
    const result = await bridge.companionRequest('GET', '/companion/v1/members', undefined, 'owner', 5_000)
    if (result.status !== 200) return undefined
    const body = result.body as { enabled?: unknown; members?: Array<{ profile?: { assistantId?: unknown; enabled?: unknown; capabilities?: unknown } }> } | null
    // 团队模式关闭时成员子代理不会运行；此时点名成员只会得到“没有这个成员”，必须回退总助理。
    if (body?.enabled !== true) return undefined
    const found = body?.members?.find(item => item.profile?.enabled === true
      && Array.isArray(item.profile.capabilities)
      && item.profile.capabilities.includes('meeting') && item.profile.capabilities.includes('document'))
    return found?.profile && typeof found.profile.assistantId === 'string' && found.profile.assistantId
      ? found.profile.assistantId : undefined
  } catch { return undefined }
}
/** 阅读视图当前展示的是哪一条讲解链、经哪个视图；暂停/停止只作用于它，换文档时不误停新打开的视图。 */
let presentedSessionId: string | null = null
let presentedView: DocViewController | null = null
/** 当前讲解链同步到的 Office 逐页窗口；与 PDF/WPS 的 presentedSessionId 互斥使用。 */
let presentedOfficeSessionId: string | null = null
const OFFICE_DOC_EXTENSIONS = new Set(['.docx', '.pptx', '.md', '.markdown'])
const isOfficeDoc = (name: string): boolean => OFFICE_DOC_EXTENSIONS.has(extensionOf(name))

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
let pendingMeetingStart: { id: string; consent: MeetingConsentInput; timer: NodeJS.Timeout; expiresAt: number; presentationId?: string; autoApproved: boolean } | null = null
let pendingMeetingReady: { id: string; meetingId: string; presentationId?: string } | null = null
const desktopCommandControllers = new Map<string, AbortController>()

type IndependentDocumentState = 'authorizing' | 'waiting-to-present' | 'waiting-to-resume' | 'starting'
  | 'presenting' | 'paused' | 'completed' | 'partial' | 'cancelled' | 'failed'
/**
 * 等待开讲的队列上限。命令自带的 expiresAt 只是受理/回执时限（模型推理+整段播报
 * 常常超过它），不能拿它当等待上限，否则"播报结束后开讲"永远等不到那一刻。
 * 受理核验仍用 expiresAt；进入等待后改用这个独立的宽限期。
 */
const PRESENT_WAIT_CAP_MS = 10 * 60_000
interface IndependentDocumentPresentation {
  id: string
  requestId: string
  bindingId: string
  path: string
  name: string
  fingerprint: string
  from: number
  total: number
  next: number
  completed: number[]
  talkId: string | null
  assistantId: string | null
  expiresAt: number
  waitUntil: number
  receiptConfirmed: boolean
  autoApproved: boolean
  state: IndependentDocumentState
  error: string | null
  timer: NodeJS.Timeout | null
}
let independentDocument: IndependentDocumentPresentation | null = null

function failIndependentDocument(presentation: IndependentDocumentPresentation, reason: string): void {
  if (independentDocument !== presentation || ['completed', 'partial', 'cancelled', 'failed'].includes(presentation.state)) return
  presentation.state = 'failed'
  presentation.error = reason
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = null
  sendToRenderer('doc-notice', reason)
}

function failIndependentDocumentForReply(bindingId: string, reason: string): void {
  const presentation = independentDocument
  if (presentation?.bindingId === bindingId && ['waiting-to-present', 'waiting-to-resume', 'starting'].includes(presentation.state)) {
    // 独立讲解没起来：如果挂起等开讲的就是这一份，作废它。
    dropPendingDocTalk(presentation.talkId)
    failIndependentDocument(presentation, reason)
  }
}

/** 只取消讲解本身，绝不改变当前会议录音。 */
function cancelIndependentDocument(reason: string): void {
  const presentation = independentDocument
  if (!presentation || ['completed', 'partial', 'cancelled', 'failed'].includes(presentation.state)) return
  const awaitingConfirmation = presentation.state === 'authorizing'
  presentation.state = 'cancelled'
  presentation.error = reason
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = null
  if (awaitingConfirmation) {
    desktopCommandControllers.get(presentation.requestId)?.abort(reason)
    void replyDesktopCommand(presentation.requestId, false, undefined, reason)
  }
  if (presentation.talkId && docTalk?.sessionId === presentation.talkId) {
    // 插话已暂停讲解时，正在播报的可能是发出本指令的语音回复，不能把它一并取消。
    if (!docTalk.stopped && !spokenRound) interruptSpeech(false)
    stopDocTalk()
    pushDocState()
  }
}

/** 等待开讲也可以暂停；再次继续时仍须重新核对文档和会话。 */
function pauseWaitingIndependentDocument(): void {
  const presentation = independentDocument
  if (presentation?.state === 'authorizing') { cancelIndependentDocument('本人已取消等待确认的讲解。'); return }
  if (presentation && ['waiting-to-present', 'waiting-to-resume', 'starting'].includes(presentation.state)) presentation.state = 'paused'
}

function resumeWaitingIndependentDocument(): ChatReply | null {
  const presentation = independentDocument
  if (!presentation || presentation.state !== 'paused' || presentation.talkId) return null
  if (Date.now() >= presentation.waitUntil || sessionState?.bindingId !== presentation.bindingId) {
    failIndependentDocument(presentation, '等待讲解的确认已过期或会话已变化，请重新发起。')
    return { ok: false, error: '等待讲解的确认已过期或会话已变化，请重新发起。' }
  }
  presentation.state = 'waiting-to-present'
  presentation.waitUntil = Date.now() + PRESENT_WAIT_CAP_MS
  armIndependentDocumentDeadline(presentation)
  presentation.receiptConfirmed = true
  return { ok: true, reply: '已恢复等待，当前回复结束后将重新核验文档再讲解。' }
}

interface MeetingPresentation {
  id: string
  requestId: string
  bindingId: string
  meetingName: string
  documentName: string
  documentPath: string
  fingerprint: string
  expiresAt: number
  waitUntil: number
  meetingId: string | null
  talkId: string | null
  assistantId: string | null
  finishRequestId: string | null
  state: MeetingPresentationState
  lectureOutcome: 'completed' | 'partial' | 'interrupted' | null
  error: string | null
  next: number
  total: number
  completed: number[]
  recordRevision: number
  timer: NodeJS.Timeout | null
}
let meetingPresentation: MeetingPresentation | null = null

/** 每次推进前持久化最小步骤证据；异常时停止推进，不把内存状态冒充持久结果。 */
function persistMeetingPresentation(presentation: MeetingPresentation): boolean {
  const record: MeetingPresentationRecord = { id: presentation.id, requestId: presentation.requestId, bindingId: presentation.bindingId,
    meetingId: presentation.meetingId, meetingName: presentation.meetingName, documentName: presentation.documentName,
    documentPath: presentation.documentPath, fingerprint: presentation.fingerprint, expiresAt: presentation.expiresAt,
    state: presentation.state, lectureOutcome: presentation.lectureOutcome, error: presentation.error?.slice(0, 2000) ?? null, next: presentation.next, total: presentation.total,
    completed: [...presentation.completed], revision: presentation.recordRevision + 1, updatedAt: Date.now() }
  let saved: { ok: true } | { ok: false; error: string }
  try { saved = meetingRecorder?.savePresentation(record, presentation.recordRevision) ?? { ok: false, error: '会议库不可用' } }
  catch { saved = { ok: false, error: '会议库写入异常' } }
  if (saved.ok) { presentation.recordRevision++; return true }
  presentation.state = 'failed'
  presentation.error = `讲解状态未能可靠保存（${saved.error}），后续步骤已停止；请在会议页核查录音。`
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = null
  sendToRenderer('doc-notice', presentation.error)
  return false
}

function failMeetingPresentation(id: string | undefined, reason: string): void {
  const presentation = meetingPresentation
  if (!id || !presentation || presentation.id !== id || ['completed', 'partial', 'cancelled', 'failed'].includes(presentation.state)) return
  presentation.state = 'failed'
  presentation.error = reason
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = null
  if (presentation.recordRevision > 0 && !persistMeetingPresentation(presentation)) return
  sendToRenderer('doc-notice', reason)
}

function failMeetingPresentationForReply(bindingId: string, reason: string): void {
  const presentation = meetingPresentation
  if (!presentation || presentation.bindingId !== bindingId) return
  const interruptedTalk = presentation.state === 'presenting' && docTalk && presentation.talkId === docTalk.sessionId && docAutoResume === docTalk
  if (!['waiting-to-present', 'starting'].includes(presentation.state) && !interruptedTalk) return
  // 会议讲解没起来或被打断：等静音后开讲的那一份如果是它，一并作废。
  dropPendingDocTalk(presentation.talkId)
  failMeetingPresentation(presentation.id, reason)
  if (interruptedTalk) { clearDocAutoResume(); interruptSpeech(false); stopDocTalk(); pushDocState() }
}

/** 暂停不丢讲解位置；显式继续时仍需重验会议与文档。 */
function pauseMeetingPresentation(): void {
  const presentation = meetingPresentation
  if (!presentation) return
  if (presentation.finishRequestId || ['authorizing', 'opening', 'stopping', 'transcribing'].includes(presentation.state)) {
    cancelMeetingPresentation('会议步骤已停止；请在会议页核查录音。')
    return
  }
  if (!['waiting-to-present', 'starting', 'presenting'].includes(presentation.state)) return
  presentation.state = 'paused'
  presentation.error = null
  if (presentation.recordRevision > 0 && !persistMeetingPresentation(presentation)
    && docTalk && presentation.talkId === docTalk.sessionId) {
    interruptSpeech(false)
    stopDocTalk()
    pushDocState()
  }
}

function resumeWaitingMeetingPresentation(): ChatReply | null {
  const presentation = meetingPresentation
  if (!presentation || presentation.state !== 'paused' || presentation.talkId) return null
  if (Date.now() >= presentation.waitUntil || sessionState?.bindingId !== presentation.bindingId) {
    failMeetingPresentation(presentation.id, '等待开讲的授权已过期或会话已切换，请重新发起。')
    return { ok: false, error: '等待开讲的授权已过期或会话已切换，请重新发起。' }
  }
  presentation.state = 'waiting-to-present'
  presentation.waitUntil = Date.now() + PRESENT_WAIT_CAP_MS
  armMeetingPresentationDeadline(presentation)
  if (!persistMeetingPresentation(presentation)) return { ok: false, error: presentation.error ?? '讲解状态无法保存' }
  return { ok: true, reply: '已恢复等待，当前回复结束后将重新核验双轨和文档再开讲。' }
}

function armMeetingPresentationDeadline(presentation: MeetingPresentation): void {
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = setTimeout(() => failMeetingPresentation(presentation.id, '等待开讲超过 10 分钟上限；会议可能仍在录音，请在会议页核查。'),
    Math.max(1, presentation.waitUntil - Date.now()))
  presentation.timer.unref?.()
}

function cancelMeetingPresentation(reason: string): void {
  const presentation = meetingPresentation
  if (presentation?.state === 'awaiting-review') return
  if (!presentation || (['completed', 'partial', 'cancelled', 'failed'].includes(presentation.state) && !presentation.finishRequestId)) return
  presentation.state = 'cancelled'
  presentation.error = reason
  if (presentation.timer) clearTimeout(presentation.timer)
  presentation.timer = null
  if (presentation.recordRevision > 0) persistMeetingPresentation(presentation)
  if (presentation.finishRequestId) desktopCommandControllers.get(presentation.finishRequestId)?.abort('会议后续步骤已取消')
  if (pendingMeetingStart?.presentationId === presentation.id) {
    clearTimeout(pendingMeetingStart.timer)
    pendingMeetingStart = null
  }
  if (pendingMeetingReady?.presentationId === presentation.id) {
    const meetingId = pendingMeetingReady.meetingId
    pendingMeetingReady = null
    if (meetingRecorder?.getState().meetingId === meetingId) meetingRecorder.requestStop(meetingId)
  }
  if (docTalk && presentation.talkId === docTalk.sessionId) {
    interruptSpeech(false)
    stopDocTalk()
    pushDocState()
  }
}

function meetingPresentationStatus(): Record<string, unknown> | null {
  const presentation = meetingPresentation
  if (!presentation) return null
  const talk = docTalk && docTalk.sessionId === presentation.talkId ? docTalk : null
  return { id: presentation.id, meetingId: presentation.meetingId, meetingName: presentation.meetingName,
    documentName: presentation.documentName, fingerprint: presentation.fingerprint,
    state: talk && presentation.state === 'presenting' && talk.stopped ? 'paused' : presentation.state,
    lectureOutcome: presentation.lectureOutcome,
    next: talk?.next ?? presentation.next, total: talk?.outline.sections.length ?? presentation.total,
    completed: talk ? [...talk.completed].sort((a, b) => a - b) : presentation.completed, error: presentation.error }
}

/** 取消只作用于同一桌面命令；迟到的渲染层开始请求会因编号失效被拒。 */
function cancelDesktopCommand(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const id = (raw as { id?: unknown }).id
  if (typeof id !== 'string') return
  desktopCommandControllers.get(id)?.abort('桌面命令已取消')
  if (pendingMeetingStart?.id === id) {
    clearTimeout(pendingMeetingStart.timer)
    pendingMeetingStart = null
  }
  if (pendingMeetingReady?.id === id) {
    const meetingId = pendingMeetingReady.meetingId
    pendingMeetingReady = null
    if (meetingRecorder?.getState().meetingId === meetingId) meetingRecorder.requestStop(meetingId)
  }
  if (meetingPresentation?.requestId === id || meetingPresentation?.finishRequestId === id) {
    cancelMeetingPresentation('会议讲解请求已取消；若会议仍在录音，请在会议页核查并明确停录。')
  }
  if (independentDocument?.requestId === id) cancelIndependentDocument('文档讲解请求已取消，录音状态不变。')
}

/**
 * 演讲被评委插话打断后"还有一条讲解停在半路"的标记。
 *
 * 它只回答"要不要在答完之后反问一句"，不再自己去续讲 —— 续不续由 followup 窗口决定
 * （见 {@link beginDocFollowup}）。用户明确暂停 / 换文档 / 结束讲解都会把它清掉，
 * 不能靠自动续讲覆盖人的决定。
 */
let docAutoResume: DocTalk | null = null

/**
 * 跳过类段落（代码/表格/公式）的"讲完先别走"。
 *
 * 这类段落只念一句跳过提示，真正的信息在屏幕上：不停一下的话，下一段立刻顶上，
 * 投屏跟着翻页，人根本来不及看。所以念完提示后停 `DOC_SKIP_HOLD_MS`。
 *
 * 三个变量分工（都用同一个清理函数，别各清各的）：
 * - `docSkipHoldPendingMs`：刚念完跳过提示，还没开始算停留（等这一句念完再开始，否则
 *   提示语本身的几秒钟会白白吃掉停留时间）。
 * - `docSkipHoldUntil`：停留的截止时刻，> Date.now() 表示正停着。
 * - `docSkipHoldTimer`：把链条重新推起来的那一次定时器。
 *
 * 关键语义：**停留期间不占用 `docTalkBusy`**。busy 是"正在跑一轮推进"，它被占用时
 * stop/pause 之后没人再来推链条；而这里只是纯等待，让出 busy 才能保证随时能停、也能重新开始。
 */
let docSkipHoldPendingMs = 0
let docSkipHoldUntil = 0
let docSkipHoldTimer: NodeJS.Timeout | null = null

/** 清掉"跳过段停留"的全部状态。暂停/停止必须调它，否则停了还会在 10 秒后自己念。 */
function clearDocSkipHold(): void {
  docSkipHoldPendingMs = 0
  docSkipHoldUntil = 0
  if (docSkipHoldTimer) {
    clearTimeout(docSkipHoldTimer)
    docSkipHoldTimer = null
  }
}

/** 从此刻开始停 `delayMs`，到点再把链条推起来。 */
function armDocSkipHold(talk: DocTalk, delayMs: number): void {
  const wait = Math.max(0, delayMs)
  docSkipHoldUntil = Date.now() + wait
  if (docSkipHoldTimer) clearTimeout(docSkipHoldTimer)
  docSkipHoldTimer = setTimeout(() => {
    docSkipHoldTimer = null
    docSkipHoldUntil = 0
    // 停留期间链条被停掉或换掉了：停就是停，不能过 10 秒又自己念。
    if (docTalk !== talk || talk.stopped) return
    void advanceDocTalk()
  }, wait)
  docSkipHoldTimer.unref()
}

function clearDocAutoResume(): void {
  docAutoResume = null
  cancelDocFollowup()
  // 讲解链被放弃：挂起等开讲的那一份也一起作废，不能等静音后又自己开始念第一段。
  pendingDocTalk = null
}

function markDocTalkForAutoResume(): void {
  if (docTalk !== null && docTalk.spoken) docAutoResume = docTalk
}

// ---------------------------------------------------------------------------
// 答完反问 + 5 秒智能等待
//
// 用户要的是"像真人开会"：被追问、答完之后不自动接着念，先反问一句"还有其他问题吗"，
// 再等一会儿 —— 没人再问就继续讲，有人还在说就继续等，明确说"继续"就立刻讲。
//
// 判据只认**流式 ASR 的识别文本有没有变长**（见 noteFollowupSpeech）：麦克风能量/VAD
// 分不清"有人说话"和"空调/键盘/椅子响"，按能量判会让讲解被杂音永久顶住。
//
// 状态机本身在 followup-window.ts 里（纯逻辑、可单测），这里只负责推进它、起定时器、
// 以及把结论落到讲解链上。
// ---------------------------------------------------------------------------

/** idle = 没这回事；to-ask = 该念反问了；asking = 反问正在念；window = 正在等。 */
type FollowupPhase = 'idle' | 'to-ask' | 'asking' | 'window'

let docFollowupPhase: FollowupPhase = 'idle'
let docFollowupTalk: DocTalk | null = null
let docFollowupBindingId: string | null = null
let docFollowupState: FollowupState = initialFollowup()
let docFollowupTimer: NodeJS.Timeout | null = null
/**
 * 本次听写的识别文本水位。只认"比上次长"，不认能量；
 * 窗口关掉就归零，不留任何跨轮次的常驻状态。
 */
let followupAsrWatermark = 0

/** 轮询间隔：比 5 秒窗口细得多，用户感觉不到，但足够让"到点续讲"看着像人决定的。 */
const FOLLOWUP_TICK_MS = 250
/** 反问话术。固定一句：用户听两三次就知道节奏，换模型生成反而每轮措辞和延迟都不一样。 */
const FOLLOWUP_QUESTION = '还有其他问题吗？'

/** 答完这一轮之后开始"反问 → 等待"。讲解链必须还活着，否则不该问。 */
function beginDocFollowup(talk: DocTalk, bindingId: string): void {
  cancelDocFollowup()
  docFollowupTalk = talk
  docFollowupBindingId = bindingId
  docFollowupPhase = 'to-ask'
  pumpDocFollowup()
}

/**
 * 推进反问流程，可被反复调用（幂等）。
 *
 * 只在**没有语音在播**时往前走：回答还在念就先等，等 `onSpeaking(false)` 再来一次 ——
 * 讲解本身此时是暂停状态（`talk.stopped === true`），不会再插进来打断判断。
 */
function pumpDocFollowup(): void {
  if (docFollowupTalk === null || docFollowupPhase === 'idle') return
  if (narrator.isSpeaking()) return
  if (docFollowupPhase === 'to-ask') {
    docFollowupPhase = 'asking'
    // ephemeral：这句是过场话，不进会话 / 记忆 / 纪要（与快答旁路同一条红线）。
    narrator.speak({ utteranceId: `followup-${randomUUID()}`, text: FOLLOWUP_QUESTION, ephemeral: true })
    // 念得出来就等它念完再开窗（用户听到问句之后才开始算 5 秒）；
    // 念不出来（TTS 不可用）也不能卡在 asking，直接开窗。
    if (narrator.isSpeaking()) return
  }
  if (docFollowupPhase === 'asking') {
    docFollowupPhase = 'window'
    openDocFollowupWindow()
  }
}

function openDocFollowupWindow(): void {
  docFollowupState = reduceFollowup(initialFollowup(), { kind: 'start', at: Date.now() }).state
  followupAsrWatermark = 0
  if (docFollowupTimer) clearInterval(docFollowupTimer)
  docFollowupTimer = setInterval(tickDocFollowup, FOLLOWUP_TICK_MS)
  docFollowupTimer.unref()
}

function tickDocFollowup(): void {
  const talk = docFollowupTalk
  // 讲解已经不是那一条了（被换掉、被停止后 docTalk 会变 null）：窗口作废。
  // **注意这里不能判 `talk.stopped`** —— 窗口本来就开在"讲解被暂停"的时候，stopped 才是常态；
  // 把它当死亡信号的话每个窗口都会在第一次 tick 就自己关掉。
  // "停了就不许过 5 秒又自己念"靠的是 stopDocTalk/pauseDocTalk 里的 cancel（docTalk 会被置空）。
  if (talk === null || docTalk !== talk) {
    cancelDocFollowup()
    return
  }
  const { state, action } = reduceFollowup(docFollowupState, { kind: 'tick', at: Date.now() })
  docFollowupState = state
  if (action === 'waiting') return
  if (action === 'continue') {
    finishDocFollowup(true)
    return
  }
  cancelDocFollowup()
}

/** 收束：`continueLecture` 为真才续讲，否则只是把窗口关干净。 */
function finishDocFollowup(continueLecture: boolean): void {
  const talk = docFollowupTalk
  cancelDocFollowup()
  if (!continueLecture || talk === null) return
  docAutoResume = null
  // 讲解已经被换掉、或者用户已经自己继续了（stopped=false）：不重复推。
  if (docTalk !== talk || !talk.stopped) return
  console.log('[dsh-pet] 反问等待结束，继续原讲解')
  sendToRenderer('doc-notice', '继续刚才的讲解')
  void resumeDocTalk(false)
}

/**
 * 关窗。**只清窗口自己的状态**，不动 `docAutoResume`：markDocTalkForAutoResume 在这一轮
 * 问答之前就打好了标记，而 `interruptSpeech()`（回答开始时必调）会走到这里 ——
 * 顺手把标记清掉的话，答完之后就再也不会反问了。
 */
function cancelDocFollowup(): void {
  if (docFollowupTimer) {
    clearInterval(docFollowupTimer)
    docFollowupTimer = null
  }
  docFollowupState = initialFollowup()
  followupAsrWatermark = 0
  docFollowupTalk = null
  docFollowupBindingId = null
  docFollowupPhase = 'idle'
}

/**
 * 流式识别每回来一次就比一次文本长度：变长 = 真的有人在说话 = 窗口顺延。
 *
 * 为什么不认 VAD / 麦克风能量：能量阈值分不清"有人说话"和"空调、键盘、椅子响"，
 * 而杂音一个字都识别不出来 —— 按能量记，讲解会被永远往后推；按识别文本记，杂音天然被过滤。
 * 只在窗口 active 时比较，关掉的窗口不会被迟到的 ASR 又唤醒。
 */
function noteFollowupSpeech(text: unknown): void {
  if (!docFollowupState.active || typeof text !== 'string') return
  // 新一轮听写从头累计：长度变短说明换了一轮，水位归零，否则这一轮的增量永远判不出来。
  if (text.length < followupAsrWatermark) followupAsrWatermark = 0
  if (text.length <= followupAsrWatermark) return
  followupAsrWatermark = text.length
  docFollowupState = reduceFollowup(docFollowupState, { kind: 'speech', at: Date.now() }).state
}

function pauseDocTalk(): void {
  docRevision += 1
  // 跳过段的停留也要一起清：用户说"停"就是在停，不能 10 秒后又冒出下一段。
  // stopDocTalk 会走到这里，所以停止路径同样被覆盖。
  clearDocSkipHold()
  // 反问窗口同理：暂停/停止之后不许过 5 秒又自己念。这里是窗口最主要的关闭点之一
  // （插话时的 interruptSpeech、用户按停、视图关闭都走这条路）。
  cancelDocFollowup()
  // 暂停同样作废"等静音后开讲"的挂起项：用户喊停了，就不该等他安静下来又自己开口。
  pendingDocTalk = null
  if (docTalk && independentDocument?.talkId === docTalk.sessionId && independentDocument.state === 'presenting') independentDocument.state = 'paused'
  if (docTalk !== null) docTalk.stopped = true
  docRequest?.abort()
  docRequest = null
  // 不清“待续讲”：插话本身就会 pause，续讲标志要活到这一轮问答播完。
  // 用户主动停止（speech-stop）与结束讲解在各自入口清除。
  if (docTalk !== null && docTalk.sessionId === presentedSessionId) presentedView?.pause()
}

function stopDocTalk(): void {
  const talk = docTalk
  if (talk && independentDocument?.talkId === talk.sessionId) {
    independentDocument.next = talk.next
    independentDocument.completed = [...talk.completed].sort((a, b) => a - b)
    if (!['completed', 'partial', 'cancelled', 'failed'].includes(independentDocument.state)) {
      independentDocument.state = 'cancelled'
      independentDocument.error = '讲解已停止或文档已切换；录音状态不变。'
    }
  }
  if (talk && meetingPresentation?.talkId === talk.sessionId) {
    meetingPresentation.next = talk.next
    meetingPresentation.completed = [...talk.completed].sort((a, b) => a - b)
    if (!['completed', 'partial', 'stopping', 'transcribing', 'awaiting-review', 'cancelled', 'failed'].includes(meetingPresentation.state)) {
      meetingPresentation.state = 'cancelled'
      meetingPresentation.error = '讲解已停止或文档已切换；若会议仍在录音，请明确停录。'
      if (meetingPresentation.recordRevision > 0) persistMeetingPresentation(meetingPresentation)
    }
  }
  clearDocAutoResume()
  pauseDocTalk()
  if (docTalk !== null && docTalk.sessionId === presentedSessionId) {
    presentedView?.stop('user')
    presentedSessionId = null
  }
  if (docTalk !== null && docTalk.sessionId === presentedOfficeSessionId) presentedOfficeSessionId = null
  docTalk = null
}

/** 讲解链换段时同步 Office 窗口；PPTX 用幻灯片页码，DOCX 由窗口按段落文字找页。 */
function syncOfficeSection(talk: DocTalk, index: number): void {
  if (presentedOfficeSessionId !== talk.sessionId || !officeView.isOpen()) return
  const section = talk.outline.sections[index]
  if (!section) return
  officeView.gotoSection(index, section.pageNumber ?? null)
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
  if (talk.via === 'wps' && (extensionOf(talk.path) === '.md' || extensionOf(talk.path) === '.markdown')) {
    return { ok: false, error: 'WPS 同步讲解目前只支持 PDF，Markdown 可使用内置阅读视图' }
  }
  if (isOfficeDoc(talk.path)) {
    const section = talk.outline.sections[talk.next]
    const start = { index: talk.next, pageNumber: section?.pageNumber ?? null }
    if (officeView.isShowing(talk.path, talk.fingerprint)) {
      officeView.gotoSection(start.index, start.pageNumber)
    } else {
      const shown = await officeView.show(talk.path, start)
      if (!shown.ok) {
        sendToRenderer('doc-notice', `逐页阅读没能打开（${shown.error ?? '未知原因'}），讲解继续`)
        return { ok: true }
      }
    }
    presentedOfficeSessionId = talk.sessionId
    presentedSessionId = null
    return { ok: true }
  }
  if (!talk.spoken || !isPdfName(talk.path)) {
    return talk.via === 'wps' && talk.spoken ? { ok: false, error: 'WPS 同步讲解目前只支持 PDF' } : { ok: true }
  }
  if (talk.via === 'wps' && !supportsWpsControl(platformOf())) return { ok: false, error: '这个系统上不支持控制 WPS' }
  const view = talk.via === 'wps' ? wpsView : docView
  const shown = await view.present({ path: talk.path, fingerprint: talk.fingerprint, sessionId: talk.sessionId, startSection: talk.next })
  // 三条分支各自留一行日志，真机上"屏幕为什么不跟"能一眼分清：
  //   wps window ok                          —— 窗口 + 页码都拿到了（UIA 全程可用）
  //   wps window ok but no pdf view (...)    —— 窗口在，但读不到 PDF 视图，走键盘翻页（见 wps-view-target.ts）
  //   wps window missing (fallback ...)      —— 连窗口都没有，才回退内置阅读视图（见下）
  if (!shown.ok) {
    console.log(`[dsh-pet] ${talk.via === 'wps' ? 'wps window missing (fallback to reading view)' : 'reading view unavailable'}`
      + `：${shown.problem.code}:${shown.problem.message}`)
  }
  if (shown.ok) {
    presentedSessionId = talk.sessionId
    presentedView = view
    return { ok: true }
  }
  if (talk.via === 'wps') {
    // 只剩一种情况会走到这里：**WPS 窗口根本没出现**（没装、打不开文件、等待超时）。
    // 窗口在但读不到 PDF 视图时不再算失败 —— 那条路走键盘翻页，由 WpsViewTarget 自己处理。
    // 窗口都没有就别把失败转嫁给用户、让他记住一句口令才能继续：自动回退内置阅读视图，
    // 只有两个都打不开才如实报错（并说清各自的原因）。
    const fallback = await docView.present({ path: talk.path, fingerprint: talk.fingerprint, sessionId: talk.sessionId, startSection: talk.next })
    if (fallback.ok) {
      sendToRenderer('doc-notice', `WPS 没能同步翻页（${shown.problem.message}），已改用内置阅读视图继续讲解`)
      presentedSessionId = talk.sessionId
      presentedView = docView
      return { ok: true }
    }
    return { ok: false, error: `${shown.problem.message}；内置阅读视图也打不开（${fallback.problem.message}）` }
  }
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
    speechLog('doc-state idle')
    sendToRenderer('doc-state', { kind: 'idle' })
    return
  }
  /*
    舞台要不要换人，全看下面 active / assistantId 这两个值。
    以前没有这行日志，用户说"形象没出来"时只能猜；现在能直接看出
    是"根本没 active"，还是"active 了但渲染层没换"。
  */
  speechLog(`doc-state assistant=${talk.assistantId ?? 'none'} spoken=${talk.spoken} stopped=${talk.stopped} next=${talk.next}/${talk.outline.sections.length}`)
  sendToRenderer('doc-state', {
    kind: 'outline',
    path: talk.path,
    title: talk.outline.title,
    estMinutes: talk.outline.estMinutes,
    total: talk.outline.sections.length,
    next: talk.next,
    assistantId: talk.assistantId ?? null,
    assistantName: talk.assistantId ? memberNamesCache?.names.get(talk.assistantId) ?? '' : '',
    // 只有"正在出声讲解且未讲完"才让委派成员留在台上；讲完/暂停/停止即下台，
    // 避免一次讲解后子助理常驻舞台。
    active: talk.spoken && !talk.stopped && talk.next < talk.outline.sections.length,
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
 * 等着开讲的讲解（总助理还在念介绍时先挂在这里）。
 *
 * 真机场景：用户一句话触发"创建会议 + 开始文档讲解"，模型调工具时这条讲解被装上，
 * 而那一刻总助理**正在流式朗读**"下面请小会来为大家讲这份文档"。`installDocTalk` 会走
 * `interruptSpeech()`，把这一轮回复判成 cancelled —— 后续增量全被丢掉，用户只听到开头的
 * 快嘴，正文一个字都没念出来。
 *
 * 所以要的是排队、不是打断：总助理把话说完，子助理再开口。开场白也一起挂起，
 * 否则"共 6 段、大约 X 分钟"会插到介绍前面去。
 */
let pendingDocTalk: { talk: DocTalk; prelude?: { utteranceId: string; text: string } } | null = null

/**
 * 作废挂起项。给了 `talkId` 就只作废那一份 —— 用户可能已经又发起了一份新的，
 * 旧的失败不该顺手把新的也扔掉。
 */
function dropPendingDocTalk(talkId?: string | null): void {
  if (talkId === undefined || talkId === null || pendingDocTalk?.talk.sessionId === talkId) pendingDocTalk = null
}

/** 挂起的讲解开始讲。由 `onSpeaking(false)` 在总助理念完之后调用。 */
function startPendingDocTalk(): void {
  const next = pendingDocTalk
  if (next === null) return
  // 还在播别的（比如又插了一句回答）：继续等下一段静音，别在半句上抢话。
  if (narrator.isSpeaking()) return
  // 这一轮回复还在生成：快嘴念完并不代表总助理念完了，它的正文可能刚开始/还没开始。
  // 这时候开讲同样会把正文顶掉，所以要等 generationDone（或这一轮已经收尾成 null）。
  if (spokenRound !== null && !spokenRound.generationDone) return
  // 先摘下来再起：startDocTalk 内部会 stopDocTalk/pauseDocTalk，那些路径会作废挂起项，
  // 顺序反过来会把刚要起的那一份自己清掉。
  pendingDocTalk = null
  startDocTalk(next.talk, next.prelude)
}

/**
 * 从某一段开始逐段讲解。段号越界或者文档读不出结构时什么都不做，由调用方先报过原因。
 *
 * `prelude` 是开讲之前要先说的那一句（"共几段、大约几分钟"）。它必须夹在装链和推进之间
 * 入队：装链那一步会 drop-queue，先入队就被丢掉了；而推进要先等模型回话，晚一步入队
 * 也仍然排在第一段前面。这个顺序不写在这里，调用方迟早会写反。
 */
function startDocTalk(talk: DocTalk, prelude?: { utteranceId: string; text: string }): void {
  // 只要这一轮回复还没**彻底收尾**（`spokenRound` 非空）就不能开始讲：
  // 快嘴在念、正文在生成、正文已入队还没开口、正文正在念 —— 这四种状态都还是"总助理在说话"。
  // 特别注意**不能只看 `narrator.isSpeaking()`**：`narrator.speak` 只是入队，从入队到真正出声
  // 之间 isSpeaking() 仍是 false，这段空窗足够讲解抢进来把正文顶掉。
  // 也不能只看 `generationDone`：生成完 ≠ 念完，正文往往在生成完之后才开口。
  // `spokenRound` 只会在两种情况下被清空：整轮播完（completeSpokenRound）或被真正打断
  // （interruptSpeech），所以"非空"就是"这一轮还没结束"的最准信号。
  // 不在这里 installDocTalk：装链会 stop + interruptSpeech，等于把用户正要听的那句回复掐掉。
  // 后一次覆盖前一次 —— 用户又发起了一份文档，要讲的当然是新的那份。
  if (narrator.isSpeaking() || spokenRound !== null) {
    pendingDocTalk = { talk, prelude }
    return
  }
  installDocTalk(talk)
  // 出声讲解开始时收起管理面板：用户要的是听讲解，不是被设置页挡着屏幕。
  if (talk.spoken) sendToRenderer('settings-close', null)
  /*
    点到成员来讲，就先演一段交接：总助交代 → 叫人 → 成员应声 → 成员开口，
    然后才进开场白和正文。以前这段编排写在 handover-sequence.ts 里却没人调用，
    于是总助嘴上说"交给小会"，舞台上什么都不会发生。
  */
  /*
    交接编排（同步版）：点到成员来讲，先用**固定台词**演"总助交棒 → 成员接棒"。

    为什么用固定台词而不是现问模型：这段必须卡在开场白之前，而讲解时序不能为了一个
    网络请求而停住（试过 await 模型生成，两条讲解时序测试直接红）。台词是表演，
    不进会话、不进记忆，和快答同一条红线。
  */
  speakMemberHandover(talk.assistantId, talk.sessionId)
  if (prelude !== undefined) {
    // 开场白单独算一轮：它被打断时该报的是"范围还没说完"，跟第一段讲了多少无关。
    narrator.beginRound()
    /*
      开场白也用**讲解人自己**的嗓子。
      否则第一句是总助、后面几十段换成员，听感上就是中途换人说话。
    */
    narrator.speak({ ...prelude, ...speakerRequestFields(presentationSpeakerVoice(talk.assistantId)) })
  }
  void advanceDocTalk()
}


/** 讲解途中每次送模型或播放前都重新校验文档与授权。 */
async function docTalkStillValid(talk: DocTalk): Promise<boolean> {
  const revision = docRevision
  let current: OpenResult | null = null
  try { current = await documents.open(talk.path) } catch { /* 读取失败按授权或文件不可用处理 */ }
  if (docTalk !== talk || talk.stopped || revision !== docRevision || talk.bindingId !== sessionState?.bindingId) return false
  if (current?.kind === 'opened' && current.doc.fingerprint === talk.fingerprint) return true
  if (meetingPresentation?.talkId === talk.sessionId) failMeetingPresentation(meetingPresentation.id, '文档内容或授权已变化，会议讲解已停止；请核查录音。')
  if (talk.sessionId === presentedSessionId) presentedView?.fileChanged()
  stopDocTalk()
  pushDocState()
  sendToRenderer('doc-notice', '文档内容或授权已变化，讲解已停止；请重新选择并确认。')
  return false
}

/**
 * 讲下一段。
 *
 * 用循环而不是一段一返回：只有代码、没有正文的段念不出声音，播放器不会再报一次"念完了"，
 * 停在那儿等就是整条链断在这里。跳过它继续往下，直到真的排上了一段或者讲完为止。
 */
async function advanceDocTalk(verified?: DocTalk): Promise<void> {
  if (docTalkBusy) return
  const talk = docTalk
  // 不出声的链条不自动往下走。它只是把提纲装在面板上，而 onSpeaking 是别人的语音轮次
  // 结束时也会触发的 —— 捡起来就是一条没有播放节拍限速的链，几十段连着打几十次模型。
  if (talk === null || talk.stopped || !talk.spoken || narrator.isSpeaking()
    || (meetingPresentation?.talkId === talk.sessionId && meetingPresentation.state !== 'presenting')) return
  // 跳过类段落念完之后要停一下，让投屏停在这一段（代码/表格/公式的信息在屏幕上）。
  // ① 正停着：重新登记一次定时器就退出。**不进 docTalkBusy** —— 它表示"正在跑一轮推进"，
  //   被纯等待占住的话，stop/pause 之后就再也没人把链条捡起来。
  // ② 刚念完跳过提示：从这一刻开始算停留（提示语本身那几秒不该算进停留里），
  //   所以这里只是"开始计时"，然后同样让出 busy。
  // 两条路径都只登记定时器，pauseDocTalk/stopDocTalk 会把状态清干净，不会出现"停了还自己念"。
  if (docSkipHoldUntil > Date.now()) {
    armDocSkipHold(talk, docSkipHoldUntil - Date.now())
    return
  }
  if (docSkipHoldPendingMs > 0) {
    const wait = docSkipHoldPendingMs
    docSkipHoldPendingMs = 0
    armDocSkipHold(talk, wait)
    return
  }
  docTalkBusy = true
  try {
    while (docTalk === talk && !talk.stopped && talk.next < talk.outline.sections.length) {
      const index = talk.next
      if (verified !== talk && !await docTalkStillValid(talk)) return
      verified = undefined
      const section = talk.outline.sections[index]
      // 讲解形态决定"这一段念什么"：source = 按原文念稿（不调模型），ai = 让模型写讲解。
      // 跳过哪类段落（代码/表格/公式）以及念完要不要停留，都在 docSpeechPlan 这个纯函数里，
      // 主进程只负责执行它的结论 —— 那段判定是最容易改错的地方，抽出去才能被单测钉住。
      const plan = docSpeechPlan(section, loadSettings().docSpeechMode ?? 'source')
      // 没有可念的文本，要不要跳过得分两种情形：
      // - AI 模式：body 为空就没有可讲解的对象，照旧静默跳过（与改造前一致，plan.text 恒为空）；
      // - 原文朗读：**纯代码/纯表格段**的 body 也是空的，而这恰恰是最该说一句"这段是代码，
      //   我跳过"的场景 —— 不说，听众会以为文档里没这段内容。这类段落由 docSpeechPlan 给出
      //   提示文本（非空），所以照样要念、要停。只有"真空段"（没正文、也没任何标记）才咽掉。
      if (section.text === '' && plan.text === '') {
        talk.next++
        pushDocState()
        continue
      }
      let explanation = talk.explanations.get(index)
      // 原文朗读：不调模型，直接念这一段的原文（跳过类段落只念一句跳过提示）。
      // 仍然写进 explanations 缓存：重讲同一段不必重算；屏幕也靠这条 doc-reply 显示当前在讲什么。
      if (explanation === undefined && plan.mode === 'source') {
        explanation = plan.text
        talk.explanations.set(index, explanation)
        sendToRenderer('doc-reply', { index, text: explanation })
      }
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
        if (!await docTalkStillValid(talk)) return
        explanation = reply.reply
        talk.explanations.set(index, explanation)
        sendToRenderer('doc-reply', { index, text: explanation })
      }
      const utteranceId = docUtteranceId(talk, index)
      if (talk.sessionId === presentedSessionId) presentedView?.explanation(index, explanation, talk.sessionId)
      syncOfficeSection(talk, index)
      narrator.beginRound()
      narrator.speak({
        utteranceId,
        text: explanation,
        fromIndex: narrator.resumeFrom(utteranceId),
        origin: { docPath: talk.path, paragraph: index },
      /* 点到谁讲，逐段就用谁的嗓子念下去；成员设了"总助代念"则用总助。 */
      ...speakerRequestFields(presentationSpeakerVoice(talk.assistantId)),
      })
      // 跳过类段落：记一个"念完再停"的额度，由下一次推进入口开始计时。
      // 不能在这里直接算截止时间——这句跳过提示本身也要念几秒，算进去等于白少停几秒。
      if (plan.holdMs > 0) docSkipHoldPendingMs = plan.holdMs
      if (narrator.isSpeaking()) return
      if (talk.completed.has(index)) continue
      pauseDocTalk()
      pushDocState()
      sendToRenderer('doc-notice', '讲解未能播放，已保留位置；请检查语音后继续。')
      return
    }
    if (docTalk === talk && !talk.stopped) {
      const startedMidway = independentDocument?.talkId === talk.sessionId && independentDocument.from > 0
      const partial = startedMidway || talk.outline.truncated || talk.outline.sections.some(section => section.text.trim() === '' || section.hasCode)
      if (independentDocument?.talkId === talk.sessionId && independentDocument.state === 'presenting') {
        independentDocument.state = partial ? 'partial' : 'completed'
        independentDocument.next = talk.next
        independentDocument.completed = [...talk.completed].sort((a, b) => a - b)
        independentDocument.error = startedMidway ? '从中间段开始，之前的段落未讲解。'
          : partial ? '文档含截断、不可提取段落或代码，仅完成可提取文字的讲解。' : null
      }
      if (meetingPresentation?.talkId === talk.sessionId && meetingPresentation.state === 'presenting') {
        meetingPresentation.state = partial ? 'partial' : 'completed'
        meetingPresentation.lectureOutcome = partial ? 'partial' : 'completed'
        meetingPresentation.error = partial ? '文档含截断、不可提取段落或代码，只有可提取文字完成讲解。' : null
        meetingPresentation.next = talk.next
        meetingPresentation.completed = [...talk.completed].sort((a, b) => a - b)
        if (persistMeetingPresentation(meetingPresentation)) {
          sendToRenderer('doc-notice', partial
            ? `《${talk.outline.title}》仅完成部分讲解，截断、不可提取内容或代码未完整讲解。可以继续讨论，或选择停录后审阅纪要。`
            : `《${talk.outline.title}》可提取文字讲完了。可以继续讨论，或选择停录后审阅会议纪要。`)
        }
      } else sendToRenderer('doc-notice', partial ? `《${talk.outline.title}》仅完成可提取文字的部分讲解。` : `《${talk.outline.title}》讲完了`)
      if (talk.sessionId === presentedSessionId) { presentedView?.stop('completed'); presentedSessionId = null }
      if (talk.sessionId === presentedOfficeSessionId) presentedOfficeSessionId = null
      speakMemberClosing(talk.assistantId)
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
async function explainDocByName(name: string, from: number, speak: boolean, assistantId?: string, via: DocTalk['via'] | 'auto' = 'auto'): Promise<ChatReply> {
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
  via: DocTalk['via'] | 'auto' = 'auto',
  expected?: { fingerprint: string; allowed(): boolean },
): Promise<ChatReply> {
  const bindingId = sessionState?.bindingId
  const revision = docRevision
  // 点名成员就按点名的来；没点名时优先交给具备会议+文档能力的子助理（如"小会"）。
  const who = assistantId ?? (speak ? await presentationMember() : undefined)
  if (who) {
    // 先暖名字缓存：交接台词要点名"交给小会"，不能等异步预取回来才念对名字。
    await memberDisplayName(who)
    prefetchHandoverLines(who, `讲解《${path.basename(target)}》`)
  }
  const opened = await documents.open(target)
  if (bindingId !== sessionState?.bindingId || revision !== docRevision) return { ok: false, error: '会话已改变或讲解已停止，未开始原文档讲解' }
  if (opened.kind !== 'opened') return { ok: false, error: `《${path.basename(target)}》讲不了：${unparseable(opened)}` }
  if (expected && (!expected.allowed() || opened.doc.fingerprint !== expected.fingerprint)) return { ok: false, error: '文档、会议或授权已变化，未开始讲解' }
  if (opened.doc.parsed.kind !== 'outline') {
    return { ok: false, error: `《${opened.doc.name}》讲不了：${parseProblem(opened.doc.parsed)}` }
  }

  const outline = opened.doc.parsed.outline
  // 没点名视图时，装了 WPS 就用 WPS 跟着讲解翻页；没装（或不是 PDF）才回退内置阅读视图。
  const pdf = isPdfName(target)
  // `auto` 恒走内置阅读视图（见 chooseDocVia 的注释），所以这里**不再探测 WPS** ——
  // 探测要拉起辅助进程（首次约 8 秒），为一个不会被采用的结论付这笔代价不值得。
  const chosenVia: DocTalk['via'] = chooseDocVia(via, { speak, pdf, wpsReady: false })
  // 用户点名 WPS 时首次打开要启动外部程序，先说一声，免得用户以为讲解卡住了。
  if (via === 'wps' && chosenVia === 'wps') sendToRenderer('doc-notice', '正在用 WPS 打开文档，讲解随后开始…')
  // 界面点出来的段号必须原样有效：夹一下等于用户点了第 3 段却听第 12 段，还以为文档就是这么写的。
  if (strictSection && (!Number.isInteger(from) || from < 0 || from >= outline.sections.length)) {
    return { ok: false, error: `段号 ${String(from)} 不存在：本文共 ${outline.sections.length} 段，请重新选择。` }
  }
  if (speak && chosenVia === 'wps' && !isPdfName(target)) return { ok: false, error: 'WPS 同步讲解目前只支持 PDF' }
  const autoApproved = speak && !expected && loadSettings().meetingDocumentAutoApprove === true
  if (speak && !expected && !autoApproved) {
    const confirmed = await dialog.showMessageBox({ type: 'question', title: '讲解文档？',
      message: `讲解 ${JSON.stringify(opened.doc.name)}？`,
      detail: `文档：${JSON.stringify(opened.doc.path)}\n文档摘要：${opened.doc.fingerprint}\n讲解会向当前会话模型发送文档片段，讲解期间会监听麦克风以支持插话。`,
      buttons: ['同意讲解', '取消'], defaultId: 1, cancelId: 1, noLink: true })
    if (confirmed.response !== 0) return { ok: false, error: '本人未同意，文档讲解没有开始' }
    if (bindingId !== sessionState?.bindingId || revision !== docRevision) return { ok: false, error: '会话或讲解状态已变化，未开始讲解' }
    const current = await documents.open(target)
    if (bindingId !== sessionState?.bindingId || revision !== docRevision || current.kind !== 'opened'
      || current.doc.fingerprint !== opened.doc.fingerprint) return { ok: false, error: '文档、授权或会话已变化，未开始讲解' }
  }
  const talk: DocTalk = {
    path: opened.doc.path,
    name: opened.doc.name,
    outline,
    fingerprint: opened.doc.fingerprint,
    assistantId: who,
    via: chosenVia,
    spoken: speak,
    next: clampSection(from, outline.sections.length),
    sessionId: randomUUID(),
    bindingId,
    completed: new Set(),
    explanations: new Map(),
    stopped: false,
  }
  // 视图先装上新讲解计划再装链：装链会停掉旧链，停的只能是旧视图会话（见 presentedSessionId）。
  if (speak || isOfficeDoc(talk.path)) {
    const shown = await presentDocView(talk)
    if (bindingId !== sessionState?.bindingId || revision !== docRevision || (expected && !expected.allowed())
      || (autoApproved && loadSettings().meetingDocumentAutoApprove !== true)) {
      if (presentedSessionId === talk.sessionId) { presentedView?.stop('replaced'); presentedSessionId = null }
      if (presentedOfficeSessionId === talk.sessionId) presentedOfficeSessionId = null
      return { ok: false, error: '会话已改变或讲解已停止，未开始原文档讲解' }
    }
    if (!shown.ok) return { ok: false, error: shown.error }
  }
  if (expected && !expected.allowed()) return { ok: false, error: '会议、授权或会话已变化，未开始讲解' }
  // 提纲算一次，两处共用：语音那条路念它的第一行，回执铺它的全部。
  const described = describeOutline(outline)
  const whoName = who ? await memberDisplayName(who) : ''
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
  // 委派要给名字：用户得知道这份文档交给了谁，而不是只有一句"已提交讲解"。
  if (who && whoName) lines.push(`交给「${whoName}」讲解。`)
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
  if (meetingPresentation?.talkId === talk.sessionId && !['presenting', 'paused'].includes(meetingPresentation.state)) {
    return { ok: false, error: '会议讲解已失效或结束，请在会议页核查。' }
  }
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
  // 用户明确说"继续讲解"就是不想再等：跳过段的停留一并作废，否则他得再干等十来秒。
  clearDocSkipHold()
  talk.stopped = false
  // 视图还开着就接着推进；用户关过视图则重新打开到当前段，不静默只出声。
  if (isOfficeDoc(talk.path)) {
    // 追问打断后页面保持原段；这里重新对齐到未讲完的段，再继续推进。
    const shown = await presentDocView(talk)
    if (!shown.ok) { talk.stopped = true; return { ok: false, error: shown.error } }
  } else if (talk.sessionId === presentedSessionId) presentedView?.resume()
  else {
    const shown = await presentDocView(talk)
    if (!shown.ok) { talk.stopped = true; return { ok: false, error: shown.error } }
  }
  if (docTalk !== talk || talk.stopped) return { ok: false, error: '文档讲解已切换或停止。' }
  if (!await docTalkStillValid(talk)) return { ok: false, error: '文档已变化或不在授权范围，请重新解析后讲解。' }
  if (meetingPresentation?.talkId === talk.sessionId && meetingPresentation.state === 'paused') {
    const state = meetingRecorder?.getState()
    if (!state?.recording || state.meetingId !== meetingPresentation.meetingId || state.missingTracks.length > 0) {
      failMeetingPresentation(meetingPresentation.id, '会议录音已停止、切换或缺轨，不能继续讲解。')
      stopDocTalk()
      return { ok: false, error: '会议录音已停止、切换或缺轨，不能继续讲解。' }
    }
    meetingPresentation.state = 'presenting'
    if (!persistMeetingPresentation(meetingPresentation)) { stopDocTalk(); return { ok: false, error: '讲解状态无法保存，请在会议页核查。' } }
  }
  if (independentDocument?.talkId === talk.sessionId && independentDocument.state === 'paused') independentDocument.state = 'presenting'
  void advanceDocTalk(talk)
  return { ok: true, reply: `继续《${talk.name}》，从上次未完整播放的句子接着讲。` }
}

/**
 * 用户明确要求"下一段"或"跳到第 N 段"。
 *
 * 讲解链由桌面端逐段推进，模型手里只有当前段；这类话一旦当成普通聊天发出去，模型就只能
 * 回答"没有原文"。这里直接接管：定位到目标段，再走 `resumeDocTalk` 的重新授权、双轨核验
 * 与播报路径，避免另开一条绕过校验的捷径。
 *
 * `target` 是 0 起的段号；省略表示跳过当前待讲的那一段。
 */
async function moveDocTalk(target?: number, spoken = false): Promise<ChatReply> {
  const talk = docTalk
  if (talk === null) return { ok: false, error: '现在没有正在讲解的文档，请先选择文档。' }
  if (meetingPresentation?.talkId === talk.sessionId && !['presenting', 'paused'].includes(meetingPresentation.state)) {
    return { ok: false, error: '会议讲解已失效或结束，请在会议页核查。' }
  }
  if (independentDocument?.talkId === talk.sessionId && !['presenting', 'paused'].includes(independentDocument.state)) {
    return { ok: false, error: '文档讲解已失效或结束，请重新发起。' }
  }
  const total = talk.outline.sections.length
  if (total === 0) return { ok: false, error: '这份文档没有可讲解的段落。' }
  // next 指向的是"下一段要讲的位置"：它已经开始讲（或正在生成）才算当前段，跳过去；
  // 还没开始才说明用户说的"下一段"就是它。
  const currentStarted = narrator.isSpeaking() || docTalkBusy || talk.explanations.has(talk.next)
  let index = target === undefined ? talk.next + (currentStarted ? 1 : 0) : clampSection(target, total)
  index = Math.min(index, total)
  clearDocAutoResume()
  interruptSpeech(false)
  if (index >= total) {
    talk.next = total
    const result = await resumeDocTalk(spoken)
    return result.ok ? { ...result, reply: `《${talk.name}》已经讲到最后一段了。` } : result
  }
  talk.next = index
  const result = await resumeDocTalk(spoken)
  if (!result.ok) return result
  return { ...result, reply: `好，从第 ${index + 1} 段「${talk.outline.sections[index].heading ?? '无标题'}」开始讲。` }
}


async function askAboutDoc(target: string, index: number, question: string, assistantId?: string, spoken = false): Promise<ChatReply> {
  const talk = docTalk
  // 讲解中的追问跟讲解用同一个成员，避免讲是小会、答又换回总助理。
  const who = assistantId ?? (talk?.path === target ? talk.assistantId : undefined)
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
      ? await sendChatReply(prompt, bindingId, true, who, undefined, false, false)
      : await bridge.chat(withInterruptedSpeech(prompt), who, request.signal, undefined, bindingId)
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

/**
 * 唤醒应答的常驻播放进程（Windows）。
 *
 * 每次新起 PowerShell 的播放路径实测要 2.5 秒才出声，而唤醒应答只有两三秒长 ——
 * 用户听到的"喊完等一两秒才回话"主要就是它。启动时预热，之后每句只剩 MCI 命令。
 */
const playHost = new PlayHost({ scriptDir: layout.scriptDir, platform: platformOf() })

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
  () => (audioPrefs().bargeIn || (docTalk !== null && docTalk.spoken && !docTalk.stopped)
    || meetingRecorder?.getState().recording === true ? 'renderer' : 'process'),
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
    const inMeeting = meetingRecorder?.getState().recording === true
    const presenting = docTalk !== null && docTalk.spoken && !docTalk.stopped
    // 本人明确允许讲解期间监听插话；设置页说明麦克风与识别服务的数据去向。
    if (audioPrefs().bargeIn || inMeeting || presenting) {
      applyAudio({ type: 'barge-in-requested', allowInMeeting: inMeeting })
    }
    return
  }
  const listening = audioState.holder === 'barge-in' || audioState.bargeInMeeting
  if (!listening || bargeReleaseTimer) return
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
    // 唤醒应答播到最后一个分句就算说完：界面收到 wake-greeting-finished 才开麦。
    // 它和回答共用 Narrator，所以"播完"只能从这里拿，不能靠等一个固定时长。
    if (wakeGreeting !== null && record.complete && record.segment.utteranceId === wakeGreeting.utteranceId) {
      const count = splitIntoSegments({ utteranceId: wakeGreeting.utteranceId, text: wakeGreeting.text }).length
      if (record.segment.index === count - 1) finishWakeGreeting(wakeGreeting.utteranceId, '播放结束')
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
      if (meetingPresentation?.talkId === talk.sessionId && meetingPresentation.state === 'presenting') {
        const presentation = meetingPresentation
        presentation.next = talk.next
        presentation.completed = [...talk.completed].sort((a, b) => a - b)
        if (!persistMeetingPresentation(presentation)) {
          talk.stopped = true
          queueMicrotask(() => {
            if (docTalk === talk && presentation.state === 'failed') { interruptSpeech(false); stopDocTalk(); pushDocState() }
          })
          return
        }
      }
      pushDocState()
    }
  },
  onSpeaking: (speaking) => {
    speechActive = speaking
    applyThrottling()
    speechLog(`speaking=${speaking}`)
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
      // 挂起的讲解排在前面：总助理的介绍念完了，现在才轮到子助理开口。
      // 顺序不能反 —— 讲解还没真正开始时，反问窗口不该开（两者互斥）。
      startPendingDocTalk()
      void advanceDocTalk()
      // 答完（或反问念完）之后推进"反问 → 等待"这件事：念完回答才知道该问，
      // 问句念完才开始算 5 秒。两跳都在这里收束，因为它只认"没有语音在播"这一个条件。
      pumpDocFollowup()
      void maybeStartMeetingPresentation()
      void maybeStartIndependentDocument()
    }
  },
  onVoice: voice => console.log('[dsh-pet] 语音合成音色：', voice),
  onError: reason => {
    console.log('[dsh-pet] 语音合成不可用：', reason)    // 念不出来是个听不见的故障：不报一句，用户只会觉得"它没反应"，然后去重启整个壳。
    speechLog(`tts-error: ${reason}`)
    sendToRenderer('speech-state', { speaking: false, error: reason })
    if (spokenRound) {
      spokenRound.cancelled = true
      spokenRound.controller.abort()
      narrator.dropFeed(spokenRound.utteranceId)
      // 合成失败必须把这一轮收掉：否则 spokenRound 永远非空，
      // 之后所有委派/讲解的"等本轮说完"闸门全被挡死，子助理再也出不来。
      const round = spokenRound
      spokenRound = null
      if (round.voiceTurn) sendToRenderer('voice-turn-complete', { ...round.voiceTurn, outcome: 'stopped' })
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
// 没自带音色的句子（唤醒应答/快答/讲解）默认用总助理的嗓子，三条链路不再各用各的。
  defaultVoice: () => chiefSpeakerVoice(),
  // 成员级音色服务：编辑窗里选的某条 TTS 配置（MiMo 三模型等）。
  resolveProfile: id => voiceApiStore?.resolveId(id) ?? null,
  // 按句携带音色档案名时按档案解析（§4.6 ★④ 子助理按成员音色播报）：
  // ①名字唯一命中自定义 TTS 档案 → 用该档案；
  // ②形如 edge-tts 音色名（zh-CN-XiaoxiaoNeural）→ 当前服务仅换音色；
  // ③解析不出 → 返回 null，Narrator 回退全局默认音色并告警，不静默丢文本。
  voiceProfileApi: (voiceProfile: string): ResolvedVoiceApi | null => {
    const byName = voiceApiStore?.resolveByName('tts', voiceProfile) ?? null
    if (byName !== null) return byName
    if (isEdgeTtsVoiceName(voiceProfile)) {
      const base = voiceApiStore?.resolve('tts') ?? null
      return base === null ? null : { ...base, voice: voiceProfile }
    }
    return null
  },
  // 固定话术（唤醒应答等）合成一次就落盘复用；换音色自动失效重合成。
  cache: ttsCache,
  // 默认合成（没配自定义服务）时的音色键：和 greetingVoiceKey(null) 必须一致，
  // 否则预热写进去的音频在默认配置下永远查不到。
  fixedVoiceKey: () => greetingVoiceKey(null),
})

let exitFallbackTimer: NodeJS.Timeout | null = null
let exitRequested = false

/** 已播报过的子助理 runId（§4.6 ★②）：断线重连重放事件环时不重播；环形上限 200 条。 */
const subAssistantSpokenRunIds = new Set<string>()

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
function setCharacterSkin(target: MenuTarget, skin: string): void {
  const current = loadSettings().characters ?? {}
  // 换形象=换一套动作素材：随机集合重置为该皮肤自有动作，避免沿用上一套皮肤的勾选。
  const custom = listCustomSkins(app.getPath('userData')).find(s => s.id === skin)?.actions ?? []
  const randomActions = custom.length > 0 ? [...custom] : [...DEFAULT_RANDOM_ACTIONS]
  const next = { ...current, [target.assistantId]: { ...current[target.assistantId], skin, randomActions } }
  saveSettings({ characters: next })
  sendToRenderer('characters-changed', next)
}

/** 右键"随机动作"勾选：只随机勾选的动作；持久化到 characters[assistantId].randomActions。 */
function setCharacterRandomAction(target: MenuTarget, action: string, on: boolean): void {
  const current = loadSettings().characters ?? {}
  const prev = current[target.assistantId]?.randomActions ?? [...DEFAULT_RANDOM_ACTIONS]
  const nextList = on ? [...new Set([...prev, action])] : prev.filter(a => a !== action)
  const next = { ...current, [target.assistantId]: { ...current[target.assistantId], skin: current[target.assistantId]?.skin ?? resolveSkinFor(target), randomActions: nextList } }
  saveSettings({ characters: next })
  sendToRenderer('characters-changed', next)
}
function resolveSkinFor(target: MenuTarget): string {
  return target.skin || 'panda'
}

function buildContextMenu(target: MenuTarget | null): Menu {
  const stored = target ? loadSettings().characters?.[target.assistantId]?.skin : undefined
  // 本机存过的优先；没有就用渲染层报的当前生效皮肤（插件下发的或编制默认的）。
  const current = stored ?? target?.skin ?? ''
  const items: Array<MenuItemConstructorOptions> = []
  // 高频在上：右键只留「最常用的三件」+ 形象/动作 + 隐藏/退出（原来 11 项）。
  // 其余入口全都并进了工作台（`settings-nav.ts` 是导航的单一真源）：宠物设置 / 团队管理 /
  // 文档管理 / 任务与提醒 / 日报工作台各自对应工作台里的一页，右键再列一遍只会越来越长。
  items.push(
    // AI 对话：复用既有的 summon 通道 —— 渲染层收到后会打开对话面板并把焦点放进输入框，
    // 和"讲完文档顺手聊一句"走的是同一条路，不新增通道。
    { label: 'AI 对话', click: () => {
      if (win && !win.isDestroyed()) { win.show(); win.focus() }
      sendToRenderer('summon', null)
    } },
    { label: '会议助手', click: () => openSettings('meeting') },
    { label: '打开工作台', click: () => openSettings('general') },
    // 日报文件夹暂时留在右键：它的"次级按钮"要加在工作台 report 页（渲染层），
    // 这轮只动菜单，先保证用户找得到；渲染层加上之后这一项可以撤掉。
    { label: '日报文件夹', click: () => { void shell.openPath(path.join(dshHome(), 'personal-assistant', 'reports')) } },
    { type: 'separator' },
  )
  if (target) {
    items.push({
      label: `换个形象：${target.displayName || '这个角色'}`,
      submenu: [
        ...PET_OPTIONS.map(option => ({
          label: option.label,
          type: 'radio' as const,
          checked: current === option.id,
          click: () => setCharacterSkin(target, option.id),
        })),
        // 本地登记的自定义皮肤（哪吒等生成形象）不进仓库，但右键要能选到：
        // 菜单每次构建时读登记表，工作室新做的皮肤下次右键即出现。
        ...listCustomSkins(app.getPath('userData')).map(skin => ({
          label: skin.name,
          type: 'radio' as const,
          checked: current === skin.id,
          click: () => setCharacterSkin(target, skin.id),
        })),
        { type: 'separator' as const },
        // 形象与音色工作室是高频功能，不埋进设置页：挂在"换个形象"里正好顺路。
        { label: '形象与音色工作室…', click: () => assetStudio?.open() },
      ],
    })
    const randomNow = loadSettings().characters?.[target.assistantId]?.randomActions ?? [...DEFAULT_RANDOM_ACTIONS]
    // 候选跟随当前形象：内置生活动作 + 该皮肤登记的自定义动作（帧序列/透明 webm）。
    const skinNow = stored ?? target.skin ?? 'panda'
    const customActions = listCustomSkins(app.getPath('userData')).find(s => s.id === skinNow)?.actions ?? []
    const randomCandidates = [...new Set([...RANDOM_CANDIDATES, ...customActions])]
    const ACTION_LABELS: Record<string, string> = {
      walk: '走路', jump: '蹦跳', wave: '挥手', read: '看书', play: '玩耍', write: '敲电脑',
      'laptop-in': '开电脑', 'laptop-out': '收电脑站起', think: '思考', sleep: '睡觉',
      turnaround: '转身', breathe: '呼吸待机', swagger: '插兜swagger走',
      'declare-fate': '我命由我不由天', 'recite-poem': '念诗', transform: '变身火焰',
    }
    items.push({
      label: '随机动作（只随机勾选的）',
      submenu: randomCandidates.map(action => ({
        label: ACTION_LABELS[action] ?? action,
        type: 'checkbox' as const,
        checked: randomNow.includes(action),
        click: (item: { checked: boolean }) => setCharacterRandomAction(target, action, item.checked),
      })),
    })
    if (target.assistantId !== 'member-tangseng') {
      const steppedDown = (loadSettings().stepDownMembers ?? []).includes(target.assistantId)
      items.push(steppedDown
        ? { label: `请${target.displayName || 'TA'}上台`, click: () => sendToRenderer('member-step-up', target.assistantId) }
        : { label: `让${target.displayName || 'TA'}退下（不退出宠物）`, click: () => sendToRenderer('member-step-down', target.assistantId) })
    }
  }
  items.push(
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
    || /^(继续讲解|接着讲|继续讲|继续往下讲|接着往下讲|往下讲|停止讲解|暂停讲解|结束讲解)/u.test(command.text.trim())) exclude()
  if (command.text.trim().startsWith('/')) return bridge.sessionCommand({ ...command, voiceTurn: undefined, spoken: false })
  const current = () => command.bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
  // 反问窗口里那句"继续/往下/接着"是给讲解链的指令，不是提问：直接续讲，**不发给模型**。
  // 发给模型会白绕一次往返，还把这 5 秒窗口耗掉 —— 用户明确要求继续时再让他等一轮模型，
  // 体验上等于没听他的话。窄匹配（≤12 字、无问号、无疑问词）保证"这段继续讲讲是什么意思"
  // 这类真问题不会被劫持，仍按提问走 withPresentationContext。
  if (docFollowupState.active && isExplicitContinue(command.text)) {
    const talk = docFollowupTalk
    cancelDocFollowup()
    if (talk !== null && docTalk === talk && talk.stopped) {
      const resumed = await resumeDocTalk(command.spoken === true)
      return resumed.ok ? { ok: true, reply: '好，接着讲。' } : { ...resumed, reply: resumed.error ?? resumed.reply }
    }
  }
  const text = command.text.trim().replace(/[。！!，,\s]+$/u, '')
  // 这里只判断是否应绕开单动作捷径，不替会话拆解、执行或批准任何步骤。
  // 打开并讲解同一文档仍属一个动作；不同业务动作同时出现才把原文交回统一入口。
  const explanationQuestion = /^(?:(?:请问)?(?:为什么|为何|如何|怎么|怎样)|(?:这里|这段|这个|这份|它|刚才).{0,16}(?:为什么|为何|怎么|如何|是什么))/u.test(text)
  const actions = [
    mentionsDocs(text),
    /(?:(?:创建|新建|召开|发起|加入|开始|启动|开启|停止|结束|暂停|关闭).{0,14}(?:会议|开会|录音|录制|麦克风|回环)|(?:会议|开会|录音|录制).{0,14}(?:开始|启动|开启|停止|结束|暂停|关闭|录下来)|(?:先|再|然后|请|帮我)(?:给我|帮我)?录音|(?:^|先|再|然后|请|帮我|我们|去|现在)(?:给我|帮我|去)?开(?:个|一场|场)?会|开录|停录)/u.test(text),
    mentionsMeetingMinutes(text),
    /(?:发送|转发|邮寄|发(?:一封|给|到|至|往|送|邮件|信息|消息|企微|微信))/u.test(text),
    /(?:提醒|催办|闹钟)/u.test(text),
    /(?:搜索|检索|查找|查询|查(?:看|找)?(?:一下)?(?:资料|信息|网页|文件|文档|报告))/u.test(text),
    /(?:安装|卸载|下载).{0,16}(?:插件|扩展|软件|应用|程序|工具)/u.test(text),
    /(?:翻译|润色|改写|导出)/u.test(text),
    /(?:另存|保存|写入|生成|创建).{0,16}(?:文件|文档|报告|表格|word|pdf)/iu.test(text),
    /(?:打开|关闭|启动|停止|退出|切换).{0,12}(?:应用|软件|程序|浏览器|窗口|页面)/u.test(text),
  ].filter(Boolean).length
  const compound = !explanationQuestion && actions > 1
  let local: ChatReply | null = null
  if (!assistantId && !compound) {
    const move = docTalk === null ? null : sectionMoveIntent(text)
    if (move !== null) {
      // 明确要求换段：由桌面端推进讲解链，不能把这句话当普通聊天交给模型。
      exclude()
      local = await moveDocTalk(move.target, command.spoken === true)
    } else if (text === '继续' && docTalk !== null && interruptedChat && interruptedSpeech !== null) {
      // 两件事都停在半路：讲解和刚才的回答。只有一件时才替用户接着做。
      local = { ok: true, reply: `有两件被打断的事：《${docTalk.name}》的讲解，和刚才的回答。说“继续讲解”接着讲文档，说“接着说”继续刚才的回答。` }
    } else if (/^(继续讲解|接着讲|继续讲|继续往下讲|接着往下讲|往下讲)$/.test(text) || (text === '继续' && docTalk !== null)) {
      interruptedChat = false
      local = resumeWaitingIndependentDocument() ?? resumeWaitingMeetingPresentation() ?? await resumeDocTalk(command.spoken === true)
    } else if (/^(停止讲解|暂停讲解|结束讲解)$/.test(text) || (text === '停一下' && docTalk !== null)) {
      if (text === '结束讲解') {
        cancelMeetingPresentation('讲解已结束；若会议仍在录音，请明确停录。')
        cancelIndependentDocument('讲解已结束，录音状态不变。')
      } else { pauseMeetingPresentation(); pauseWaitingIndependentDocument() }
      interruptSpeech()
      if (text === '结束讲解') stopDocTalk()
      pushDocState()
      local = { ok: true, reply: text === '结束讲解' ? '已结束讲解。' : '已暂停讲解并保留位置。' }
    } else if (mentionsDocs(text)) {
      const intent = detectDocIntent(text, await docCandidates())
      if (!current()) return { ok: false, error: '会话已改变，文档请求未继续执行' }
      if (intent.kind !== 'none') exclude()
      // 点名 WPS 就按指定应用处理；WPS 不可用时如实说明，不悄悄换成系统关联或阅读视图。
      // 说“内置/自带/阅读视图”则明确要求内置阅读视图，不被默认的 WPS 偏好覆盖。
      const viaWps = /wps/iu.test(text)
      const viaReading = !viaWps && /(内置|自带|阅读视图)/u.test(text)
      if (intent.kind === 'open') local = viaWps ? await openDocInWps(intent.mention.file.name) : await openDocByName(intent.mention.file.name)
      if (intent.kind === 'explain') {
        // 语音发起的讲解直接开讲；打字发起时按“朗读回复”设置决定是否出声（用户明确打开过就该念）。
        // 不出声时仍要打开文档面板：否则用户只看到一句提纲，既没有文档也没有讲解入口。
        const wantSpeak = command.spoken === true || loadSettings().readReplies === true
        local = await explainDocByName(intent.mention.file.name, 0, wantSpeak, undefined, viaWps ? 'wps' : viaReading ? 'reading' : 'auto')
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
    return sendChatReply(command.text, command.bindingId, command.spoken === true || readReplies, assistantId, voiceTurn, compound, true,
      command.spoken === true ? command.text : undefined)
  }
  interruptSpeech()
  const contextual = withPresentationContext(command.text)
  return bridge.sessionCommand({ ...command, text: compound ? command.text : contextual, spoken: false })
}

function registerIpc(): void {
  meetingRecorder = createMeetingRecorder({
    userDataDir: app.getPath('userData'),
    audio: applyAudio,
    speakerCounts: () => loadSettings().meetingSpeakerCounts ?? { mic: 0, loopback: 0 },
    notifyRenderer: (channel: string, payload: unknown) => {
      // 会议开始：先把会议麦克风轨的授权（令牌 = 会议 id）下发，再通知渲染层开采 —— 顺序反了它订阅不上。
      if (channel === 'meeting-started' && payload !== null && typeof payload === 'object'
        && typeof (payload as { meetingId?: unknown }).meetingId === 'string') {
        meetingGrantId = (payload as { meetingId: string }).meetingId
        pushAudioGrants()
      }
      sendToRenderer(channel, payload)
      if (channel === 'meeting-state-changed' || channel === 'meeting-started') {
        reportPetState()
        applyThrottling()
        speechLog(`meeting recording=${meetingRecorder?.getState().recording === true}`)
      }
      if (channel === 'meeting-state-changed' && meetingPresentation?.meetingId) {
        const presentation = meetingPresentation
        const state = payload as ReturnType<MeetingRecorder['getState']>
        if (!['completed', 'partial', 'stopping', 'transcribing', 'awaiting-review', 'cancelled', 'failed'].includes(presentation.state)
          && (state.meetingId !== presentation.meetingId || !state.recording || state.missingTracks.length > 0)) {
          failMeetingPresentation(presentation.id, '会议录音已停止、切换或缺轨，讲解不再推进；请在会议页核查。')
          if (docTalk && presentation.talkId === docTalk.sessionId) { interruptSpeech(false); stopDocTalk(); pushDocState() }
        }
      }
    },
    // 密钥包装手段按平台分派（`dpapi.ts`）：Windows 走 DPAPI，macOS/Linux 走 safeStorage。
    // 这里把 safeStorage 递进去 —— dpapi.ts 自己不许 import electron（要能被 node --test 导入）。
    storeDeps: { dpapi: { safeStorage } },
    // 纪要草稿优先交给会议+文档子助理生成；没有这样的成员才回退当前会话的模型。
    // 会议文字会进入该会话的上下文与历史：这一点写进授权说明，由用户决定。
    summarize: async (prompt, signal) => bridge.chat(prompt, await presentationMember(), signal, undefined, sessionState?.bindingId),
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
  registerMeetingIpc({ ipc: ipcMain, recorder: meetingRecorder,
    chooseExportDirectory: async event => {
      const parent = win
      if (!parent || parent.isDestroyed() || !stageSender(event as Electron.IpcMainInvokeEvent)) return null
      const picked = await dialog.showOpenDialog(parent, { title: '选择保存明文会议纪要的目录',
        buttonLabel: '保存到此目录', properties: ['openDirectory'] })
      return picked.canceled || picked.filePaths.length !== 1 ? null : picked.filePaths[0]
    },
    confirmDelete: async (event, name) => {
      const parent = win
      if (!parent || parent.isDestroyed() || !stageSender(event as Electron.IpcMainInvokeEvent)) return false
      const { response } = await dialog.showMessageBox(parent, {
        type: 'warning', title: '删除这场会议？', message: `删除《${name}》？`,
        detail: '录音、转写与纪要会一并删除，无法恢复；已经导出的纪要文件不在删除范围内。',
        buttons: ['删除', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      return response === 0
    },
    authorizeStart: (event, raw, requestId) => {
      if (requestId === undefined) return null
      const pending = pendingMeetingStart
      if (!stageSender(event as Electron.IpcMainInvokeEvent) || !pending || pending.id !== requestId || pending.expiresAt <= Date.now()) {
        return '会议启动请求已取消、过期或来源无效'
      }
      if (pending.autoApproved && loadSettings().meetingDocumentAutoApprove !== true) return '自动审批已关闭，未开始录音'
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '会议参数与本次请求不一致'
      const consent = raw as Partial<MeetingConsentInput>
      const expected = pending.consent
      if (consent.name !== expected.name || consent.sources !== expected.sources || consent.consentText !== expected.consentText
        || consent.consented !== expected.consented || consent.retentionDays !== expected.retentionDays) return '会议参数与本次请求不一致'
      return null
    },
    onStarted: (meetingId, consent, requestId) => {
    const pending = pendingMeetingStart
    if (!pending) return
    pendingMeetingStart = null
    clearTimeout(pending.timer)
    if (requestId !== pending.id) {
      failMeetingPresentation(pending.presentationId, '另一场人工会议已开始，本次会议讲解没有启动')
      void replyDesktopCommand(pending.id, false, { meetingId }, '另一场人工会议已开始，本次桌面命令未执行')
      return
    }
    pendingMeetingReady = { id: pending.id, meetingId, presentationId: pending.presentationId }
    if (pending.presentationId && meetingPresentation?.id === pending.presentationId) {
      meetingPresentation.meetingId = meetingId
      if (!persistMeetingPresentation(meetingPresentation)) {
        pendingMeetingReady = null
        meetingRecorder?.requestStop(meetingId)
        void replyDesktopCommand(pending.id, false, undefined, '会议已开始但步骤状态未能保存，已请求停录；请核查冲刷结果。')
        return
      }
    }
    // 双轨就绪才回“开始成功”：只下发开始事件不代表真的录到了声音。
    void (async () => {
      const ready = await meetingRecorder!.waitTracksReady(meetingId)
      if (pendingMeetingReady?.id !== pending.id || pendingMeetingReady.meetingId !== meetingId) return
      pendingMeetingReady = null
      const current = meetingRecorder!.getState()
      if (!current.recording || current.stopping || current.meetingId !== meetingId) {
        failMeetingPresentation(pending.presentationId, '会议在就绪前已停止或切换，不能继续讲解')
        await replyDesktopCommand(pending.id, false, { meetingId, ...ready }, '会议在就绪前已停止或切换，不能继续后续步骤')
        return
      }
      if (!ready.ready) {
        const stopped = meetingRecorder!.requestStop(meetingId)
        const names = ready.missing.map(track => track === 'mic' ? '麦克风' : '系统回环').join('、') || '音频'
        failMeetingPresentation(pending.presentationId, `${names}未就绪，讲解没有开始；停录结果请在会议页核查。`)
        await replyDesktopCommand(pending.id, false, { meetingId, ...ready, stopRequested: stopped.ok },
          `${names}在时限内没有收到音频；${stopped.ok ? '已请求停录，仍需等待冲刷回执' : '停录请求未获确认'}，请在会议页核查。`)
        return
      }
      const presentation = pending.presentationId && meetingPresentation?.id === pending.presentationId ? meetingPresentation : null
      if (presentation && presentation.state !== 'opening') return
      const delegateName = presentation?.assistantId ? await memberDisplayName(presentation.assistantId) : ''
      if (presentation) {
        presentation.state = 'waiting-to-present'
        presentation.waitUntil = Date.now() + PRESENT_WAIT_CAP_MS
        if (!persistMeetingPresentation(presentation)) {
          meetingRecorder!.requestStop(meetingId)
          await replyDesktopCommand(pending.id, false, undefined, '双轨已就绪但步骤状态未能保存，已请求停录；请在会议页核查。')
          return
        }
      }
      const delivered = await replyDesktopCommand(pending.id, true, { meetingId, name: consent.name, sources: consent.sources,
        startedAt: current.startedAt, recorded: ready.recorded,
        notice: `${presentation ? `两轨已就绪；${delegateName ? `交给「${delegateName}」，` : ''}当前会话回复结束后才开始讲解，这不代表已经讲完。` : '两轨已就绪，录音已开始。'}会议编号供工具内部使用，回复中不要读出或展示。`,
        ...(presentation ? { presentationId: presentation.id, state: 'waiting-to-present' } : {}) })
      if (presentation) {
        if (!delivered) { failMeetingPresentation(presentation.id, '会议已开始但桌面回执未确认，未自动开讲，请在会议页核查。'); return }
        if (meetingPresentation !== presentation || presentation.state !== 'waiting-to-present') return
        armMeetingPresentationDeadline(presentation)
        void maybeStartMeetingPresentation()
      }
    })()
  } })
  ipcMain.handle('meeting-take-command', event => {
    if (!stageSender(event)) return null
    return pendingMeetingStart ? { requestId: pendingMeetingStart.id, consent: pendingMeetingStart.consent } : null
  })

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

  // ===== 受管执行器与目标锁（底座 4.6 切片1）=====
  // 与窗口证据共用同一 UIA 辅助进程；只有真的领到命令才拉起，平时不常驻。
  const execActions = (): WinDesktopActions => (evidenceActions ??= createWinActions({ scriptDir: layout.scriptDir }))
  targetLockHandle = createTargetLock(winActionsTargetLockIO({
    readForegroundIdentity: () => execActions().readForegroundIdentity(),
    readProcessIdentity: pid => execActions().readProcessIdentity(pid),
  }))
  const desktopExecutor = createDesktopTaskExecutor({
    channel: {
      nextCommand: () => bridge.nextDesktopCommand(),
      claimCommand: id => bridge.claimDesktopCommand(id),
      receiptCommand: (id, receipt) => bridge.receiptDesktopCommand(id, receipt),
    },
    actions: {
      readVisibleText: (...args: Parameters<WinDesktopActions['readVisibleText']>) => execActions().readVisibleText(...args),
      readPage: (...args: Parameters<WinDesktopActions['readPage']>) => execActions().readPage(...args),
    },
    targetLock: targetLockHandle,
    // 切片2：经 executor 凭据消费插件侧已批准的一次性动作；无回执记 unknown 由执行器对账。
    applyApprovedAction: async (actionId) => {
      const result = await bridge.applyComputerAction(actionId)
      if (!result) throw new Error('电脑动作没有确定回执')
      if (result.ok === true && result.state === 'issued') return { state: 'issued' }
      if (result.state === 'failed-before-effect') return { state: 'failed-before-effect', error: String(result.error ?? '执行前被拒绝') }
      return { state: 'unknown', error: String(result.error ?? '结果不明') }
    },
    log: message => console.log(`[desktop-executor] ${message}`),
  })
  const executorTimer = setInterval(() => {
    if (platformOf() === 'win32') void desktopExecutor.runOnce().catch(() => {})
  }, 2000)
  executorTimer.unref()

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

  ipcMain.handle('meeting-todo-import', createMeetingTodoHandler<Electron.IpcMainInvokeEvent>({
    binding: event => stageSender(event) && sessionState?.status !== 'disconnected' ? sessionState?.bindingId ?? null : null,
    read: id => ({ name: meetingRecorder?.meetingName(id) ?? null,
      view: meetingRecorder?.getMinutes(id) ?? { ok: false as const, error: '会议库尚未就绪' } }),
    confirm: async item => {
      const choice = await dialog.showMessageBox({ type: 'question', title: '将会议行动项记为待办？',
        message: '请核对这条行动项和数据去向', buttons: ['取消', '确认加入待办'], defaultId: 0, cancelId: 0, noLink: true,
        detail: [`会议：${item.meetingName}`, `行动项：${item.text}`, `负责人：${item.owner || '待确认'}`,
          `期限：${item.due || '待确认'}`, `转写版本：${item.revision}`, `纪要摘要：${item.digest}`,
          `来源：${item.sourceRefs.join('、')}`, '',
          '这条内容将以明文复制到本机任务库，不会因此发信或设置提醒。会议后续修改不会自动更新已有待办。'].join('\n') })
      return choice.response === 1
    },
    post: item => bridge.companionRequest('POST', '/companion/v1/meeting-actions/import', item, 'owner'),
  }))

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
  /** 试听用的固定例句：够长能听出音色和语气，又不至于每次白烧很多字。 */
const VOICE_PREVIEW_TEXT = '你好，我是你的桌面助理。这句话用来试听音色——如果听着自然，就把这个音色留下；如果太生硬，换一个再听。'

  /*
   * 按性格生成音色描述：把助理的性格/人设交给插件侧的主助理模型，换回一段
   * 可直接喂给 MiMo voicedesign 的描述。产出是**起点**，用户还能手改再试听。
   */
  ipcMain.handle('voice-design-assist', async (_event, input: unknown) => {
    const raw = (input && typeof input === 'object' ? input : {}) as { name?: unknown; personality?: unknown; model?: unknown }
    const personality = typeof raw.personality === 'string' ? raw.personality.trim() : ''
    if (personality === '') return { ok: false, error: '先给这位助理写一点性格，才能按性格配色' }
    if (personality.length > 4000) return { ok: false, error: '性格描述太长了，请精简一些' }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : undefined
    const modelRaw = (raw.model && typeof raw.model === 'object' ? raw.model : null) as { provider?: unknown; model?: unknown } | null
    const model = modelRaw && typeof modelRaw.provider === 'string' && typeof modelRaw.model === 'string'
      && modelRaw.provider.trim() && modelRaw.model.trim()
      ? { provider: modelRaw.provider.trim().slice(0, 128), model: modelRaw.model.trim().slice(0, 256) } : undefined
    try {
      const response = await bridge.companionRequest('POST', '/companion/v1/members/voice-design',
        { personality, ...(name ? { name } : {}), ...(model ? { model } : {}) }, 'owner', 95_000)
      if (response.status !== 200) {
        const message = (response.body as { message?: string } | null)?.message
        return { ok: false, error: message ?? '音色助手暂时不可用' }
      }
      const body = response.body as { description?: unknown; style?: unknown } | null
      const description = body?.description
      if (typeof description !== 'string' || description.trim() === '') return { ok: false, error: '没有生成出可用的描述，请补充一点性格再试' }
      return { ok: true, description: description.trim(), style: typeof body?.style === 'string' ? body.style.trim().slice(0, 500) : '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '音色助手暂时不可用' }
    }
  })

  /*
   * 交接台词：总助把活交给某成员时，四方各说一句（由模型按两人性格生成）。
   * 台词只用于朗读与气泡，**不写进会话、不进记忆** —— 交接是表演，不是事实。
   */
  ipcMain.handle('handover-lines', async (_event, input: unknown) => {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const text = (key: string, max: number): string => typeof raw[key] === 'string' ? (raw[key] as string).trim().slice(0, max) : ''
    const task = text('task', 500)
    if (task === '') return { ok: false, error: '先说要交接哪件事' }
    try {
      const response = await bridge.companionRequest('POST', '/companion/v1/members/handover', {
        chiefName: text('chiefName', 80), chiefPersona: text('chiefPersona', 4000),
        memberName: text('memberName', 80), memberPersona: text('memberPersona', 4000), task,
      }, 'owner', 95_000)
      if (response.status !== 200) {
        const message = (response.body as { message?: string } | null)?.message
        return { ok: false, error: message ?? '交接助手暂时不可用' }
      }
      const lines = (response.body as { lines?: unknown } | null)?.lines
      if (!lines || typeof lines !== 'object') return { ok: false, error: '没有生成出可用的台词' }
      return { ok: true, lines }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '交接助手暂时不可用' }
    }
  })

  /*
   * 声纹环境自检：把"注册失败"背后那串**英文原始报错**原样带回来。
   *
   * 为什么需要它：注册失败可能来自四个完全不同的地方（模型文件、原生模块、
   * 音频格式、系统密钥）。以前只有一句"注册失败：<英文>"，看不出是哪一层。
   * 这里逐步试，每步都记下原始错误，用户点一下就能看到断在哪。
   */
  ipcMain.handle('voiceprint-diagnose', async () => {
    const steps: Array<{ name: string; ok: boolean; detail: string }> = []
    const userData = app.getPath('userData')
    const modelPath = voiceprintModelPath(userData)
    try {
      const size = statSync(modelPath).size
      steps.push({ name: '声纹模型文件', ok: true, detail: `${modelPath}（${Math.round(size / 1024 / 1024)} MB）` })
    } catch (error) {
      steps.push({ name: '声纹模型文件', ok: false, detail: `读不到：${error instanceof Error ? error.message : String(error)}` })
      return { ok: false, steps }
    }
    try {
      const sherpa = await import('sherpa-onnx-node')
      const version = (sherpa as { default?: unknown }) !== undefined ? '已加载' : '已加载'
      steps.push({ name: 'sherpa-onnx 原生模块', ok: true, detail: version })
    } catch (error) {
      steps.push({ name: 'sherpa-onnx 原生模块', ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
      return { ok: false, steps }
    }
    try {
      const key = voiceprintKey()
      steps.push({ name: '系统密钥', ok: true, detail: '可用' })
      void key
    } catch (error) {
      steps.push({ name: '系统密钥', ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
    try {
      /* 静音一秒就够：这一步只验证"模型能不能跑起来"，不关心有没有人声。 */
      const { extractEmbedding } = await import('./voiceprint.ts')
      const vector = await extractEmbedding(new Float32Array(16000), modelPath)
      steps.push({ name: '模型推理', ok: true, detail: `成功，维度 ${vector.length}` })
    } catch (error) {
      steps.push({ name: '模型推理', ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    }
    return { ok: steps.every(step => step.ok), steps }
  })

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
  /*
   * 试听：用**已保存**的那条配置合成一句样例，把音频直接回给渲染层播放。
   *
   * 只接受已保存的 profile id，不接受渲染层传端点/密钥进来 —— 否则等于给渲染层
   * 开了一条"随便往哪儿发请求、带任何密钥"的通道。
   * 每次试听都会真实调用一次语音服务，界面要事先说明这一点。
   */
  /*
    总助理音色的读取口：单独一条通道，不再依赖 get-state 的形状。
    之前踩过两次"存进去了但页面读不到"，都是回读路径和写入路径对不上。
  */
  ipcMain.handle('agent-voice-state', () => {
    /* 组装规则在 agent-voice.ts 里，有测试钉着；这里只负责取设置。 */
    return agentVoicePayload(loadSettings())
  })

  ipcMain.handle('voice-api-preview', async (_event, id: unknown, voiceDesign: unknown, voice: unknown, sample: unknown, style: unknown) => {
    if (typeof id !== 'string' || id === '') return { ok: false, error: '缺少要试听的配置' }
    const state = apis.snapshot()
    const profile = state.profiles.find(item => item.id === id)
    if (!profile) return { ok: false, error: '这条语音配置不存在，可能已被删除' }
    if (profile.kind !== 'tts') return { ok: false, error: '只有语音合成配置能试听' }
    const resolved = apis.resolve('tts')
    if (!resolved || resolved.id !== id) return { ok: false, error: '这条配置还没被选为当前音色；请先选中再试听' }
    try {
      /* 试听可以带一段临时描述：用户还没保存或想对比时，不该逼他先存一遍。 */
      const override = typeof voiceDesign === 'string' ? voiceDesign.trim().slice(0, 2000) : ''
      const voiceId = typeof voice === 'string' ? voice.trim().slice(0, 200) : ''
      const settingsNow = loadSettings()
      /*
        样本优先用**本次传进来的**（用户刚录完还没保存也该能试听），
        没有才回落到已保存的那份。
      */
      const live = (sample && typeof sample === 'object' ? sample : {}) as { data?: unknown; mime?: unknown }
      let sampleData = typeof live.data === 'string' && live.data.trim() !== '' ? live.data : (settingsNow.agentVoiceSample ?? '')
      if (sampleData === '' && settingsNow.agentVoiceSampleFile) {
        try { sampleData = readFileSync(settingsNow.agentVoiceSampleFile).toString('base64') } catch { sampleData = '' }
      }
      const sampleMime = typeof live.mime === 'string' && live.mime !== '' ? live.mime : (settingsNow.agentVoiceSampleMime || 'audio/wav')
      const styleHint = typeof style === 'string' ? style.trim().slice(0, 500) : (settingsNow.agentVoiceStyle ?? '')
      /*
        模型必须跟意图对上：复刻样本要 voiceclone，音色描述要 voicedesign。
        用户是分别建了几条配置的（预置 / 设计 / 复刻），一律拿"当前选中"那条去发，
        等于用预置音色模型去发音频样本，服务端直接 4xx。
      */
      const pickByModel = (needle: string): typeof resolved | null => {
        if (resolved.model.includes(needle)) return resolved
        const candidates = state.profiles.filter(item => item.kind === 'tts' && item.model.includes(needle))
        if (candidates.length === 0) return null
        const chosen = candidates.find(item => item.hasKey) ?? candidates[0]
        return { ...resolved, id: chosen.id, name: chosen.name, endpoint: chosen.endpoint,
          model: chosen.model, voice: chosen.voice, voiceDesign: chosen.voiceDesign }
      }
      if (sampleData !== '') {
        const clone = pickByModel('voiceclone')
        if (clone === null) {
          return { ok: false, error: '复刻需要一条模型名为 mimo-v2.5-tts-voiceclone 的语音配置；当前没有，请先在语音设置里加一条' }
        }
        const audio = await synthesizeApi({ ...clone, voiceSample: sampleData, voiceSampleMime: sampleMime, voiceDesign: '', voiceStyle: styleHint }, VOICE_PREVIEW_TEXT)
        return { ok: true, audio: audio.toString('base64'), mime: 'audio/wav' }
      }
      if (voiceId !== '') {
        const audio = await synthesizeApi({ ...resolved, voice: voiceId, voiceDesign: '' }, VOICE_PREVIEW_TEXT)
        return { ok: true, audio: audio.toString('base64'), mime: 'audio/wav' }
      }
      const designTarget = override !== '' ? (pickByModel('voicedesign') ?? resolved) : resolved
      const target = override !== '' ? { ...designTarget, voiceDesign: override, voiceStyle: styleHint } : { ...designTarget, voiceStyle: styleHint }
      const audio = await synthesizeApi(target, VOICE_PREVIEW_TEXT)
      return { ok: true, audio: audio.toString('base64'), mime: 'audio/wav' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ===== 形象与音色工作室（底座 4.8/4.9）=====
  // provider 全部用户自配；密钥走系统密钥库；生成/克隆/删除前原生确认。
  const studioUserData = app.getPath('userData')
  const broadcastAll = (channel: string, payload?: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
  const fanout = (event: string): void => {
    if (event === 'custom-skins-changed') {
      broadcastAll(event, listCustomSkins(studioUserData).map(skin => ({ id: skin.id, actions: skin.actions })))
    } else if (event === 'pet-settings-changed') {
      sendToRenderer('characters-changed', loadSettings().characters ?? {})
    } else {
      broadcastAll(event)
    }
  }
  const mediaProviders = new MediaProviderStore(studioUserData, { dpapi: { safeStorage } })
  const assetPipeline = new AssetPipeline({ userDataDir: studioUserData, store: mediaProviders, emit: fanout })
  const voiceClone = new VoiceCloneService({ userDataDir: studioUserData, store: mediaProviders, voices: apis, emit: fanout })
  assetStudio = new AssetStudio({
    userDataDir: studioUserData,
    pipeline: assetPipeline,
    voices: voiceClone,
    providers: mediaProviders,
    voiceStore: apis,
    broadcast: fanout,
    studioAssist: async request => {
      const r = await bridge.companionRequest('POST', '/companion/v1/members/studio-assist', { request }, 'owner', 95_000)
      if (r.status !== 200) {
        const message = (r.body as { message?: string } | null)?.message
        throw new Error(message ?? '形象配置助手暂时不可用')
      }
      return r.body as { name: string; prompt: string; actions: string[]; notes: string }
    },
  })
  ipcMain.handle('custom-skins-list', () => listCustomSkins(studioUserData).map(skin => ({ id: skin.id, actions: skin.actions })))
  ipcMain.handle('asset-studio-open', () => {
    assetStudio?.open()
    return { ok: true }
  })

  // ===== 快速应答（快嘴旁路）=====
  // 只服务于"用户说完话立刻应一声"，与主会话双轨并行；接什么模型由用户配置。
  fastReply = new FastReplyService(studioUserData, {
    dpapi: { safeStorage },
    context: chiefContext,
    log: message => console.log('[dsh-pet]', message),
  })
  ipcMain.handle('fast-reply-state', event => {
    if (!stageSender(event) || !fastReply) return null
    return fastReply.snapshot()
  })
  ipcMain.handle('fast-reply-save', async (event, input: unknown) => {
    if (!stageSender(event) || !fastReply) return { ok: false, error: '请求来源无效' }
    const patch = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as FastReplyInput
    try {
      // 开启意味着用户原话要发给第三方接口：必须原生确认，界面开关不能替用户做这个决定。
      if (patch.enabled === true && !fastReply.load().enabled) {
        const options = {
          type: 'question' as const,
          title: '开启快速应答',
          message: '开启快速应答？',
          detail: '开启后，你每句语音的原话会发给你配置的第三方模型接口，仅用于生成一句即时短应答；'
            + '短应答不进入助理会话与记忆。接口地址与模型由你决定，密钥只加密保存在本机。',
          buttons: ['取消', '开启'],
          defaultId: 0,
          cancelId: 0,
        }
        const confirmed = win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options)
        if (confirmed.response !== 1) return { ok: false, error: '已取消，未开启' }
      }
      return { ok: true, state: fastReply.save(patch) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('fast-reply-test', async event => {
    if (!stageSender(event) || !fastReply) return { ok: false, error: '请求来源无效' }
    return fastReply.test()
  })

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
      meetingDocumentAutoApprove: settings.meetingDocumentAutoApprove === true,
      meetingSpeakerCounts: settings.meetingSpeakerCounts ?? { mic: 0, loopback: 0 },
      bounds: settings.bounds,
      positions: settings.positions,
      characters: settings.characters,
      stepDownMembers: settings.stepDownMembers ?? [],
      layoutVersion: settings.layoutVersion,
      idleSleepMinutes: settings.idleSleepMinutes,
      sleepMinutes: settings.sleepMinutes,
      chatDock: settings.chatDock ?? 'top',
      chatSize: settings.chatSize,
      // 讲解形态与外观档位也要回读：设置页靠 get-state 回显，缺一项就会永远显示默认值。
      // （`docSpeechMode` 此前没在这里出现，等于"存得进去、读不回来"，这次一并补上。）
      docSpeechMode: settings.docSpeechMode === 'ai' ? 'ai' : 'source',
      petScale: settings.petScale,
      petOpacity: settings.petOpacity,
      petDock: settings.petDock !== false,
      dockedAt: settings.dockedAt ?? null,
    }
  })

  ipcMain.handle(
    'save-settings',
    (event, patch: { bounds?: { x: number; y: number }; positions?: Record<string, { x: number; y: number }>; voiceConversation?: boolean; continuousVoice?: boolean; readReplies?: boolean; meetingDocumentAutoApprove?: boolean; memberHandover?: boolean; meetingSpeakerCounts?: { mic: number; loopback: number }; idleSleepMinutes?: number; sleepMinutes?: number; chatDock?: 'top' | 'auto'; chatSize?: { width: number; height: number }; stepDownMembers?: string[]; characters?: Record<string, { skin?: string }>; agentVoiceDesign?: string; agentVoiceId?: string; agentVoiceSample?: string; agentVoiceSampleMime?: string; agentVoiceStyle?: string; docSpeechMode?: 'source' | 'ai'; petScale?: number; petOpacity?: number; petDock?: boolean; dockedAt?: 'left' | 'right' | 'top' | 'bottom' | null }) => {
      if (!patch || typeof patch !== 'object') return { ok: false }
      if ('stepDownMembers' in patch && (!stageSender(event) || !Array.isArray(patch.stepDownMembers) || patch.stepDownMembers.some(id => typeof id !== 'string'))) return { ok: false }
      if ('meetingDocumentAutoApprove' in patch && (!stageSender(event) || typeof patch.meetingDocumentAutoApprove !== 'boolean')) return { ok: false }
      const counts = patch.meetingSpeakerCounts
      const validCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
      if ('meetingSpeakerCounts' in patch && (!stageSender(event) || !counts || !validCount(counts.mic) || !validCount(counts.loopback))) {
        return { ok: false }
      }
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
      /*
       * 形象覆盖：与已存的合并，只改传进来的那个角色。
       *
       * 必须先合并再写：`saveSettings` 的 characters 是**整份替换**的，
       * 直接把 patch 写进去会把其它角色（包括它的 randomActions）一起清掉。
       * skin 合法性交给 settings.normalize 判（内置三项 + 已登记自定义皮肤），这里不重复白名单。
       */
      let charactersPatch: Record<string, { skin: string; randomActions?: string[] }> | null = null
      if (patch.characters !== undefined) {
        if (!stageSender(event) || !patch.characters || typeof patch.characters !== 'object' || Array.isArray(patch.characters)) return { ok: false }
        const merged: Record<string, { skin: string; randomActions?: string[] }> = { ...(loadSettings().characters ?? {}) }
        for (const [assistantId, value] of Object.entries(patch.characters)) {
          const skin = (value as { skin?: unknown } | undefined)?.skin
          if (!assistantId || assistantId.length > 128) return { ok: false }
          if (typeof skin !== 'string' || skin === '' || skin.length > 128) return { ok: false }
          merged[assistantId] = { ...(merged[assistantId] ?? { skin }), skin }
        }
        charactersPatch = merged
      }
      /*
        样本落盘：把 base64 写成 wav 文件，配置里只留路径。
        设置文件不会涨到几百 KB，TTS 合成也不必把整段 base64 穿过内部管道。
      */
      let agentVoiceFile: string | null = null
      if (typeof patch.agentVoiceSample === 'string' && patch.agentVoiceSample.trim() !== '') {
        try {
          const target = path.join(app.getPath('userData'), 'voice-sample.wav')
          writeFileSync(target, Buffer.from(patch.agentVoiceSample, 'base64'))
          agentVoiceFile = target
        } catch (error) {
          console.warn(`[dsh-pet] 音色样本落盘失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      saveSettings({
        ...(patch.bounds ? { bounds: patch.bounds } : {}),
        ...(patch.positions ? { positions: patch.positions } : {}),
        ...(typeof patch.voiceConversation === 'boolean' ? { voiceConversation: patch.voiceConversation } : {}),
        ...(typeof patch.continuousVoice === 'boolean' ? { continuousVoice: patch.continuousVoice } : {}),
        ...(typeof patch.readReplies === 'boolean' ? { readReplies: patch.readReplies } : {}),
        ...(typeof patch.meetingDocumentAutoApprove === 'boolean' ? { meetingDocumentAutoApprove: patch.meetingDocumentAutoApprove } : {}),
        ...(typeof patch.memberHandover === 'boolean' ? { memberHandover: patch.memberHandover } : {}),
        ...(counts ? { meetingSpeakerCounts: { mic: counts.mic, loopback: counts.loopback } } : {}),
        ...(patch.idleSleepMinutes !== undefined ? { idleSleepMinutes: patch.idleSleepMinutes } : {}),
        ...(patch.sleepMinutes !== undefined ? { sleepMinutes: patch.sleepMinutes } : {}),
        ...(patch.chatDock === 'top' || patch.chatDock === 'auto' ? { chatDock: patch.chatDock } : {}),
        ...(chatSize ? { chatSize } : {}),
        // 讲解形态：只认这两个值。没有这一步的话字段永远写不进设置（这条 IPC 是白名单式的），
        // 设置项就成了只能手改文件的死配置。不新增通道、也不用改渲染层类型。
        ...(patch.docSpeechMode === 'source' || patch.docSpeechMode === 'ai'
          ? { docSpeechMode: patch.docSpeechMode }
          : {}),
        // 大小与透明度：档位制白名单。只认这三档，别的一律不写 —— 让"手改文件写 1.5"
        // 与"界面传错值"都落回归一化那一步，而不是把角色撑大。
        ...(patch.petScale === 0.8 || patch.petScale === 1 || patch.petScale === 1.2
          ? { petScale: patch.petScale }
          : {}),
        ...(patch.petOpacity === 0.6 || patch.petOpacity === 0.8 || patch.petOpacity === 1
          ? { petOpacity: patch.petOpacity }
          : {}),
        ...(typeof patch.petDock === 'boolean' ? { petDock: patch.petDock } : {}),
        // 停靠边：只认四条边或 null（取消停靠）。别的值不写，免得存进一个算不出位置的边。
        ...(patch.dockedAt === null || patch.dockedAt === 'left' || patch.dockedAt === 'right'
          || patch.dockedAt === 'top' || patch.dockedAt === 'bottom'
          ? { dockedAt: patch.dockedAt }
          : {}),
        ...(Array.isArray(patch.stepDownMembers) ? { stepDownMembers: patch.stepDownMembers } : {}),
        /*
         * 形象覆盖：只接受舞台窗口发来的、形状是 { [assistantId]: { skin } } 的对象。
         * skin 的合法性交给 settings.normalize 判（内置三项 + 已登记的自定义皮肤），
         * 这里不重复那份白名单 —— 两处各写一份迟早会不一致。
         */
        ...(charactersPatch ? { characters: charactersPatch } : {}),
        ...(typeof patch.agentVoiceDesign === 'string' ? { agentVoiceDesign: patch.agentVoiceDesign.slice(0, 2000) } : {}),
        ...(typeof patch.agentVoiceId === 'string' ? { agentVoiceId: patch.agentVoiceId.slice(0, 200) } : {}),
        /*
          样本落盘，配置里只留路径。
          640KB 的 base64 塞进设置、再塞进 TTS 内部管道，会拖慢并撑爆一次性写入；
          落成文件后，合成时按需读一次即可。
        */
        ...(agentVoiceFile !== null ? { agentVoiceSample: '', agentVoiceSampleFile: agentVoiceFile } : {}),
        ...(typeof patch.agentVoiceSampleMime === 'string' ? { agentVoiceSampleMime: patch.agentVoiceSampleMime.slice(0, 100) } : {}),        ...(typeof patch.agentVoiceStyle === 'string' ? { agentVoiceStyle: patch.agentVoiceStyle.slice(0, 500) } : {}),
      })
      if (patch.meetingDocumentAutoApprove === false) {
        if (pendingMeetingStart?.autoApproved) cancelDesktopCommand({ id: pendingMeetingStart.id })
        if (independentDocument?.autoApproved && ['authorizing', 'waiting-to-present', 'waiting-to-resume', 'starting'].includes(independentDocument.state)) {
          failIndependentDocument(independentDocument, '自动审批已关闭，尚未开始的文档讲解已取消。')
        }
      }
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
    }
    applyThrottling()
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
      void maybeStartMeetingPresentation()
      void maybeStartIndependentDocument()
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
      void maybeStartMeetingPresentation()
      void maybeStartIndependentDocument()
    }
  })

  ipcMain.on('speech-stop', (_event, preserveAutoResume?: unknown) => {
    speechLog(`speech-stop received preserve=${preserveAutoResume === true}`)
    // 用户主动停播（按钮或“停一下”口令）：默认不再用自动续讲把讲解接回去。
    // 口令后面直接带问题的情形由渲染层传 preserveAutoResume=true：先停这一句，等回答播完再续讲。
    // 口令后面直接带问题的情形由渲染层传 preserveAutoResume=true：先停这一句，等回答播完再续讲。
    if (preserveAutoResume !== true) clearDocAutoResume()
    pauseMeetingPresentation()
    pauseWaitingIndependentDocument()
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

  ipcMain.handle('office-open', async (event, target: unknown) => {
    if (!stageSender(event)) return { ok: false, error: '请求来源无效' }
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    return officeView.show(target)
  })

  ipcMain.handle('doc-explain', async (_event, target: unknown, from: unknown, speak: unknown, assistantId: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    const who = typeof assistantId === 'string' && assistantId ? assistantId : undefined
    // 提纲是点名 WPS 要来的，就在面板上点"开始讲"时仍跟随 WPS；否则按默认（装了 WPS 就用 WPS）选择。
    const via = docTalk !== null && docTalk.path === target ? docTalk.via : 'auto'
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
  companionTasks = registerCompanionTasks({
    request: (method, pathname, body, subject) => bridge.companionRequest(method, pathname, body, subject),
    openApproval: id => approvals.request(id),
  })
  registerAssistantSettings({
    getStageWindow: () => win,
    pagePath: path.join(here, '../renderer/index.html'),
    request: (method, pathname, body) => bridge.companionRequest(method, pathname, body, 'owner'),
  })
  registerAssistantMail({
    getStageWindow: () => win,
    pagePath: path.join(here, '../renderer/index.html'),
    request: (method, pathname, body) => bridge.companionRequest(method, pathname, body, 'owner'),
  })
  const memberEditor = new MemberEditorWindow()
  memberEditor.registerIpc()
  // 成员音色（壳侧）：语气与克隆样本存设置，编号/描述仍归插件目录；只认编辑窗来源。
  ipcMain.handle('member-voice-get', (event, id: unknown) => {
    if (!memberEditor.allowed(event) || typeof id !== 'string') return null
    return loadSettings().memberVoices?.[id] ?? null
  })
  ipcMain.handle('member-voice-save', (event, id: unknown, voice: unknown) => {
    if (!memberEditor.allowed(event) || typeof id !== 'string' || id.trim() === '') return { ok: false }
    const v = (voice ?? {}) as Record<string, unknown>
    const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
    const current = loadSettings().memberVoices ?? {}
    saveSettings({
      memberVoices: {
        ...current,
        [id]: { ...current[id], style: str(v.style, 500), sampleFile: str(v.sampleFile, 500), sampleMime: str(v.sampleMime, 100), profileId: str(v.profileId, 64) },
      },
    })
    return { ok: true }
  })
  // 成员编辑窗的"已配置模型"下拉：与总助理会话模型下拉同源（session mirror 的 models）。
  ipcMain.handle('member-model-options', (event) => {
    if (!memberEditor.allowed(event)) return []
    return sessionState?.models ?? []
  })
  // 成员编辑窗的"音色服务"下拉：语音设置里配好的全部 TTS 配置（MiMo 三模型等）。
  ipcMain.handle('member-tts-profiles', (event) => {
    if (!memberEditor.allowed(event)) return []
    return (voiceApiStore?.snapshot().profiles ?? [])
      .filter(p => p.kind === 'tts')
      .map(p => ({ id: p.id, name: p.name, model: p.model, provider: p.provider }))
  })
  // 成员音色试听：与总助理试听同一条合成链路，按编辑窗里当前未保存的音色配置合成一句。
  ipcMain.handle('member-voice-preview', async (event, input: unknown) => {
    if (!memberEditor.allowed(event)) return { ok: false, error: '请求不是来自成员编辑窗口' }
    const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '')
    const speaker: SpeakerVoice = {
      voiceId: str(v.voiceId, 200), design: str(v.design, 2000), style: str(v.style, 500),
      sampleFile: str(v.sampleFile, 500), sampleMime: str(v.sampleMime, 100), profileId: str(v.profileId, 64),
    }
    const baseApi = (speaker.profileId ? voiceApiStore?.resolveId(speaker.profileId) : null)
      ?? voiceApiStore?.resolve('tts') ?? null
    if (baseApi === null) return { ok: false, error: '还没接入语音服务：先在语音设置里配一条 TTS' }
    const api = { ...baseApi, ...speakerOverlay(baseApi.provider, baseApi.model, speaker) }
    try {
      const audio = await synthesizeApi(api, VOICE_PREVIEW_TEXT)
      return { ok: true, audio: audio.toString('base64'), mime: sniffAudioMime(audio) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('member-voice-pick-sample', async (event) => {
    if (!memberEditor.allowed(event)) return { ok: false }
    const picked = await dialog.showOpenDialog({
      title: '选择音色克隆样本', properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false }
    const file = picked.filePaths[0]
    const ext = path.extname(file).toLowerCase()
    const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav'
    return { ok: true, file, mime }
  })
  registerMemberManagement({
    getStageWindow: () => win,
    pagePath: path.join(here, '../renderer/index.html'),
    request: (method, pathname, body, subject, timeoutMs) => bridge.companionRequest(method, pathname, body, subject, timeoutMs),
    allowWindow: event => memberEditor.allowed(event),
    parentOf: event => BrowserWindow.fromWebContents(event.sender) ?? win,
    changed: () => {
      if (win && !win.isDestroyed()) win.webContents.send('members-changed')
      memberEditor.notifyChanged()
    },
  })
  // 成员独立会话查看：DSH 侧栏里成员会话埋在折叠分组里、标题又是任务原文，用户找不到。
  // 这里直接读宿主持久化的会话文件（zstd），开一个只读窗口展示，入口在团队成员行。
  ipcMain.handle('member-session-view', async (event, id: unknown) => {
    if (!stageSender(event) || typeof id !== 'string' || id.trim() === '') return { ok: false, error: '请求来源或成员标识无效' }
    const result = await bridge.companionRequest('GET', '/companion/v1/members', undefined, 'owner', 5000)
    const body = result.status === 200
      ? result.body as { members?: Array<{ profile?: { assistantId?: string; displayName?: string; sessionId?: string | null } }> } | null
      : null
    const profile = body?.members?.find(item => item.profile?.assistantId === id)?.profile
    const sessionId = profile?.sessionId
    if (!sessionId) return { ok: false, error: '这位成员还没有独立会话；首次派活时会自动新建。' }
    const sessionsRoot = path.join(dshHome(), 'sessions')
    let file: string | null = null
    try {
      for (const group of readdirSync(sessionsRoot)) {
        const candidate = path.join(sessionsRoot, group, sessionId, 'session.v4.jsonl.zstd')
        if (existsSync(candidate)) { file = candidate; break }
      }
    } catch { /* 目录不存在按找不到处理 */ }
    if (!file) return { ok: false, error: '会话文件还没落盘，稍后再试。' }
    let raw: string
    try {
      // 会话文件是多个 zstd frame 追加写的，Node 一次只解第一帧；按魔数逐帧解。
      const buf = readFileSync(file)
      const starts: number[] = []
      for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
      }
      if (starts.length === 0) starts.push(0)
      const parts: string[] = []
      for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : buf.length
        parts.push(zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'))
      }
      raw = parts.join('')
    } catch (error) {
      return { ok: false, error: `会话读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as { type?: string; data?: { content?: unknown } }
        if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
        const blocks = Array.isArray(ev.data?.content) ? ev.data.content as Array<{ type?: string; text?: string }> : []
        const text = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
        if (text) messages.push({ role: ev.type === 'user/message' ? 'user' : 'assistant', text })
      } catch { /* 坏行跳过 */ }
    }
    const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(profile?.displayName ?? id)} · 独立会话</title>
<style>body{font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f6f9fb;color:#22303c}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #dfe7ee;padding:12px 20px;font-weight:600}
main{max-width:860px;margin:0 auto;padding:20px}.m{margin:0 0 14px;padding:10px 14px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.u{background:#e8f1fb;border:1px solid #cfe957}.a{background:#fff;border:1px solid #dfe7ee}
.r{font-size:12px;color:#68788a;margin-bottom:4px}</style></head><body>
<header>${escape(profile?.displayName ?? id)} 的独立会话（只读）</header><main>
${messages.length === 0 ? '<p>这个会话还没有可见消息。</p>' : messages.map(m => `<div class="m ${m.role === 'user' ? 'u' : 'a'}"><div class="r">${m.role === 'user' ? '用户 / 总助派活' : escape(profile?.displayName ?? id)}</div>${escape(m.text)}</div>`).join('')}
</main></body></html>`
    const win = new BrowserWindow({
      width: 780, height: 880, title: `${profile?.displayName ?? id} · 独立会话`, autoHideMenuBar: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    })
    win.setMenuBarVisibility(false)
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return { ok: true }
  })

  ipcMain.handle('member-editor-open', (event, id: unknown) => {
    const stagePage = pathToFileURL(path.join(here, '../renderer/index.html')).href
    if (!stageSender(event) || event.senderFrame?.url !== stagePage) return { ok: false }
    if (id !== null && (typeof id !== 'string' || !id.trim() || id.length > 256)) return { ok: false }
    memberEditor.open({ memberId: id as string | null,
      // 把自定义皮肤带进编辑窗口：用户自己在工作室做出来的形象，必须能在成员配置里选到。
      skins: listCustomSkins(app.getPath('userData')).map(item => ({ id: item.id, name: item.name })) })
    return { ok: true }
  })
  ipcMain.handle('report-workbench-open', event => {
    if (!stageSender(event)) return { ok: false }
    reportWorkbench?.open()
    return { ok: true }
  })
  ipcMain.handle('companion-tasks-open', event => {
    if (!stageSender(event)) return { ok: false }
    companionTasks?.open()
    return { ok: true }
  })
  // 阅读视图的五条通道（会话/字节/页许可/资源/回报）都在控制器里注册并核对发送方。
  docView.registerIpc()
  wpsView.registerIpc()
  officeView.registerIpc()

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
    petPresentation = on === true
    host?.setPresentationMode(on === true)
    reportPetState()
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
  /** 流式模型尚未就绪时先收下的音频。模型加载不阻塞录音，就绪后按序补喂。 */
  let pendingStreamFrames: Buffer[] = []
  let pendingStreamBytes = 0
  let streamInit: 'idle' | 'pending' | 'failed' = 'idle'
  let streamEpoch = 0
  /** 60 秒 16kHz PCM16，略留余量；超出的帧不会再被本场识别采用。 */
  const MAX_PENDING_STREAM_BYTES = 2 * 1024 * 1024

  const resetStreamState = (): void => {
    streamEpoch += 1
    streamSession = null
    pendingStreamFrames = []
    pendingStreamBytes = 0
    streamInit = 'idle'
  }

  const ensureStreamSession = (): StreamingSession | null => {
    if (streamSession !== null) return streamSession
    try {
      streamSession = createStreamingSession(app.getPath('userData'))
      streamInit = 'idle'
      for (const frame of pendingStreamFrames) streamSession.feed(pcm16Base64ToFloat32(frame.toString('base64')))
      pendingStreamFrames = []
      pendingStreamBytes = 0
      return streamSession
    } catch (error) {
      streamInit = 'failed'
      pendingStreamFrames = []
      pendingStreamBytes = 0
      console.log('[dsh-pet] 流式识别器创建失败，改用整句识别：', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /**
   * 模型首次创建会阻塞约 2.5 秒。先让这次 IPC 返回、渲染层开始录音，再在下一拍加载模型；
   * 期间收到的音频暂存，不能因为初始化把用户开口弄丢。
   */
  const scheduleStreamSession = (): void => {
    if (streamInit !== 'idle') return
    streamInit = 'pending'
    const epoch = streamEpoch
    setTimeout(() => {
      // 这期间用户已经停止：不要再为一场不存在的听写建 stream。
      if (epoch !== streamEpoch) return
      ensureStreamSession()
    }, 0).unref()
  }

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

  ipcMain.handle('asr-begin', (_event, options?: unknown) => {
    // 插话交接的听写才能穿过会议录音；手动按键听写仍被会议拒绝。
    const bargeIn = options !== null && typeof options === 'object' && (options as { bargeIn?: unknown }).bargeIn === true
    const granted = applyAudio({ type: 'dictation-requested', ...(bargeIn ? { source: 'barge-in' as const } : {}) })
    if (granted.denied) return { ok: false, error: granted.denied }
    // 讲解进行中：用户开口就是要提问，不再要求"停一下"口令（功能设计：随时插话）。
    // 回声、咳嗽与旁人闲聊由渲染层的自回声过滤和最短文本判定兜住，见 App.tsx 的 direct 分支。
    const presenting = docTalk !== null && docTalk.spoken && !docTalk.stopped
    const direct = presenting
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
    // 流式模型装了就承诺流式链路；模型在“第一次喂音频”时再创建。这样本次 IPC 先返回，
    // 渲染层能立刻开始录音，模型加载的快慢不再决定用户开头的话能不能被采到。
    resetStreamState()
    return { ok: true, streaming: apiAsr === null && streamingAvailable(app.getPath('userData')), direct }
  })

  /** 流式喂数：帧 PCM 进识别器，返回当前累积文本（渲染层实时回显）。 */
  ipcMain.handle('asr-stream-feed', (_event, chunkB64: unknown) => {
    if (typeof chunkB64 !== 'string' || chunkB64.length === 0) return { text: '' }
    if (streamSession === null) {
      if (streamInit === 'failed') return { text: '' }
      const frame = Buffer.from(chunkB64, 'base64')
      if (pendingStreamBytes + frame.length <= MAX_PENDING_STREAM_BYTES) {
        pendingStreamFrames.push(frame)
        pendingStreamBytes += frame.length
      }
      scheduleStreamSession()
      return { text: '' }
    }
    try {
      const text = streamSession.feed(pcm16Base64ToFloat32(chunkB64))
      // 反问窗口开着时，识别文本变长就是"还有人在说话"，窗口顺延（见 noteFollowupSpeech）。
      noteFollowupSpeech(text)
      return { text }
    } catch (error) {
      console.log('[dsh-pet] 流式喂数失败：', error instanceof Error ? error.message : error)
      return { text: '' }
    }
  })

  ipcMain.handle('asr-stream-stop', () => {
    // 若模型还在排队，这里要同步等它建好并补喂已缓存的音频；录音已经结束，只是识别收尾。
    const session = streamSession ?? (streamInit === 'pending' ? ensureStreamSession() : null)
    resetStreamState()
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
    ).then(result => {
      speechLog(`asr-transcribe ok=${result.ok} text=${(result.text ?? '').slice(0, 40)}`)
      return result
    }).finally(() => {
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

/**
 * 声纹状态缓存。设置页每 2 秒轮询一次；Windows 上解 DPAPI 密钥要起 PowerShell，
 * 不能每次轮询都解一遍。注册、删除、改名后刷新。
 */
let voiceprintCache: VoiceprintStatus | null = null
/** 声纹与会议库共用同一把机器绑定密钥；macOS/Linux 上把 electron 的 safeStorage 递进去。 */
const voiceprintKey = () => getDataKey(app.getPath('userData'), { safeStorage })
function voiceprintState(): VoiceprintStatus {
  if (voiceprintCache === null) voiceprintCache = voiceprintStatus(app.getPath('userData'), voiceprintKey)
  return voiceprintCache
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
      name: prefs.wakeName,
      voiceprint: { enabled: prefs.wakeVoiceprint, threshold: prefs.wakeVoiceprintThreshold, ...voiceprintState() },
      wakeDuringSpeech: prefs.wakeDuringSpeech,
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
      if (audioState.holder === 'barge-in' || audioState.bargeInMeeting) {
        applyAudio({ type: 'barge-in-finished', force: true })
      }
    }
  })

  ipcMain.on('tts-playback-receipt', (event, receipt: unknown) => {
    if (!fromStage(event) || receipt === null || typeof receipt !== 'object') return
    const value = receipt as RendererReceipt
    if (typeof value.id !== 'string' || !['started', 'finished', 'cancelled', 'error'].includes(value.kind)) return
    rendererPlayback.receipt(value)
  })

  ipcMain.on('barge-in-detected', (event) => {
    speechLog('barge-in-detected received')
    // 只核对来源。不再要求 audioState 此刻仍持有插话：设备交接与授权更新有先后，
    // 后到的一帧不该被丢掉；状态机自己会对“已经不是 barge-in”的事件做幂等处理。
    if (!fromStage(event)) return
    // 口令式打断：检出人声只把设备留给听写，**不立刻停朗读**。
    // 渲染层先听清“停一下 / 暂停一下 / 等一下 / 打断一下 / 等等”，命中后才发 speech-stop 停播；
    // 否则回声、咳嗽和旁人闲聊都会让讲解说一半自己停掉。
    applyAudio({ type: 'barge-in-detected' })
    // 真正打断后回答结束要自动接着讲；没命中口令时不会产生回答，这个标记不会触发续讲。
    markDocTalkForAutoResume()
    if (bargeHandoverTimer) clearTimeout(bargeHandoverTimer)
    bargeHandoverTimer = setTimeout(() => {
      bargeHandoverTimer = null
      // 只在仍处于"检出后等听写"时才强制归还：听写已经接手、又开始了新一句的插话监听，就不该被这个旧定时器掐掉。
      if ((audioState.holder === 'barge-in' || audioState.bargeInMeeting) && audioState.bargeHandover) {
        applyAudio({ type: 'barge-in-finished', force: true })
      }
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

  ipcMain.handle('voiceprint-status', event => (fromStage(event) ? voiceprintState() : null))

  /**
   * 注册声纹：渲染层传 2–5 段 16k 单声道 WAV（base64）。
   * 提取与加密都在主进程；只落 embedding，不落原始录音。
   */
  ipcMain.handle('voiceprint-enroll', async (event, raw: unknown) => {
    if (!fromStage(event)) return { ok: false, error: '设置来源无效' }
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) return { ok: false, error: '需要 2–5 段录音' }
    const wavs: Buffer[] = []
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0) return { ok: false, error: '录音格式无效' }
      const wav = Buffer.from(item, 'base64')
      if (wav.length < 44 || wav.length > 8 * 1024 * 1024) return { ok: false, error: '录音大小无效' }
      wavs.push(wav)
    }
    const result = await enrollVoiceprint({
      userDataDir: app.getPath('userData'),
      name: audioPrefs().wakeName,
      wavs,
      loadKey: voiceprintKey,
    })
    if (result.ok) {
      voiceprintCache = null
      applyAudio({ type: 'wake-engine-changed' })
    }
    return result
  })

  ipcMain.handle('voiceprint-clear', (event) => {
    if (!fromStage(event)) return { ok: false, error: '设置来源无效' }
    try {
      const removed = clearVoiceprint(app.getPath('userData'))
      voiceprintCache = null
      // 删了声纹就不能继续"只认声纹"：把开关关掉，否则下次唤醒会直接不可用。
      if (audioPrefs().wakeVoiceprint) audioPrefsStore?.update({ wakeVoiceprint: false })
      applyAudio({ type: 'wake-engine-changed' })
      return { ok: true, removed }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('residency-set', (event, raw: unknown) => {
    if (!fromStage(event)) return { ok: false, error: '设置来源无效' }
    if (raw === null || typeof raw !== 'object') return { ok: false, error: '设置格式不对' }
    const patch = raw as Record<string, unknown>
    try {
      if (patch.wakeVoiceprint === true && !voiceprintState().registered) {
        return { ok: false, error: '请先在设置页录制 3 次唤醒词，再开启声纹唤醒' }
      }
      if (typeof patch.trayResident === 'boolean') host?.setTrayResident(patch.trayResident)
      audioPrefs()
      const store = audioPrefsStore!
      const { previous, next } = store.update(patch)
      if (previous.wakeEngine !== next.wakeEngine) applyAudio({ type: 'wake-engine-changed' })
      // 改名要重建 keywords 文件；声纹开关/阈值变化要重新加载声纹模型。都走同一条停/起路径。
      else if (previous.wakeName !== next.wakeName
        || previous.wakeVoiceprint !== next.wakeVoiceprint
        || previous.wakeVoiceprintThreshold !== next.wakeVoiceprintThreshold) applyAudio({ type: 'wake-engine-changed' })
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
  /* 分句策略取自设置：打开后相邻短句并段合成，减少"两三个字一次请求"的卡顿。 */
  configureSpeech({ mergeShortSentences: loadSettings().mergeShortSentences === true })
    // Windows 的通知必须挂在稳定的应用标识上；开发态不设会让提醒静默不显示。
    if (process.platform === 'win32') app.setAppUserModelId('com.dsh.pet')
    applyPlatformWindowTweaks()
    // 唤醒应答的常驻播放进程：把 PowerShell 冷启动与 Add-Type 编译挪到启动阶段。
    // 不 await：预热在后台跑，失败时 playOneShot 会回退到一次性脚本。
    const playHostStartedAt = Date.now()
    void playHost.start().then(ready => {
      console.log(`[dsh-pet] 常驻播放器${ready ? '已就绪' : '不可用'}（${Date.now() - playHostStartedAt}ms）`)
    })
    // 会议回环声的桌面采集授权：必须在任何 getDisplayMedia 之前注册（见函数注释）。
    configureDisplayMedia()
    // 自定义皮肤素材在 userData，渲染层相对路径探不到，走 pet-asset 协议。
    // 装配替身可能没有 getAppPath：拿不到就指一个空目录，协议注册本身会因替身缺 protocol 而跳过。
    let bundledAssets = path.join(app.getPath('userData'), 'bundled-assets')
    try {
      bundledAssets = path.join(app.getAppPath(), 'dist', 'assets')
    } catch { /* 装配测试替身 */ }
    registerPetAssetProtocol(app.getPath('userData'), bundledAssets)
    // 锁屏/解锁是陪伴静默的真实信号源；拿不到 powerMonitor 时只是少这一条闸门。
    void import('electron').then(({ powerMonitor }) => {
      powerMonitor?.on('lock-screen', () => { petLocked = true; reportPetState() })
      powerMonitor?.on('unlock-screen', () => { petLocked = false; reportPetState() })
    })
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
          return { trayResident: settings.trayResident, runtimeProfile: settings.runtimeProfile, wakeName: audioPrefs().wakeName }
        },
        saveSettings: patch => {
          saveSettings(patch)
        },
      },
      { mainDir: here, dshHome: dshHome(), instanceId: randomUUID(), layout },
    )
    host.start()

    reminderTimer = setInterval(() => { void deliverRemindersOnce(); void deliverMailNoticesOnce() }, 3_000)
    reminderTimer.unref?.()

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
        // 快捷键唤出同样抢焦点：先锁唤醒前前台身份。
        void targetLockHandle?.captureTargetLock(Date.now())
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
    // 启动后把固定话术的音频补齐到缓存（稍等一下，别和启动抢带宽）。
    // 没有这一步，唤醒应答随机抽到"没缓存过的句子"就要当场联网合成，用户会感觉
    // "有时候立刻响、有时候要等好几秒"。放到 1.5 秒：用户重启后往往很快就喊第一声。
    const warmTimer = setTimeout(() => { void warmGreetingCache(voiceApiStore?.resolve('tts') ?? null) }, 1_500)
    warmTimer.unref()
    // 本地识别模型首次加载分别是秒级，而且是**同步**加载：预热期间主线程被占住，
    // 唤醒动画与播放也会跟着停顿。所以延后到用户通常已经喊过第一声之后（12 秒起），
    // 不和唤醒抢那几秒。自定义云端 ASR 不走这两套本地模型，选了就跳过。
    const warmAsrTimer = setTimeout(() => {
      try {
        if (voiceApiStore?.resolve('asr') ?? null) return
        const userData = app.getPath('userData')
        const started = Date.now()
        if (warmStreamingAsr(userData)) {
          console.log(`[dsh-pet] 流式识别模型已预热：${Date.now() - started}ms`)
        }
        const senseTimer = setTimeout(() => {
          const senseStarted = Date.now()
          try {
            if (warmSenseVoiceAsr(userData)) {
              console.log(`[dsh-pet] 整句识别模型已预热：${Date.now() - senseStarted}ms`)
            }
          } catch (error) {
            console.log('[dsh-pet] 整句识别模型预热失败：', error instanceof Error ? error.message : String(error))
          }
        }, 2_000)
        senseTimer.unref()
      } catch (error) {
        console.log('[dsh-pet] 流式识别模型预热失败：', error instanceof Error ? error.message : String(error))
      }
    }, 12_000)
    warmAsrTimer.unref()
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
        if (status === 'disconnected') {
          for (const id of desktopCommandControllers.keys()) cancelDesktopCommand({ id })
          if (pendingMeetingStart) cancelDesktopCommand({ id: pendingMeetingStart.id })
          if (pendingMeetingReady) cancelDesktopCommand({ id: pendingMeetingReady.id })
          cancelIndependentDocument('连接已断开，独立讲解不会继续。')
          cancelMeetingPresentation('连接已断开，讲解不会继续；请在会议页核查录音。')
        }
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
        if (event.type === 'desktop/cancel') {
          cancelDesktopCommand(event.payload)
          return
        }
        if (event.type === 'desktop/command') {
          void handleDesktopCommand(event.payload)
          return
        }
        if (event.type === 'notice') {
          const payload = (event.payload ?? {}) as { kind?: unknown; text?: unknown; memberId?: unknown; at?: unknown }
          // 断线重连会重放事件环里的旧通知；超过一小时的不再弹。
          if (typeof payload.at === 'number' && Date.now() - payload.at > 3_600_000) return
          const text = typeof payload.text === 'string'
            ? payload.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').slice(0, 800) : ''
          if (!text) return
          const kind = payload.kind === 'mail' ? 'mail' : 'member'
          sendToRenderer('member-notice', { kind, text, ...(typeof payload.memberId === 'string' ? { memberId: payload.memberId } : {}) })
          try {
            if (Notification.isSupported()) {
              const notification = new Notification({ title: kind === 'mail' ? '邮件值守' : '成员通知', body: text.slice(0, 500) })
              notification.on('click', () => openSettings('team'))
              notification.show()
            }
          } catch (error) { console.error('[dsh-pet] member notice failed:', error) }
          return
        }
        if (event.type === 'subassistant-report') {
          // runId 幂等去重：断线重连会重放事件环里的旧事件，重播会吓到人。
          const runId = typeof event.runId === 'string' ? event.runId : ''
          const text = typeof event.text === 'string'
            ? event.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').slice(0, 8000) : ''
          if (!runId || !text || subAssistantSpokenRunIds.has(runId)) return
          subAssistantSpokenRunIds.add(runId)
          if (subAssistantSpokenRunIds.size > 200) {
            subAssistantSpokenRunIds.delete(subAssistantSpokenRunIds.values().next().value as string)
          }
          // ★③ 独立播报入口：不占会话 reply 的 utteranceId 空间，打断纪律沿用现有四层管线。
          narrator.speak({ utteranceId: `sub-${runId}`, text,
            ...(typeof event.voiceProfile === 'string' && event.voiceProfile ? { voiceProfile: event.voiceProfile } : {}) })
          // ★② 舞台形象：让该成员的角色出气泡；角色不在 cast（未启用等）时只播语音不出气泡。
          sendToRenderer('subassistant-report', {
            assistantId: typeof event.assistantId === 'string' ? event.assistantId : '',
            displayName: typeof event.displayName === 'string' ? event.displayName : '',
            skinId: typeof event.skinId === 'string' ? event.skinId : '',
            text,
          })
          return
        }
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
  // 常驻播放进程同理：不主动收尾就会在系统里留下一个空闲的 PowerShell。
  playHost.stop()
  docView.dispose()
  wpsView.dispose()
  officeView.close()
  wpsController?.dispose()
  bridge.dispose()
  // 退出过程中不该再留着一个能签发批准的窗口：IPC 摘掉、卡片关掉。
  approvals.dispose()
  reportWorkbench?.dispose()
  companionTasks?.dispose()
  if (reminderTimer) {
    clearInterval(reminderTimer)
    reminderTimer = null
  }
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
