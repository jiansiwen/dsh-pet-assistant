/**
 * 多角色舞台：在一个铺满屏幕的透明窗口里渲染团队里所有**已启用**的角色。
 *
 * 不开多个 BrowserWindow —— 窗口本来就是全屏透明的，多角色只是多个绝对定位的 sprite，
 * 共用一套素材缓存和一个鼠标穿透判断。多窗口的代价是 N 份合成器开销和 N 套穿透协商。
 *
 * 四件事在这里发生：
 *
 * 1. **座位排布**。角色沿屏幕底部排开；窗口尺寸变化（多屏切换、DPI 改变）后重新夹紧。
 * 2. **命中盒注册**。鼠标穿透要靠"鼠标是否落在某个角色身上"来决定，而角色每 16ms 就可能
 *    移动一次。用 React state 上报位置等于让根组件每秒重渲染六十次，所以命中盒写进
 *    模块级注册表，穿透判断命令式地读它。
 * 3. **状态投影**。任务状态映射成动作与角标，并且让行为引擎进入工作态 —— 只投影动作
 *    不够，随机调度两三秒后就会把它改成打瞌睡。
 * 4. **群体场景**。麻将/开黑/闲聊期间场景临时接管位置、动作、朝向与绘制层，见
 *    `useGroupScene.ts`。注意是"临时接管"：`home` 始终是角色自己的锚点，场景走位用
 *    `walkTo` 而不是 `setPos`，否则一场麻将之后五个角色的家就全搬到桌子边上了。
 *
 * 排布算法、投影规则与命中盒几何都在 `stage-layout.ts`：那些是不认识 React 的纯函数，
 * 拆出去才测得了（Node 跑得动 .ts，跑不动 .tsx）。这个文件只负责把它们接到 hook 和 DOM 上。
 *
 * 未启用的席位不渲染，也不播放假工作：桌上站着几个假装在干活的熊猫，比空着更误导人。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PetSprite from './PetSprite.js'
import PortalExit, { type PortalPhase } from './PortalExit.js'
import { manifestFor, markForeground, resolveAction, type CharacterManifest, type SkinOverrides } from './character-manifest.js'
import type { CharacterMenuTarget } from './types.js'
import { depthToZIndex, type SceneRole } from './group-scene.js'
import { PET_WIDTH } from './pet-metrics.js'
import { proactiveButtons } from './proactive-ui.js'
import { useGroupScene } from './useGroupScene.js'
import { usePetBehavior, type PetAction, type PetBehavior } from './usePetBehavior.js'
import { usePetFrames, usePetSkinImages } from './usePetImage.js'
import {
  actionForStatus,
  characterHitbox,
  clampToViewport,
  isWorking,
  needsAttention,
  proactiveHitboxExtra,
  registerCharacterHitbox,
  seatPositions,
  unregisterCharacterHitbox,
  type ExitStage,
  type StageMember,
  type StageTaskStatus,
} from './stage-layout.js'

export interface TeamStageHandle {
  /** 让指定角色出声（抢占式）。用户点名或回复落到谁身上，谁就得说话。 */
  sayTo(assistantId: string, text: string, ms?: number): void
  pokeOf(assistantId: string): void
  writeOf(assistantId: string): void
  /** 退场：冻住全部角色。 */
  freezeAll(): void
  /** 退场编排里强制全体做同一个动作。 */
  forceAll(action: PetAction): void
  /** 面板要贴着谁弹。选中角色的 behavior 还没就绪时退回它的座位。 */
  anchorPosition(): { x: number; y: number } | null
}

