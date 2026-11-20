/**
 * 讲话队列的测试：分句、播放游标、四层打断。
 *
 * 钉住的是计划 §2.8 里三条会出错就要命的规则 —— 打断要分层（停讲解不等于撤后台任务）、
 * 播放位置要能被续讲接上、以及**打断之后交给模型的上下文只能是用户实际听到的内容**。
 * 最后这条一旦错了，模型会以为结论已经送达而接着往下讲，用户听到的却是半句话加一段沉默。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  INITIAL_SPEECH_STATE,
  MAX_SEGMENT_CHARS,
  cleanForSpeech,
  describeSpoken,
  nextSpeech,
  pendingDispatch,
  resumeIndex,
  splitIntoSegments,
  type SpeechRequest,
  type SpeechState,
} from '../src/main/speech.ts'

const request = (text: string, utteranceId = 'u1', origin?: { docPath: string; paragraph: number }): SpeechRequest =>
  origin ? { utteranceId, text, origin } : { utteranceId, text }

/** 连着跑一串事件，返回最后的状态。 */
function run(state: SpeechState, ...events: Parameters<typeof nextSpeech>[1][]): SpeechState {
  return events.reduce((acc, event) => nextSpeech(acc, event).state, state)
}

/** enqueue 一句 → 逐句 dispatched/spoken 播完。 */
function speakAll(state: SpeechState, text: string, utteranceId = 'u1'): SpeechState {
  let next = nextSpeech(state, { type: 'enqueue', request: request(text, utteranceId) }).state
  while (pendingDispatch(next) !== null) {
    next = run(next, { type: 'dispatched' }, { type: 'spoken' })
  }
  return next
}

describe('分句', () => {
  test('按中文句末标点切，标点留在句尾', () => {
    // 标点得留着：合成器靠它决定停顿，去掉之后念出来是一口气不断的那种腔调。
    const segments = splitIntoSegments(request('今天做了三件事。第一件是修麦克风。第二件还没做完'))
    assert.deepEqual(segments.map((s) => s.text), ['今天做了三件事。', '第一件是修麦克风。', '第二件还没做完'])
  })

  test('序号从 0 递增，utteranceId 与文档定位原样透传', () => {
    const segments = splitIntoSegments(request('第一段。第二段。', 'u7', { docPath: 'D:/a.pdf', paragraph: 3 }))
    assert.deepEqual(segments.map((s) => s.index), [0, 1])
    for (const segment of segments) {
      assert.equal(segment.utteranceId, 'u7')
      assert.deepEqual(segment.origin, { docPath: 'D:/a.pdf', paragraph: 3 })
    }
  })

  test('没有文档定位时不凭空造一个 origin 字段', () => {
    const [segment] = splitIntoSegments(request('闲聊一句。'))
    assert.equal('origin' in segment, false, '续讲要靠 origin 判断有没有文档，undefined 和缺字段不该混')
  })

  test('空文本、纯空白、纯标点都切不出句子', () => {
    assert.deepEqual(splitIntoSegments(request('')), [])
    assert.deepEqual(splitIntoSegments(request('   \n  ')), [])
    assert.deepEqual(splitIntoSegments(request('。。')), [])
  })

  test('没有句末标点的长句按上限硬切，不然打断粒度就是一整段', () => {
    const segments = splitIntoSegments(request('字'.repeat(MAX_SEGMENT_CHARS * 2 + 30)))
    assert.deepEqual(segments.map((s) => s.text.length), [MAX_SEGMENT_CHARS, MAX_SEGMENT_CHARS, 30])
  })

  test('硬切优先退到最近的逗号上，不从短语中间劈开', () => {
    const text = '字'.repeat(55) + '，' + '字'.repeat(20)
    const segments = splitIntoSegments(request(text))
    assert.equal(segments[0].text.length, 56, '应当切在逗号之后而不是硬切到 60')
    assert.ok(segments[0].text.endsWith('，'))
    assert.equal(segments.map((s) => s.text).join(''), text, '切完拼回去必须一字不差')
  })

  test('逗号落在哪儿都一样：切完拼回去一字不差', () => {
    // 退到逗号上切的时候，逗号之后那截必须继续攒进下一句。这里曾经把它清空过，字就没了 ——
    // 而上面那条固定用例只试了一个逗号位置，别的落点上同样吞字它也发现不了。
    let seed = 0x2f6e2b1
    const rnd = (bound: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed) % bound
    }
    for (let round = 0; round < 200; round++) {
      // 逗号不连续、首尾都是实字：这样每个片段都至少含一个字，不会有片段被"纯标点"规则丢掉，
      // 拼回去才应当严格等于原文。
      let text = '字'
      for (let i = 1; i < 40 + rnd(300); i++) {
        text += rnd(7) === 0 && !text.endsWith('，') ? '，' : '字'
      }
      const segments = splitIntoSegments(request(text, `u${round}`))
      assert.equal(
        segments.map((s) => s.text).join(''),
        text,
        `第 ${round} 轮丢字了`,
      )
      for (const segment of segments) {
        assert.ok(segment.text.length <= MAX_SEGMENT_CHARS, `第 ${round} 轮切超了上限`)
      }
    }
  })

  test('小数点不是句末标点，数字不会被切开', () => {
    const segments = splitIntoSegments(request('占用率是 3.14 和 5.67。'))
    assert.equal(segments.length, 1)
    assert.equal(segments[0].text, '占用率是 3.14 和 5.67。')
  })
})

