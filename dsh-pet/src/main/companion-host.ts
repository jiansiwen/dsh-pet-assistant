/**
 * 桌面壳的生命周期：托盘常驻、分阶段启动握手、运行时所有权。
 *
 * 计划里这一块的要求是三条，每条都对应这里的一处刻意设计：
 *
 * 1. **托盘存活**：关掉舞台只是隐藏角色，唤醒监听与启动入口都还在。所以「隐藏」走 win.hide()，
 *    只有「退出桌面壳」才走退场动画 + app.quit()。
 * 2. **启动握手分阶段上报**：`locate-cli → locate-profile → locate-plugin → locate-overlay →
 *    check-runtime → spawn → await-bridge → verify-contract`。任何一步不成立就停在那一步，
 *    把原因原样告诉用户 —— 进程起来了不等于团队可用，界面显示"已开启"而实际什么都没连上，
 *    比明确报错更难排查。
 * 3. **所有权**：只终止自己 spawn 的那个进程（手里有 ChildProcess 句柄），从不按 pid 杀。
 *    附着到用户自己起的运行时时，退出只断连接。
 *
 * 会话绑定与运行时是两件事：插件一加载就写出 bridge.json（未绑定，`/health` 回 bound:false），
 * 桌面可以经 `/session/start` 开启或恢复会话，网页里「召唤宠物」也照旧接管绑定。所以 `await-bridge`
 * 超时说明插件没加载或是改造前的旧版，而不是"还没人召唤"。
 *
 * 状态里刻意不含"活动记录是否开启""会议录音是否开启"：这两件事由 dsh 侧的插件控制，
 * 壳现在拿不到证据。等阶段C/D 把它们接进来时必须各自单列一项，不能并进"在线"里 ——
 * 一个绿灯暗示全部在工作，正是计划点名要避免的。开机自启同理没有接：默认不启用，
 * 接的时候必须是一次单独授权，不能搭着"启动助理团队"一起打开。
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { probeHealth, readBridgeInfo } from './harness.ts'
import { platformOf } from './platform.ts'
import { resolveAppLayout, type AppLayout } from './runtime-launch.ts'
import {
  decideStartAction,
  listLaunchableProfiles,
  matchesOwnedRuntime,
  MAX_BOOT_MS,
  planRuntimeLaunch,
  sanitizeOwnership,
  verifyRuntimeContract,
  type HealthBody,
  type LaunchStage,
  type RuntimeOwnership,
} from './runtime-launch.ts'

/** 壳与运行时之间的关系。五种，不含糊：能证明是哪一种就显示哪一种。 */
export type RuntimeLink =
  | 'none'
  | 'starting'
  | 'booted'
  | 'attached-external'
  | 'attached-own'

export interface CompanionState {
  link: RuntimeLink
  /** 角色是否在桌面上可见。与运行时状态是两件事。 */
  stageVisible: boolean
  /**
   * 专注模式：会议 / 屏幕共享时禁用**随机发言**与**群体娱乐**（design.md §2.7、§2.12）。
   *
   * 与 `stageVisible` 是两件事，用户可以只开一个：隐藏是把角色从桌面上拿走（截图里什么都不剩），
   * 专注是角色还在、任务状态照常显示，但不自言自语、不开麻将桌 —— 投屏时观众看得见团队在干活，
   * 却不会被一句闲聊或一场牌局打断。
   *
   * 不落盘。会议总会结束，重启后还闷着不说话只会被当成坏了；宁可让用户再点一下。
   */
  focusMode: boolean
  /**
   * 演示隐私模式（M5-05）：隐藏本应用的历史与预览、压制主动提醒与娱乐，但**保留**文档讲解、
   * 外放插话与暂停/停止这些"你正在用它做的事"。
   *
   * 与上面两件是**三件不同的事**，可以任意组合：
   * - `stageVisible=false`：角色从桌面上消失（截图里什么都不剩）。
   * - `focusMode=true`：角色还在，但不闲聊、不开牌局、不听唤醒词。
   * - `presentationMode=true`：角色和任务状态照常，但**过去的内容不再露出来** ——
   *   聊天历史、主动提醒、会议/日报预览都收起；新产生的内容照常显示（用户正在演示它）。
   *
   * 不落盘，理由与 focusMode 相同：演示结束后还藏着历史只会被当成"坏了"。
   * 关闭即恢复 —— 这里从不删除任何数据，只是不渲染。
   */
  presentationMode: boolean
  /** 关闭舞台后是否仍保留壳（唤醒监听 + 启动入口）。用户明确启用才为 true。 */
  trayResident: boolean
  profile: string
  /** 最近一次握手的阶段与结论。成功也留着，失败时它就是给用户看的那句话。 */
  lastStage: LaunchStage | null
  lastMessage: string | null
  /**
   * 最近一次上报是失败还是进展。
   *
   * 不能靠 lastStage 推断：`spawn` 既播报"启动 dsh --profile …"也播报"启动进程失败"，
   * `check-runtime` 既播报进展也播报"没法停这个进程"。界面要能一眼分出这两种语气。
   */
  lastFailed: boolean
  /** 自有运行时进程号；没有就是 null。 */
  ownPid: number | null
}

