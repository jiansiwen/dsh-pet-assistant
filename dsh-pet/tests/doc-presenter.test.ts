/** 讲解展示状态机、锚点对齐、文字层拼接与播放回执旁路（M5-01 / M5-02）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Outline } from '../src/main/document.ts'
import {
  buildDocPlan,
  createPlaybackTap,
  describeAnchor,
  describeStatus,
  docUtteranceId,
  INITIAL_PRESENTER,
  joinTextRuns,
  nextPresenter,
  paragraphsOf,
  parseTtsEventId,
  sectionForPage,
  segmentAnchor,
  textDigest,
  type DocPlan,
  type PresenterEvent,
  type PresenterState,
  type PresenterTurn,
} from '../src/main/doc-presenter.ts'

const FP = '1234:abcdef'
const SESSION = 'session-1'

function pdfOutline(pages: readonly string[]): Outline {
  return {
    title: '合成',
    sections: pages.map((text, index) => ({ index, pageNumber: index + 1, heading: null, level: 1, text, hasCode: false })),
    charCount: pages.join('').length,
    estMinutes: 1,
    truncated: false,
  }
}

function planOf(pages: readonly string[], startSection = 0): DocPlan {
  const built = buildDocPlan({ sessionId: SESSION, fingerprint: FP, outline: pdfOutline(pages), startSection })
  assert.equal(built.kind, 'plan')
  assert.ok(built.kind === 'plan')
  return built.plan
}

const PAGES = [
  'Alpha opening line of page one.\n\nSecond paragraph on page one with unique words.',
  'Beta page two text body here.',
  'Gamma page three content.',
  'Delta page four content.',
  'Epsilon page five content.',
]

const utt = (section: number) => docUtteranceId(SESSION, FP, section)
const started = (section: number, segment: number): PresenterEvent => ({ type: 'receipt', receipt: { kind: 'started', utteranceId: utt(section), segment } })
const finished = (section: number, segment: number): PresenterEvent => ({ type: 'receipt', receipt: { kind: 'finished', utteranceId: utt(section), segment } })
const cancelled = (section: number, segment: number): PresenterEvent => ({ type: 'receipt', receipt: { kind: 'cancelled', utteranceId: utt(section), segment } })

/** 依次喂事件，收集全部输出。 */
function run(events: readonly PresenterEvent[], from: PresenterState = INITIAL_PRESENTER): { state: PresenterState; turns: PresenterTurn[] } {
  let state = from
  const turns: PresenterTurn[] = []
  for (const event of events) {
    const turn = nextPresenter(state, event)
    turns.push(turn)
    state = turn.state
  }
  return { state, turns }
}

const gotos = (turns: readonly PresenterTurn[]) => turns.flatMap(turn => turn.view.filter(command => command.type === 'goto'))
const hosts = (turns: readonly PresenterTurn[]) => turns.flatMap(turn => turn.host)

test('计划：PDF 提纲一段对齐一个物理页；页码不连续或非 PDF 提纲拒绝建计划', () => {
  const plan = planOf(['one', '', 'three'], 2)
  assert.deepEqual(plan.sections.map(section => section.page), [1, 2, 3])
  assert.equal(plan.pageCount, 3)
  assert.equal(plan.startSection, 2)
  assert.equal(plan.sections[1].textDigest, null)
  assert.equal(plan.sections[1].anchor.fallback, 'no-text-layer')
  assert.equal(plan.sections[0].anchor.precision, 'page')

  const markdown: Outline = { ...pdfOutline(['x']), sections: [{ index: 0, heading: 'h', level: 1, text: 'x', hasCode: false }] }
  assert.equal(buildDocPlan({ sessionId: SESSION, fingerprint: FP, outline: markdown }).kind, 'not-pdf')
  const gap: Outline = { ...pdfOutline(['a', 'b']), sections: [
    { index: 0, pageNumber: 1, heading: null, level: 1, text: 'a', hasCode: false },
    { index: 1, pageNumber: 3, heading: null, level: 1, text: 'b', hasCode: false },
  ] }
  assert.equal(buildDocPlan({ sessionId: SESSION, fingerprint: FP, outline: gap }).kind, 'not-pdf')

  // 扫描件：没有文字层，计划为空，只能看页。
  const scanned = buildDocPlan({ sessionId: SESSION, fingerprint: FP, outline: null })
  assert.ok(scanned.kind === 'plan')
  assert.equal(scanned.plan.textLayer, false)
  assert.equal(scanned.plan.pageCount, null)
  assert.equal(sectionForPage(scanned.plan, 1), null)
  // 起点越界回到 0，不夹到最后一页冒充。
  assert.equal(planOf(['a', 'b'], 9).startSection, 0)
})