describe('一次只交给合成器一句', () => {
  test('空闲且有队列时给出队首', () => {
    const state = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('第一句。第二句。') }).state
    assert.equal(pendingDispatch(state)?.text, '第一句。')
  })

  test('正在出声时给出 null：塞第二句合成器会拒，拒了这句就丢了', () => {
    let state = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('第一句。第二句。') }).state
    state = nextSpeech(state, { type: 'dispatched' }).state
    assert.equal(state.playing?.text, '第一句。')
    assert.equal(pendingDispatch(state), null)
    assert.equal(state.queue.length, 1, '第二句还在队列里等着，没有丢')
  })

  test('队列空了给出 null', () => {
    assert.equal(pendingDispatch(INITIAL_SPEECH_STATE), null)
  })

  test('dispatched 与 spoken 重复到达都不动状态', () => {
    // 合成进程的超时和正常结束可能各报一次，重复收尾要是把下一句也吞了就查不出来。
    const queued = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('只有一句。') }).state
    const dispatched = nextSpeech(queued, { type: 'dispatched' }).state
    assert.deepEqual(nextSpeech(dispatched, { type: 'dispatched' }).state, dispatched)
    const spoken = nextSpeech(dispatched, { type: 'spoken' }).state
    assert.deepEqual(nextSpeech(spoken, { type: 'spoken' }).state, spoken)
    assert.equal(spoken.spoken.length, 1)
  })
})

describe('播出记录', () => {
  test('完整播出记 complete=true', () => {
    const state = speakAll(INITIAL_SPEECH_STATE, '说完了。')
    assert.equal(state.spoken.length, 1)
    assert.equal(state.spoken[0].complete, true)
    assert.equal(state.spoken[0].segment.text, '说完了。')
  })

  test('合成器报 cancelled 时记 complete=false', () => {
    const dispatched = nextSpeech(
      nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('说到一半。') }).state,
      { type: 'dispatched' },
    ).state
    const cut = nextSpeech(dispatched, { type: 'cut' }).state
    assert.equal(cut.spoken.length, 1)
    assert.equal(cut.spoken[0].complete, false, '半句不能算说过')
    assert.equal(cut.playing, null)
  })

  test('没有正在播的句子时 cut 是空操作', () => {
    assert.deepEqual(nextSpeech(INITIAL_SPEECH_STATE, { type: 'cut' }).state, INITIAL_SPEECH_STATE)
  })
})

