/**
 * 麦克风仲裁的测试。
 *
 * 钉住的是一条物理事实：一台机器上只有一个默认录音设备，Windows 的离线识别器不会拒绝第二个
 * 使用者，它只是把静音流交过去。所以"唤醒词在听"和"按键听写在听"绝不能同时成立 ——
 * 一旦同时成立，用户按了说话没反应，而两边日志都显示一切正常，这是最难查的那类故障。
 *
 * 计划 §2.8 的三条也落在这里：统一音频控制器拥有麦克风；会议（专注）场景采用更保守的
 * 唤醒词/按键；打断不丢用户已经说出口的话。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { INITIAL_AUDIO_STATE, kwsTakesAudio, nextAudio, wakeListening, type AudioEffect, type AudioEvent, type AudioState, type RunningWake } from '../src/main/audio.ts'

/** 穷举用的全部事件。 */
const EVENTS: readonly AudioEvent[] = [
  { type: 'boot' },
  { type: 'focus', on: true },
  { type: 'focus', on: false },
  { type: 'dictation-requested' },
  { type: 'dictation-finished' },
  { type: 'wake-lost' },
  { type: 'wake-retry' },
]

/** 开机后的正常状态：唤醒词在听，设备被它占着。 */
const AWAKE: AudioState = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state

/**
 * 录音不剥夺唤醒：会议期间只要唤醒可用，监听就应在听（共享采集/独立进程可与会议轨并存）；
 * 会议里插话检出后交接给听写的那一段，唤醒也不停（wakeDuringHandover）。
 * 这里刻意不调用产品代码里的 wakeListening，独立写一遍，穷举时两边互相核对。
 */
const wakeRunning = (s: AudioState): number => {
  const usable = s.wakeEnabled && !s.focus && !s.wakeUnavailable
  return (s.holder === 'wake' || (s.holder === 'meeting' && s.meetingActive && usable)
    || (s.holder === 'dictation' && s.wakeDuringHandover && usable)) ? 1 : 0
}

describe('麦克风只有一个主人', () => {
  test('开机就把唤醒监听拉起来', () => {
    const first = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' })
    assert.equal(first.state.holder, 'wake')
    assert.deepEqual(first.effects, ['start-wake'])
  })

  test('唤醒在听时申请听写：先放掉唤醒，再交给听写', () => {
    const turn = nextAudio(AWAKE, { type: 'dictation-requested' })
    assert.deepEqual(turn.effects, ['stop-wake'], '同一个设备不能有两个进程同时收音')
    assert.equal(turn.state.holder, 'dictation')
    assert.equal(turn.denied, null)
  })

  test('设备空闲时申请听写：直接给，不多不少一个副作用', () => {
    const idle: AudioState = { ...AWAKE, holder: null }
    const turn = nextAudio(idle, { type: 'dictation-requested' })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, 'dictation')
  })

  test('听写结束就把设备交还给唤醒', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'dictation-finished' })
    assert.deepEqual(turn.effects, ['start-wake'])
    assert.equal(turn.state.holder, 'wake')
  })

  test('听写收尾来了两次，第二次什么都不做', () => {
    // 超时和正常结束会各触发一次收尾。第二次要是也把唤醒停掉，用户下一句"小潘"就没人应了 ——
    // 而他只会在很久之后才发现唤醒坏了。
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const first = nextAudio(dictating, { type: 'dictation-finished' })
    const second = nextAudio(first.state, { type: 'dictation-finished' })
    assert.deepEqual(second.effects, [])
    assert.equal(second.state.holder, 'wake')
    assert.deepEqual(second.state, first.state)
  })

  test('听写进行中再按一次：拒绝并说人话，状态一点不动', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'dictation-requested' })
    assert.equal(turn.denied, '正在听你说，这一次听完再按')
    assert.deepEqual(turn.effects, [], '不排队：排了队他会对着上一次的收音结果说话')
    assert.deepEqual(turn.state, dictating)
  })

  test('任意事件序列下，唤醒监听的起停次数始终和 holder 对得上', () => {
    // 这条是穷举，不是抽样：状态只有三个字段、事件只有七种，跑满五步也才一万多条路径。
    // 它抓住的是"起了两次唤醒"和"停了没人起的唤醒"这两类错误 —— 前者留下一个抢麦克风的
    // 孤儿进程，后者让用户下一次喊话没人应，两者都不会在任何单次断言里露出来。
    let checked = 0
    const walk = (state: AudioState, balance: number, depth: number): void => {
      for (const event of EVENTS) {
        const turn = nextAudio(state, event)
        let next = balance
        for (const effect of turn.effects) next += effect === 'start-wake' ? 1 : -1
        assert.ok(next >= 0, `停了一个没在跑的唤醒监听：${JSON.stringify(event)}`)
        assert.equal(
          next,
          wakeRunning(turn.state),
          `唤醒监听跑着的份数和状态不一致（${JSON.stringify(event)}）`,
        )
        if (turn.state.holder === 'dictation') {
          assert.ok(
            !turn.effects.includes('start-wake'),
            '听写占着设备时不许拉起唤醒',
          )
        }
        checked++
        if (depth > 0) walk(turn.state, next, depth - 1)
      }
    }
    walk(INITIAL_AUDIO_STATE, 0, 4)
    assert.ok(checked > 10_000, `穷举规模异常（只走了 ${checked} 步）`)
  })
})

