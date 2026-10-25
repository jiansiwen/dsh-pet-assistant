/**
 * 参数化可动画宠物角色。
 * 各部件以 class 命名（p-body/p-leg-l/p-eye/…），由 pet-anim.css 按 data-action 驱动动画。
 * 通过 skin 切换形象：小熊猫 / 眼镜女生 / 眼镜男生。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkinImages, SkinImageKey, SkinVideos } from './usePetImage.js'
import { nextFrame, oneShot } from './pet-interaction.js'

export type PetSkin = 'panda' | 'girl-glasses' | 'boy-glasses'

type Pose =
  | { id: string; kind: 'walk'; src: string; action?: string }
  | { id: string; kind: 'img'; src: string; action?: string }
  | { id: string; kind: 'frames'; frames: string[]; fps: number; once: boolean; action?: string }
  | { id: string; kind: 'video'; src: string; loop: boolean; action?: string }

const DEFAULT_FPS = 10
/** 这些动作由环境调度整段播放一次，播完就切；循环会在结尾回绕成第一帧，视觉上闪一下。 */
const ONE_CYCLE_ACTIONS = new Set(['play', 'read', 'wave', 'jump'])

/** 完成事件在计时器中发出，不在 React 状态更新器内发出，避免严格模式重复通知。 */
function FrameSequence({ frames, fps, once, active, onComplete }: {
  frames: string[]; fps: number; once: boolean; active: boolean; onComplete?: () => void
}) {
  const [idx, setIdx] = useState(0)
  const index = useRef(0)
  const completed = useRef(false)
  const callback = useRef(onComplete)
  callback.current = onComplete
  useEffect(() => {
    if (!active || completed.current) return
    const timer = window.setInterval(() => {
      const next = nextFrame(index.current, frames.length, once)
      index.current = next.index
      setIdx(next.index)
      if (next.complete) {
        if (once) { completed.current = true; window.clearInterval(timer) }
        callback.current?.()
      }
    }, 1000 / fps)
    return () => window.clearInterval(timer)
  }, [frames, fps, once, active])
  return <img className="pet-img pet-frame" src={frames[Math.min(idx, frames.length - 1)]} alt="" draggable={false} />
}

/**
 * 24fps 透明 WebM。旧层在淡出期间继续播放，不再冻结在最后一帧；
 * 一次性动作由 ended 驱动，循环动作交给 video 的 loop。
 */
function VideoSequence({ src, loop, active, onComplete, onReady }: {
  src: string; loop: boolean; active: boolean; onComplete?: () => void; onReady?: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const completed = useRef(false)
  const callback = useRef(onComplete)
  const readyCallback = useRef(onReady)
  const readySent = useRef(false)
  const [ready, setReady] = useState(false)
  callback.current = onComplete
  readyCallback.current = onReady
  const markReady = () => {
    if (readySent.current) return
    readySent.current = true
    // 先让新层以 opacity 0 挂一帧，再开始 220ms 淡入；否则会瞬间满亮，看起来像闪一下。
    window.setTimeout(() => {
      setReady(true)
      readyCallback.current?.()
    }, 80)
  }
  useEffect(() => {
    completed.current = false
    readySent.current = false
    setReady(false)
    const el = ref.current
    if (!el) return
    el.currentTime = 0
    void el.play().catch(() => undefined)
    return () => el.pause()
  }, [src])
  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (el) void el.play().catch(() => undefined)
  }, [active])
  return (
    <video
      ref={ref}
      className="pet-video"
      src={src}
      muted
      playsInline
      preload="auto"
      loop={loop}
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.22s linear' }}
      onLoadedData={markReady}
      onPlaying={markReady}
      onCanPlay={() => {
        markReady()
        const el = ref.current
        if (el) void el.play().catch(() => undefined)
      }}
      onEnded={() => {
        if (loop || !active || completed.current) return
        completed.current = true
        callback.current?.()
      }}
    />
  )
}

