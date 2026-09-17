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

import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState } from '../src/main/audio.ts'

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
          turn.state.holder === 'wake' ? 1 : 0,
          `唤醒监听跑着的份数和 holder 不一致（${JSON.stringify(event)}）`,
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
