/**
 * 麦克风仲裁：谁在收音，谁不许收音。
 *
 * 这块之所以存在，是因为唤醒词监听（`wake.ts`）和按键听写（`asr.ts`）各起一个 PowerShell
 * 进程，两个进程都调 `SetInputToDefaultAudioDevice()`。Windows 的离线识别器不会拒绝第二个
 * 使用者，它只是把静音流交给它 —— 于是唤醒还活着、听写也"成功返回"，用户按了说话没反应，
 * 两边日志一片正常。设备必须有一个唯一的主人。
 *
 * 决策写成纯函数（`nextAudio`），副作用只有"起/停唤醒监听"与"起/停插话监听"两对，由调用方去执行。
 * 这样互斥规则能被单测钉住，不必真开麦克风 —— 而真开麦克风恰恰是测试里最难稳定的部分。
 *
 * M1-03 之后的分工：
 * - 这里仍是"谁持有麦克风"的**唯一真源**。渲染层的共享采集服务（`renderer/audio-capture.ts`）
 *   只开一次设备，听写 / 插话检测 / KWS 唤醒 / 会议麦克风轨按这里的授权订阅它。
 * - 唤醒有两种引擎：Windows 默认的 System.Speech（自带设备，独立进程）与 sherpa KWS（吃共享采集）。
 *   引擎选择不在状态机里 —— 对仲裁来说它们都是"唤醒在听"，`start-wake`/`stop-wake` 由调用方
 *   按当前引擎分派。换引擎走 `wake-engine-changed`，在跑就先停再起，份数始终是 1。
 */

/**
 * 可能持有麦克风的使用者。
 * - meeting 是显式会议录制：一开就是长时间独占。
 * - barge-in 是"外放插话"实验开关打开时、播放期间的受控收音（M1-05）：只做语音活动检测，
 *   检出后把设备连同预滚动音频交给听写。
 */
export type MicUser = 'wake' | 'dictation' | 'meeting' | 'barge-in'

export interface AudioState {
  /** 当前谁在收音。null 就是设备空闲。 */
  readonly holder: MicUser | null
  /**
   * 专注模式。开着就不跑唤醒词，只留按键听写。
   *
   * 计划要求会议场景"采用更保守的唤醒词/按键，避免把参会者谈话当指令"。唤醒词是这里
   * 唯一会自动触发命令的东西，所以它得关掉；按键是用户自己按的，不存在误触别人说话。
   * 插话监听同理：专注时旁人说话不能把正在播的回答打断。
   */
  readonly focus: boolean
  /**
   * 唤醒监听初始化失败过（没麦克风、没装中文语音包、KWS 模型缺失）。
   *
   * 粘住不自动重试：`wake.ts` 每三秒重拉一次，失败就每三秒刷一条日志，用户看到的只是
   * 一个一直在报错的宠物。恢复要用户自己动手（`wake-retry`，或改唤醒设置）。
   */
  readonly wakeUnavailable: boolean
  /**
   * 唤醒开关（M1-02 四个独立开关之一）。缺省 true 保持 Windows 既有行为；macOS 由调用方在
   * boot 前按设置下发 false（Mac 上开唤醒意味着持续采集、菜单栏常亮麦克风图标，必须用户明确打开）。
   */
  readonly wakeEnabled: boolean
  /**
   * 插话已检出、设备正等着交给听写。这期间播放结束（`barge-in-finished`）不能把设备还给唤醒 ——
   * 否则唤醒刚拉起来就被紧随其后的听写申请停掉，System.Speech 白白起停一次。
   */
  readonly bargeHandover: boolean
  /**
   * 会议还在录。与 holder 分开记：插话交接时 holder 会临时变成 dictation，
   * 但会议轨仍在订阅共享采集，结束后不能把设备交还给唤醒。
   */
  readonly meetingActive: boolean
  /**
   * 会议期间另开的插话监听。它与会议同时订阅同一路共享采集，不算第二个设备主人；
   * 唤醒仍然关闭，避免把评委的话当指令。
   */
  readonly bargeInMeeting: boolean
}

export type AudioEvent =
  /** 壳起来了：按当前设置决定要不要开始听唤醒词。 */
  | { readonly type: 'boot' }
  | { readonly type: 'focus'; readonly on: boolean }
  /** source=barge-in 是插话交接的听写；会议期间只有这一种允许。 */
  | { readonly type: 'dictation-requested'; readonly source?: 'user' | 'barge-in' }
  | { readonly type: 'dictation-finished' }
  /**
   * 显式开一场会议录制。专注模式不阻止它（会议本来就是用户在专注场景里亲手开的），
   * 但会议期间唤醒词必须停：参会者的谈话不能被当成指令。
   */
  | { readonly type: 'meeting-requested' }
  | { readonly type: 'meeting-finished' }
  | { readonly type: 'wake-lost' }
  | { readonly type: 'wake-retry' }
  /** 唤醒开关变了（设置页/托盘）。关掉就立即停，打开且空闲就立即起。 */
  | { readonly type: 'wake-config'; readonly enabled: boolean }
  /** 唤醒引擎换了（System.Speech ↔ KWS）。在跑就重启到新引擎；视同用户重试，清掉粘住的失败。 */
  | { readonly type: 'wake-engine-changed' }
  /** 播放开始且"外放插话"开关打开：申请播放期间的受控收音。 */
  | { readonly type: 'barge-in-requested'; readonly allowInMeeting?: boolean }
  /** 插话已检出：设备保留给紧接着的听写。 */
  | { readonly type: 'barge-in-detected' }
  /**
   * 播放结束 / 开关关掉 / 采集失败。force=true 用于交接超时：检出后听写迟迟没来，不能一直占着设备。
   */
  | { readonly type: 'barge-in-finished'; readonly force?: boolean }