describe('打断分四层，逐层升级', () => {
  /** 三句话，第一句已经播完，第二句正在出声。 */
  const midSpeech = (): SpeechState => {
    const queued = nextSpeech(INITIAL_SPEECH_STATE, {
      type: 'enqueue',
      request: request('第一句。第二句。第三句。'),
    }).state
    const afterFirst = run(queued, { type: 'dispatched' }, { type: 'spoken' })
    return nextSpeech(afterFirst, { type: 'dispatched' }).state
  }

  test('第一层只掐当前这句，队列留着', () => {
    const turn = nextSpeech(midSpeech(), { type: 'interrupt', level: 'stop-playback' })
    assert.deepEqual(turn.effects, ['stop-audio'])
    assert.equal(turn.state.playing, null)
    assert.equal(turn.state.queue.length, 1, '第三句还在，用户只说了"停一下这句"')
    assert.equal(turn.state.spoken.at(-1)?.complete, false)
  })

  test('第二层连没播的也丢掉', () => {
    const turn = nextSpeech(midSpeech(), { type: 'interrupt', level: 'drop-queue' })
    assert.deepEqual(turn.effects, ['stop-audio'])
    assert.deepEqual(turn.state.queue, [])
    assert.equal(pendingDispatch(turn.state), null, '丢了就不该马上又开播')
  })

  test('第三层再取消正在生成的回答', () => {
    const generating = nextSpeech(midSpeech(), { type: 'generation-started' }).state
    const turn = nextSpeech(generating, { type: 'interrupt', level: 'cancel-generation' })
    assert.deepEqual(turn.effects, ['stop-audio', 'cancel-generation'])
    assert.equal(turn.state.generating, false)
    assert.deepEqual(turn.state.queue, [], '第三层包含第二层')
  })

  test('第四层才申请取消实际任务', () => {
    // "停止讲解"不该顺手把用户后台跑着的编译撤掉，只有"全部停下"才走到这一层。
    const generating = nextSpeech(midSpeech(), { type: 'generation-started' }).state
    const turn = nextSpeech(generating, { type: 'interrupt', level: 'cancel-task' })
    assert.deepEqual(turn.effects, ['stop-audio', 'cancel-generation', 'request-task-cancel'])
    assert.equal(turn.state.taskCancelRequested, true)
  })

  test('取消任务只申请一次：反复申请只会让用户被同一个确认框问好几遍', () => {
    const once = nextSpeech(midSpeech(), { type: 'interrupt', level: 'cancel-task' }).state
    const twice = nextSpeech(once, { type: 'interrupt', level: 'cancel-task' })
    assert.deepEqual(twice.effects, [], '已经没在播、队列已空、任务也已申请过')
    assert.equal(twice.state.taskCancelRequested, true)
  })

  test('空闲时按最高层打断：只申请取消任务，不去停没有的声音', () => {
    const turn = nextSpeech(INITIAL_SPEECH_STATE, { type: 'interrupt', level: 'cancel-task' })
    assert.deepEqual(turn.effects, ['request-task-cancel'], '没有声音要停，也没有回答在生成')
    assert.deepEqual(turn.state.queue, [])
  })

  test('没有回答在生成时，第三层不去取消空气', () => {
    const queued = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('一句。') }).state
    const turn = nextSpeech(queued, { type: 'interrupt', level: 'cancel-generation' })
    assert.deepEqual(turn.effects, [])
    assert.deepEqual(turn.state.queue, [], '队列照样要清空')
    assert.equal(turn.state.generating, false)
  })

  test('被打断的半句进播出记录，被丢掉的队列内容不进', () => {
    const turn = nextSpeech(midSpeech(), { type: 'interrupt', level: 'drop-queue' })
    const described = describeSpoken(turn.state)
    assert.ok(described.includes('第一句。'), '完整播过的要在')
    assert.ok(described.includes('第二句。'), '半句也要在，但要标明是半句')
    assert.ok(!described.includes('第三句。'), '从没播出过的一句绝不能算说过')
  })
})

describe('交给模型的"用户实际听到了什么"', () => {
  test('一个字都没播时明说，别让模型猜', () => {
    assert.equal(describeSpoken(INITIAL_SPEECH_STATE), '（还没有播出任何内容）')
  })

  test('全部完整播出时就是原文', () => {
    const state = speakAll(INITIAL_SPEECH_STATE, '第一句。第二句。')
    assert.equal(describeSpoken(state), '已完整播出：第一句。第二句。')
  })

  test('半句要单独标明，不能混进"已完整播出"里', () => {
    const queued = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('说完了。没说完。') }).state
    const first = run(queued, { type: 'dispatched' }, { type: 'spoken' })
    const second = nextSpeech(first, { type: 'dispatched' }).state
    const cut = nextSpeech(second, { type: 'cut' }).state
    const described = describeSpoken(cut)
    assert.ok(described.includes('已完整播出：说完了。'))
    assert.ok(described.includes('只播出一半就被打断：没说完。'))
    assert.ok(!described.includes('已完整播出：说完了。没说完。'), '半句混进完整播出就等于骗模型')
  })
})

