/**
 * 个人助理工作台的样式常量。
 *
 * 为什么是 TS 而不是 CSS 文件：客户端插件没有样式构建链（esbuild 只打 JS，宿主也不加载
 * 额外样式表），写一个 .css 进去不会被任何人读取。所以样式只能以内联对象的形式存在，
 * 集中在这个文件里至少能保证同一种卡片只有一个定义。
 *
 * 视觉口径：白底、留白足、卡片化 —— 卡片只有 1px 描边与圆角，不加阴影；主色只用在
 * 主按钮、选中 tab 与状态点。不要渐变、不要重色块。
 *
 * 两处按用户反馈调过：
 * 1. 页面**撑满**（上限 1200px）而不是居中 880px 小框 —— 后者旁边空一大块，看起来像没做完；
 * 2. 顶部**压缩**：标题、说明、连接状态各占一行就够，不给它们各配一张大卡。
 */

import type { CSSProperties } from 'react'

export const TOKENS = {
  /** 内容上限：再宽一行字就太长，但也不能窄成一个小框。 */
  maxWidth: 'min(1200px, 100%)',
  ink: '#1f2329',
  muted: 'rgba(31,35,41,.6)',
  faint: 'rgba(31,35,41,.42)',
  line: '#eceef2',
  soft: '#f7f8fa',
  primary: '#4a7dff',
  green: '#22c55e',
  grey: '#c9ccd3',
  amber: '#f59e0b',
  ok: '#15803d',
  bad: '#dc2626',
} as const

export const page: CSSProperties = {
  maxWidth: TOKENS.maxWidth,
  margin: '0 auto',
  padding: '28px 32px 40px',
  color: TOKENS.ink,
  font: '400 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  boxSizing: 'border-box',
}

export const header: CSSProperties = { margin: '0 0 14px' }
export const titleRow: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 4px', flexWrap: 'wrap' }
export const title: CSSProperties = { fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '.2px' }
export const badge: CSSProperties = {
  fontSize: 12, lineHeight: '20px', padding: '0 8px', borderRadius: 6,
  background: '#f2f3f5', color: TOKENS.muted, whiteSpace: 'nowrap',
}
export const subtitle: CSSProperties = { fontSize: 13, margin: 0, color: TOKENS.muted }

/** 顶部状态条：一行、高 ≤44px。 */
export const statusBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minHeight: 44,
  padding: '0 14px',
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  background: '#fff',
  flexWrap: 'wrap',
}

export const statGrid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginTop: 12,
}
export const statTile: CSSProperties = {
  background: TOKENS.soft, borderRadius: 10, padding: '10px 12px',
}
export const statValue: CSSProperties = { fontSize: 18, fontWeight: 600, lineHeight: '24px' }
export const statValueSmall: CSSProperties = { fontSize: 12.5, fontWeight: 500, lineHeight: '24px', color: TOKENS.muted }
export const statLabel: CSSProperties = { fontSize: 11.5, color: TOKENS.muted, marginTop: 1 }
export const statNote: CSSProperties = { fontSize: 11, color: TOKENS.faint, marginTop: 4, lineHeight: '15px' }

/** 水平 tab：下边 1px 分隔，选中项 2px 品牌下划线。 */
export const tabBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 24,
  margin: '18px 0 0',
  borderBottom: `1px solid ${TOKENS.line}`,
  overflowX: 'auto',
}

export const tabButton = (active: boolean): CSSProperties => ({
  appearance: 'none',
  border: 0,
  borderBottom: active ? `2px solid ${TOKENS.primary}` : '2px solid transparent',
  background: 'transparent',
  color: active ? TOKENS.primary : TOKENS.muted,
  font: 'inherit',
  fontSize: 13.5,
  fontWeight: active ? 600 : 500,
  padding: '10px 0',
  marginBottom: -1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'color .16s ease, border-color .16s ease',
})

export const tabPanel: CSSProperties = { padding: '16px 0 0' }

export const tableWrap: CSSProperties = {
  border: `1px solid ${TOKENS.line}`, borderRadius: 12, background: '#fff', overflow: 'hidden',
}
export const tableHeadRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
  borderBottom: `1px solid ${TOKENS.line}`, background: TOKENS.soft,
  color: TOKENS.faint, fontSize: 11.5, fontWeight: 600,
}
export const tableRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, padding: '10px 14px',
  borderBottom: `1px solid ${TOKENS.line}`, fontSize: 13,
}
/** 空态 / 读不到：整块居中，不假装是一行数据。 */
export const tableEmpty: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 10, minHeight: 132, padding: '22px 16px', color: TOKENS.faint, fontSize: 12.5, textAlign: 'center',
}
export const tableHint: CSSProperties = { fontSize: 12, color: TOKENS.faint }

/** 配置区（邮件 / 企业微信）：状态 + 说明 + 一个主按钮。 */
export const configBlock: CSSProperties = {
  border: `1px solid ${TOKENS.line}`, borderRadius: 12, background: '#fff',
  padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10,
}

/** 设置页的只读摘要行。 */
export const summaryRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '11px 14px', borderBottom: `1px solid ${TOKENS.line}`, fontSize: 13,
}

export const entryGrid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12,
}
export const entryItem: CSSProperties = {
  border: `1px solid ${TOKENS.line}`, borderRadius: 12, padding: '14px 16px',
  display: 'flex', flexDirection: 'column', gap: 6,
}
export const entryTitleRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

export const primaryButton: CSSProperties = {
  border: 'none', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', background: TOKENS.primary, color: '#fff',
}
export const secondaryButton: CSSProperties = {
  border: '1px solid rgba(128,128,140,.3)', borderRadius: 10, padding: '9px 16px',
  fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: TOKENS.ink,
}
export const smallButton: CSSProperties = {
  border: '1px solid rgba(128,128,140,.3)', borderRadius: 8, padding: '5px 11px',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: TOKENS.ink,
}
export const disabledButton: CSSProperties = {
  ...secondaryButton, cursor: 'not-allowed', color: TOKENS.faint, borderColor: TOKENS.line,
}
export const dockButton: CSSProperties = {
  border: '1px solid rgba(128,128,140,.3)', borderRadius: 999, padding: '3px 10px',
  fontSize: 12, lineHeight: '18px', cursor: 'pointer', background: 'transparent', color: 'inherit',
  whiteSpace: 'nowrap',
}

export const dot = (color: string): CSSProperties => ({
  width: 6, height: 6, borderRadius: 999, background: color, flex: 'none',
})
export const statusRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }
export const result: CSSProperties = { fontSize: 12, margin: 0, minHeight: 18 }