export interface CompanionHostCallbacks {
  onState: (state: CompanionState) => void
  /** 显示/隐藏角色。壳只发意图，窗口的 show/hide 由主进程做。 */
  onStageVisible: (visible: boolean) => void
  /**
   * 专注模式开关变了。
   *
   * 渲染层自己会从状态里读到 `focusMode`（不闲聊、不开牌局），但麦克风归主进程管：
   * 会议里不该让唤醒词把参会者的话当指令，所以这条变化必须报出来。
   */
  onFocusMode: (on: boolean) => void
  /** 用户在托盘上要求重新监听唤醒词。唤醒失败后是粘住不自动重试的，这是唯一的恢复入口。 */
  onRetryWake: () => void
  /** 退出桌面壳：走完退场动画再退出。 */
  onExit: () => void
  readSettings: () => { trayResident?: boolean; runtimeProfile?: string }
  saveSettings: (patch: { trayResident?: boolean; runtimeProfile?: string }) => void
}

const LINK_LABEL: Record<RuntimeLink, string> = {
  none: '未连接运行时',
  starting: '正在启动…',
  booted: '运行时已启动，等待助理插件就绪',
  'attached-external': '已连接（用户启动的运行时）',
  'attached-own': '已连接（本壳启动的运行时）',
}

/** 状态刷新间隔。只在有 bridge.json 时才真的发一次本机请求，代价可忽略。 */
const REFRESH_MS = 15_000

/** 自有运行时收到终止信号后的等待窗口，超时才升级到强杀。 */
const STOP_GRACE_MS = 5_000

/** 进程是否存在。EPERM 说明它在，只是不归我们发信号 —— 那也算活着。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 运行时在线但还没有会话：告诉用户下一步，而不是让"已就绪"暗示可以对话。 */
function unboundHint(health: HealthBody | null): string {
  return health?.bound === false ? '；助理会话尚未开启：在宠物会话框发消息或说“开启个人助理模式”即可开启' : ''
}

export class CompanionHost {
  private tray: Tray | null = null
  private child: ChildProcess | null = null
  private ownership: RuntimeOwnership | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private starting = false
  private disposed = false
  private state: CompanionState
  private readonly callbacks: CompanionHostCallbacks
  private readonly options: { mainDir: string; dshHome: string; instanceId: string; layout?: AppLayout }

  // 显式字段 + 构造函数体内赋值，不用参数属性（constructor(private readonly …)）：
  // Node 的 strip-only TypeScript 只擦类型、不改写语法，参数属性会让本文件无法被
  // node --test 直接导入，而 index.ts 传递导入了它，整条主进程装配就都测不了。
  constructor(
    callbacks: CompanionHostCallbacks,
    options: { mainDir: string; dshHome: string; instanceId: string; layout?: AppLayout },
  ) {
    this.callbacks = callbacks
    this.options = options
    const settings = callbacks.readSettings()
    this.state = {
      link: 'none',
      stageVisible: true,
      focusMode: false,
      presentationMode: false,
      trayResident: settings.trayResident === true,
      profile: settings.runtimeProfile || 'web',
      lastStage: null,
      lastMessage: null,
      lastFailed: false,
      ownPid: null,
    }
  }