test('锚点：原文摘录逐字唯一匹配才给文字区间与自然段；解释句、对不上、重复与无文字层退回页级', () => {
  const plan = planOf(PAGES)
  const page1 = plan.sections[0]
  assert.deepEqual(paragraphsOf(page1.text).length, 2)

  const quoted = segmentAnchor(page1, '【原文】“Second paragraph on page one”。')
  assert.equal(quoted.precision, 'text')
  assert.equal(quoted.paragraph, 1)
  assert.equal(page1.text.slice(quoted.textStart, quoted.textEnd), 'Second paragraph on page one')

  // 空白差异（换行被讲成空格）不影响逐字比对，区间仍映射回原文偏移。
  const spaced = segmentAnchor(planOf(['Line one\ncontinues here'])
    .sections[0], 'Line one continues')
  assert.equal(spaced.precision, 'text')
  assert.equal(spaced.textStart, 0)

  assert.deepEqual(segmentAnchor(page1, '【解释】这一页讲的是开场。'), { ...page1.anchor, fallback: 'section' })
  assert.equal(segmentAnchor(page1, '这一页大意是开场白，作者想表达很多东西。').fallback, 'section')
  assert.equal(segmentAnchor(page1, '【原文】完全不存在于本页的一句话哦哦哦。').fallback, 'no-match')
  assert.equal(segmentAnchor(page1, '【原文】').fallback, 'section')
  assert.equal(segmentAnchor(page1, 'page one').precision, 'page', '短于下限的片段不定位')
  assert.equal(segmentAnchor(planOf(['repeat words repeat words'])
    .sections[0], '【原文】repeat words').fallback, 'ambiguous')
  assert.equal(segmentAnchor(planOf(['']).sections[0], '【原文】anything at all here').fallback, 'no-text-layer')

  // 措辞不宣称逐字。
  assert.match(describeAnchor(quoted), /片段级，非逐字/)
  assert.doesNotMatch(describeAnchor(quoted), /逐字高亮/)
  assert.match(describeAnchor(page1.anchor), /页级/)
})

test('文字层拼接：大纵向间距产生自然段空行；区间映射到 trim 之后的文字', () => {
  const run = (str: string, x: number, y: number, width = 40, hasEOL = false) => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, hasEOL })
  const joined = joinTextRuns([
    run('  Head', 50, 750),
    run('line', 50, 730),          // 20 / 12 < 1.9：同段换行
    run('next', 50, 690),          // 40 / 12 > 1.9：新自然段
    run('', 0, 0, 0, true),
    run('word', 92, 690),          // 前项 hasEOL=false 但空项带 EOL：换行
  ])
  assert.equal(joined.text, 'Head\nline\n\nnext\nword')
  assert.deepEqual(joined.spans[0], { start: 0, end: 4 })
  assert.equal(joined.spans[3], null)
  assert.equal(joined.text.slice(joined.spans[2]!.start, joined.spans[2]!.end), 'next')
  assert.equal(textDigest('abc'), textDigest('abc'))
  assert.notEqual(textDigest('abc'), textDigest('abd'))
})

test('回执旁路：事件先交给 Narrator 再抄送；订阅者抛错不影响播放；id 解析严格', () => {
  assert.deepEqual(parseTtsEventId(`${utt(2)}#3`), { utteranceId: utt(2), segment: 3 })
  assert.equal(parseTtsEventId('no-hash'), null)
  assert.equal(parseTtsEventId('x#-1'), null)
  assert.equal(parseTtsEventId('x#1.5'), null)

  const tap = createPlaybackTap<unknown>()
  const order: string[] = []
  let deliver: ((event: unknown) => void) | null = null
  const open = tap.wrap((sink: (event: unknown) => void) => { deliver = sink; return { write() {}, close() {} } })
  open((event) => order.push(`narrator:${JSON.stringify(event)}`))
  tap.subscribe(() => { throw new Error('视图坏了') })
  const off = tap.subscribe((receipt) => order.push(`receipt:${receipt.kind}:${receipt.segment}`))
  deliver!({ started: { id: `${utt(0)}#0` } })
  deliver!({ ready: true })
  deliver!({ finished: { id: `${utt(0)}#0` } })
  off()
  deliver!({ started: { id: `${utt(0)}#1` } })
  assert.deepEqual(order, [
    `narrator:{"started":{"id":"${utt(0)}#0"}}`,
    'receipt:started:0',
    'narrator:{"ready":true}',
    `narrator:{"finished":{"id":"${utt(0)}#0"}}`,
    'receipt:finished:0',
    `narrator:{"started":{"id":"${utt(0)}#1"}}`,
  ])
})