describe('专注模式：唤醒词关掉，按键留着', () => {
  test('开专注就把唤醒停掉', () => {
    const turn = nextAudio(AWAKE, { type: 'focus', on: true })
    assert.deepEqual(turn.effects, ['stop-wake'])
    assert.equal(turn.state.holder, null)
    assert.equal(turn.state.focus, true)
  })

  test('开专注时正在听写：不掐断他这一句', () => {
    // 这一次收音是他自己刚按下去的。会议开始了就丢他半句话，他会以为按键坏了。
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'focus', on: true })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, 'dictation')
    assert.equal(turn.state.focus, true)
  })

  test('专注下按键听写照样给：按键是他自己按的，不存在误把别人的话当指令', () => {
    const focus = nextAudio(AWAKE, { type: 'focus', on: true }).state
    const turn = nextAudio(focus, { type: 'dictation-requested' })
    assert.equal(turn.state.holder, 'dictation')
    assert.equal(turn.denied, null)
  })

  test('专注下听写结束不恢复唤醒', () => {
    const focus = nextAudio(AWAKE, { type: 'focus', on: true }).state
    const dictating = nextAudio(focus, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'dictation-finished' })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, null)
  })

  test('关掉专注就把唤醒恢复回来', () => {
    const focus = nextAudio(AWAKE, { type: 'focus', on: true }).state
    const turn = nextAudio(focus, { type: 'focus', on: false })
    assert.deepEqual(turn.effects, ['start-wake'])
    assert.equal(turn.state.holder, 'wake')
  })

  test('关掉专注时设备还被听写占着，就不抢', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const focus = nextAudio(dictating, { type: 'focus', on: true }).state
    const turn = nextAudio(focus, { type: 'focus', on: false })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, 'dictation', '等这次听写自己收尾')
  })
})

