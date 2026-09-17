/**
 * 麦克风仲裁：谁在收音，谁不许收音。
 *
 * 这块之所以存在，是因为唤醒词监听（`wake.ts`）和按键听写（`asr.ts`）各起一个 PowerShell
 * 进程，两个进程都调 `SetInputToDefaultAudioDevice()`。Windows 的离线识别器不会拒绝第二个
 * 使用者，它只是把静音流交给它 —— 于是唤醒还活着、听写也"成功返回"，用户按了说话没反应，
 * 两边日志一片正常。设备必须有一个唯一的主人。
 *
 * 决策写成纯函数（`nextAudio`），副作用只有"起/停唤醒监听"两种，由调用方去执行。
 * 这样互斥规则能被单测钉住，不必真开麦克风 —— 而真开麦克风恰恰是测试里最难稳定的部分。
 */

/** 可能持有麦克风的两个使用者。 */
export type MicUser = 'wake' | 'dictation'

export interface AudioState {
  /** 当前谁在收音。null 就是设备空闲。 */
  readonly holder: MicUser | null
  /**
   * 专注模式。开着就不跑唤醒词，只留按键听写。
   *
   * 计划要求会议场景"采用更保守的唤醒词/按键，避免把参会者谈话当指令"。唤醒词是这里
   * 唯一会自动触发命令的东西，所以它得关掉；按键是用户自己按的，不存在误触别人说话。
   */
  readonly focus: boolean
  /**
   * 唤醒监听初始化失败过（没麦克风、没装中文语音包）。
   *
   * 粘住不自动重试：`wake.ts` 每三秒重拉一次，失败就每三秒刷一条日志，用户看到的只是
   * 一个一直在报错的宠物。恢复要用户自己动手（`wake-retry`）。
   */
  readonly wakeUnavailable: boolean
}

export type AudioEvent =
  /** 壳起来了：按当前设置决定要不要开始听唤醒词。 */
  | { readonly type: 'boot' }
  | { readonly type: 'focus'; readonly on: boolean }
  | { readonly type: 'dictation-requested' }
  | { readonly type: 'dictation-finished' }
  | { readonly type: 'wake-lost' }
  | { readonly type: 'wake-retry' }

/** 调用方要执行的副作用：拉起或停掉唤醒监听。只有两种，没有附带数据。 */
export type AudioEffect = 'start-wake' | 'stop-wake'

export interface AudioTransition {
  readonly state: AudioState
  readonly effects: readonly AudioEffect[]
  /** 这次请求被拒了，给用户看的原因。null 就是没被拒。 */
  readonly denied: string | null
}

export const INITIAL_AUDIO_STATE: AudioState = { holder: null, focus: false, wakeUnavailable: false }

/** 空闲状态下能不能把唤醒监听拉起来。 */
function canStartWake(state: AudioState): boolean {
  return !state.focus && !state.wakeUnavailable
}

function done(state: AudioState, effects: readonly AudioEffect[] = [], denied: string | null = null): AudioTransition {
  return { state, effects, denied }
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
        return done(focus)
      }
      if (focus.holder === null && canStartWake(focus)) return done({ ...focus, holder: 'wake' }, ['start-wake'])
      return done(focus)
    }

    case 'dictation-requested': {
      if (state.holder === 'dictation') {
        // 不排队。按键的人就在屏幕前等着，排一个队让他对着上一次的收音结果说话，
        // 比直接告诉他"这一次听完再按"糟得多。
        return done(state, [], '正在听你说，这一次听完再按')
      }
      const effects: AudioEffect[] = state.holder === 'wake' ? ['stop-wake'] : []
      return done({ ...state, holder: 'dictation' }, effects)
    }

    case 'dictation-finished': {
      // 超时和正常结束可能各触发一次收尾，第二次必须什么都不做 —— 否则会把刚拉起来的
      // 唤醒监听又停掉，用户下一次喊"小潘"没人应。
      if (state.holder !== 'dictation') return done(state)
      const idle = { ...state, holder: null }
      if (canStartWake(idle)) return done({ ...idle, holder: 'wake' }, ['start-wake'])
      return done(idle)
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
  }
}
