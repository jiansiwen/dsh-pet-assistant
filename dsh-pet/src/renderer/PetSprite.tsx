/**
 * 参数化可动画宠物角色。
 * 各部件以 class 命名（p-body/p-leg-l/p-eye/…），由 pet-anim.css 按 data-action 驱动动画。
 * 通过 skin 切换形象：小熊猫 / 眼镜女生 / 眼镜男生。
 */

import { useEffect, useRef, useState } from 'react'
import type { SkinImages, SkinImageKey } from './usePetImage.js'

export type PetSkin = 'panda' | 'girl-glasses' | 'boy-glasses'

type Pose =
  | { id: string; kind: 'walk'; src: string }
  | { id: string; kind: 'img'; src: string }
  | { id: string; kind: 'frames'; frames: string[]; fps: number }

/** 序列帧播放帧率：与抽帧帧率一致，1 倍速原速回放。 */
const DEFAULT_FPS = 10

/** 逐帧播放器：帧内切换不做淡入，连贯播放形成动画。 */
function FrameSequence({ frames, fps }: { frames: string[]; fps: number }) {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    setIdx(0)
    if (frames.length < 2) return
    const timer = window.setInterval(() => setIdx(i => (i + 1) % frames.length), 1000 / fps)
    return () => window.clearInterval(timer)
  }, [frames, fps])

  return <img className="pet-img pet-frame" src={frames[Math.min(idx, frames.length - 1)]} alt="" draggable={false} />
}

function renderPose(pose: Pose) {
  if (pose.kind === 'walk') {
    return (
      <div className="pet-walk-frame">
        <img className="pet-walk-strip" src={pose.src} alt="" draggable={false} />
      </div>
    )
  }
  if (pose.kind === 'frames') {
    return <FrameSequence frames={pose.frames} fps={pose.fps} />
  }
  return <img className="pet-img" src={pose.src} alt="" draggable={false} />
}

/** 交叉淡入淡出 + 缩放补间，让姿势切换像动画过渡而非硬切图。 */
function AnimatedPose({ pose }: { pose: Pose }) {
  const [curr, setCurr] = useState(pose)
  const [prev, setPrev] = useState<Pose | null>(null)
  const timer = useRef<number>(0)
  const currIdRef = useRef(pose.id)

  useEffect(() => {
    // 只用 id 判断是否换姿势：重渲染产生的新 pose 对象不会误触切换，
    // 也不能在这里 cleanup 定时器（否则重渲染会取消"移除旧层"的定时器）
    if (pose.id === currIdRef.current) return
    currIdRef.current = pose.id
    setPrev(curr)
    setCurr(pose)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPrev(null), 300)
  }, [pose, curr])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <div className="pose-stack">
      {prev && <div className="pose-layer pose-out">{renderPose(prev)}</div>}
      <div className={`pose-layer pose-in${prev ? ' pose-over' : ''}`}>{renderPose(curr)}</div>
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
  skin,
  images,
  frames = {},
  action,
  dragging = false,
}: {
  skin: PetSkin
  images: SkinImages
  frames?: Partial<Record<string, string[]>>
  action?: string
  dragging?: boolean
}) {
  const p = PALETTES[skin]
  const isPanda = skin === 'panda'

  const effective = dragging && frames['grab']?.length ? 'grab' : action
  const frameList = effective ? frames[effective] : undefined

  const pose: Pose | null = frameList?.length
    ? { id: `frames:${effective}:${frameList.length}`, kind: 'frames', frames: frameList, fps: DEFAULT_FPS }
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
        <AnimatedPose pose={pose} />
      </div>
    )
  }

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