function renderPose(pose: Pose, active: boolean, onComplete?: () => void, onReady?: () => void) {
  if (pose.kind === 'video') {
    return <VideoSequence src={pose.src} loop={pose.loop} active={active} onComplete={onComplete} onReady={onReady} />
  }
  if (pose.kind === 'walk') {
    return <div className="pet-walk-frame"><img className="pet-walk-strip" src={pose.src} alt="" draggable={false} /></div>
  }
  if (pose.kind === 'frames') {
    return <FrameSequence frames={pose.frames} fps={pose.fps} once={pose.once} active={active} onComplete={onComplete} />
  }
  return <img className="pet-img" src={pose.src} alt="" draggable={false} />
}

/** 新视频真正显示后才淡出旧层；避免切换时中间出现透明空档。 */
function AnimatedPose({ pose, onComplete }: { pose: Pose; onComplete?: () => void }) {
  const [curr, setCurr] = useState(pose)
  const [prev, setPrev] = useState<Pose | null>(null)
  const [currReady, setCurrReady] = useState(true)
  const timer = useRef<number>(0)
  const readyRef = useRef(true)
  useEffect(() => {
    if (pose.id === curr.id) return
    setPrev(curr)
    setCurr(pose)
    const ready = pose.kind !== 'video'
    readyRef.current = ready
    setCurrReady(ready)
    window.clearTimeout(timer.current)
  }, [pose, curr])
  const markReady = useCallback(() => {
    if (readyRef.current) return
    readyRef.current = true
    setCurrReady(true)
  }, [])
  useEffect(() => {
    if (!prev || !currReady) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPrev(null), 380)
    return () => window.clearTimeout(timer.current)
  }, [prev, currReady])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div className="pose-stack">
      {[...(prev ? [prev] : []), curr].map(layer => {
        const isCurr = layer.id === pose.id
        const video = layer.kind === 'video'
        const className = isCurr
          ? `pose-layer pose-in${prev ? ' pose-over' : ''}${video ? ' pose-video' : ''}`
          : `pose-layer${currReady ? ' pose-out' : ''}${video ? ' pose-video' : ''}`
        return <div key={layer.id} className={className} data-pose-action={layer.action ?? ''}>
          {renderPose(layer, isCurr, isCurr ? onComplete : undefined, isCurr ? markReady : undefined)}
        </div>
      })}
    </div>
  )
}

interface Palette {
  body: string
  bodyDark: string
  belly: string
  skin: string
  hair: string
  blush: string
  outline: string
}

const PALETTES: Record<PetSkin, Palette> = {
  'panda': {
    body: '#E0784A',
    bodyDark: '#7A4028',
    belly: '#FFF3E4',
    skin: '#FFF3E4',
    hair: '#E0784A',
    blush: '#FF9E9E',
    outline: '#5C3320',
  },
  'girl-glasses': {
    body: '#7FC8C0',
    bodyDark: '#5BA8A0',
    belly: '#FFFDF7',
    skin: '#FFE0C7',
    hair: '#6B4A3A',
    blush: '#FF9E9E',
    outline: '#4A3628',
  },
  'boy-glasses': {
    body: '#7FA8D9',
    bodyDark: '#5F88B9',
    belly: '#FFFDF7',
    skin: '#FFE0C7',
    hair: '#2F2A26',
    blush: '#FF9E9E',
    outline: '#241F1C',
  },
}

const joint = (ox: string, oy: string) => ({
  transformBox: 'fill-box' as const,
  transformOrigin: `${ox} ${oy}`,
})

