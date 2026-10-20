/**
 * 外部证据收件的跨进程类型（主进程 / preload / 渲染层共用）。
 *
 * 单独成文件而不是塞进主进程模块：渲染层要用同一份形状，而主进程模块会带进
 * node:fs 之类的依赖，渲染层包不该为了一个类型把它们拖进来。
 *
 * 与插件侧 `evidence-intake.ts` 的 `IntakeRequest` 是**同一条协议的两种表述**：
 * 那边校验、这边发送。改字段要两边一起改，测试会同时红。
 */

/** 目前允许收进来的两类证据。 */
export type EvidenceIntakeKind = 'meeting_minutes' | 'window_text'

export interface EvidenceIntakeRequest {
  kind: EvidenceIntakeKind
  /** 给人看的标题：会议名 / 窗口标题。 */
  title: string
  /** 正文。 */
  text: string
  /**
   * 内容的产生时刻（毫秒）。会议用纪要确认时刻，窗口用抓取时刻。
   * 必须给：缺了就只能用"收件时刻"，会让证据的时间点失真。
   */
  capturedAt: number
  /** 会议用纪要确认时的 digest，用来对账"收的是哪一版"。窗口不需要。 */
  digest?: string
}

export type EvidenceIntakeOutcome =
  | {
      ok: true
      /** 证据在插件资料库里的编号，工作事项用它作 ref。 */
      materialId: string
      /** 同一份内容之前已经收过，这次没有产生新证据。 */
      duplicate: boolean
      /** 收下了但要让用户知道的一句话（例如摘要对不上）。 */
      warning: string | null
    }
  | { ok: false; error: string }

/** 会议纪要转证据的输入：由主进程从会议库里取，渲染层只传会议 id。 */
export interface MinutesEvidenceInput {
  readonly meetingId: string
}