/** 调用方要执行的副作用。没有附带数据：用哪个唤醒引擎、插话监听怎么做，由调用方按当前配置决定。 */
export type AudioEffect = 'start-wake' | 'stop-wake' | 'start-barge-in' | 'stop-barge-in'

export interface AudioTransition {
  readonly state: AudioState
  readonly effects: readonly AudioEffect[]
  /** 这次请求被拒了，给用户看的原因。null 就是没被拒。 */
  readonly denied: string | null
}

export const INITIAL_AUDIO_STATE: AudioState = {
  holder: null, focus: false, wakeUnavailable: false, wakeEnabled: true, bargeHandover: false,
  meetingActive: false, bargeInMeeting: false,
}

/** 空闲状态下能不能把唤醒监听拉起来。 */
function canStartWake(state: AudioState): boolean {
  return state.wakeEnabled && !state.focus && !state.wakeUnavailable
}

function done(state: AudioState, effects: readonly AudioEffect[] = [], denied: string | null = null): AudioTransition {
  return { state, effects, denied }
}

/** 设备空出来了：能起唤醒就交还给唤醒。会议还在录时不交还，会议轨仍要用设备。 */
function release(state: AudioState, effects: AudioEffect[] = []): AudioTransition {
  const idle: AudioState = { ...state, holder: null, bargeHandover: false, bargeInMeeting: false }
  if (idle.meetingActive) return done(idle, effects)
  if (canStartWake(idle)) return done({ ...idle, holder: 'wake' }, [...effects, 'start-wake'])
  return done(idle, effects)
}

