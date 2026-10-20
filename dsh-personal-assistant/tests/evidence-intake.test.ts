/**
 * 外部证据收件（M3-03 / M4-06 后续）：真实 SQLite、真实资料库、真实工具与桥接 HTTP。
 *
 * 这一组测试要钉住的是**证据强度的边界**，不是"能不能存下来"：
 * - 用户确认过的会议纪要 → 可支撑 direct，可以写讨论主题；
 * - 用户主动记录的窗口文本 → 只能 inferred，不能写讨论主题。
 *
 * 这个区别一旦松掉，日报里就会出现"看了一下午报价单"被写成"完成了报价单"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intakeEvidence, MAX_INTAKE_BYTES } from '../src/evidence-intake.ts'
import { planWorkItem } from '../src/work-items.ts'
import { workbenchFixture } from './support/workbench-fixture.ts'

const MINUTES = `# 会议纪要：产品评审会

- 时间：2026-10-18 14:00 — 15:10
- 录音来源：麦克风 + 系统回环声

## 摘要
评审了退款校验口径，决定按订单金额判断。

## 决议
退款校验改为按订单金额，本周内上线。
`

const WINDOW_TEXT = 'select * from orders where amount > 100;\n-- 结果 37 行'

/** 直接调收件函数：不需要 HTTP 就能覆盖校验与入库。 */
function intake(f: ReturnType<typeof workbenchFixture>, request: unknown) {
  return intakeEvidence(request, { materials: f.rt.materials, now: () => Date.now() })
}

test('收下已确认的会议纪要：进资料库、来源可追溯、默认不发送模型', async t => {
  const f = workbenchFixture(t)
  const result = intake(f, {
    kind: 'meeting_minutes',
    title: '产品评审会',
    text: MINUTES,
    capturedAt: new Date(2026, 9, 18, 15, 20).getTime(),
    digest: 'whatever',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sourceKind, 'meeting_minutes')
  assert.equal(result.duplicate, false)
  // 桌面侧传了 digest，但和本地算出的不一致 —— 要给出警告，而不是拒收。
  assert.match(result.warning ?? '', /不一致/)

  const material = f.rt.materials.get(result.materialId)!
  assert.equal(material.origin, 'meeting_minutes')
  assert.equal(material.kind, 'import_text')
  assert.equal(material.modelVisible, false, '用户同意的是"存本机当证据"，不是"发给模型"')
  assert.match(material.sourceLabel, /会议纪要/)
  assert.match(material.objectLabel ?? '', /产品评审会/)
  assert.match(material.coverage, /你确认过的会议纪要|用户确认过的会议纪要/)
  assert.match(material.coverage, /不代表会上说过的每一句话/)
})

test('同一份内容收两次：第二次是 duplicate，不产生第二条证据', async t => {
  const f = workbenchFixture(t)
  const first = intake(f, { kind: 'meeting_minutes', title: '产品评审会', text: MINUTES })
  const second = intake(f, { kind: 'meeting_minutes', title: '产品评审会（又一次）', text: MINUTES })
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(second.duplicate, true)
  assert.equal(second.materialId, first.materialId, '重复导入返回原来那条')
})

test('空正文、超大正文、缺标题、未知类型一律拒收，且原因具体', async t => {
  const f = workbenchFixture(t)
  const empty = intake(f, { kind: 'window_text', title: '某窗口', text: '   ' })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /没有读到文字|为空/)

  const huge = intake(f, { kind: 'window_text', title: '某窗口', text: 'x'.repeat(MAX_INTAKE_BYTES + 10) })
  assert.equal(huge.ok, false)
  if (!huge.ok) assert.match(huge.error, /上限/)

  const noTitle = intake(f, { kind: 'meeting_minutes', title: '  ', text: MINUTES })
  assert.equal(noTitle.ok, false)
  if (!noTitle.ok) assert.match(noTitle.error, /会议名/)

  const badKind = intake(f, { kind: 'chat_excerpt', title: 'x', text: 'y' })
  assert.equal(badKind.ok, false)
  if (!badKind.ok) assert.match(badKind.error, /不认识/)
})

test('会议纪要可支撑 direct 且能写讨论主题；窗口文本只能 inferred 且不能写讨论主题', async t => {
  const f = workbenchFixture(t)
  const minutes = intake(f, { kind: 'meeting_minutes', title: '产品评审会', text: MINUTES })
  const window = intake(f, { kind: 'window_text', title: 'orders.sql - 查询工具', text: WINDOW_TEXT })
  assert.equal(minutes.ok && window.ok, true)
  if (!minutes.ok || !window.ok) return

  const now = Date.now()
  const base = now - 3_600_000
  const range = { start: base, end: base + 1_800_000, summary: '评审退款校验口径' }

  // 会议纪要：直接证据 + 讨论主题都成立。
  const direct = f.rt.call('commit_events', {
    events: [{
      ...range,
      discussionTopic: '退款校验按订单金额',
      status: 'direct',
      sources: [{ kind: 'meeting_minutes', ref: minutes.materialId }],
    }],
  })
  const directResult = await direct
  assert.equal(directResult.committed, 1, JSON.stringify(directResult))

  // 窗口文本：同样的说法必须被拒成 direct。
  const windowDirect = await f.rt.call('commit_events', {
    events: [{ ...range, summary: '查了订单金额', status: 'direct', sources: [{ kind: 'window_text', ref: window.materialId }] }],
  })
  assert.equal(windowDirect.committed, 0, '窗口里显示过什么不证明做成了什么')
  assert.match(windowDirect.error, /直接证据/)

  // 降级成 inferred 才能提交。
  const windowInferred = await f.rt.call('commit_events', {
    events: [{ ...range, summary: '查了订单金额', status: 'inferred', sources: [{ kind: 'window_text', ref: window.materialId }] }],
  })
  assert.equal(windowInferred.committed, 1, JSON.stringify(windowInferred))

  // 窗口文本不能用来写"讨论了…"。
  const windowDiscussion = await f.rt.call('commit_events', {
    events: [{
      ...range, summary: '沟通了退款口径', discussionTopic: '退款口径',
      status: 'inferred', sources: [{ kind: 'window_text', ref: window.materialId }],
    }],
  })
  assert.equal(windowDiscussion.committed, 0)
  assert.match(windowDiscussion.error, /讨论|聊/)
})

