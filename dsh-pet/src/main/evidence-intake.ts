/**
 * 桌面侧的"外部证据收件"编排：把会议纪要 / 当前窗口文字交给个人助理。
 *
 * 这个文件只做三件事，顺序不能变：
 *
 *   1. **拿到内容**（从会议库取已确认的纪要；或读一次前台窗口）
 *   2. **让用户确认**（主进程原生对话框，显示真实内容和去向）
 *   3. **上报**（`POST /evidence/intake`，见 `harness.ts`）
 *
 * 为什么第 2 步必须在第 3 步之前、而且必须显示真实内容：
 * - 会议纪要里可能有薪酬、人事、客户名单；窗口里可能正开着私人聊天。
 *   "把某窗口的内容记下来"这个请求本身，不足以让用户知道**将会存下什么**。
 * - 所以确认框给的是**正文前若干字的原文**，不是"窗口标题 + 字数"。
 *   看不见内容就点同意，等于盲签。
 *
 * 这个文件不碰 Electron：确认框与读窗口都靠注入，于是能在 `node --test` 里跑完整链路
 * （包括"用户取消 → 一个请求都不发"这条最容易被写错的路径）。
 */
import type { EvidenceIntakeOutcome, EvidenceIntakeRequest } from '../evidence-types.ts'

/** 确认框里给用户看的东西。刻意包含原文预览：看不见内容就点同意等于盲签。 */
export interface EvidenceConfirmView {
  readonly kind: 'meeting_minutes' | 'window_text'
  readonly title: string
  /** 正文前若干字。 */
  readonly preview: string
  /** 正文规模，让用户知道被收走多少。 */
  readonly sizeText: string
  /** 去向说明。 */
  readonly destination: string
  /** 确认按钮文字。 */
  readonly confirmLabel: string
}

/** 预览长度。够看清是什么内容，又不至于让对话框变成一堵墙。 */
export const PREVIEW_CHARS = 200

export interface EvidenceIntakeDeps {
  /** 弹原生确认框，返回用户是否同意。 */
  readonly confirm: (view: EvidenceConfirmView) => Promise<boolean>
  readonly post: (request: EvidenceIntakeRequest) => Promise<EvidenceIntakeOutcome>
  /**
   * 读一次前台窗口的文字。失败要给出**能照做**的原因（缺哪个权限、哪个窗口读不到），
   * 不要只说"失败"。
   */
  readonly readWindowText: () => Promise<
    | { readonly ok: true; readonly text: string; readonly title: string }
    | { readonly ok: false; readonly error: string }
  >
  /** 导出一场**已确认**的纪要正文；未确认必须在这里就被拒。 */
  readonly exportMinutes: (meetingId: string) => Promise<
    | { readonly ok: true; readonly content: string; readonly digest: string; readonly confirmedAt: number }
    | { readonly ok: false; readonly error: string }
  >
  /** 会议名，用于标题与确认框。找不到时返回 null（标题退化成"某场会议"）。 */
  readonly meetingName: (meetingId: string) => Promise<string | null>
  readonly now: () => number
}

/** 正文摘要。避免把几千字一次性塞进对话框。 */
export function previewOf(text: string, limit = PREVIEW_CHARS): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}…`
}

/** 规模说明：多少字、多少行。比"3.2KB"更好懂。 */
export function sizeTextOf(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n').length
  return `${normalized.length} 字、${lines} 行`
}

/**
 * 把已确认的会议纪要交给个人助理。
 *
 * 未确认的纪要在 `exportMinutes` 那一层就被拒了（不是在这里判断）——
 * 因为"能不能导出定稿"的规则只该有一处实现，桌面别的地方也依赖它。
 */
export async function intakeMinutes(meetingId: string, deps: EvidenceIntakeDeps): Promise<EvidenceIntakeOutcome> {
  const exported = await deps.exportMinutes(meetingId)
  if (!exported.ok) return { ok: false, error: exported.error }
  if (exported.content.trim() === '') return { ok: false, error: '这场会议的纪要是空的，没有可收的内容' }

  const name = (await deps.meetingName(meetingId))?.trim() || '某场会议'
  const agreed = await deps.confirm({
    kind: 'meeting_minutes',
    title: name,
    preview: previewOf(exported.content),
    sizeText: sizeTextOf(exported.content),
    destination: '只存本机，作为日报里"开会"这类事项的证据。文字不会因此发给模型服务商。',
    confirmLabel: '交给个人助理',
  })
  if (!agreed) return { ok: false, error: '已取消：这份纪要没有交给个人助理' }

  return deps.post({
    kind: 'meeting_minutes',
    title: name,
    text: exported.content,
    capturedAt: exported.confirmedAt,
    digest: exported.digest,
  })
}

/**
 * 把当前窗口的文字记为工作证据。
 *
 * 注意这里是**用户按下按钮那一刻**才读窗口：不预先读、不缓存。
 * 预先读会让"我还没决定要不要记"变成"已经读过了"。
 */
export async function intakeWindow(deps: EvidenceIntakeDeps): Promise<EvidenceIntakeOutcome> {
  const read = await deps.readWindowText()
  if (!read.ok) return { ok: false, error: read.error }
  if (read.text.trim() === '') return { ok: false, error: '这个窗口里没有读到文字（可能是图片、视频或自绘界面）' }

  const agreed = await deps.confirm({
    kind: 'window_text',
    title: read.title,
    preview: previewOf(read.text),
    sizeText: sizeTextOf(read.text),
    destination: '只存本机，作为日报里的工作证据。文字不会因此发给模型服务商；它只能支撑"推断"，不能证明事情已经做完。',
    confirmLabel: '记为工作证据',
  })
  if (!agreed) return { ok: false, error: '已取消：这段窗口文字没有记下来' }

  return deps.post({
    kind: 'window_text',
    title: read.title,
    text: read.text,
    capturedAt: deps.now(),
  })
}