export function nextAudio(state: AudioState, event: AudioEvent): AudioTransition {
  switch (event.type) {
    case 'boot': {
      if (state.holder === null && canStartWake(state)) return done({ ...state, holder: 'wake' }, ['start-wake'])
      return done(state)
    }

    case 'focus': {
      const focus = { ...state, focus: event.on }
      if (event.on) {
        // 正在听写的不掐断：这一次收音是用户自己刚按下去的，会议开始了也不该丢他半句话。
        if (state.holder === 'wake') return done({ ...focus, holder: null }, ['stop-wake'])
        // 会议里的插话监听是给评委提问用的，不因专注停掉；其余场景旁人说话不能打断播报。
        if (state.holder === 'barge-in' && !state.bargeHandover && !state.meetingActive) {
          return done({ ...focus, holder: null }, ['stop-barge-in'])
        }
        return done(focus)
      }
      if (focus.holder === null && !focus.meetingActive && canStartWake(focus)) {
        return done({ ...focus, holder: 'wake' }, ['start-wake'])
      }
      return done(focus)
    }

    case 'dictation-requested': {
      if (state.holder === 'dictation') {
        // 不排队。按键的人就在屏幕前等着，排一个队让他对着上一次的收音结果说话，
        // 比直接告诉他"这一次听完再按"糟得多。
        return done(state, [], '正在听你说，这一次听完再按')
      }
      if (state.holder === 'meeting') {
        // 会议期间只放插话交接的听写：那正是要听评审/评委说什么。
        // 手动按键听写仍拒绝，免得把参会者的话喂给命令识别器。
        if (event.source !== 'barge-in') return done(state, [], '正在录制会议，结束会议后再用听写')
        return done({ ...state, holder: 'dictation', bargeHandover: false, bargeInMeeting: false },
          state.bargeInMeeting ? ['stop-barge-in'] : [])
      }
      // 插话监听让路给听写：共享采集的设备不关，预滚动音频由渲染层交给听写。
      const effects: AudioEffect[] = state.holder === 'wake' ? ['stop-wake']
        : state.holder === 'barge-in' ? ['stop-barge-in'] : []
      return done({ ...state, holder: 'dictation', bargeHandover: false, bargeInMeeting: false }, effects)
    }

    case 'dictation-finished': {
      // 超时和正常结束可能各触发一次收尾，第二次必须什么都不做 —— 否则会把刚拉起来的
      // 唤醒监听又停掉，用户下一次喊"小潘同学"没人应。
      if (state.holder !== 'dictation') return done(state)
      // 会议还在录：设备交回会议，不启唤醒（参会者的话不是指令）。
      if (state.meetingActive) return done({ ...state, holder: 'meeting', bargeHandover: false })
      return release(state)
    }

    case 'meeting-requested': {
      if (state.holder === 'meeting' || state.meetingActive) return done(state, [], '已经有一场会议在录制')
      if (state.holder === 'dictation') {
        // 听写最多二十秒就收尾，等它说完再开会议，不掐断用户已经说出口的话。
        return done(state, [], '正在听写，这一句收完再开会议')
      }
      // 专注模式不拦显式会议；唤醒在听就先停掉——会议期间参会者的话不是指令。
      const effects: AudioEffect[] = state.holder === 'wake' ? ['stop-wake']
        : state.holder === 'barge-in' ? ['stop-barge-in'] : []
      return done({ ...state, holder: 'meeting', meetingActive: true, bargeHandover: false, bargeInMeeting: false }, effects)
    }

    case 'meeting-finished': {
      // 与听写收尾同理：重复收尾必须幂等，否则会把唤醒监听错误地停掉。
      const next: AudioState = { ...state, meetingActive: false, bargeInMeeting: false, bargeHandover: false }
      if (state.holder !== 'meeting') return done(next)
      return release(next, state.bargeInMeeting ? ['stop-barge-in'] : [])
    }

    case 'wake-lost': {
      // 标志粘住，等用户自己重试。
      const lost = { ...state, wakeUnavailable: true }
      if (state.holder !== 'wake') return done(lost)
      // 进程是自己没的，但仍然要真的停一次：wake.ts 在意外退出时排了一个三秒后的自动重启，
      // 不调用停止就不会清掉那个定时器，它会把仲裁器刚决定放弃的监听又拉起来。
      return done({ ...lost, holder: null }, ['stop-wake'])
    }

    case 'wake-retry': {
      const retried = { ...state, wakeUnavailable: false }
      if (retried.holder === null && canStartWake(retried)) {
        return done({ ...retried, holder: 'wake' }, ['start-wake'])
      }
      return done(retried)
    }

    case 'wake-config': {
      const next = { ...state, wakeEnabled: event.enabled }
      if (!event.enabled) {
        // 关掉就立刻不再监听 —— "关唤醒后不再监听"是验收项，不等下一次空闲。
        if (state.holder === 'wake') return done({ ...next, holder: null }, ['stop-wake'])
        return done(next)
      }
      if (next.holder === null && canStartWake(next)) return done({ ...next, holder: 'wake' }, ['start-wake'])
      return done(next)
    }

    case 'wake-engine-changed': {
      // 换引擎是用户的明确动作，视同重试：旧引擎的失败不该粘在新引擎上。
      const next = { ...state, wakeUnavailable: false }
      if (state.holder === 'wake') {
        if (canStartWake(next)) return done(next, ['stop-wake', 'start-wake'])
        return done({ ...next, holder: null }, ['stop-wake'])
      }
      if (next.holder === null && canStartWake(next)) return done({ ...next, holder: 'wake' }, ['start-wake'])
      return done(next)
    }

    case 'barge-in-requested': {
      if (state.holder === 'barge-in' || state.bargeInMeeting) return done(state)
      // 会议中允许另开插话监听：共享采集本来就支持多消费者，会议轨不受影响。
      // 这是评审/评委能自然插话的前提；唤醒仍然停着。
      if (state.holder === 'meeting') {
        if (!state.meetingActive || event.allowInMeeting !== true) {
          return done(state, [], '麦克风正被占用，本次播放不监听插话')
        }
        return done({ ...state, bargeInMeeting: true }, ['start-barge-in'])
      }
      // 专注时不开插话监听；听写占着设备时更不能抢。这几种都是静默拒绝 ——
      // 播放照常进行，只是没有插话能力，不值得打扰用户。
      if (state.focus) return done(state, [], '专注模式下不监听插话')
      if (state.holder === 'dictation') return done(state, [], '麦克风正被占用，本次播放不监听插话')
      const effects: AudioEffect[] = state.holder === 'wake' ? ['stop-wake', 'start-barge-in'] : ['start-barge-in']
      return done({ ...state, holder: 'barge-in', bargeHandover: false }, effects)
    }

    case 'barge-in-detected': {
      if (state.holder === 'barge-in' || state.bargeInMeeting) return done({ ...state, bargeHandover: true })
      return done(state)
    }

    case 'barge-in-finished': {
      if (state.bargeInMeeting && state.holder === 'meeting') {
        if (state.bargeHandover && event.force !== true) return done(state)
        return done({ ...state, bargeInMeeting: false, bargeHandover: false }, ['stop-barge-in'])
      }
      if (state.holder !== 'barge-in') return done(state)
      // 检出后正等听写接手：播放结束不归还设备（force 是交接超时的兜底）。
      if (state.bargeHandover && event.force !== true) return done(state)
      // 会议还在录：插话结束后把设备交回会议，不启唤醒。
      if (state.meetingActive) return done({ ...state, holder: 'meeting', bargeHandover: false }, ['stop-barge-in'])
      return release(state, ['stop-barge-in'])
    }
  }
}

