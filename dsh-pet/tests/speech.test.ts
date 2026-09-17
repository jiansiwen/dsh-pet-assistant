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
