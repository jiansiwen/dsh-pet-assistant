/**
 * 外部证据收件：把桌面壳产生的两样东西（已确认的会议纪要、用户主动记录的窗口文本）
 * 收进资料库，成为工作事项可以引用的来源。
 *
 * 为什么要有这个文件：数据产生在桌面壳一侧（它才有会议库、才有读窗口的能力），
 * 而工作事项活在插件这一侧。没有这条通道，会议纪要导出后就是一坨死文本，
 * 日报里想写"今天开了个评审会"，模型找不到任何可引用的来源 —— 只能凭活动线索猜，
 * 而那正是项目规则明令禁止的。
 *
 * 三条设计约束（都写在验收里）：
 *
 * 1. **收件必须已经在桌面侧拿到用户同意**。这个函数不弹任何框、也不判断"该不该收"，
 *    它只负责"收得对"。授权发生在数据产生的那一刻（原生对话框，见桌面侧 `evidence-intake.ts`）。
 * 2. **内容哈希去重**。同一份纪要收两次不该变成两条证据 —— 复用 `MaterialStore` 的
 *    `byDigest`，第二次返回 `duplicate: true` 和原来那条 id。
 * 3. **证据强度由来源类型决定，不由调用方声明**。`meeting_minutes` 解析为直接证据
 *    （用户确认过的原文），`window_text` 解析为间接证据（屏幕上有什么 ≠ 做成了什么）。
 *    调用方只能选 `kind`，选完强度就定了，没有"声称这是直接证据"的入口。
 */
import {
  MAX_MATERIAL_BYTES,
  type Material,
  type MaterialOrigin,
  type MaterialStore,
} from './materials.ts'
import type { WorkItemSourceKind } from './work-items.ts'

/** 收件来源。与 `MaterialOrigin` 里的同名值一一对应，但只暴露这一条通道允许的两类。 */
export const INTAKE_KINDS = ['meeting_minutes', 'window_text'] as const
export type IntakeKind = (typeof INTAKE_KINDS)[number]

/** 收件来源 → 资料库的 origin。 */
const ORIGIN_OF: Record<IntakeKind, MaterialOrigin> = {
  meeting_minutes: 'meeting_minutes',
  window_text: 'desktop_window',
}

/** 收件来源 → 工作事项的来源类型（两者同名，但分开写以免以后改名时漏掉一处）。 */
const SOURCE_KIND_OF: Record<IntakeKind, WorkItemSourceKind> = {
  meeting_minutes: 'meeting_minutes',
  window_text: 'window_text',
}

/** 单份正文上限，与资料库一致。超了就让用户分段，不静默截断成半份"证据"。 */
export const MAX_INTAKE_BYTES = MAX_MATERIAL_BYTES

export interface IntakeRequest {
  readonly kind: IntakeKind
  /** 给人看的标题：会议名 / "窗口：报价单.xlsx - WPS 表格"。 */
  readonly title: string
  /** 正文。 */
  readonly text: string
  /**
   * 内容产生的时刻（毫秒）。
   * 会议用纪要确认时刻，窗口用抓取时刻。缺省取收件时刻 —— 但那会让"什么时候拍的"失真，
   * 所以调用方应当总是给。
   */
  readonly capturedAt?: number
  /**
   * 桌面侧算出的内容摘要（会议用纪要确认时的 digest）。
   *
   * 只用来对账"我收到的是不是你确认的那一份"：不一致时收下但回一句警告
   * （正文本身有效，拒收只会让用户白点一次）。不落库 —— 资料库自己按正文算摘要。
   */
  readonly digest?: string
}

export type IntakeResult =
  | {
      readonly ok: true
      readonly materialId: string
      /** 同一份内容之前已经收过：返回的是原来那条，没有产生新证据。 */
      readonly duplicate: boolean
      readonly sourceKind: WorkItemSourceKind
      /**
       * 需要让用户知道但不构成失败的一句话（例如摘要对不上）。
       * null = 没有任何异常。
       */
      readonly warning: string | null
    }
  | { readonly ok: false; readonly error: string }