describe('续讲接得上播放位置', () => {
  test('没有播出记录就从头讲', () => {
    assert.equal(resumeIndex(INITIAL_SPEECH_STATE, 'u1'), 0)
  })

  test('完整播完两句就从第三句接着讲', () => {
    const state = speakAll(INITIAL_SPEECH_STATE, '第一句。第二句。第三句。')
    assert.equal(state.spoken.length, 3)
    assert.equal(resumeIndex(state, 'u1'), 3, '整份都讲完了，续讲没有剩下的句子')
  })

  test('播到一半的那句要重讲，不能跳过', () => {
    const queued = nextSpeech(INITIAL_SPEECH_STATE, { type: 'enqueue', request: request('第一句。第二句。第三句。') }).state
    const afterFirst = run(queued, { type: 'dispatched' }, { type: 'spoken' })
    const cut = run(afterFirst, { type: 'dispatched' }, { type: 'cut' })
    assert.equal(resumeIndex(cut, 'u1'), 1, '第二句只播了一半，续讲要从它重来')
  })

  test('别的讲话的记录不干扰这一份的定位', () => {
    const withOther = speakAll(INITIAL_SPEECH_STATE, '别的文档第一段。别的文档第二段。', 'other')
    const queued = nextSpeech(withOther, { type: 'enqueue', request: request('这一份第一句。', 'u1') }).state
    const played = run(queued, { type: 'dispatched' }, { type: 'spoken' })
    assert.equal(resumeIndex(played, 'u1'), 1)
    assert.equal(resumeIndex(played, 'other'), 2)
  })

  test('文档定位跟着句子走，续讲时知道回到哪一段', () => {
    const state = nextSpeech(INITIAL_SPEECH_STATE, {
      type: 'enqueue',
      request: request('第三段的第一句。', 'u9', { docPath: 'D:/doc/设计说明.pdf', paragraph: 3 }),
    }).state
    const dispatched = nextSpeech(state, { type: 'dispatched' }).state
    assert.deepEqual(dispatched.playing?.origin, { docPath: 'D:/doc/设计说明.pdf', paragraph: 3 })
  })
})

describe('朗读清洗', () => {
  test('UUID 编号不进入声音，回复里的正文保留', () => {
    const cleaned = cleanForSpeech('会议编号 0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3 已开始录音。')
    assert.equal(cleaned, '会议编号 已开始录音。')
  })

  test('编号后的悬空标点收拢，念出来不成乱码', () => {
    assert.equal(cleanForSpeech('会议编号：0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3，已完成。'), '会议编号，已完成。')
    assert.equal(cleanForSpeech('编号 0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3。'), '编号。')
  })

  test('三十二位十六进制串同样不念', () => {
    assert.equal(cleanForSpeech('摘要 d41d8cd98f00b204e9800998ecf8427e 已核验。'), '摘要 已核验。')
  })

  test('普通文本与数字不受影响', () => {
    assert.equal(cleanForSpeech('从第 3 段开始讲，共 6 段。'), '从第 3 段开始讲，共 6 段。')
  })

  test('追问回答的引用块整行不念，正文照常；文档原文朗读不受影响', () => {
    const cleaned = cleanForSpeech('结论是提醒做成周期。\n> 原文：到点提醒你。\n继续说明。', { stripQuotes: true })
    assert.equal(cleaned, '结论是提醒做成周期。 继续说明。')
    assert.equal(cleanForSpeech('> 引用一句原文。'), '引用一句原文。', '没有开关时保持原样（文档朗读）')
    const segments = splitIntoSegments({ utteranceId: 'u9', text: '> 原文引用。\n正文回答。', stripQuotes: true })
    assert.deepEqual(segments.map(segment => segment.text), ['正文回答。'])
  })

  test('切句入口统一清洗：纯编号句子整句丢掉', () => {
    const segments = splitIntoSegments(request('0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3。第二句正文。'))
    assert.deepEqual(segments.map(segment => segment.text), ['第二句正文。'])
  })
})