test('快生成慢播放：讲解全部生成完也不翻页，只有 started 回执推进；finished 不预跳下一段', () => {
  const plan = planOf(PAGES)
  const { state, turns } = run([
    { type: 'plan', plan },
    // 模型一口气把五段都讲完了。
    ...PAGES.map((_, section): PresenterEvent => ({ type: 'explanation', section, segments: ['讲解一句。', '讲解两句。'] })),
  ])
  // 只有开讲前的起点定位，且不高亮。
  assert.deepEqual(gotos(turns), [{ type: 'goto', anchor: plan.sections[0].anchor, highlight: false }])
  assert.equal(state.position, null)
  assert.ok(turns.slice(1).every(turn => turn.view.length === 0), '生成事件不产生任何视图指令')

  const after = run([started(0, 0), finished(0, 0), started(0, 1), finished(0, 1)], state)
  assert.deepEqual(gotos(after.turns).map(command => command.type === 'goto' && command.anchor.page), [1, 1])
  assert.equal(after.state.viewPage, 1)
  // 第 0 段最后一句播完：仍停在第 1 页，等第 1 段真的开始播。
  assert.equal(after.state.positionStatus, 'finished')
  const next = run([started(1, 0)], after.state)
  assert.deepEqual(gotos(next.turns).map(command => command.type === 'goto' && command.anchor.page), [2])
  assert.equal(next.state.viewPage, 2)
})

test('暂停不滚动、继续不跳段；暂停期间与暂停赛跑的回执只记位置不翻页', () => {
  const plan = planOf(PAGES)
  const base = run([{ type: 'plan', plan }, started(0, 0), finished(0, 0)]).state
  const paused = run([{ type: 'pause' }, started(1, 0)], base)
  assert.equal(gotos(paused.turns).length, 0, '暂停后不再滚动')
  assert.equal(paused.state.viewPage, 1)
  assert.deepEqual(paused.state.position, { section: 1, segment: 0 })

  // 继续：回到最后被确认的位置（第 2 页），不往前猜第 3 页。
  const resumed = run([{ type: 'resume' }], paused.state)
  assert.deepEqual(gotos(resumed.turns).map(command => command.type === 'goto' && command.anchor.page), [2])

  // 没有赛跑回执时，继续不产生跳页。
  const quiet = run([{ type: 'pause' }, { type: 'resume' }], base)
  assert.equal(gotos(quiet.turns).length, 0)
  assert.equal(quiet.state.viewPage, 1)
  assert.equal(run([{ type: 'resume' }], base).turns[0].dropped, 'duplicate')
  const status = run([{ type: 'pause' }], base).turns[0].view.at(-1)
  assert.ok(status?.type === 'status')
  assert.match(describeStatus(status.status), /暂停，页面停在原处/)
})

function never(): never { throw new Error('unreachable') }

test('用户手动翻页即脱离：之后回执不再自动翻页；给出两个选项；回到讲解位置由主进程触发', () => {
  const plan = planOf(PAGES)
  const base = run([{ type: 'plan', plan }, started(0, 0)]).state
  const flipped = run([{ type: 'user-page', page: 4 }], base)
  assert.equal(flipped.state.mode, 'detached')
  assert.deepEqual(hosts(flipped.turns), [{
    type: 'detached', page: 4, narration: base.anchor, fromHereSection: 3, options: ['return', 'from-here'],
  }])
  const later = run([finished(0, 0), started(1, 0), { type: 'user-page', page: 5 }], flipped.state)
  assert.equal(gotos(later.turns).length, 0, '脱离后不自动跳页')
  assert.equal(hosts(later.turns).length, 0, '已脱离时继续翻页不重复征求意见')
  assert.equal(later.state.viewPage, 5)
  assert.deepEqual(later.state.position, { section: 1, segment: 0 })

  const back = run([{ type: 'reattach' }], later.state)
  assert.equal(back.state.mode, 'following')
  assert.deepEqual(gotos(back.turns).map(command => command.type === 'goto' && command.anchor.page), [2])
  assert.equal(run([{ type: 'reattach' }], back.state).turns[0].dropped, 'inactive')
  // 翻到当前页本身不算脱离。
  assert.equal(run([{ type: 'user-page', page: 1 }], base).turns[0].dropped, 'duplicate')
  assert.equal(run([{ type: 'user-page', page: 99 }], base).turns[0].dropped, 'invalid')
})

