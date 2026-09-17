/**
 * 群体场景的渲染侧接线：把 `group-scene.ts` 的纯状态机挂到共享场景时钟上。
 *
 * 计划里这一块叫 `useGroupScene.ts`。状态机、座位几何、表演节拍都在那个纯模块里
 * （`.ts` 才进得了 `node --test`，沾了 React 就测不了），这里只剩三件事：按时钟步进、
 * 把状态换成座位与道具、给每个角色算一份投影。
 *
 * **不另起定时器**。`scene-clock.ts` 存在的意义就是把全场唤醒合成一个，这里再挂一个
 * `setInterval(250)` 等于把刚省下来的开销加回去。所以每拍（16ms）都步进一次：一次
 * O(人数) 的纯函数调用，比五个角色各自的每帧位移便宜得多，而"任务一来座位立刻放掉"
 * 因此是**这一帧**就发生，不用等到下一个 250ms 边界。
 *
 * 重渲染靠引用相等跳过：`stepScene` 在什么都没变时返回**原对象**，所以下面的判断能挡住
 * 绝大多数拍，一整场戏只因阶段切换重渲染五六次。
 *
 * 但循环阶段的表演节拍（2.4 秒换一个人出牌）并不改变 `SceneState`，光靠引用相等就永远不动。
 * 所以另存一个 `now`，只在**阶段变了或节拍换了**的时候才更新它，渲染层据此重算动作 ——
 * 频率是每 2.4 秒一次，不是每帧。
 *
 * 权威状态放在 `stateRef` 而不是从 `view` 读：`setView` 到重渲染之间还会有 tick 进来，
 * 读到旧状态就会把同一步算两遍。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  idleScene,
  sceneBeat,
  sceneProp,
  sceneRole,
  sceneSeats,
  stepScene,
  type SceneCandidate,
  type SceneProp,
  type SceneRole,
  type SceneSeat,
  type SceneState,
} from './group-scene.js'
import { subscribeTick } from './scene-clock.js'

export interface GroupSceneOptions {
  /** 台上的人，按编制顺序。只有启用的角色进来；`working` 决定能不能被拉去占座。 */
  cast: readonly SceneCandidate[]
  /** 舞台尺寸。座位与道具几何要用，窗口尺寸变化（多屏、DPI）后必须重算。 */
  width: number
  height: number
}

export interface GroupScene {
  readonly state: SceneState
  readonly seats: readonly SceneSeat[]
  /** 麻将桌 / 开黑长桌。闲聊没有道具，退场时道具先收，所以是 null。 */
  readonly prop: SceneProp | null
  /**
   * 某个角色这一帧归场景管的部分。`home` 是它自己的徘徊锚点 ——
   * 退场时目的地是家而不是座位，所以这个函数需要知道家在哪。
   */
  roleOf(assistantId: string, home: { x: number; y: number }): SceneRole
}

export function useGroupScene({ cast, width, height }: GroupSceneOptions): GroupScene {
  const [view, setView] = useState(() => {
    const now = Date.now()
    return { state: idleScene(now), now }
  })

  const stateRef = useRef(view.state)
  const beatRef = useRef(-1)
  const castRef = useRef(cast)
  castRef.current = cast

  useEffect(
    () =>
      subscribeTick(() => {
        const now = Date.now()
        const next = stepScene(stateRef.current, castRef.current, now)
        const beat = sceneBeat(next, now)
        if (next === stateRef.current && beat === beatRef.current) return
        stateRef.current = next
        beatRef.current = beat
        setView({ state: next, now })
      }),
    [],
  )

  const { state, now } = view
  const seats = useMemo(() => sceneSeats(state, width, height), [state, width, height])
  const prop = useMemo(() => sceneProp(state, seats, width, height), [state, seats, width, height])

  return { state, seats, prop, roleOf: (assistantId, home) => sceneRole(state, seats, assistantId, home, now) }
}