export interface IntakeDeps {
  readonly materials: MaterialStore
  readonly now: () => number
  /** 本地日期（YYYY-MM-DD），用于"归属哪一天"。测试可注入。 */
  readonly localDate?: (timestamp: number) => string
}

function defaultLocalDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isIntakeKind(value: unknown): value is IntakeKind {
  return value === 'meeting_minutes' || value === 'window_text'
}

/** 来源说明的措辞。刻意把"这份材料不能证明什么"写出来，与资料库其他来源一致。 */
function sourceLabelOf(kind: IntakeKind, title: string): string {
  return kind === 'meeting_minutes' ? `会议纪要：${title}` : `窗口记录：${title}`
}

/**
 * 收一份外部证据。
 *
 * 入参来自 HTTP，一律当不可信数据处理：类型、长度、空内容都当场校验，
 * 任何一条不成立就拒收并给出**具体**原因（前端要能把原因原样显示给用户）。
 */
export function intakeEvidence(raw: unknown, deps: IntakeDeps): IntakeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '收件请求格式不对' }
  const input = raw as Partial<IntakeRequest>
  if (!isIntakeKind(input.kind)) return { ok: false, error: `收件类型不认识：${String(input.kind)}` }
  const kind: IntakeKind = input.kind

  const text = typeof input.text === 'string' ? input.text : ''
  if (text.trim() === '') {
    // 空正文绝不入库：一条空证据会让"引用过它"的事项看起来有来源，实际什么也没有。
    return { ok: false, error: kind === 'meeting_minutes' ? '纪要正文为空，没有可收的内容' : '这个窗口里没有读到文字，没有可收的内容' }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_INTAKE_BYTES) {
    return { ok: false, error: `正文 ${Math.round(bytes / 1024)}KB 超过 ${MAX_INTAKE_BYTES / 1024}KB 上限，请分段记录` }
  }

  const title = (typeof input.title === 'string' ? input.title : '').trim()
  if (title === '') {
    return { ok: false, error: kind === 'meeting_minutes' ? '缺少会议名，无法说明这份纪要来自哪场会议' : '缺少窗口标题，无法说明这段文字是从哪儿来的' }
  }

  const capturedAt = typeof input.capturedAt === 'number' && Number.isFinite(input.capturedAt) && input.capturedAt > 0
    ? input.capturedAt
    : deps.now()
  const localDate = (deps.localDate ?? defaultLocalDate)(capturedAt)
  const declaredDigest = (typeof input.digest === 'string' ? input.digest : '').trim() || null

  const registered = deps.materials.register({
    kind: 'import_text',
    origin: ORIGIN_OF[kind],
    sourceLabel: sourceLabelOf(kind, title),
    objectLabel: title,
    // 时间点而不是区间：两者都是"某一刻的快照"。区间留空，由覆盖说明解释。
    coveredFrom: capturedAt,
    coveredTo: capturedAt,
    content: text,
    // 默认不发送模型：用户同意的是"存本机当证据"，不是"发给模型服务商"。
    // 真正要用时由日报生成那一步按既有授权流程再问一次。
    modelVisible: false,
    localDate,
  }, deps.now())

  if (!registered.ok) return { ok: false, error: registered.message }

  return {
    ok: true,
    materialId: registered.material.id,
    duplicate: registered.duplicate,
    sourceKind: SOURCE_KIND_OF[kind],
    warning: describeIntakeMismatch(registered.material.digest, declaredDigest),
  }
}

/**
 * 桌面侧传来的 digest 与本地算出的不一致时，给用户一句能看懂的话。
 *
 * 为什么不做成拒收：纪要正文是用户确认过的那一份，内容本身有效；
 * 不一致通常意味着"传输中变了"（编码、截断）。拒收会让用户白点一次，
 * 收下并提示"和你看到的那一版可能不是同一份"更有用。
 *
 * `materialDigest` 是资料库按规范化正文算出的摘要；返回 null 表示一致或没传。
 */
export function describeIntakeMismatch(materialDigest: string, declaredDigest: string | null | undefined): string | null {
  const declared = (declaredDigest ?? '').trim()
  if (declared === '') return null
  if (declared === materialDigest) return null
  return '收到内容的摘要与桌面侧记下的不一致：可能是传输中被截断或编码变化，请核对后再引用'
}