test('文件变化 / 授权撤销 / 关闭窗口：停止推进并告诉主进程；关窗要求确认；停止后回执全部丢弃', () => {
  const plan = planOf(PAGES)
  const base = run([{ type: 'plan', plan }, started(0, 0)]).state
  for (const [event, reason, needsConfirm] of [
    [{ type: 'file-changed' }, 'file-changed', false],
    [{ type: 'unauthorized' }, 'unauthorized', false],
    [{ type: 'view-closed' }, 'view-closed', true],
    [{ type: 'view-error' }, 'error', false],
  ] as const) {
    const out = run([event, started(1, 0)], base)
    assert.equal(out.state.mode, 'stopped')
    assert.equal(out.state.stopReason, reason)
    assert.deepEqual(hosts(out.turns), [{ type: 'stopped', reason, needsConfirm }])
    assert.equal(out.turns[1].dropped, 'inactive')
    assert.equal(gotos(out.turns).length, 0)
  }
  // 主进程自己叫停不回声。
  const stopped = run([{ type: 'stop', reason: 'user' }, { type: 'view-closed' }], base)
  assert.equal(hosts(stopped.turns).length, 0)
  assert.equal(stopped.turns[1].dropped, 'duplicate')
})

test('迟到回执、旧 utteranceId、别的会话被丢弃；重复回执幂等；掐断后同句可重播', () => {
  const plan = planOf(PAGES)
  const base = run([{ type: 'plan', plan }, started(0, 0), finished(0, 0), started(1, 0)]).state
  const replay = (event: PresenterEvent) => run([event], base).turns[0]

  assert.equal(replay(started(0, 1)).dropped, 'stale', '迟到的旧句 started')
  assert.equal(replay(finished(0, 0)).dropped, 'stale', '迟到的旧句 finished')
  assert.equal(replay(started(1, 0)).dropped, 'duplicate', '重复 started')
  assert.equal(replay(finished(1, 1)).dropped, 'out-of-order', '没开始就结束')
  const old = docUtteranceId(SESSION, '999:oldprint', 2)
  assert.equal(replay({ type: 'receipt', receipt: { kind: 'started', utteranceId: old, segment: 0 } }).dropped, 'foreign', '改版前指纹')
  assert.equal(replay({ type: 'receipt', receipt: { kind: 'started', utteranceId: docUtteranceId('other', FP, 2), segment: 0 } }).dropped, 'foreign')
  assert.equal(replay({ type: 'receipt', receipt: { kind: 'started', utteranceId: `doc-outline:${FP}`, segment: 0 } }).dropped, 'foreign', '开场白')
  assert.equal(replay({ type: 'receipt', receipt: { kind: 'started', utteranceId: utt(77), segment: 0 } }).dropped, 'foreign', '越界段')

  const done = run([finished(1, 0), finished(1, 0)], base)
  assert.equal(done.turns[1].dropped, 'duplicate', '重复 finished 幂等')
  assert.equal(run([started(1, 0)], done.state).turns[0].dropped, 'duplicate', '播完的句子不再被重新开始')

  // 打断后续讲：同一句被掐断，再次开始是合法的重播。
  const cut = run([cancelled(1, 0), started(1, 0)], base)
  assert.equal(cut.turns[1].dropped, undefined)
  assert.equal(cut.state.positionStatus, 'playing')
  assert.equal(run([started(0, 0)], INITIAL_PRESENTER).turns[0].dropped, 'inactive')
})

test('细化锚点：讲解句与原文逐字对上时高亮文字区间，句子尚未生成时只到页', () => {
  const plan = planOf(PAGES)
  const out = run([
    { type: 'plan', plan },
    { type: 'explanation', section: 0, segments: ['【原文】Second paragraph on page one with unique words.', '【解释】这是说明。'] },
    started(0, 0),
    finished(0, 0),
    started(0, 1),
    started(1, 0),
  ])
  const anchors = gotos(out.turns).slice(1).map(command => command.type === 'goto' ? command.anchor : never())
  assert.equal(anchors[0].precision, 'text')
  assert.equal(anchors[0].paragraph, 1)
  assert.equal(anchors[1].precision, 'page')
  assert.equal(anchors[1].fallback, 'section')
  assert.equal(anchors[2].precision, 'page', '没有讲解文本的段只到页')
  assert.equal(anchors[2].page, 2)
})

test('扫描件计划：状态如实说明只能按页看，不暗示会开讲', () => {
  const built = buildDocPlan({ sessionId: SESSION, fingerprint: FP, outline: null })
  assert.ok(built.kind === 'plan')
  const turn = nextPresenter(INITIAL_PRESENTER, { type: 'plan', plan: built.plan })
  const status = turn.view.at(-1)
  assert.ok(status?.type === 'status')
  assert.match(describeStatus(status.status), /仅供按页查看/)
  assert.doesNotMatch(describeStatus(status.status), /等待播放/)
  assert.equal(gotos([turn]).length, 0)
})
