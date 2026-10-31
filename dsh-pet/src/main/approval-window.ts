/**
 * 专用审批窗口：批准只在这里签发。
 *
 * 为什么要单独一个窗口，而不是在舞台面板里放两个按钮：
 * 舞台渲染器上显示的是**模型写出来的文本**（气泡、摘要、提案说明）。让同一个渲染器
 * 直接签发批准，等于让不可信内容有能力影响批准的签发路径——它不需要骗过用户，
 * 只要能让面板发出一次 `decide` 就够了。所以设计里把这两件事分开：
 * 舞台只能**请求**打开这个窗口，决定只能从这个窗口回来，而回执还要过 `checkSender`。
 *
 * 这个窗口因此有几条硬规矩，改任何一条都要想清楚是在拆哪层保护：
 * - 只加载打包进来的那个固定本地页面，禁止一切导航与新窗口；
 * - 用**专用** preload，只暴露"读本卡片"和"提交决定"两个接口，不给通用 IPC；
 * - 不加载角色包（形象、皮肤、动画一律不进这个窗口），它不需要好看，只需要可信；
 * - 卡片上的操作、目标、摘要、风险全部由主进程按自己保存的原始提案算，
 *   窗口回传的任何内容都不参与渲染，也不参与判定；
 * - 高风险与不可撤销的操作，批准前再过一次主进程原生确认框，且默认焦点在"先不批准"上。
 *
 * 有一件事这个窗口做不到，也不假装能做到：它不能证明**点按钮的那个人**是设备的主人。
 * 应用完整性被破坏或宿主系统被攻陷不在这层保证范围内（设计文档明确了这条边界）。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  cardView,
  checkSender,
  confirmDialogSpec,
  needsNativeConfirm,
  meetingMailOutcomeText,
  type ApprovalCardView,
  type ApprovalProposal,
} from './approval-policy.ts'
import type { BridgeClient } from './harness.ts'
import type { ApprovalDecision, DecideApprovalResult, TeamSnapshot } from '../renderer/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 期望的页面地址是**算出来**的，不是加载后观察到的。
 *
 * 观察 `getURL()` 的结果再拿它当基准，等于让页面自己定义什么算合法：真被导到别处时，
 * 基准也跟着变了，比对永远通过。算出来的这个值不依赖任何运行时状态。
 */
const PAGE_PATH = path.join(here, '../renderer/approval.html')
const PAGE_URL = pathToFileURL(PAGE_PATH).href
const PRELOAD_PATH = path.join(here, '../preload/approval.cjs')

const WINDOW_WIDTH = 480
const WINDOW_HEIGHT = 360

/** 打开窗口前先去桥接取一次提案与成员名的上限。本地回环，正常几毫秒；卡住也不能永远等。 */
const LOOKUP_TIMEOUT_MS = 3_000

export class ApprovalWindow {
  private win: BrowserWindow | null = null
  /** 开窗时登记的 webContents.id。回执必须来自它，否则不采信。 */
  private registeredId: number | null = null
  /** 主进程自己保存的那条原始提案。卡片渲染与判定都只认它。 */
  private current: ApprovalProposal | null = null
  private currentRequester: string | null = null
  /** 同时来了多条待批提案时排队，一次只显示一条：两张卡叠在一起，用户会批错那张。 */
  private readonly queue: ApprovalProposal[] = []
  private readonly queuedRequesters = new Map<string, string | null>()
  private disposed = false
  private deciding = false
  private readonly bridge: BridgeClient

  // 显式字段而不是参数属性：Node 的 strip-only TypeScript 只擦类型、不改写语法，
  // 参数属性会让本文件无法被 node --test 直接导入，而 index.ts 传递导入了它。
  constructor(bridge: BridgeClient) {
    this.bridge = bridge
  }

