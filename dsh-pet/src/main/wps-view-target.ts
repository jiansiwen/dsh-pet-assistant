/**
 * WPS 作为讲解视图目标（M5-03/M5-04）：按状态机给出的 goto 跳页，再把读回的页码如实回报。
 *
 * 失焦、弹窗、WPS 关闭或切走文档时讲解必须暂停：这里不自行重试、不换窗口，只回报给状态机，
 * 由主进程停声并提示。用户在 WPS 里自己翻页（读回页与上次跳到的页不同）按"手动翻页"回报，
 * 状态机据此判定脱离。关闭/释放只停止同步，不关用户的 WPS。
 */
import type { PauseReason } from './desktop-actions.ts'
import type { DocAnchor, DocViewTarget, DocViewTargetSession, DocViewUserAction, PresenterStatus } from './doc-presenter.ts'
import type { WpsController, WpsSession, WpsSyncStatus } from './wps-control.ts'

/** 讲解进行中核对一次 WPS 状态的间隔：失焦或弹窗最迟这么久后暂停。 */
export const WPS_POLL_MS = 4_000

const PAUSE_TEXT: Record<PauseReason, string> = {
  'focus-lost': 'WPS 不在前台',
  dialog: 'WPS 出现了弹窗',
  closed: 'WPS 窗口已关闭',
  'document-switched': 'WPS 里切换到了别的文档',
  unsupported: '这个 WPS 版本不支持同步翻页',
  permission: '缺少控制 WPS 所需的系统权限',
  ambiguous: 'WPS 里开着同名文档，无法确定是哪一份',
  error: 'WPS 操作失败',
}

export interface WpsViewTargetOptions {
  /** 惰性取控制器：辅助脚本首次启动较慢，没人用 WPS 时不拉起。 */
  readonly wps: () => WpsController
  /** 暂停的可读原因交给主进程提示（状态机的 view-error 不带原因）。 */
  readonly notify: (message: string) => void
  readonly pollMs?: number
}

export class WpsViewTarget implements DocViewTarget {
  readonly kind = 'wps'
  private readonly options: WpsViewTargetOptions
  private session: WpsSession | null = null
  private generation = 0
  private page: number | null = null
  /** 最近一次由讲解跳到的页；读回页与它不同说明是用户在 WPS 里自己翻的。 */
  private expected: number | null = null
  private following = false
  private timer: ReturnType<typeof setInterval> | null = null
  private chain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(action: DocViewUserAction) => void>()
  /** plan 里每段的原文：跳页后拿它和 WPS 读回的文字比对（判"跳对没跳对"）。 */
  private sections: readonly { readonly text: string }[] = []

  constructor(options: WpsViewTargetOptions) {
    this.options = options
  }

  async show(target: DocViewTargetSession): Promise<void> {
    this.release()
    const generation = this.generation
    if (target.plan === null) throw new Error(target.problem?.message ?? '这份文档不能在 WPS 中同步讲解')
    const opened = await this.options.wps().open(target.realPath)
    if (generation !== this.generation) throw new Error('讲解已切换，WPS 打开结果作废')
    if (!opened.ok) throw new Error(`WPS 没能打开：${opened.error.guidance ?? opened.error.message}`)
    if (opened.value.profile === null) {
      throw new Error('WPS 已打开文件，但这类文件没有可靠的页码控制，不能同步翻页')
    }
    this.session = opened.value
    this.sections = target.plan.sections
    if (opened.value.position === undefined) {
      // 窗口能用但**读不到页码**（WPS 12.x 的 Qt5 窗口没有 KxPdfView / 页码控件）。
      // 这时不放弃 WPS：翻页走键盘退路（见 win-uia.ps1 的 Goto-PageByKeyboard），
      // 也**不轮询** —— 没有页码可读，轮询只会每几秒把讲解误判成"暂停"。
      this.page = null
      this.expected = null
      console.log('[dsh-pet] wps window ok but no pdf view (keyboard fallback)')
      return
    }
    this.page = opened.value.position.page
    this.expected = this.page
    console.log('[dsh-pet] wps window ok')
    this.timer = setInterval(() => this.poll(), this.options.pollMs ?? WPS_POLL_MS)
    this.timer.unref?.()
  }

  /** WPS 没有可控的段落高亮，只跳到锚点所在的物理页。 */
  goto(anchor: DocAnchor, _options: { readonly highlight: boolean }): void {
    const session = this.session
    if (session === null) return
    // 键盘模式（`show()` 里读不到页码）也照样跳：每一段都有确定的物理页码，目标是已知的，
    // 由 win-uia.ps1 的绝对跳页（Ctrl+G 输页码）完成，跳完读回文字交给 syncTo 比对。
    // "对不上"就由 apply(status) 把讲解暂停并说明原因 —— 这才对，不是"宁可不翻"。
    const expectText = this.sections[anchor.sectionIndex]?.text ?? undefined
    const generation = this.generation
    this.enqueue(async () => {
      if (generation !== this.generation) return
      this.expected = anchor.page
      const status = await this.options.wps().syncTo(session, anchor.page, expectText)
      if (generation === this.generation) this.apply(status)
    })
  }

  status(status: PresenterStatus): void {
    this.following = status.mode === 'following' && !status.paused && status.playing
  }

  currentPage(): number | null {
    return this.page
  }

  invalidate(): void {
    this.release()
  }

  onUserAction(listener: (action: DocViewUserAction) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  close(): void {
    this.release()
  }

  dispose(): void {
    this.release()
    this.listeners.clear()
  }

  /** 只在讲解实际推进时核对；暂停、脱离时不去碰 WPS。 */
  private poll(): void {
    const session = this.session
    if (session === null || !this.following) return
    const generation = this.generation
    this.enqueue(async () => {
      if (generation !== this.generation || !this.following) return
      const status = await this.options.wps().status(session)
      if (generation === this.generation) this.apply(status)
    })
  }

  private apply(status: WpsSyncStatus): void {
    if (status.state === 'in-sync') {
      this.page = status.position.page
      if (this.expected !== null && status.position.page !== this.expected) {
        this.expected = status.position.page
        this.emit({ kind: 'page', page: status.position.page })
      }
      return
    }
    const detail = `${PAUSE_TEXT[status.reason]}，讲解已暂停：${status.error.guidance ?? status.error.message}`
    // 弹窗/失焦是可恢复的暂停：必须把恢复方法说出来，否则用户只能看到“暂停”不知道下一步。
    const text = status.reason === 'dialog' || status.reason === 'focus-lost'
      ? `${detail}。关掉 WPS 弹窗并把 WPS 切回前台后，说“继续讲解”即可接着讲`
      : detail
    this.options.notify(text)
    if (status.reason === 'closed' || status.reason === 'document-switched') {
      this.release()
      this.emit({ kind: 'closed' })
    } else {
      this.emit({ kind: 'error', message: text })
    }
  }

  private emit(action: DocViewUserAction): void {
    for (const listener of [...this.listeners]) listener(action)
  }

  /** WPS 的读页/跳页都经同一个常驻辅助进程：串行执行，避免交错的按键与读回。 */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch(error => {
      this.options.notify(`WPS 同步出错，讲解已暂停：${error instanceof Error ? error.message : String(error)}`)
      this.emit({ kind: 'error', message: String(error) })
    })
  }

  private release(): void {
    this.generation += 1
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.session = null
    this.page = null
    this.expected = null
    this.following = false
  }
}