interface CharacterSlotProps {
  manifest: CharacterManifest
  home: { x: number; y: number }
  /** 群体场景对这一帧的投影。不在场景里时各字段都是中性值（见 `sceneRole`）。 */
  scene: SceneRole
  assistantActive: boolean
  status: StageTaskStatus | undefined
  selected: boolean
  exitStage: ExitStage
  portalPhase: PortalPhase
  showPortal: boolean
  /** 专注模式：压掉随机发言。点名应答（`say`）不受影响。 */
  quiet: boolean
  /** 主动提醒（§2.7）：只挂在一个角色（选中的那个）头顶，null 表示没有待回应的提醒。 */
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  onBehavior(behavior: PetBehavior | null): void
  onSelect(position: { x: number; y: number }): void
  onPersist(x: number, y: number): void
  onContextMenu(): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
}

/**
 * 单个角色。
 *
 * 一个角色一个组件实例，这样 hook 调用顺序固定，角色增减时 React 直接挂载/卸载，
 * 不必在循环里条件调用 hook。
 */
function CharacterSlot({
  manifest,
  home,
  scene,
  assistantActive,
  status,
  selected,
  exitStage,
  portalPhase,
  showPortal,
  quiet,
  proactive,
  onProactiveRespond,
  onBehavior,
  onSelect,
  onPersist,
  onContextMenu,
  onDragStart,
}: CharacterSlotProps) {
  const working = isWorking(status)
  const behavior = usePetBehavior({
    assistantActive,
    lines: manifest.lines,
    home,
    working,
    sceneBound: scene.bound,
    quiet,
    onPersist,
  })
  const images = usePetSkinImages(manifest.skin)
  const frames = usePetFrames(manifest.skin)

  useEffect(() => {
    onBehavior(behavior)
    return () => onBehavior(null)
  }, [behavior, onBehavior])

  /**
   * 座位变化（resize、多屏切换）后把角色夹回可见区域。
   *
   * 不能把 behavior 放进依赖：它每次渲染都是新对象，effect 会每轮都跑一次 setPos，
   * 而 setPos 会把用户刚拖到的位置强行改回座位 —— 拖拽就再也留不住了。
   * 所以只记"上一次应用过的座位"，座位真的变了才动。
   */
  const appliedSeat = useRef(home)
  const setPos = behavior.setPos
  useEffect(() => {
    const previous = appliedSeat.current
    if (previous.x === home.x && previous.y === home.y) return
    appliedSeat.current = home
    setPos(home.x, home.y)
  }, [home, setPos])

  // 命中盒：位置每次变化都更新，卸载时摘掉自己。
  // 头顶挂着提醒气泡时把盒子扩到气泡顶：气泡是窗口里唯一悬在角色上方的可点元素，
  // 盒子不跟上它，那次点击就会穿透到桌面。
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [bubbleHeight, setBubbleHeight] = useState(0)
  useLayoutEffect(() => {
    if (!proactive) {
      setBubbleHeight(0)
      return
    }
    setBubbleHeight(bubbleRef.current?.offsetHeight ?? 0)
  }, [proactive])
  useEffect(() => {
    const extra = proactive ? proactiveHitboxExtra(bubbleHeight) : 0
    registerCharacterHitbox(manifest.assistantId, characterHitbox(behavior.x, behavior.y, extra))
    return () => {
      unregisterCharacterHitbox(manifest.assistantId)
    }
  }, [manifest.assistantId, behavior.x, behavior.y, proactive, bubbleHeight])

  /**
   * 场景领位：入场时走到座位，退场时走回自己的位置。
   *
   * 依赖用**坐标数字**而不是 `scene.destination` 对象：对象每次渲染都是新的，effect 就会
   * 每拍重发一次 walkTo，角色永远在"重新起步"，一步也走不出去。
   *
   * 用户把座位上的角色拖走时这里不会把它拽回去 —— 用户的手比场景的编排优先。它会就地继续演，
   * 直到退场才被领着回自己的位置。
   */
  const walkTo = behavior.walkTo
  const destX = scene.destination?.x
  const destY = scene.destination?.y
  useEffect(() => {
    if (destX == null || destY == null) return
    walkTo(destX, destY)
  }, [destX, destY, walkTo])

  /**
   * 动作优先级：工作投影 > 场景编排 > 生活随机。
   *
   * 任务在跑而人在打牌是最坏的一种不一致（计划的退出条件之一就是"真工作与动画一致"），
   * 所以场景只在没有工作投影时才发牌。两个 effect 可能在同一次提交里都跑（状态刚变成
   * working、场景还没在下一次步进里放掉座位），声明顺序就是优先级：场景先让路，工作后落槌。
   */
  const projected = actionForStatus(status)
  const sceneAction = scene.action
  const force = behavior.force
  useEffect(() => {
    if (sceneAction && !projected) force(sceneAction)
  }, [sceneAction, projected, force])
  // 工作状态压过生活状态：任务一来就摆出对应动作（随机调度那边靠 working 让路）。
  useEffect(() => {
    if (projected) force(projected)
  }, [projected, force])

  /**
   * 缺动作降级：这套皮肤没有当前动作的素材时退到 idle。
   * 连 idle 都没有（素材还没加载完）就传 undefined 给 PetSprite，让它落到内联 SVG ——
   * 绝不能因为一张图没到位就让角色从舞台上消失。
   */
  const available = useMemo(() => {
    const set = new Set<string>(Object.keys(images))
    for (const action of Object.keys(frames)) set.add(action)
    return set
  }, [images, frames])
  const effectiveAction = resolveAction(behavior.action, available)

  /**
   * 名牌文字色：底色是色标，所以文字要按色标亮度挑黑或白。
   * 五个色标的白字对比是 5.47 / 4.71 / 4.60 / 4.99 / 6.98，全部 AA；
   * 但这套逻辑对插件新加的备用色标同样成立，不能写死成白色。
   */
  const markForegroundColor = useMemo(() => markForeground(manifest.markColor), [manifest.markColor])

  const attention = needsAttention(status)
  /** 围坐时朝向由场景给（谁都看向桌子中心），场景不管时沿用角色自己的。 */
  const facing = scene.facing ?? behavior.facing

  return (
    <div
      className={[
        'pet-stage',
        'character-slot',
        `action-${behavior.action}`,
        facing === -1 ? 'facing-left' : '',
        exitStage === 'turn' ? 'exit-turn' : '',
        exitStage === 'jump' ? 'exit-jump' : '',
        selected ? 'selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: behavior.x,
        top: behavior.y,
        width: PET_WIDTH,
        // 麻将的桌子要夹在远排与近排之间，这个前后关系是"围着一张桌子"唯一的视觉依据。
        zIndex: depthToZIndex(scene.depth),
        ['--mark' as string]: manifest.markColor,
        ['--mark-fg' as string]: markForegroundColor,
      }}
      data-assistant-id={manifest.assistantId}
      data-interactive
      onMouseDown={(event) => {
        onSelect({ x: behavior.x, y: behavior.y })
        onDragStart(event, behavior)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu()
      }}
    >
      {showPortal && <PortalExit phase={portalPhase} />}
      {behavior.bubble && !behavior.dragging && <div className="pet-bubble">{behavior.bubble}</div>}

      {proactive && (
        <div ref={bubbleRef} className="proactive-bubble" data-interactive role="dialog" aria-label="主动提醒">
          <p className="proactive-text">{proactive.message}</p>
          <div className="proactive-actions">
            {proactiveButtons(proactive.suggestDisable).map(button => (
              <button
                key={button.kind}
                type="button"
                className="proactive-btn"
                onClick={() => onProactiveRespond(button.kind)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {attention ? (
        <div className="character-alert" title="有事等你处理">
          !
        </div>
      ) : (
        assistantActive && <div className="pet-badge" title="个人助理模式运行中" />
      )}

      {exitStage !== 'gone' && (
        <PetSprite
          skin={manifest.skin}
          images={images}
          frames={frames}
          action={effectiveAction ?? undefined}
          dragging={behavior.dragging}
        />
      )}
    </div>
  )
}

export interface TeamStageProps {
  /** 团队编制。只有 enabled 的成员会上台。 */
  members: readonly StageMember[]
  assistantActive: boolean
  /** 任务状态投影，按 assistantId 索引。 */
  statusByAssistant?: Readonly<Record<string, StageTaskStatus>>
  /** 用户拖出来的自定义座位，覆盖默认排布；没有的角色按座位顺序排。 */
  positions?: Readonly<Record<string, { x: number; y: number }>>
  selectedId: string | null
  onSelect(assistantId: string, position: { x: number; y: number }): void
  exitStage: ExitStage
  portalPhase: PortalPhase
  /** 退场时每个角色身后都开一个通道：他们是一起走的。 */
  showPortal?: boolean
  /**
   * 专注模式：不随机发言、不开群体娱乐。
   *
   * 真源在主进程（托盘那一项），经 companion-state 流到 App 再传下来。舞台自己绝不推断
   * "现在是不是在开会" —— 它看不到屏幕共享状态，猜只会猜错。
   */
  focusMode?: boolean
  /** 用户在本机为每个角色挑的形象，键是 assistantId。压过插件下发的 skinId。 */
  characterSkins?: SkinOverrides
  onPersist(assistantId: string, x: number, y: number): void
  /** 在某个角色上弹原生菜单。要把是谁报上去：主进程不知道台上站着谁。 */
  onContextMenu(target: CharacterMenuTarget): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
  /** 主动提醒：渲染在选中角色头顶，用户点选后经 onProactiveRespond 回执。 */
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  handleRef?: React.MutableRefObject<TeamStageHandle | null>
}

export default function TeamStage({
  members,
  assistantActive,
  statusByAssistant,
  positions,
  selectedId,
  onSelect,
  exitStage,
  portalPhase,
  showPortal = false,
  focusMode = false,
  characterSkins,
  onPersist,
  onContextMenu,
  onDragStart,
  proactive,
  onProactiveRespond,
  handleRef,
}: TeamStageProps) {
  const cast = useMemo(
    () =>
      members
        .filter((member) => member.enabled !== false && member.assistantId)
        .map((member) => manifestFor(member, characterSkins)),
    [members, characterSkins],
  )

  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1920 : window.innerWidth,
    height: typeof window === 'undefined' ? 1080 : window.innerHeight,
  }))

  // 多屏切换与 DPI 变化都会触发 resize：重新算座位，把角色夹回可见区域。
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const seats = useMemo(() => seatPositions(cast.length, viewport.width, viewport.height), [cast.length, viewport])

  /** 实际落座位置：用户拖过的座位优先，其余按顺序排。 */
  const homes = useMemo(
    () =>
      cast.map((manifest, index) => {
        const saved = positions?.[manifest.assistantId]
        return saved ? clampToViewport(saved, viewport.width, viewport.height) : (seats[index] ?? { x: 8, y: 8 })
      }),
    [cast, positions, seats, viewport],
  )

  /**
   * 场景编制：只有还空着的人能被拉去占座。
   *
   * 判断"谁在干活"用的是和面板、角标同一个 `isWorking`，不是另写一套 ——
   * 计划的退出条件之一是"真工作与动画一致"，两处判据不同就不可能一致。
   *
   * 专注模式给**空编制**，而不是给 useGroupScene 加一个 enabled 开关：空编制就是"一个空闲的人
   * 都没有"，走的正是已经测过的"人数不足就散场"那条路 —— 正在演的那一场就地散掉、走退场动画、
   * 进冷却。加开关就得在场景状态机里再开一条分支，而那条分支要做的事和这条一模一样。
   */
  const sceneCast = useMemo(
    () =>
      focusMode
        ? []
        : cast.map((manifest) => ({
          assistantId: manifest.assistantId,
          working: isWorking(statusByAssistant?.[manifest.assistantId]),
        })),
    [cast, statusByAssistant, focusMode],
  )

  const scene = useGroupScene({ cast: sceneCast, width: viewport.width, height: viewport.height })

  // 选中态只看编制，不查 behavior 是否已就绪：渲染期间读 ref 拿到的是上一轮的值，
  // 刚挂载的角色会被误判成"没有 behavior"而丢掉高亮。
  const selected = useMemo(() => {
    if (selectedId && cast.some((item) => item.assistantId === selectedId)) return selectedId
    return cast[0]?.assistantId ?? null
  }, [selectedId, cast])

  const behaviors = useRef(new Map<string, PetBehavior>())
  /** 每个角色的 behavior 回调必须稳定，否则 CharacterSlot 的注册 effect 会反复重挂。 */
  const callbacks = useRef(new Map<string, (behavior: PetBehavior | null) => void>())
  const callbackFor = useCallback((assistantId: string) => {
    let slot = callbacks.current.get(assistantId)
    if (!slot) {
      slot = (behavior: PetBehavior | null) => {
        if (behavior) behaviors.current.set(assistantId, behavior)
        else behaviors.current.delete(assistantId)
      }
      callbacks.current.set(assistantId, slot)
    }
    return slot
  }, [])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      sayTo(assistantId, text, ms) {
        behaviors.current.get(assistantId)?.say(text, ms)
      },
      pokeOf(assistantId) {
        behaviors.current.get(assistantId)?.poke()
      },
      writeOf(assistantId) {
        behaviors.current.get(assistantId)?.doWrite()
      },
      freezeAll() {
        for (const behavior of behaviors.current.values()) behavior.freeze()
      },
      forceAll(action) {
        for (const behavior of behaviors.current.values()) behavior.force(action)
      },
      anchorPosition() {
        const index = selected ? cast.findIndex((item) => item.assistantId === selected) : -1
        const behavior = selected ? behaviors.current.get(selected) : undefined
        if (behavior) return { x: behavior.x, y: behavior.y }
        return homes[Math.max(index, 0)] ?? null
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef, selected, cast, homes])

  // 编制变化时清掉不再上台的角色，否则句柄会继续操作已卸载的角色。
  useEffect(() => {
    const alive = new Set(cast.map((item) => item.assistantId))
    for (const key of [...behaviors.current.keys()]) {
      if (!alive.has(key)) {
        behaviors.current.delete(key)
        callbacks.current.delete(key)
      }
    }
  }, [cast])

  return (
    <>
      {scene.prop && (
        <div
          className={`scene-prop scene-prop-${scene.prop.shape}`}
          aria-hidden
          style={{
            left: scene.prop.x,
            top: scene.prop.y,
            width: scene.prop.width,
            height: scene.prop.height,
            zIndex: depthToZIndex(scene.prop.depth),
          }}
        />
      )}
      {cast.map((manifest, index) => {
        const home = homes[index] ?? { x: 8, y: 8 }
        return (
          <CharacterSlot
            key={manifest.assistantId}
            manifest={manifest}
            home={home}
            scene={scene.roleOf(manifest.assistantId, home)}
            assistantActive={assistantActive}
            status={statusByAssistant?.[manifest.assistantId]}
            selected={manifest.assistantId === selected}
            exitStage={exitStage}
            portalPhase={portalPhase}
            showPortal={showPortal}
            quiet={focusMode}
            proactive={manifest.assistantId === selected ? proactive : null}
            onProactiveRespond={onProactiveRespond}
            onBehavior={callbackFor(manifest.assistantId)}
            onSelect={(position) => onSelect(manifest.assistantId, position)}
            onPersist={(x, y) => onPersist(manifest.assistantId, x, y)}
            onContextMenu={() =>
              onContextMenu({
                assistantId: manifest.assistantId,
                displayName: manifest.displayName,
                skin: manifest.skin,
              })
            }
            onDragStart={onDragStart}
          />
        )
      })}
    </>
  )
}