describe('唤醒监听不可用：粘住，等用户自己重试', () => {
  test('初始化失败就放掉设备，并且不再自动拉起', () => {
    // wake.ts 每三秒重拉一次。没麦克风或没装中文语音包时，那就是每三秒刷一条错误日志，
    // 用户看到的是一只一直在报错的宠物。
    const turn = nextAudio(AWAKE, { type: 'wake-lost' })
    assert.equal(turn.state.wakeUnavailable, true)
    assert.equal(turn.state.holder, null)
    assert.deepEqual(turn.effects, ['stop-wake'], '进程是自己没的，但那个自动重启的定时器得清掉')
    assert.equal(nextAudio(turn.state, { type: 'boot' }).state.holder, null)
  })

  test('不可用期间听写照样能按，结束也不恢复唤醒', () => {
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const dictating = nextAudio(lost, { type: 'dictation-requested' }).state
    assert.equal(dictating.holder, 'dictation', '唤醒坏了不该连带把按键听写也废掉')
    const turn = nextAudio(dictating, { type: 'dictation-finished' })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, null)
  })

  test('不可用期间关掉专注也不拉起', () => {
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const focus = nextAudio(lost, { type: 'focus', on: true }).state
    const turn = nextAudio(focus, { type: 'focus', on: false })
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, null)
  })

  test('用户重试之后恢复正常', () => {
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const turn = nextAudio(lost, { type: 'wake-retry' })
    assert.equal(turn.state.wakeUnavailable, false)
    assert.equal(turn.state.holder, 'wake')
    assert.deepEqual(turn.effects, ['start-wake'])
  })

  test('重试时正处在专注模式：清掉标志但不拉起', () => {
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const focus = nextAudio(lost, { type: 'focus', on: true }).state
    const turn = nextAudio(focus, { type: 'wake-retry' })
    assert.equal(turn.state.wakeUnavailable, false)
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, null, '等他关掉专注再说')
    assert.equal(nextAudio(turn.state, { type: 'focus', on: false }).state.holder, 'wake')
  })

  test('重试时设备被听写占着：只清标志', () => {
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const dictating = nextAudio(lost, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'wake-retry' })
    assert.equal(turn.state.wakeUnavailable, false)
    assert.deepEqual(turn.effects, [])
    assert.equal(turn.state.holder, 'dictation')
    assert.equal(nextAudio(turn.state, { type: 'dictation-finished' }).state.holder, 'wake')
  })

  test('唤醒在听写期间挂掉，不会把听写一起带走', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'wake-lost' })
    assert.equal(turn.state.holder, 'dictation')
    assert.equal(turn.state.wakeUnavailable, true)
  })
})

// ── M1-02 / M1-03 / M1-05：唤醒开关、引擎切换、插话监听 ─────────────────────

/** 扩展后的全部事件。 */
const ALL_EVENTS: readonly AudioEvent[] = [
  ...EVENTS,
  { type: 'meeting-requested' },
  { type: 'meeting-finished' },
  { type: 'wake-config', enabled: true },
  { type: 'wake-config', enabled: false },
  { type: 'wake-engine-changed' },
  { type: 'barge-in-requested' },
  { type: 'barge-in-requested', allowInMeeting: true },
  { type: 'barge-in-detected' },
  { type: 'barge-in-finished' },
  { type: 'barge-in-finished', force: true },
  { type: 'dictation-requested', source: 'barge-in' },
]

describe('穷举：唤醒与插话两类监听的起停份数始终和 holder 对得上', () => {
  test('任意 5 步事件序列', () => {
    let checked = 0
    const walk = (state: AudioState, wake: number, barge: number, depth: number): void => {
      for (const event of ALL_EVENTS) {
        const turn = nextAudio(state, event)
        let w = wake
        let b = barge
        for (const effect of turn.effects) {
          if (effect === 'start-wake') w++
          else if (effect === 'stop-wake') w--
          else if (effect === 'start-barge-in') b++
          else b--
          assert.ok(w >= 0 && w <= 1, `唤醒份数越界：${JSON.stringify(event)} ${JSON.stringify(state)}`)
          assert.ok(b >= 0 && b <= 1, `插话监听份数越界：${JSON.stringify(event)} ${JSON.stringify(state)}`)
        }
        assert.equal(w, wakeRunning(turn.state), `唤醒份数与状态不一致（${JSON.stringify(event)}）`)
        // 产品代码的"唤醒在听"判据必须与起停份数一致：KWS 收不收 PCM 就靠它。
        assert.equal(wakeListening(turn.state), w === 1, `wakeListening 与起停份数不一致（${JSON.stringify(event)} ${JSON.stringify(state)}）`)
        // KWS 会话在跑（按副作用起停）⇔ 主进程收它的 PCM、渲染层拿得到授权；System.Speech 在跑时不收。
        assert.equal(kwsTakesAudio(turn.state, w === 1 ? 'kws' : null), w === 1, `KWS 在跑却不收 PCM（或反之）：${JSON.stringify(event)} ${JSON.stringify(turn.state)}`)
        assert.equal(kwsTakesAudio(turn.state, w === 1 ? 'system' : null), false)
        // 交接期间保留唤醒只在"听写占着、唤醒可用"时成立；任何时候都不在听写占着设备时拉起唤醒。
        if (turn.state.wakeDuringHandover) {
          assert.ok(turn.state.holder === 'dictation' && turn.state.wakeEnabled && !turn.state.focus && !turn.state.wakeUnavailable,
            `交接保留唤醒的标志落在了不该在的状态：${JSON.stringify(turn.state)}`)
        }
        if (turn.state.holder === 'dictation') assert.ok(!turn.effects.includes('start-wake'), `听写占着设备时拉起了唤醒：${JSON.stringify(event)}`)
        const barges = (turn.state.holder === 'barge-in' ? 1 : 0) + (turn.state.bargeInMeeting ? 1 : 0)
        assert.equal(b, barges, `插话份数与 holder 不一致（${JSON.stringify(event)}）`)
        // 不变量：关着唤醒 / 专注 / 不可用时绝不会处于"唤醒在听"。
        if (turn.state.holder === 'wake') {
          assert.ok(turn.state.wakeEnabled && !turn.state.focus && !turn.state.wakeUnavailable, `不该在听唤醒：${JSON.stringify(turn.state)}`)
        }
        // 交接标志只在插话监听存在时才有意义（独立 holder 或会议内的插话监听）。
        if (turn.state.bargeHandover) assert.ok(turn.state.holder === 'barge-in' || turn.state.bargeInMeeting)
        // 会议外的专注仍然不新开插话监听；会议里的插话正是为了评审提问。
        if (turn.effects.includes('start-barge-in')) assert.ok(!turn.state.focus || turn.state.meetingActive)
        // 会议中听写放开：本人按键与插话交接都交给听写（共享采集多消费者）。
        if (state.holder === 'meeting' && event.type === 'dictation-requested') {
          assert.equal(turn.state.holder, 'dictation')
        }
        // 会议结束（或插话交接结束）不得把设备交给唤醒。
        if (turn.state.meetingActive) assert.notEqual(turn.state.holder, 'wake')
        checked++
        if (depth > 0) walk(turn.state, w, b, depth - 1)
      }
    }
    walk(INITIAL_AUDIO_STATE, 0, 0, 4)
    assert.ok(checked > 1_000_000, `穷举规模异常（只走了 ${checked} 步）`)
  })
})