  /**
   * 舞台请求批准某条提案。
   *
   * 只接受 proposalId：提案的内容一律由主进程去桥接取，不接受舞台回传的字段。
   * 舞台能改的东西都不该出现在批准的依据里。
   */
  async request(proposalId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.disposed) return { ok: false, error: '桌面壳正在退出' }
    if (typeof proposalId !== 'string' || !proposalId) {
      return { ok: false, error: '没有指定要批准哪条提案' }
    }
    const found = await this.lookup(proposalId)
    if (!found) {
      // 这条已经不是待批状态了：可能刚被别处批掉、也可能过期。如实说，不要开一张空卡片。
      return { ok: false, error: '这条提案已经不在待批列表里，刷新一下看看' }
    }
    if (this.current?.proposalId === proposalId) {
      this.focus()
      return { ok: true }
    }
    if (this.current) {
      // 已经有一条在批了：排到后面，别把当前这条顶掉——顶掉等于用户读到一半内容被换走。
      if (!this.queue.some(item => item.proposalId === proposalId)) {
        this.queue.push(found.proposal)
        this.queuedRequesters.set(proposalId, found.requester)
      }
      return { ok: true }
    }
    this.show(found.proposal, found.requester)
    return { ok: true }
  }

  /** 提案被消费、过期或从待办里消失后调用：正在显示的是它就换下一条，队列空了关窗。 */
  retire(proposalId: string): void {
    const queuedIndex = this.queue.findIndex(item => item.proposalId === proposalId)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      this.queuedRequesters.delete(proposalId)
    }
    if (this.current?.proposalId !== proposalId) return
    const next = this.queue.shift()
    if (next) {
      const requester = this.queuedRequesters.get(next.proposalId) ?? null
      this.queuedRequesters.delete(next.proposalId)
      this.show(next, requester)
      return
    }
    this.close()
  }

  /**
   * 桥接断开或会话结束时清空。
   *
   * 这时候卡片上那条提案已经不可能再被批准了：审批凭据与代次都随会话一起失效。
   * 留着窗口，用户会点一次注定失败的批准，然后收到一句"会话已重启"——而那张卡片
   * 明明还好好地摊在眼前。关掉它，让"没有待批的操作"这个事实从桌面上就看得出来。
   */
  clear(): void {
    this.queue.length = 0
    this.queuedRequesters.clear()
    this.close()
  }

  registerIpc(): void {
    ipcMain.handle('approval-open', async (_event, proposalId: unknown) => {
      return this.request(typeof proposalId === 'string' ? proposalId : '')
    })

    ipcMain.handle('approval-card-read', event => {
      // 读卡片也要核发信者：这个 preload 只挂在审批窗口上，但 ipcMain 收到的是所有窗口的调用。
      const check = this.verify(event, this.current?.proposalId ?? '')
      if (!check.ok || !this.current) return null
      return this.view()
    })

    ipcMain.handle(
      'approval-card-decide',
      async (event, proposalId: unknown, decision: unknown): Promise<DecideApprovalResult> => {
        return this.decide(event, proposalId, decision)
      },
    )

    // 关掉卡片不等于驳回：提案在宿主那边仍然是待批的，到期才失效。
    ipcMain.on('approval-card-close', event => {
      if (!this.verify(event, this.current?.proposalId ?? '').ok) return
      const next = this.queue.shift()
      if (next) {
        const requester = this.queuedRequesters.get(next.proposalId) ?? null
        this.queuedRequesters.delete(next.proposalId)
        this.show(next, requester)
        return
      }
      this.close()
    })
  }

  dispose(): void {
    this.disposed = true
    ipcMain.removeHandler('approval-open')
    ipcMain.removeHandler('approval-card-read')
    ipcMain.removeHandler('approval-card-decide')
    ipcMain.removeAllListeners('approval-card-close')
    this.queue.length = 0
    this.queuedRequesters.clear()
    this.close()
  }

  /** 当前卡片内容。主进程按自己保存的原始提案算，每次都重算——过期与否取决于当下这一刻。 */
  private view(): ApprovalCardView | null {
    if (!this.current) return null
    return cardView(this.current, this.currentRequester, Date.now())
  }

  private async decide(
    event: Electron.IpcMainInvokeEvent,
    proposalId: unknown,
    decision: unknown,
  ): Promise<DecideApprovalResult> {
    const check = this.verify(event, typeof proposalId === 'string' ? proposalId : '')
    if (!check.ok) return { ok: false, error: check.reason }
    if (decision !== 'approve' && decision !== 'reject') {
      return { ok: false, error: '未知的决定类型' }
    }
    // 判定用主进程保存的原始提案重新算一次：卡片是几秒前渲染的，这几秒里可能已经过期。
    const proposal = this.current as ApprovalProposal
    const view = cardView(proposal, this.currentRequester, Date.now())
    if (!view.canDecide) {
      return { ok: false, error: view.blockedReason ?? '这条提案现在不能决定' }
    }

    if (this.deciding) return { ok: false, error: '正在处理当前决定，请勿重复点击' }
    this.deciding = true
    try {
      if (decision === 'approve' && needsNativeConfirm(proposal)) {
        const confirmed = await this.confirmNatively(view)
        if (!confirmed) return { ok: false, error: '你在确认框里选择了不批准，这条提案还没有被批准' }
      }
      const recheck = this.verify(event, proposal.proposalId)
      if (!recheck.ok || this.current !== proposal || this.disposed) {
        return { ok: false, error: '审批窗口或提案已变化，请重新查看待办' }
      }
      const currentView = cardView(proposal, this.currentRequester, Date.now())
      if (!currentView.canDecide) return { ok: false, error: currentView.blockedReason ?? '提案已失效' }
      const result = await this.bridge.decideApproval(proposal.proposalId, decision as ApprovalDecision,
        event.sender.id, proposal.kind ?? 'team', proposal.epoch)
      if (result.ok && decision === 'approve' && proposal.tool === 'personal_assistant_send_meeting_minutes') {
        const notice = meetingMailOutcomeText(result.meetingMail)
        try { await dialog.showMessageBox({ type: 'info', title: '会议邮件与提醒结果', message: notice.message,
          detail: notice.detail, buttons: ['知道了'], noLink: true }) } catch { /* 结果仍可在任务页和团队页核查 */ }
      }
      if (result.ok) this.retire(proposal.proposalId)
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.deciding = false
    }
  }

  /**
   * 原生确认框。
   *
   * 按钮顺序是刻意的：**"先不批准"在前且是默认**，回车不会批准。高风险操作不该让
   * "顺手按个回车"就能通过；真要批准的用户会去点那个按钮，多花的这一秒正是这道关口的意义。
   */
  private async confirmNatively(view: ApprovalCardView): Promise<boolean> {
    const spec = confirmDialogSpec(view, this.currentRequester, Date.now())
    const parent = this.win && !this.win.isDestroyed() ? this.win : undefined
    const { response } = parent
      ? await dialog.showMessageBox(parent, {
          type: 'warning',
          title: spec.title,
          message: spec.message,
          detail: spec.detail,
          buttons: [spec.cancelLabel, spec.approveLabel],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: spec.title,
          message: spec.message,
          detail: spec.detail,
          buttons: [spec.cancelLabel, spec.approveLabel],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
    return response === 1
  }

  /** 回执核验。事实全部取自主进程自己能观察到的东西，不看 payload 里自报的窗口信息。 */
  private verify(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, claimedProposalId = ''): {
    ok: true
  } | { ok: false; reason: string } {
    return checkSender({
      senderId: event.sender.id,
      registeredId: this.registeredId,
      isMainFrame: event.senderFrame === event.sender.mainFrame,
      url: event.senderFrame?.url ?? '',
      expectedUrl: PAGE_URL,
      claimedProposalId,
      registeredProposalId: this.current?.proposalId ?? null,
    })
  }

  private focus(): void {
    if (!this.win || this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  private show(proposal: ApprovalProposal, requester: string | null): void {
    this.current = proposal
    this.currentRequester = requester
    if (this.win && !this.win.isDestroyed()) {
      // 窗口还在，只是换内容：卡片每次决定后都会重新 read，所以只要把它带到前面。
      this.focus()
      this.win.webContents.send('approval-card-changed')
      return
    }
    const win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      title: '需要你点头',
      frame: true,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      // 置顶：提案有有效期，被别的窗口压住等于用户没机会批。
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // 不给这个窗口任何额外能力：它只需要读本卡片、提交决定。
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
    })
    this.win = win
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setMenuBarVisibility(false)

    // 禁止新窗口：连"用系统浏览器打开"都不给，这个窗口里没有任何东西值得跳出去看。
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 禁止导航：地址一旦变了，checkSender 就会拒掉这个窗口的一切回执。这里直接不让它变。
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-frame-navigate', event => event.preventDefault())

    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.registeredId = null
        this.current = null
        this.currentRequester = null
      }
    })

    void win.loadFile(PAGE_PATH).catch(error => {
      console.log('[dsh-pet] 审批页面加载失败:', error instanceof Error ? error.message : String(error))
      this.close()
    })
    win.once('ready-to-show', () => {
      // 加载完成之后才登记 webContents.id：在此之前收到的任何回执都因为"没登记过"被拒。
      this.registeredId = win.webContents.id
      win.webContents.send('approval-card-changed')
      win.show()
      win.focus()
    })
  }

  private close(): void {
    const win = this.win
    this.win = null
    this.registeredId = null
    this.current = null
    this.currentRequester = null
    if (win && !win.isDestroyed()) win.close()
  }

  /**
   * 去桥接取这条提案的原始内容，顺带把提请者的显示名认出来。
   *
   * 一次调用拿两件事：提案与成员表本来就在同一个快照里，分两次取会拿到两个时刻的状态。
   * 取不到就返回 null —— 宁可不开窗，也不要按舞台回传的内容开一张卡。
   */
  private async lookup(proposalId: string): Promise<{ proposal: ApprovalProposal; requester: string | null } | null> {
    let snapshot: TeamSnapshot | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      snapshot = await Promise.race([
        this.bridge.getTeam(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS) }),
      ])
    } catch {
      snapshot = null
    } finally { if (timer) clearTimeout(timer) }
    const found = snapshot?.proposals?.find(item => item.proposalId === proposalId)
    if (!found) return null
    const proposal: ApprovalProposal = {
      kind: found.kind,
      reportId: found.reportId,
      revision: found.revision,
      digest: found.digest,
      content: found.content,
      epoch: found.epoch ?? snapshot?.epoch,
      proposalId: found.proposalId,
      taskId: found.taskId ?? null,
      assistantId: found.assistantId ?? null,
      summary: found.summary ?? null,
      tool: found.tool ?? null,
      target: found.target ?? null,
      risk: found.risk ?? null,
      state: found.state ?? 'pending',
      expiresAt: typeof found.expiresAt === 'number' ? found.expiresAt : undefined,
    }
    const assistantId = proposal.assistantId
    const member = assistantId ? snapshot?.members?.find(item => item.assistantId === assistantId) : null
    return { proposal, requester: member?.displayName || null }
  }
}