export default function PetSprite({
  skin, images, frames = {}, videos = {}, action, dragging = false, animationVersion = 0, onComplete,
}: {
  skin: PetSkin
  images: SkinImages
  frames?: Partial<Record<string, string[]>>
  videos?: SkinVideos
  action?: string
  dragging?: boolean
  animationVersion?: number
  onComplete?: (action: string, version: number) => void
}) {
  const p = PALETTES[skin]
  const isPanda = skin === 'panda'
  const canGrab = Boolean(videos['grab'] || frames['grab']?.length)
  const effective = dragging && canGrab ? 'grab' : action
  const frameList = effective ? frames[effective] : undefined
  const videoSrc = effective ? videos[effective] : undefined
  const callback = useRef(onComplete)
  callback.current = onComplete
  // 没有该动作素材的备用皮肤沿用静态降级，但不能让交互状态永远卡住。
  useEffect(() => {
    if (dragging || frameList?.length || videoSrc || !action || (!oneShot(action) && action !== 'write')) return
    const durations: Record<string, number> = { drop: 3900, lie: 5000, 'laptop-in': 3500, 'laptop-out': 2300, write: 1600, 'walk-stop': 300 }
    const timer = window.setInterval(() => callback.current?.(action, animationVersion), durations[action])
    return () => window.clearInterval(timer)
  }, [action, animationVersion, dragging, frameList, videoSrc])
  const pose: Pose | null = videoSrc
    ? { id: `video:${skin}:${effective}:${animationVersion}:${videoSrc}`, kind: 'video', src: videoSrc, loop: !oneShot(effective) && !(effective !== undefined && ONE_CYCLE_ACTIONS.has(effective)), action: effective }
    : frameList?.length
    ? { id: `frames:${skin}:${effective}:${animationVersion}:${frameList.length}`, kind: 'frames', frames: frameList, fps: DEFAULT_FPS, once: oneShot(effective) }
    : effective === 'walk' && images.walk
      ? { id: `walk:${images.walk}`, kind: 'walk', src: images.walk }
      : (() => {
          const key = effective as SkinImageKey | undefined
          const src = (key && images[key]) || images.idle
          return src ? { id: `img:${src}`, kind: 'img', src } : null
        })()

  if (pose) {
    return (
      <div className="pet-flip">
        <AnimatedPose pose={pose} onComplete={!dragging && action ? () => onComplete?.(action, animationVersion) : undefined} />
      </div>
    )
  }

  // 素材没到位就不显示，避免看到不匹配的默认形象。
  return null
  // eslint-disable-next-line no-unreachable
  return (
    <svg className="pet-svg" viewBox="0 0 200 200" width="150" height="150">
      <g className="pet-flip">
        {/* 影子 */}
        <ellipse cx="100" cy="190" rx="52" ry="8" fill="#000" opacity="0.12" />

        {/* 尾巴（小熊猫） */}
        {isPanda && (
          <g className="p-tail" style={joint('10%', '90%')}>
            <circle cx="152" cy="150" r="16" fill={p.body} />
            <circle cx="163" cy="134" r="13" fill={p.bodyDark} />
            <circle cx="168" cy="116" r="11" fill={p.body} />
            <circle cx="165" cy="100" r="9" fill={p.belly} />
          </g>
        )}

        {/* 后腿/腿 */}
        <g className="p-leg-l" style={joint('50%', '8%')}>
          <rect x="78" y="150" width="16" height="40" rx="8" fill={isPanda ? p.bodyDark : p.skin} />
        </g>
        <g className="p-leg-r" style={joint('50%', '8%')}>
          <rect x="106" y="150" width="16" height="40" rx="8" fill={isPanda ? p.bodyDark : p.skin} />
        </g>

        {/* 身体 */}
        <g className="p-body" style={joint('50%', '100%')}>
          <ellipse cx="100" cy="142" rx="36" ry="32" fill={p.body} />
          <ellipse cx="100" cy="152" rx="22" ry="20" fill={p.belly} />
        </g>

        {/* 手臂 */}
        <g className="p-arm-l" style={joint('50%', '10%')}>
          <rect x="60" y="118" width="14" height="36" rx="7" fill={isPanda ? p.bodyDark : p.skin} transform="rotate(18 67 122)" />
        </g>
        <g className="p-arm-r" style={joint('50%', '10%')}>
          <rect x="126" y="118" width="14" height="36" rx="7" fill={isPanda ? p.bodyDark : p.skin} transform="rotate(-18 133 122)" />
        </g>

        {/* 头 */}
        <g className="p-head" style={joint('50%', '90%')}>
          {/* 耳朵（小熊猫） */}
          {isPanda && (
            <>
              <polygon points="58,52 78,20 92,50" fill={p.body} />
              <polygon points="66,48 78,28 86,48" fill={p.belly} />
              <polygon points="142,52 122,20 108,50" fill={p.body} />
              <polygon points="134,48 122,28 114,48" fill={p.belly} />
            </>
          )}
          {/* 后发（人） */}
          {!isPanda && (
            <path d="M 52 84 Q 46 26 100 22 Q 154 26 148 84 L 148 108 Q 140 116 134 108 L 134 78 L 66 78 L 66 108 Q 60 116 52 108 Z" fill={p.hair} />
          )}
          <circle cx="100" cy="78" r="48" fill={isPanda ? p.body : p.skin} />
          {/* 刘海（人） */}
          {!isPanda && (
            <path d="M 56 74 Q 56 34 100 32 Q 144 34 144 74 Q 134 56 118 52 Q 124 62 118 68 Q 104 50 80 54 Q 62 60 60 76 Q 58 76 56 74 Z" fill={p.hair} />
          )}
          {/* 小熊猫脸部白斑 */}
          {isPanda && (
            <>
              <ellipse cx="76" cy="92" rx="16" ry="13" fill={p.belly} />
              <ellipse cx="124" cy="92" rx="16" ry="13" fill={p.belly} />
              <ellipse cx="100" cy="100" rx="20" ry="15" fill={p.belly} />
              <ellipse cx="84" cy="60" rx="8" ry="6" fill={p.belly} />
              <ellipse cx="116" cy="60" rx="8" ry="6" fill={p.belly} />
            </>
          )}

          {/* 睁眼 */}
          <g className="p-eye">
            <ellipse cx="82" cy="78" rx="7" ry="9" fill={p.outline} />
            <ellipse cx="118" cy="78" rx="7" ry="9" fill={p.outline} />
            <circle cx="84.5" cy="74.5" r="2.6" fill="#fff" />
            <circle cx="120.5" cy="74.5" r="2.6" fill="#fff" />
          </g>
          {/* 闭眼（睡觉） */}
          <g className="p-eye-closed">
            <path d="M 75 78 Q 82 84 89 78" stroke={p.outline} strokeWidth="3" strokeLinecap="round" fill="none" />
            <path d="M 111 78 Q 118 84 125 78" stroke={p.outline} strokeWidth="3" strokeLinecap="round" fill="none" />
          </g>

          {/* 眼镜 */}
          {skin === 'girl-glasses' && (
            <g className="p-glasses" stroke={p.outline} strokeWidth="3.5" fill="#fff" fillOpacity="0.25">
              <circle cx="82" cy="78" r="14" />
              <circle cx="118" cy="78" r="14" />
              <line x1="96" y1="78" x2="104" y2="78" />
            </g>
          )}
          {skin === 'boy-glasses' && (
            <g className="p-glasses" stroke={p.outline} strokeWidth="3.5" fill="#fff" fillOpacity="0.25">
              <rect x="68" y="66" width="28" height="24" rx="6" />
              <rect x="104" y="66" width="28" height="24" rx="6" />
              <line x1="96" y1="76" x2="104" y2="76" />
            </g>
          )}

          {/* 腮红 */}
          <ellipse cx="68" cy="94" rx="8" ry="5" fill={p.blush} opacity="0.55" />
          <ellipse cx="132" cy="94" rx="8" ry="5" fill={p.blush} opacity="0.55" />

          {/* 嘴 */}
          <g className="p-mouth">
            <path d="M 93 98 Q 100 104 107 98" stroke={p.outline} strokeWidth="3" strokeLinecap="round" fill="none" />
          </g>
          <g className="p-mouth-happy">
            <path d="M 90 96 Q 100 110 110 96 Q 100 102 90 96 Z" fill="#B0524A" />
          </g>
          {isPanda && <ellipse cx="100" cy="92" rx="6" ry="4.5" fill={p.outline} />}

          {/* Zzz（睡觉） */}
          <g className="p-zzz" fill="#8f9fe7" fontWeight="700">
            <text x="146" y="40" fontSize="20">Z</text>
            <text x="158" y="28" fontSize="14">z</text>
          </g>
        </g>

        {/* 开心星星 */}
        <g className="p-sparkle" fill="#FFD75E">
          <path d="M 40 60 l 4 8 8 4 -8 4 -4 8 -4 -8 -8 -4 8 -4 Z" />
          <path d="M 160 70 l 3 6 6 3 -6 3 -3 6 -3 -6 -6 -3 6 -3 Z" />
        </g>
      </g>
    </svg>
  )
}