describe('唤醒开关（M1-02）', () => {
  test('关掉唤醒：正在听就立刻停，之后任何收尾都不再拉起', () => {
    const off = nextAudio(AWAKE, { type: 'wake-config', enabled: false })
    assert.deepEqual(off.effects, ['stop-wake'])
    assert.equal(off.state.holder, null)
    const dictating = nextAudio(off.state, { type: 'dictation-requested' }).state
    assert.deepEqual(nextAudio(dictating, { type: 'dictation-finished' }).effects, [], '听写结束不恢复一个被关掉的唤醒')
    assert.equal(nextAudio(off.state, { type: 'boot' }).state.holder, null)
    assert.equal(nextAudio(off.state, { type: 'wake-retry' }).state.holder, null, '重试也不能绕过开关')
  })

  test('缺省关（macOS）：boot 不开麦；打开后立即开始听', () => {
    const mac: AudioState = { ...INITIAL_AUDIO_STATE, wakeEnabled: false }
    const booted = nextAudio(mac, { type: 'boot' })
    assert.deepEqual(booted.effects, [])
    const on = nextAudio(booted.state, { type: 'wake-config', enabled: true })
    assert.deepEqual(on.effects, ['start-wake'])
    assert.equal(on.state.holder, 'wake')
  })

  test('换引擎：在听就先停旧的再起新的；不可用标志被清掉', () => {
    const turn = nextAudio(AWAKE, { type: 'wake-engine-changed' })
    assert.deepEqual(turn.effects, ['stop-wake', 'start-wake'])
    const lost = nextAudio(AWAKE, { type: 'wake-lost' }).state
    const retried = nextAudio(lost, { type: 'wake-engine-changed' })
    assert.equal(retried.state.wakeUnavailable, false)
    assert.deepEqual(retried.effects, ['start-wake'])
  })
})