  /**
   * 桌面壳的目录布局。优先用 `index.ts` 算好的那一份。
   *
   * 两处各算一次的风险很具体：打包态下 `mainDir` 在 asar 里，独立算出来会把随包 dsh CLI
   * 指到 `app.asar/node_modules/...` —— 子进程读不了，启动必然失败。共用一份就不会分裂。
   */
  private appLayout(): AppLayout {
    if (this.options.layout) return this.options.layout
    const packaged = app.isPackaged === true
    return resolveAppLayout({
      mainDir: this.options.mainDir,
      isPackaged: packaged,
      appPath: packaged && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined,
      resourcesPath: packaged ? process.resourcesPath : undefined,
    })
  }

  /** 建托盘、恢复上一次的所有权记录、开始周期性刷新。 */
  start(): void {
    this.ownership = this.readOwnership()
    this.createTray()
    void this.refresh()
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  /**
   * 退出前收尾：拆托盘、停自有运行时并等它静止。
   *
   * 等待是异步且有界的（SIGTERM → 最多 5s → SIGKILL）。同步阻塞主线程等 exitCode 是没用的：
   * 子进程的退出事件要靠事件循环派发，阻塞期间它永远不会被置位。
   */
  async shutdown(): Promise<void> {
    this.disposed = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.tray?.destroy()
    this.tray = null
    await this.terminateOwnRuntime()
  }

  setStageVisible(visible: boolean): void {
    if (this.state.stageVisible === visible) return
    this.state = { ...this.state, stageVisible: visible }
    this.callbacks.onStageVisible(visible)
    this.emit()
  }

  /**
   * 切专注模式。
   *
   * 不动窗口：角色还在桌面上，只是不闲聊、不开牌局、不听唤醒词。前两条由渲染层读 `focusMode`
   * 自己做，第三条是麦克风的事，走 `onFocusMode` 交给仲裁器。
   */
  setFocusMode(value: boolean): void {
    if (this.state.focusMode === value) return
    this.state = { ...this.state, focusMode: value }
    this.callbacks.onFocusMode(value)
    this.emit()
  }

  /**
   * 切演示隐私模式。
   *
   * 只改状态：渲染层读到 `presentationMode` 之后决定隐藏哪些历史与预览。
   * **不动**麦克风、不动窗口、不动专注模式 —— 演示时用户往往还要讲解、还要插话，
   * 把它们一起掐掉就成了"关掉宠物"，不是"别把我的历史露出来"。
   */
  setPresentationMode(value: boolean): void {
    if (this.state.presentationMode === value) return
    this.state = { ...this.state, presentationMode: value }
    this.emit()
  }

  setTrayResident(value: boolean): void {
    this.callbacks.saveSettings({ trayResident: value })
    this.state = { ...this.state, trayResident: value }
    this.emit()
  }

  /** 桥接状态变了（连上/断开）就叫一次：壳对运行时的判断必须跟着事实走，不能只靠自己的定时器。 */
  noteBridgeChange(): void {
    void this.refresh()
  }

  /**
   * 启动团队运行时。
   *
   * 只有在确认没有活着的运行时时才真的 spawn（`decideStartAction`）。一次启动进行中再点第二次
   * 不会并发拉起两个进程 —— 那样两个运行时会抢同一份 bridge.json 与同一个采样器。
   */
  async startRuntime(profile?: string): Promise<void> {
    if (this.starting) {
      this.report('check-runtime', '已经有一次启动在进行中，等它出结果')
      return
    }
    const target = profile || this.state.profile
    this.callbacks.saveSettings({ runtimeProfile: target })
    this.starting = true
    this.state = { ...this.state, link: 'starting', profile: target }
    this.emit()
    try {
      const layout = this.appLayout()
      const plan = planRuntimeLaunch({
        dshHome: this.options.dshHome,
        profile: target,
        // 打包后随包 CLI 在 app.asar.unpacked：以子进程跑的东西读不了 asar 内的路径。
        appDir: layout.realAppDir,
        // 只影响失败时给用户的下一步：安装版里没有"去 dsh-pet 目录装依赖"这回事。
        packaged: layout.packaged,
      })
      if (!plan.ok) {
        this.report(plan.stage, plan.message, true)
        return
      }

      this.report(
        'check-runtime',
        `已找到 dsh ${plan.dshVersion} 与插件 ${plan.pluginVersion}，检查是否已有运行时`,
      )
      const bridge = readBridgeInfo()
      const health = bridge ? await probeHealth(bridge) : null
      const decision = decideStartAction({ health, bridge, pidAlive })
      if (decision.action === 'attach') {
        this.finishAttach(health, 'attached-external')
        return
      }
      if (decision.action === 'wait') {
        // 不是失败：有进程在，只是还没应答。这时候再启动一个才是真正的错误。
        this.report('check-runtime', decision.message)
        this.state = { ...this.state, link: 'none' }
        this.emit()
        return
      }

      this.report('spawn', `启动 dsh --profile ${plan.profile} --patch ${path.basename(plan.overlayPath)}`)
      const spawnedAt = Date.now()
      const log = this.openLogFile(spawnedAt)
      const logFile = log?.file ?? null
      let child: ChildProcess
      try {
        child = spawn(plan.command, [...plan.args], {
          cwd: plan.cwd,
          env: { ...process.env, ...plan.env },
          windowsHide: true,
          stdio: ['ignore', log?.fd ?? 'ignore', log?.fd ?? 'ignore'],
        })
      } catch (error) {
        this.report('spawn', `启动进程失败：${error instanceof Error ? error.message : String(error)}`, true)
        return
      } finally {
        // 抛错时也要关：这条 finally 是描述符唯一的归还点。
        if (log) closeSync(log.fd)
      }
      if (typeof child.pid !== 'number') {
        this.report('spawn', '进程没有拿到 pid，启动失败', true)
        return
      }
      this.child = child
      this.ownership = {
        instanceId: this.options.instanceId,
        pid: child.pid,
        spawnedAt,
        profile: plan.profile,
        overlayPath: plan.overlayPath,
      }
      this.writeOwnership(this.ownership)
      this.state = { ...this.state, link: 'booted', ownPid: child.pid }
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null
        this.clearOwnership()
        if (this.disposed) return
        // 进程自己退了：把手上的日志路径告诉用户，这比一句"启动失败"有用得多。
        this.report(
          'spawn',
          `运行时进程已退出（code=${String(code)} signal=${String(signal ?? 'none')}）${logFile ? `，输出在 ${logFile}` : ''}`,
          true,
        )
        void this.refresh()
      })
      this.emit()
      await this.awaitBridge(child, logFile)
    } finally {
      this.starting = false
    }
  }

  /** 用户在托盘上点「停止自有运行时」。没有句柄（上一次的壳启动的）就只报告，不按 pid 杀。 */
  async stopOwnRuntime(): Promise<void> {
    if (!this.child) {
      const stale = this.ownership
      if (stale && pidAlive(stale.pid)) {
        this.report(
          'check-runtime',
          `运行时 ${stale.pid} 是上一次桌面壳启动的，本进程没有它的句柄：请在它自己的窗口里关闭，或手动结束该进程`,
          true,
        )
      } else {
        this.report('check-runtime', '没有由本壳启动的运行时')
      }
      return
    }
    await this.terminateOwnRuntime()
    this.report('check-runtime', '已停止本壳启动的运行时')
    await this.refresh()
  }

  private async terminateOwnRuntime(): Promise<void> {
    const child = this.child
    this.child = null
    this.clearOwnership()
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    // 有界等待：不给运行时无限时间去刷盘，也不一上来就强杀（它可能正在写团队库）。
    await Promise.race([once(child, 'exit'), sleep(STOP_GRACE_MS)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  /**
   * 等 bridge.json 出现，且出现的确实是**我们这个子进程**写的。
   *
   * 只等文件出现是不够的：文件可能来自另一个运行时（用户自己起的那个）。pid 对不上就说明
   * 我们启动的这个还没绑定会话，而该附着的对象是那个已经在跑的。
   */
  private async awaitBridge(child: ChildProcess, logFile: string | null): Promise<void> {
    const deadline = Date.now() + MAX_BOOT_MS
    while (!this.disposed && Date.now() < deadline) {
      await sleep(1000)
      if (child.exitCode !== null || child.signalCode !== null) return
      const bridge = readBridgeInfo()
      if (!bridge) continue
      const health = await probeHealth(bridge)
      if (bridge.pid !== child.pid) {
        // 别的运行时先应答了：附着它，我们启动的这个继续留着（它没有绑定任何会话）。
        if (health?.ok === true) {
          this.finishAttach(health, 'attached-external')
          return
        }
        continue
      }
      const contract = verifyRuntimeContract(health, this.state.profile)
      if (!contract.ok) {
        this.report(contract.stage, contract.message, true)
        return
      }
      this.state = { ...this.state, link: 'attached-own' }
      this.report('ready', `团队模式已就绪（profile ${this.state.profile}，运行时 pid=${bridge.pid}）${unboundHint(health)}`)
      return
    }
    if (this.disposed) return
    // 旧版插件只在召唤时才写 bridge.json；新版一加载就写。等满时限还没出现，多半是插件没加载起来。
    this.state = { ...this.state, link: child.exitCode === null && child.signalCode === null ? 'booted' : 'none' }
    this.report(
      'await-bridge',
      `运行时已启动（pid ${String(child.pid)}），但助理插件的桥接没有出现：插件可能没有加载，或是旧版（旧版需要在 dsh 会话里说「召唤宠物」）${logFile ? `；运行时输出在 ${logFile}` : ''}`,
    )
  }

  private finishAttach(health: HealthBody | null, link: RuntimeLink): void {
    const contract = verifyRuntimeContract(health, this.state.profile)
    if (!contract.ok) {
      this.report(contract.stage, contract.message, true)
      return
    }
    this.state = { ...this.state, link }
    this.report('ready', `已连接到正在运行的助理团队（profile ${this.state.profile}）${unboundHint(health)}`)
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return
    const bridge = readBridgeInfo()
    const health = bridge ? await probeHealth(bridge) : null
    if (health?.ok !== true) {
      if (this.state.link === 'attached-external' || this.state.link === 'attached-own') {
        this.state = {
          ...this.state,
          link: this.child ? 'booted' : 'none',
          ownPid: this.child?.pid ?? null,
        }
        this.emit()
      }
      return
    }
    const contract = verifyRuntimeContract(health, this.state.profile)
    if (!contract.ok) {
      // 同一条失败只播报一次：刷新每 15s 跑一遍，重复播报会让界面上同一句话一直闪。
      if (this.state.lastStage !== contract.stage || this.state.lastMessage !== contract.message) {
        this.report(contract.stage, contract.message, true)
      }
      if (this.state.link === 'attached-external' || this.state.link === 'attached-own') {
        this.state = { ...this.state, link: this.child ? 'booted' : 'none', ownPid: this.child?.pid ?? null }
        this.emit()
      }
      return
    }
    const own = matchesOwnedRuntime(this.ownership, bridge)
    const link: RuntimeLink = own ? 'attached-own' : 'attached-external'
    const ownPid = own ? (bridge?.pid ?? null) : null
    if (this.state.link !== link || this.state.ownPid !== ownPid) {
      this.state = { ...this.state, link, ownPid }
      this.emit()
    }
  }

  private report(stage: LaunchStage, message: string, failed = false): void {
    const link = stage === 'ready' || stage === 'await-bridge' || this.state.link !== 'starting'
      ? this.state.link
      : this.child ? 'booted' : 'none'
    this.state = { ...this.state, lastStage: stage, lastMessage: message, lastFailed: failed, link }
    this.emit()
  }

  private emit(): void {
    this.callbacks.onState(this.state)
    this.rebuildTray()
  }

  private createTray(): void {
    // 图标用现成的角色素材：托盘上那只熊猫和桌面上那只是同一个形象。
    //
    // macOS 要用 **Template Image**（文件名以 `Template` 结尾、16×16 + 32×32@2x）：
    // 系统据此把它当"单色蒙版"，跟随浅色/深色菜单栏自动反色。用彩色 PNG 的话，
    // 深色菜单栏上会是一块不协调的亮斑。仓库里 `assets/tray/pandaTemplate.png` 是这个版本，
    // 没有就退回彩色图 —— 能显示，只是不那么合群。
    const trayDir = path.join(this.options.mainDir, '../assets/tray')
    const template = path.join(trayDir, 'pandaTemplate.png')
    const plain = path.join(this.options.mainDir, '../assets/pets/panda.png')
    const isMac = platformOf() === 'darwin'
    const iconPath = isMac && existsSync(template) ? template : plain
    const image = existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      : nativeImage.createEmpty()
    if (isMac && iconPath === template) image.setTemplateImage(true)
    this.tray = new Tray(image)
    // 单击托盘 = 显示/隐藏角色。这是"关掉舞台但壳还在"最常用的那一下。
    //
    // ⚠️ **macOS 上这个回调不会来**：一旦 `setContextMenu` 设过菜单，点击托盘图标会直接
    // 弹出菜单，系统不再派发 click 事件（官方文档明说 `mouse-up` 同理不派发）。
    // 所以 macOS 的等价入口是菜单里的「隐藏角色 / 显示角色」项 —— 那个一直都在。
    // 这里照旧注册：Windows/Linux 上它仍然是最快的那一下，macOS 上只是静默不触发。
    this.tray.on('click', () => this.setStageVisible(!this.state.stageVisible))
    this.rebuildTray()
  }

  private rebuildTray(): void {
    const tray = this.tray
    if (!tray || tray.isDestroyed()) return
    const { link, stageVisible, focusMode, trayResident, lastMessage, ownPid } = this.state
    const launchable = listLaunchableProfiles(this.options.dshHome)
    const busy = link === 'starting' || link === 'attached-own' || link === 'attached-external'

    tray.setToolTip(`dsh 桌面助理团 · ${LINK_LABEL[link]}${lastMessage ? `\n${lastMessage}` : ''}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `助理团：${LINK_LABEL[link]}`, enabled: false },
        { label: `角色：${stageVisible ? '显示中' : '已隐藏'}`, enabled: false },
        { label: ownPid ? `自有运行时：pid ${ownPid}` : '自有运行时：无', enabled: false },
        { type: 'separator' },
        {
          // 隐藏是 §2.12 要的"统一隐藏开关"：截图、投屏、录屏都靠它，桌面上什么都不剩。
          label: stageVisible ? '隐藏角色（截图 / 录屏）' : '显示角色',
          click: () => this.setStageVisible(!stageVisible),
        },
        {
          // 专注与隐藏是两件事：角色还在、任务状态照常显示，只是不闲聊、不开牌局、不听唤醒词。
          label: '专注模式（会议 / 屏幕共享：不闲聊、不开牌局、不听唤醒词）',
          type: 'checkbox',
          checked: focusMode,
          click: item => this.setFocusMode(item.checked),
        },
        {
          // 第三种：演示隐私模式。与上面两项的区别是"藏什么"——
          // 隐藏藏的是角色本身，专注压的是闲聊与唤醒，这里藏的是**过去的内容**（历史、提醒、预览）。
          // 讲解、插话、暂停照旧可用：演示时用户正是要用它们。
          label: '演示隐私模式（隐藏历史与提醒，讲解与插话照常）',
          type: 'checkbox',
          checked: this.state.presentationMode,
          click: item => this.setPresentationMode(item.checked),
        },
        {
          // 唤醒监听初始化失败后会粘住、不自动重试（否则每三秒刷一条错误日志，用户看到的
          // 是一只一直在报错的宠物）。所以修好麦克风、装好中文语音包之后得有地方能把它叫回来。
          label: '重新监听唤醒词（"小潘同学"）',
          click: () => this.callbacks.onRetryWake(),
        },
        {
          label: `启动助理团队（${this.state.profile}）`,
          enabled: !busy,
          // 只列出此刻真的具备条件的 profile：装好了插件、也有团队覆盖层。
          submenu: launchable.length === 0
            ? [{ label: '没有可用的 profile（先在 dsh 里装好个人助理插件）', enabled: false }]
            : launchable.map(name => ({
              label: name,
              type: 'radio' as const,
              checked: name === this.state.profile,
              click: () => void this.startRuntime(name),
            })),
        },
        {
          label: '停止自有运行时',
          enabled: this.child !== null,
          click: () => void this.stopOwnRuntime(),
        },
        { type: 'separator' },
        {
          label: '托盘常驻（隐藏角色后仍保留唤醒监听）',
          type: 'checkbox',
          checked: trayResident,
          click: item => this.setTrayResident(item.checked),
        },
        { type: 'separator' },
        { label: '退出桌面壳', click: () => this.callbacks.onExit() },
      ]),
    )
  }

  /**
   * 打开本次启动的日志文件，返回路径与一个已打开的写描述符。
   *
   * 必须是描述符而不是路径字符串：stdio 不认路径，Node 会抛 ERR_INVALID_SYNC_FORK_INPUT，
   * 而那个异常会被 spawn 外面的 try 吞成一句"启动进程失败"——排查时根本看不出问题在日志上。
   * 描述符在 spawn 返回后立刻关闭（子进程拿到的是复制品），不必由壳保管。
   */
  private openLogFile(spawnedAt: number): { file: string; fd: number } | null {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `runtime-${spawnedAt}.log`)
      return { file, fd: openSync(file, 'a') }
    } catch {
      // 日志写不出来不该挡住启动：宁可少一条排查线索，也不要因为日志失败就说"启动不了"。
      return null
    }
  }

  private ownershipPath(): string {
    return path.join(app.getPath('userData'), 'runtime-ownership.json')
  }

  /**
   * 恢复上一次壳留下的所有权记录。
   *
   * 只有当 bridge.json 的 pid 与启动时刻都对得上时，才认为那个运行时还是我们的 ——
   * pid 会被系统回收，光凭号码相等就动手，杀掉的可能是完全无关的进程。
   */
  private readOwnership(): RuntimeOwnership | null {
    try {
      const file = this.ownershipPath()
      if (!existsSync(file)) return null
      const record = sanitizeOwnership(JSON.parse(readFileSync(file, 'utf8')))
      if (!record) return null
      if (!pidAlive(record.pid)) {
        this.clearOwnership()
        return null
      }
      if (!matchesOwnedRuntime(record, readBridgeInfo())) {
        this.clearOwnership()
        return null
      }
      return record
    } catch {
      return null
    }
  }

  private writeOwnership(record: RuntimeOwnership): void {
    try {
      mkdirSync(path.dirname(this.ownershipPath()), { recursive: true })
      writeFileSync(this.ownershipPath(), JSON.stringify(record, null, 2), 'utf8')
    } catch {
      // 写不下所有权记录时，本次运行仍然握有句柄，退出照样能停掉自有运行时。
    }
  }

  private clearOwnership(): void {
    this.ownership = null
    if (this.state.ownPid !== null) this.state = { ...this.state, ownPid: null }
    try {
      rmSync(this.ownershipPath(), { force: true })
    } catch {
      // 删不掉就是一个过期文件，下次 readOwnership 会因 pid 不活着而丢弃它。
    }
  }
}

