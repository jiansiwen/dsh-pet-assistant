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
    if (opened.value.profile === null || opened.value.position === undefined) {
      throw new Error('WPS 已打开文件，但读不到页码，不能同步翻页')
    }
    this.session = opened.value
    this.page = opened.value.position.page
    this.expected = this.page
    this.timer = setInterval(() => this.poll(), this.options.pollMs ?? WPS_POLL_MS)
    this.timer.unref?.()
  }

  /** WPS 没有可控的段落高亮，只跳到锚点所在的物理页。 */
  goto(anchor: DocAnchor, _options: { readonly highlight: boolean }): void {
    const session = this.session
    if (session === null) return
    const generation = this.generation
    this.enqueue(async () => {
      if (generation !== this.generation) return
      this.expected = anchor.page
      const status = await this.options.wps().syncTo(session, anchor.page)
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
    const text = `${PAUSE_TEXT[status.reason]}，讲解已暂停：${status.error.guidance ?? status.error.message}`
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