describe('插话监听（M1-05）', () => {
  const BARGE = nextAudio(AWAKE, { type: 'barge-in-requested' })

  test('播放开始：先停唤醒再开插话监听，设备只有一个主人', () => {
    assert.deepEqual(BARGE.effects, ['stop-wake', 'start-barge-in'])
    assert.equal(BARGE.state.holder, 'barge-in')
  })

  test('播放结束：插话监听退场，设备还给唤醒', () => {
    const turn = nextAudio(BARGE.state, { type: 'barge-in-finished' })
    assert.deepEqual(turn.effects, ['stop-barge-in', 'start-wake'])
    assert.equal(turn.state.holder, 'wake')
  })

  test('检出后播放结束不归还设备：等紧接着的听写接手', () => {
    const detected = nextAudio(BARGE.state, { type: 'barge-in-detected' }).state
    const ended = nextAudio(detected, { type: 'barge-in-finished' })
    assert.deepEqual(ended.effects, [])
    assert.equal(ended.state.holder, 'barge-in')
    const dictation = nextAudio(ended.state, { type: 'dictation-requested' })
    assert.deepEqual(dictation.effects, ['stop-barge-in'], '交给听写：不经过唤醒，不白起停一次 System.Speech')
    assert.equal(dictation.state.holder, 'dictation')
    assert.equal(dictation.denied, null)
  })

  test('检出后听写迟迟不来：交接超时（force）归还设备', () => {
    const detected = nextAudio(BARGE.state, { type: 'barge-in-detected' }).state
    const forced = nextAudio(detected, { type: 'barge-in-finished', force: true })
    assert.deepEqual(forced.effects, ['stop-barge-in', 'start-wake'])
  })

  test('专注时不开插话；开专注掐掉还没检出的插话监听', () => {
    const focus = nextAudio(AWAKE, { type: 'focus', on: true }).state
    const denied = nextAudio(focus, { type: 'barge-in-requested' })
    assert.deepEqual(denied.effects, [])
    assert.ok(denied.denied)
    const cut = nextAudio(BARGE.state, { type: 'focus', on: true })
    assert.deepEqual(cut.effects, ['stop-barge-in'])
    assert.equal(cut.state.holder, null)
  })

  test('听写占着设备时不抢；会议开始掐掉普通插话监听', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    assert.equal(nextAudio(dictating, { type: 'barge-in-requested' }).state.holder, 'dictation')
    const meeting = nextAudio(BARGE.state, { type: 'meeting-requested' })
    assert.deepEqual(meeting.effects, ['stop-barge-in', 'start-wake'], '录音不剥夺唤醒：插话让位、唤醒拉起')
    assert.equal(meeting.state.holder, 'meeting')
    assert.equal(meeting.state.bargeInMeeting, false)
    // 不带会议许可的申请仍然被拒：日常外放不会被意外开麦。
    const denied = nextAudio(meeting.state, { type: 'barge-in-requested' })
    assert.equal(denied.state.holder, 'meeting')
    assert.ok(denied.denied)
  })
})