/**
 * 讲解文本的清洗（C1）。
 *
 * 这一组钉的是「讲解听起来像朗读器」的具体成因：`explainPrompt` 要求模型分三段并各自标明
 * `【原文】/【解释】/【补充】`，模型经常连整块方括号、列表符号、Markdown 记号一起吐出来；
 * 这些给眼睛看的结构如果原样送进合成器，就会念成"方括号原文方括号"。
 *
 * 同时钉住**不该删的东西**：别的方括号标签（`【会议结论】`）、小数（`3.5`）、正文里的
 * `+` 与 `->`。多念一个符号只是难听，少念一个字是信息丢失 —— 后者的用例同样是这一组的主体。
 */
/**
 * 这一行/这一句开头还像不像列表、标题或引用。
 *
 * 必须和被测实现用同一条判据（`- ` 有空格、`1.` 后面必须是空白）—— 否则 `3.5 版本`
 * 这种正文会被自己的断言误判成"列表没洗干净"。
 */
function looksLikeMarker(line: string): boolean {
  return /^[ \t]*(?:[-*•][ \t]|\d+[.)][ \t]|\d+、|#{1,6}[ \t]|>)/u.test(line)
}

describe('讲解文本的清洗：只去眼睛用的结构，不动信息', () => {
  test('【原文】连同方括号一起摘掉，正文留下', () => {
    const cleaned = cleanForSpeech('【原文】接口约定要求返回 200。')
    assert.equal(cleaned, '接口约定要求返回 200。')
    assert.ok(!cleaned.includes('原文'), '标签词不该被念出来')
    assert.ok(!cleaned.includes('【') && !cleaned.includes('】'), '方括号本身就是噪音')
  })

  test('带后缀的标签变体同样摘掉：【解释：…】/【原文·第 3 页】/【补充 …】', () => {
    assert.equal(cleanForSpeech('【解释：这里说的是重试次数】最多重试三次。'), '最多重试三次。')
    assert.equal(cleanForSpeech('【原文·第 3 页】这一段讲限流。'), '这一段讲限流。')
    assert.equal(cleanForSpeech('【补充】这和上次会议结论一致。'), '这和上次会议结论一致。')
  })

  test('其它方括号标签原样保留：这是白名单，不是无条件删方括号', () => {
    // 删掉"下面是会议结论"这句提示，后面的话就没有主语了；它们不是讲解三段标签。
    for (const input of ['【会议结论】下周三上线。', '【工作事项】整理需求。', '【待办】补测试。']) {
      assert.equal(cleanForSpeech(input), input)
    }
  })

  test('行首的列表、引用、标题符号去掉，文字留下', () => {
    assert.equal(cleanForSpeech('- 需求一\n- 需求二'), '需求一 需求二')
    assert.equal(cleanForSpeech('* 需求一'), '需求一')
    assert.equal(cleanForSpeech('• 需求一'), '需求一')
    assert.equal(cleanForSpeech('1. 需求一\n2. 需求二'), '需求一 需求二')
    assert.equal(cleanForSpeech('1、需求一\n2、需求二'), '需求一 需求二')
    assert.equal(cleanForSpeech('> 引用一句原文。'), '引用一句原文。')
    assert.equal(cleanForSpeech('## 标题一'), '标题一')
  })

  test('换行不拆句：跨行的同一句合成一段完整播报', () => {
    const segments = splitIntoSegments(request('小潘同学会帮你记录会议，\n并在结束后生成纪要。'))
    assert.deepEqual(segments.map(segment => segment.text), ['小潘同学会帮你记录会议， 并在结束后生成纪要。'])
  })

  test('句首（同一行里跟在句号后面）的列表符号也去掉', () => {
    assert.equal(cleanForSpeech('第一点讲完了。 - 第二点的补充'), '第一点讲完了。第二点的补充')
  })

  test('小数不被当成有序列表：3.5 版本 不能变成 5 版本', () => {
    // 判据是"点号后面必须跟空白"：3.5 的点后面是数字，列表 1. 的点后面是空格。
    assert.equal(cleanForSpeech('3.5 版本要兼容。'), '3.5 版本要兼容。')
    assert.equal(cleanForSpeech('占用率 3.14，延迟 5.67。'), '占用率 3.14，延迟 5.67。')
    assert.equal(cleanForSpeech('从第 3 段开始讲，共 6 段。'), '从第 3 段开始讲，共 6 段。')
  })

  test('成对粗体/斜体记号去掉，里面的字留下', () => {
    assert.equal(cleanForSpeech('**重点**要靠前。'), '重点要靠前。')
    assert.equal(cleanForSpeech('__重点__ 也要。'), '重点 也要。')
  })

  test('正文里的加号与箭头不动：A + B 与 x -> y 不是列表', () => {
    assert.equal(cleanForSpeech('使用 A + B 的形式。'), '使用 A + B 的形式。')
    assert.equal(cleanForSpeech('把 x -> y 记下来。'), '把 x -> y 记下来。')
  })

  test('原有清洗规则一条都不回归', () => {
    assert.equal(cleanForSpeech('会议编号 0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3 已开始录音。'), '会议编号 已开始录音。')
    assert.equal(cleanForSpeech('会议编号：0f29f82c-b3ad-4de5-bd1e-16c55a9d96e3，已完成。'), '会议编号，已完成。')
    assert.equal(cleanForSpeech('摘要 d41d8cd98f00b204e9800998ecf8427e 已核验。'), '摘要 已核验。')
    assert.equal(cleanForSpeech('  多  余 \t 空 格  '), '多 余 空 格')
  })

  test('摘掉标签与列表后留下的空行/空格被收拢，不会念出连串停顿', () => {
    const cleaned = cleanForSpeech('- 需求一\n\n- 需求二')
    assert.equal(cleaned, '需求一 需求二')
    assert.ok(!cleaned.includes('- '))
  })

  test('整段只剩标签时清洗后为空：切句入口会按原规则丢掉它', () => {
    assert.equal(cleanForSpeech('【原文】'), '')
    assert.equal(cleanForSpeech('【解释：只在屏幕上排版】'), '')
    // 不做特殊处理：`WORTH_SPEAKING` 那一层照旧把空片段筛掉。
    assert.deepEqual(splitIntoSegments(request('【原文】。第二句正文。')).map(segment => segment.text), ['第二句正文。'])
  })

  test('一段真实的三段式讲解：念出来没有方括号、没有列表符号，信息一个字不丢', () => {
    const answer = [
      '【原文】',
      '- 接口默认超时 3 秒。',
      '- 失败后最多重试 3 次。',
      '【解释】这里说的是重试预算：**总耗时**不会超过 9 秒。',
      '【补充】',
      '1. 官方文档建议把重试放在幂等接口上。',
      '2. 3.5 版本之后默认值改成了 5 秒。',
    ].join('\n')

    const cleaned = cleanForSpeech(answer)
    assert.ok(!cleaned.includes('【') && !cleaned.includes('】'), `还留着方括号：${cleaned}`)
    assert.ok(!cleaned.includes('**'), '粗体记号不该被念出来')
    for (const line of cleaned.split(/\s+/)) {
      assert.ok(!looksLikeMarker(line), `行首还留着列表符号：${line}`)
    }
    // 信息不丢：三段的正文、小数、数字都在。
    for (const piece of ['接口默认超时 3 秒。', '失败后最多重试 3 次。', '重试预算', '总耗时', '不会超过 9 秒。',
      '幂等接口上。', '3.5 版本', '改成了 5 秒。']) {
      assert.ok(cleaned.includes(piece), `丢了「${piece}」：${cleaned}`)
    }

    // 送进合成器的每一句同样干净，且没有空片段混进去。
    const segments = splitIntoSegments(request(answer))
    assert.ok(segments.length > 0)
    for (const segment of segments) {
      assert.ok(!segment.text.includes('【'), segment.text)
      assert.ok(!looksLikeMarker(segment.text), `句首还留着列表符号：${segment.text}`)
    }
  })

  test('清洗只作用于声音路：切句用的清洗不改写入参原文', () => {
    const raw = '【原文】接口约定要求返回 200。'
    const segments = splitIntoSegments(request(raw))
    assert.deepEqual(segments.map(segment => segment.text), ['接口约定要求返回 200。'])
    assert.equal(raw, '【原文】接口约定要求返回 200。', '屏幕那一份必须原样保留结构标签')
  })
})
