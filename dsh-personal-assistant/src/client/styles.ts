/**
 * 个人助理工作台的样式常量。
 *
 * 宿主只加载客户端包，不加载独立样式文件。面板布局规则放在有作用域的内嵌样式里，
 * 既有业务表格和表单继续共用下方样式常量。
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
  primary: '#09634e',
  rail: '#f2f6f5',
  accentWash: '#e2f2eb',
  railLine: '#dce7e4',
  green: '#22c55e',
  grey: '#c9ccd3',
  amber: '#f59e0b',
  ok: '#15803d',
  bad: '#dc2626',
} as const

export const page: CSSProperties = {
  // 桌面宿主用居中的弹性面板承载插件；开启容器查询后必须显式撑宽。
  width: '100%',
  maxWidth: TOKENS.maxWidth,
  margin: '0 auto',
  padding: '26px clamp(14px, 2.6vw, 36px) 36px',
  color: TOKENS.ink,
  font: '400 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  boxSizing: 'border-box',
  containerType: 'inline-size',
  containerName: 'personal-assistant',
}

export const header: CSSProperties = { margin: '0 0 14px' }
export const title: CSSProperties = { fontSize: 22, fontWeight: 600, margin: '0 0 4px', letterSpacing: '.2px' }
export const badge: CSSProperties = {
  fontSize: 12, lineHeight: '20px', padding: '0 8px', borderRadius: 6,
  background: '#f2f3f5', color: TOKENS.muted, whiteSpace: 'nowrap',
}
export const subtitle: CSSProperties = { fontSize: 13, margin: 0, color: TOKENS.muted }

/** 顶部状态条；窄窗口允许连接操作换行。 */
export const statusBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minHeight: 44,
  padding: '8px 12px',
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  background: '#fff',
  flexWrap: 'wrap',
}

export const statGrid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 10, marginTop: 12,
}
export const statTile: CSSProperties = {
  background: TOKENS.soft, borderRadius: 10, padding: '10px 12px',
}
export const statValue: CSSProperties = { fontSize: 18, fontWeight: 600, lineHeight: '24px' }
export const statValueSmall: CSSProperties = { fontSize: 12.5, fontWeight: 500, lineHeight: '24px', color: TOKENS.muted }
export const statLabel: CSSProperties = { fontSize: 11.5, color: TOKENS.muted, marginTop: 1 }
export const statNote: CSSProperties = { fontSize: 11, color: TOKENS.faint, marginTop: 4, lineHeight: '15px' }