describe('会议里的自然插话（比赛链）', () => {
  const MEETING = nextAudio(INITIAL_AUDIO_STATE, { type: 'meeting-requested' }).state

  test('会议中允许另开插话监听，唤醒保持监听', () => {
    const turn = nextAudio(MEETING, { type: 'barge-in-requested', allowInMeeting: true })
    assert.deepEqual(turn.effects, ['start-barge-in'])
    assert.equal(turn.state.holder, 'meeting')
    assert.equal(turn.state.bargeInMeeting, true)
    assert.equal(turn.state.meetingActive, true)
  })

  test('会议插话检出后可交接给听写，会议仍记为在录；交接期间唤醒不停，收尾也不重起', () => {
    const listening = nextAudio(MEETING, { type: 'barge-in-requested', allowInMeeting: true }).state
    const detected = nextAudio(listening, { type: 'barge-in-detected' })
    assert.equal(detected.state.bargeHandover, true)
    const dictation = nextAudio(detected.state, { type: 'dictation-requested', source: 'barge-in' })
    // 插话喊的可能正是唤醒词：这时停 KWS，它只听到头一两个字，讲解中喊名字永远没反应。
    assert.deepEqual(dictation.effects, ['stop-barge-in'], '交接只收插话监听，唤醒继续听完这句')
    assert.equal(dictation.state.holder, 'dictation')
    assert.equal(dictation.state.wakeDuringHandover, true)
    assert.equal(dictation.state.meetingActive, true)
    assert.equal(dictation.denied, null)
    const finished = nextAudio(dictation.state, { type: 'dictation-finished' })
    assert.deepEqual(finished.effects, [], '唤醒一直在听：收尾不重起（不白白重载一次唤醒模型）')
    assert.equal(finished.state.holder, 'meeting')
    assert.equal(finished.state.wakeDuringHandover, false)
  })

  test('会议中手动听写放开（录音不剥夺对话），插话监听的结束只停监听', () => {
    const manual = nextAudio(MEETING, { type: 'dictation-requested' })
    assert.equal(manual.denied, null)
    assert.equal(manual.state.holder, 'dictation')
    assert.deepEqual(manual.effects, ['stop-wake'])
    const listening = nextAudio(MEETING, { type: 'barge-in-requested', allowInMeeting: true }).state
    const ended = nextAudio(listening, { type: 'barge-in-finished' })
    assert.deepEqual(ended.effects, ['stop-barge-in'])
    assert.equal(ended.state.holder, 'meeting')
    assert.equal(ended.state.meetingActive, true)
  })

  test('会议中的专注停唤醒但不清插话监听；会议结束收掉插话', () => {
    const listening = nextAudio(MEETING, { type: 'barge-in-requested', allowInMeeting: true }).state
    const focus = nextAudio(listening, { type: 'focus', on: true })
    assert.deepEqual(focus.effects, ['stop-wake'])
    assert.equal(focus.state.bargeInMeeting, true)
    const done = nextAudio(focus.state, { type: 'meeting-finished' })
    assert.deepEqual(done.effects, ['stop-barge-in'], '会议结束，插话监听一起收掉')
    assert.equal(done.state.meetingActive, false)
  })

  test('会议中检出后人没再说话：超时强制收掉插话监听，会议继续', () => {
    const listening = nextAudio(MEETING, { type: 'barge-in-requested', allowInMeeting: true }).state
    const detected = nextAudio(listening, { type: 'barge-in-detected' }).state
    const ended = nextAudio(detected, { type: 'barge-in-finished' })
    assert.deepEqual(ended.effects, [], '交接中不提前收')
    const forced = nextAudio(ended.state, { type: 'barge-in-finished', force: true })
    assert.deepEqual(forced.effects, ['stop-barge-in'])
    assert.equal(forced.state.holder, 'meeting')
  })

  test('重复申请幂等；唤醒关着时插话结束不拉起唤醒', () => {
    const listening = nextAudio(AWAKE, { type: 'barge-in-requested' }).state
    assert.deepEqual(nextAudio(listening, { type: 'barge-in-requested' }).effects, [])
    const off = nextAudio(AWAKE, { type: 'wake-config', enabled: false }).state
    const barge = nextAudio(off, { type: 'barge-in-requested' })
    assert.deepEqual(barge.effects, ['start-barge-in'])
    assert.deepEqual(nextAudio(barge.state, { type: 'barge-in-finished' }).effects, ['stop-barge-in'])
  })
})

// ── 会议录音期间的 KWS 唤醒：PCM 链路与插话交接 ─────────────────────────────

/**
 * 模拟 index.ts 的 applyAudio：按副作用起停一个 KWS 会话（start-wake 先停后起，份数始终 1），
 * 每一步记下"KWS 会话在不在跑"与"主进程收不收它的 PCM"（kws-feed / 授权共用的判据）。
 */
function drive(events: readonly AudioEvent[], from: AudioState = INITIAL_AUDIO_STATE) {
  let state = from
  let running: RunningWake = null
  let starts = 0
  const steps: Array<{ event: AudioEvent; state: AudioState; running: RunningWake; effects: readonly AudioEffect[]; takes: boolean }> = []
  for (const event of events) {
    const turn = nextAudio(state, event)
    state = turn.state
    for (const effect of turn.effects) {
      if (effect === 'start-wake') { running = 'kws'; starts++ }
      else if (effect === 'stop-wake') running = null
    }
    steps.push({ event, state, running, effects: turn.effects, takes: kwsTakesAudio(state, running) })
  }
  return { state, running, starts, steps }
}

/** 回归前 kws-feed 入口的判据：只认 holder==='wake'。 */
const oldFeedGate = (state: AudioState, running: RunningWake): boolean => state.holder === 'wake' && running === 'kws'

