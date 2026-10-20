/**
 * 桌面侧证据收件的编排测试。
 *
 * 重点不是"能不能发出去"，而是**确认之前一个请求都不能发**：
 * 用户点开对话框、看了内容、点了取消 —— 这件事不能留下任何痕迹。
 * 反过来，"用户同意了但没发出去"要如实报错，不能悄悄成功。
 *
 * 另一条边界：未确认的纪要连确认框都不该弹（`exportMinutes` 拒了就直接返回）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  intakeMinutes,
  intakeWindow,
  previewOf,
  sizeTextOf,
  type EvidenceConfirmView,
  type EvidenceIntakeDeps,
} from '../src/main/evidence-intake.ts'
import type { EvidenceIntakeOutcome, EvidenceIntakeRequest } from '../src/evidence-types.ts'

const MINUTES = `# 会议纪要：产品评审会

## 决议
退款校验改为按订单金额，本周内上线。
`

function harness(over: Partial<EvidenceIntakeDeps> = {}) {
  const posted: EvidenceIntakeRequest[] = []
  const confirms: EvidenceConfirmView[] = []
  let agree = true
  const deps: EvidenceIntakeDeps = {
    confirm: async view => { confirms.push(view); return agree },
    post: async (request): Promise<EvidenceIntakeOutcome> => {
      posted.push(request)
      return { ok: true, materialId: 'mat-1', duplicate: false, warning: null }
    },
    readWindowText: async () => ({ ok: true, text: 'select 1;\n-- 37 行', title: 'orders.sql - 查询工具' }),
    exportMinutes: async () => ({ ok: true, content: MINUTES, digest: 'd1', confirmedAt: 1_760_000_000_000 }),
    meetingName: async () => '产品评审会',
    now: () => 1_760_000_100_000,
    ...over,
  }
  return {
    deps,
    posted,
    confirms,
    disagree: () => { agree = false },
    agree: () => { agree = true },
  }
}

test('用户取消：一个请求都不发，并如实说"已取消"', async t => {
  const h = harness()
  h.disagree()
  const result = await intakeMinutes('mtg-1', h.deps)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /取消/)
  assert.equal(h.posted.length, 0, '取消之后绝不能有任何请求')
  assert.equal(h.confirms.length, 1, '取消之前要给用户看一次内容')
  void t
})

test('确认框里给的是正文原文预览，不是"窗口标题 + 字数"', async t => {
  const h = harness()
  h.disagree()
  await intakeMinutes('mtg-1', h.deps)
  const view = h.confirms[0]
  assert.equal(view.kind, 'meeting_minutes')
  assert.equal(view.title, '产品评审会')
  assert.match(view.preview, /退款校验改为按订单金额/, '预览必须是真实内容，否则用户是盲签')
  assert.match(view.sizeText, /字、\d+ 行/)
  assert.match(view.destination, /只存本机/)
  void t
})

test('同意后按协议上报：会议用确认时刻与 digest，窗口用抓取时刻', async t => {
  const h = harness()
  const minutes = await intakeMinutes('mtg-1', h.deps)
  assert.equal(minutes.ok, true)
  assert.deepEqual(h.posted[0], {
    kind: 'meeting_minutes',
    title: '产品评审会',
    text: MINUTES,
    capturedAt: 1_760_000_000_000,
    digest: 'd1',
  })

  const window = await intakeWindow(h.deps)
  assert.equal(window.ok, true)
  assert.deepEqual(h.posted[1], {
    kind: 'window_text',
    title: 'orders.sql - 查询工具',
    text: 'select 1;\n-- 37 行',
    capturedAt: 1_760_000_100_000,
  })
  void t
})

test('未确认的纪要：连确认框都不弹，直接把库给的原因带出来', async t => {
  const h = harness({
    exportMinutes: async () => ({ ok: false, error: '纪要还没确认，不能导出为定稿' }),
  })
  const result = await intakeMinutes('mtg-1', h.deps)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /还没确认/)
  assert.equal(h.confirms.length, 0, '导不出就不该打扰用户')
  assert.equal(h.posted.length, 0)
  void t
})

test('读不到窗口文字：不弹确认框，把具体原因原样带出', async t => {
  const h = harness({
    readWindowText: async () => ({
      ok: false,
      error: '这个窗口没有通过 UI Automation 暴露正文文字（可能是自绘界面或未开启辅助功能）',
    }),
  })
  const result = await intakeWindow(h.deps)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /UI Automation/)
  assert.equal(h.confirms.length, 0, '读不到就没有可确认的内容')
  assert.equal(h.posted.length, 0)
  void t
})

test('读到空正文：不提交空证据', async t => {
  const h = harness({ readWindowText: async () => ({ ok: true, text: '   \n  ', title: '空白窗口' }) })
  const result = await intakeWindow(h.deps)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /没有读到文字/)
  assert.equal(h.posted.length, 0)
  void t
})

test('上报失败要把插件的原话带回来，不能悄悄成功', async t => {
  const h = harness({
    post: async () => ({ ok: false, error: '正文 600KB 超过 512KB 上限，请分段记录' }),
  })
  const result = await intakeWindow(h.deps)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /上限/)
  void t
})

test('摘要对不上时把警告传下去（收下了，但要告诉用户）', async t => {
  const h = harness({
    post: async () => ({ ok: true, materialId: 'mat-2', duplicate: true, warning: '收到内容的摘要与桌面侧记下的不一致' }),
  })
  const result = await intakeMinutes('mtg-1', h.deps)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.duplicate, true)
    assert.match(result.warning ?? '', /不一致/)
  }
  void t
})

test('预览与规模说明：长文截断、换行归一', () => {
  assert.equal(previewOf('a\r\nb'), 'a\nb')
  const long = previewOf('x'.repeat(500))
  assert.equal(long.endsWith('…'), true)
  assert.equal(long.length, 201)
  assert.equal(sizeTextOf('a\nb\nc'), '5 字、3 行')
})