test('来源被删除后不能再引用；类型张冠李戴会被拒', async t => {
  const f = workbenchFixture(t)
  const window = intake(f, { kind: 'window_text', title: 'orders.sql - 查询工具', text: WINDOW_TEXT })
  assert.equal(window.ok, true)
  if (!window.ok) return

  // 拿 window_text 的 id 当会议纪要引用：类型对不上，必须拒。
  const wrongKind = await f.rt.call('commit_events', {
    events: [{
      start: Date.now() - 1000, end: Date.now(), summary: '开会', status: 'inferred',
      sources: [{ kind: 'meeting_minutes', ref: window.materialId }],
    }],
  })
  assert.equal(wrongKind.committed, 0)
  assert.match(wrongKind.error, /不是会议纪要/)

  assert.ok(f.rt.materials.remove(window.materialId, '测试用删除', Date.now()))
  const deleted = await f.rt.call('commit_events', {
    events: [{
      start: Date.now() - 1000, end: Date.now(), summary: '查了订单', status: 'inferred',
      sources: [{ kind: 'window_text', ref: window.materialId }],
    }],
  })
  assert.equal(deleted.committed, 0)
  assert.match(deleted.error, /删除/)
})

test('planWorkItem 单独校验时也不给绕过强度限制的口子', async t => {
  const f = workbenchFixture(t)
  // 直接用内存解析器模拟"窗口文本"来源：用来确认强度判定只认 evidenceType。
  const resolver = () => ({
    evidenceType: 'window_text' as const, projectDir: null, readAt: null, digest: null, summary: '窗口记录', materialKind: 'window_text',
  })
  const attempted = planWorkItem({
    start: 1, end: 2, summary: '完成了报价单', status: 'direct',
    sources: [{ kind: 'window_text', ref: 'mat-x' }],
  }, resolver)
  assert.equal(attempted.ok, false)
  if (!attempted.ok) assert.match(attempted.message, /直接证据/)

  const asInferred = planWorkItem({
    start: 1, end: 2, summary: '看了报价单', status: 'inferred',
    sources: [{ kind: 'window_text', ref: 'mat-x' }],
  }, resolver)
  assert.equal(asInferred.ok, true)
  void f
})

test('HTTP 路由：鉴权、非法 JSON、未接证据库、成功入库四条路径', async t => {
  const { SessionBridge } = await import('../src/bridge.ts')
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const { mkdtempSync, rmSync } = await import('node:fs')

  const f = workbenchFixture(t)
  const dir = mkdtempSync(path.join(f.dir, 'bridge-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已清理 */ } })

  // 先起一个没接证据库的桥：必须 503，不能假装收下。
  const bare = new SessionBridge({ dshHome: dir })
  await bare.listen()
  const info = JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge.json'), 'utf8')) as { port: number; token: string }
  const post = (body: unknown, token = info.token) => fetch(`http://127.0.0.1:${info.port}/evidence/intake?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await post({ kind: 'window_text', title: 'x', text: 'y' }, 'wrong')).status, 401, '令牌不对不能收')
  const unboundIntake = await post({ kind: 'window_text', title: 'x', text: 'y' })
  assert.equal(unboundIntake.status, 503)
  assert.match(((await unboundIntake.json()) as { error: string }).error, /没有接上证据库/)
  await bare.dispose()

  // 再接一个真正接线好的桥。
  const bridge = new SessionBridge({
    dshHome: dir,
    evidenceIntake: request => intake(f, request),
  })
  await bridge.listen()
  const wired = JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge.json'), 'utf8')) as { port: number; token: string }
  const postWired = (body: string) => fetch(`http://127.0.0.1:${wired.port}/evidence/intake?token=${wired.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })

  const malformed = await postWired('{not json')
  assert.equal(malformed.status, 400)

  const accepted = await postWired(JSON.stringify({ kind: 'meeting_minutes', title: '产品评审会', text: MINUTES }))
  assert.equal(accepted.status, 200)
  const acceptedBody = await accepted.json() as { ok: boolean; materialId: string; sourceKind: string; duplicate: boolean }
  assert.equal(acceptedBody.ok, true)
  assert.equal(acceptedBody.sourceKind, 'meeting_minutes')
  assert.ok(f.rt.materials.get(acceptedBody.materialId), 'HTTP 收下的内容必须真的进了库')

  const rejected = await postWired(JSON.stringify({ kind: 'window_text', title: '', text: 'x' }))
  assert.equal(rejected.status, 400)
  await bridge.dispose()
})