describe('会议录音期间的唤醒：KWS 吃得到共享采集的 PCM', () => {
  test('回归：会议在录（holder=meeting）时 KWS 在跑，主进程必须收它的 PCM', () => {
    const { state, running, steps } = drive([{ type: 'boot' }, { type: 'meeting-requested' }])
    assert.equal(state.holder, 'meeting')
    assert.equal(running, 'kws', '开会不停唤醒（录音不剥夺唤醒）')
    assert.deepEqual(steps[1].effects, [], '唤醒原本就在听：开会不重起')
    assert.equal(kwsTakesAudio(state, running), true, '授权与收 PCM 都要放行')
    // 现场故障：授权早就不看 holder 了，收 PCM 的入口却还按 holder==='wake' 拦 —— 整场会议一帧都没送进 KWS。
    assert.equal(oldFeedGate(state, running), false)
  })

  test('System.Speech 在跑、或唤醒让路时不收 PCM', () => {
    const meeting = drive([{ type: 'boot' }, { type: 'meeting-requested' }]).state
    assert.equal(kwsTakesAudio(meeting, 'system'), false, 'System.Speech 自己开设备，不吃共享采集')
    assert.equal(kwsTakesAudio(meeting, null), false)
    const focus = nextAudio(meeting, { type: 'focus', on: true }).state
    assert.equal(kwsTakesAudio(focus, 'kws'), false, '专注时唤醒不在听')
    const manual = nextAudio(meeting, { type: 'dictation-requested' }).state
    assert.equal(kwsTakesAudio(manual, 'kws'), false, '本人按键听写时唤醒让路')
  })

  test('会议 + 讲解全程：KWS 在跑的每一刻都收 PCM；插话交接不停唤醒，口令后续听让路、听完恢复', () => {
    const script: AudioEvent[] = [
      { type: 'boot' },
      { type: 'meeting-requested' }, // 开始录音
      { type: 'barge-in-requested', allowInMeeting: true }, // 讲解开播：插话监听与唤醒并存
      { type: 'barge-in-detected' }, // 讲解声中有人开口（可能正是在喊唤醒词）
      { type: 'dictation-requested', source: 'barge-in' }, // 交接给口令门禁的听写
      { type: 'dictation-finished' }, // 这句收完
      { type: 'dictation-requested', source: 'barge-in' }, // 口令后的提问窗口续听（没有检出）
      { type: 'dictation-finished' }, // 提问收完：插话后恢复
      { type: 'barge-in-requested', allowInMeeting: true }, // 回答 / 续讲开播
      { type: 'barge-in-finished' }, // 播完
      { type: 'meeting-finished' }, // 停录
    ]
    const { steps, starts } = drive(script)
    for (const step of steps) {
      assert.equal(step.takes, step.running === 'kws', `KWS 在跑与收 PCM 不一致：${JSON.stringify(step.event)} ${JSON.stringify(step.state)}`)
    }
    assert.deepEqual(steps.map(step => step.running === 'kws'),
      [true, true, true, true, true, true, false, true, true, true, true],
      '只有口令后的续听让唤醒让路，其余时刻唤醒都在听')
    assert.deepEqual(steps[4].effects, ['stop-barge-in'], '交接只收插话监听，KWS 继续听完这句唤醒词')
    assert.deepEqual(steps[5].effects, [], '交接听写收尾不重起 KWS')
    assert.deepEqual(steps[6].effects, ['stop-wake'], '口令后的续听照旧让路')
    assert.deepEqual(steps[7].effects, ['start-wake'], '续听收尾恢复唤醒')
    assert.equal(steps[10].state.holder, 'wake')
    assert.equal(starts, 2, '开机一次 + 续听后恢复一次；交接前后不再白白重载唤醒模型')
    // 回归前的判据在会议里的每一步都把 PCM 拦掉。
    assert.ok(steps.slice(1, 10).every(step => !oldFeedGate(step.state, step.running)))
  })
})

