/**
 * 漩涡通道：宠物退场时在身后展开的空间漩涡。
 *
 * phase 驱动两段动画（时长在 portal.css 中定义，与 App.tsx 的退场时间线对齐）：
 * - opening：0.7s 从中心放大出现并带旋转
 * - open：持续旋转（多层环反向转动 + 中心暗核呼吸）
 * - closing：1.2s 缩小消散
 * - closed：不渲染
 */
export type PortalPhase = 'opening' | 'open' | 'closing' | 'closed'

export default function PortalExit({ phase }: { phase: PortalPhase }) {
  if (phase === 'closed') return null
  return (
    <div className={`portal portal-${phase}`} aria-hidden="true">
      <div className="portal-ring portal-ring-1" />
      <div className="portal-ring portal-ring-2" />
      <div className="portal-ring portal-ring-3" />
      <div className="portal-core" />
    </div>
  )
}