export const workbenchCss = `
.pa-workspace { margin-top: 16px; display: grid; grid-template-columns: 174px minmax(0, 1fr); min-height: 340px;
  border: 1px solid ${TOKENS.railLine}; border-radius: 12px; overflow: hidden; background: #fff; }
.pa-rail { padding: 14px 10px; background: ${TOKENS.rail}; border-inline-end: 1px solid ${TOKENS.railLine}; }
.pa-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 3px; margin-bottom: 12px;
  border: 1px solid ${TOKENS.railLine}; border-radius: 8px; }
.pa-categories { display: grid; gap: 3px; }
.pa-rail button, .pa-open-detail, .pa-detail-close { border: 0; border-radius: 7px; background: transparent;
  color: inherit; font: inherit; cursor: pointer; }
.pa-rail button { min-height: 36px; }
.pa-rail button[aria-pressed='true'] { background: #fff; color: ${TOKENS.primary}; font-weight: 650; }
.pa-categories button { display: flex; align-items: center; gap: 8px; padding: 5px 10px; text-align: start; }
.pa-rail button:hover, .pa-categories button[aria-current='page'] { background: ${TOKENS.accentWash}; color: ${TOKENS.primary}; }
.pa-categories button[aria-current='page'] { font-weight: 650; }
.pa-content { min-width: 0; padding: 18px 20px; }
.pa-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.pa-tools :is(h3, h4), .pa-detail-head h3, .pa-samples h4 { margin: 0; font-size: 15px; font-weight: 650; }
.pa-search { width: min(250px, 100%); box-sizing: border-box; border: 1px solid ${TOKENS.railLine}; border-radius: 7px;
  padding: 7px 10px; background: #fff; color: ${TOKENS.ink}; font: inherit; }
.pa-table-frame { border: 1px solid ${TOKENS.railLine}; border-radius: 8px; overflow: auto; }
.pa-table { width: 100%; border-collapse: collapse; text-align: start; font-size: 13px; }
.pa-table :is(th, td) { padding: 10px 12px; border-bottom: 1px solid ${TOKENS.railLine}; vertical-align: middle; text-align: start; }
.pa-table thead { background: ${TOKENS.rail}; color: ${TOKENS.muted}; }
.pa-table tbody tr:last-child > * { border-bottom: 0; }
.pa-table tbody th { font-weight: 650; }
.pa-table :is(th, td):last-child { text-align: end; white-space: nowrap; }
.pa-content .pa-table th:first-child { width: 110px; white-space: nowrap; }
.pa-description { color: ${TOKENS.muted}; overflow-wrap: anywhere; }
.pa-row-state { color: ${TOKENS.muted}; font-size: 12px; }
.pa-row-state[data-tone='ok'] { color: ${TOKENS.primary}; }
.pa-open-detail { color: ${TOKENS.primary}; padding: 4px; white-space: nowrap; }
.pa-open-detail:hover { text-decoration: underline; text-underline-offset: 3px; }
.pa-empty { padding: 18px 12px; text-align: center; color: ${TOKENS.muted}; font-size: 13px; margin: 0; }
.pa-detail { width: min(960px, calc(100vw - 30px)); max-height: min(86vh, 840px); max-height: min(86dvh, 840px);
  margin: auto; padding: 0; box-sizing: border-box; color: ${TOKENS.ink}; background: #fff; border: 1px solid ${TOKENS.railLine};
  border-radius: 14px; overflow: auto; box-shadow: 0 18px 56px rgb(23 45 39 / 16%); }
.pa-detail::backdrop { background: rgb(24 43 40 / 39%); }
.pa-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px;
  border-bottom: 1px solid ${TOKENS.railLine}; background: #fff; position: sticky; top: 0; z-index: 3; }
.pa-detail-head h3 { font-size: 17px; }
.pa-detail-head p { margin: 0; color: ${TOKENS.muted}; font-size: 12px; }
.pa-detail-close { flex: none; padding: 6px 10px; background: ${TOKENS.rail}; }
.pa-detail-close:hover { background: ${TOKENS.accentWash}; color: ${TOKENS.primary}; }
.pa-detail-body { padding: 16px 20px 20px; }
.pa-samples { margin-top: 16px; }
.pa-samples h4 { margin-bottom: 7px; }
.pa-samples .pa-table, .pa-skill-table { min-width: 416px; }
.pa-samples .pa-table th:first-child, .pa-skill-table th:first-child { overflow-wrap: anywhere; }
.pa-sample-actions { display: inline-flex; justify-content: flex-end; gap: 5px; flex-wrap: wrap; }
[data-personal-assistant] :is(button,input,select,textarea):focus-visible { outline: 2px solid ${TOKENS.primary}; outline-offset: 2px; }
@container personal-assistant (max-width: 660px) {
  .pa-workspace { grid-template-columns: minmax(0, 1fr); }
  .pa-rail { border-inline-end: 0; border-bottom: 1px solid ${TOKENS.railLine}; }
  .pa-modes { width: max-content; }
  .pa-modes button { padding-inline: 16px; }
  .pa-categories { display: flex; flex-wrap: wrap; }
  .pa-content { padding: 12px; }
}
@container personal-assistant (max-width: 460px) {
  .pa-content .pa-table th:first-child { width: auto; white-space: normal; }
  .pa-content .pa-table :is(th, td) { padding-inline: 8px; }
}
@media (max-width: 600px) {
  .pa-detail-body, .pa-detail-head { padding-inline: 12px; }
}
`

export const tableWrap: CSSProperties = {
  border: `1px solid ${TOKENS.line}`, borderRadius: 12, background: '#fff',
  // 列表行多时在卡片内部上下滚（表头吸顶），不依赖外层页面是否可滚；
  // 横向也允许滚，窄屏隐藏列之外仍能看到被截的列。
  overflow: 'auto', maxHeight: 'min(56vh, 520px)',
}
export const tableHeadRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
  borderBottom: `1px solid ${TOKENS.line}`, background: TOKENS.soft,
  color: TOKENS.faint, fontSize: 11.5, fontWeight: 600,
  // 吸顶：卡片内滚动时表头不跟着滚走，否则滚到下面不知道每列是什么。
  position: 'sticky', top: 0, zIndex: 1,
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