describe('会议里插话交接期间保留的唤醒：其它开关照常收得住', () => {
  const HANDOVER = drive([
    { type: 'boot' },
    { type: 'meeting-requested' },
    { type: 'barge-in-requested', allowInMeeting: true },
    { type: 'barge-in-detected' },
    { type: 'dictation-requested', source: 'barge-in' },
  ]).state

  test('前提：交接中听写占着设备、唤醒仍在听', () => {
    assert.equal(HANDOVER.holder, 'dictation')
    assert.equal(HANDOVER.wakeDuringHandover, true)
    assert.equal(wakeListening(HANDOVER), true)
    assert.equal(kwsTakesAudio(HANDOVER, 'kws'), true)
  })

  test('开专注：停唤醒、听写不动；收尾不再拉起', () => {
    const focus = nextAudio(HANDOVER, { type: 'focus', on: true })
    assert.deepEqual(focus.effects, ['stop-wake'])
    assert.equal(focus.state.holder, 'dictation')
    assert.equal(focus.state.wakeDuringHandover, false)
    assert.deepEqual(nextAudio(focus.state, { type: 'dictation-finished' }).effects, [])
  })

  test('关唤醒 / 唤醒挂掉：立刻停，收尾不拉起', () => {
    const off = nextAudio(HANDOVER, { type: 'wake-config', enabled: false })
    assert.deepEqual(off.effects, ['stop-wake'])
    assert.deepEqual(nextAudio(off.state, { type: 'dictation-finished' }).effects, [])
    const lost = nextAudio(HANDOVER, { type: 'wake-lost' })
    assert.deepEqual(lost.effects, ['stop-wake'], '清掉自动重启定时器')
    assert.equal(lost.state.wakeUnavailable, true)
    assert.equal(lost.state.holder, 'dictation', '唤醒挂了不带走听写')
    assert.deepEqual(nextAudio(lost.state, { type: 'dictation-finished' }).effects, [])
  })

  test('换引擎：先停旧的，听写收尾再起新的（听写占着设备时不拉起唤醒）', () => {
    const changed = nextAudio(HANDOVER, { type: 'wake-engine-changed' })
    assert.deepEqual(changed.effects, ['stop-wake'])
    const finished = nextAudio(changed.state, { type: 'dictation-finished' })
    assert.deepEqual(finished.effects, ['start-wake'])
    assert.equal(finished.state.holder, 'meeting')
  })

  test('交接中会议先停了：唤醒一直在听，听写收尾记回 wake、不重起', () => {
    const stopped = nextAudio(HANDOVER, { type: 'meeting-finished' })
    assert.deepEqual(stopped.effects, [])
    assert.equal(stopped.state.holder, 'dictation')
    const finished = nextAudio(stopped.state, { type: 'dictation-finished' })
    assert.deepEqual(finished.effects, [])
    assert.equal(finished.state.holder, 'wake')
    assert.equal(finished.state.wakeDuringHandover, false)
  })

  test('只认会议里检出后的交接：本人按键、未检出的续听、会议外的插话交接都照旧', () => {
    const meeting = drive([{ type: 'boot' }, { type: 'meeting-requested' }, { type: 'barge-in-requested', allowInMeeting: true }]).state
    // 检出之后本人去按了麦克风：按键听写照旧让路。
    const detected = nextAudio(meeting, { type: 'barge-in-detected' }).state
    const manual = nextAudio(detected, { type: 'dictation-requested' })
    assert.deepEqual(manual.effects, ['stop-wake', 'stop-barge-in'])
    assert.equal(manual.state.wakeDuringHandover, false)
    // 没有检出的口令续听：照旧让路。
    const relisten = nextAudio(meeting, { type: 'dictation-requested', source: 'barge-in' })
    assert.deepEqual(relisten.effects, ['stop-wake', 'stop-barge-in'])
    assert.equal(relisten.state.wakeDuringHandover, false)
    // 会议外：插话监听开播时唤醒就已停了，交接只收插话监听，收尾恢复唤醒。
    const barge = nextAudio(AWAKE, { type: 'barge-in-requested' }).state
    const outside = nextAudio(nextAudio(barge, { type: 'barge-in-detected' }).state, { type: 'dictation-requested', source: 'barge-in' })
    assert.deepEqual(outside.effects, ['stop-barge-in'])
    assert.equal(outside.state.wakeDuringHandover, false)
    assert.deepEqual(nextAudio(outside.state, { type: 'dictation-finished' }).effects, ['start-wake'])
  })
})
