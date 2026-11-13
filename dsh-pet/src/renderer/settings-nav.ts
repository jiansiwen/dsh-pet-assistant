/**
 * 设置面板的导航：九项、两组，按"先干活、后配置"排。
 *
 * 为什么单独一个纯逻辑文件：
 *
 * 1. **顺序与标题是产品决定**，不是渲染细节。用户在哪儿找"日报"、第一项是不是"对话"，
 *    这类判断错了，界面就难用；而它一旦写死在 `.tsx` 里，就只能靠开壳用眼睛数。
 * 2. 主理人给的验收判据里有一条"正好 9 项、两组、id 不重复、chat 第一、general 最后"，
 *    这些断言需要一份可 `node --test` 直接导入的数据源。
 *
 * 排序理由：前六项是"今天要做的事"，后三项是"把这只宠物调成我喜欢的样子"。
 * 对话排第一位，是因为它是用户最常回来的一页 —— 打开面板十次里有八次其实只是想接着说话。
 */

import type { SettingsPage } from './types.js'

export type SettingsNavGroupId = 'work' | 'settings'

export interface SettingsNavItem {
  readonly id: SettingsPage
  readonly title: string
  /** 进入该页时顶部那行说明（也用于入口卡片的副文案）。 */
  readonly summary: string
}

export interface SettingsNavGroup {
  readonly id: SettingsNavGroupId
  readonly label: string
  readonly items: readonly SettingsNavItem[]
}

/**
 * 九项导航。`chat` 不是"一个设置页"，点了会关掉面板直接开对话 —— 但它必须在这里，
 * 否则用户想从设置里回到对话就得先找关闭按钮再找输入框。
 */
export function settingsNavGroups(): readonly SettingsNavGroup[] {
  return [
    {
      id: 'work',
      label: '工作',
      items: [
        { id: 'chat', title: '对话', summary: '接着和总助理说话，设置面板会收起。' },
        { id: 'todo', title: '待办提醒', summary: '查看任务与催办提醒；完整的待办页在独立窗口里。' },
        { id: 'mail', title: '邮件', summary: '审批发信与邮箱配置；完整的邮件页还在建设中。' },
        { id: 'wecom', title: '企业微信', summary: '配置企业微信连接与已配对会话。' },
        { id: 'report', title: '日报周报', summary: '把今天做的事整理成日报；工作台在独立窗口里。' },
        { id: 'meeting', title: '会议助手', summary: '查看录音状态，整理并核对会议纪要。' },
      ],
    },
    {
      id: 'settings',
      label: '设置',
      items: [
        { id: 'team', title: '助理团', summary: '管理成员、额度与等待处理的任务。' },
        { id: 'doc', title: '文档与讲解', summary: '管理授权目录、阅读与讲解方式。' },
        { id: 'general', title: '通用', summary: '调整桌面伙伴的行为、语音与隐私。' },
      ],
    },
  ]
}

/**
 * 每一个页面的标题与说明，**包括不在导航上的两个**。
 *
 * 面板顶部的引言靠它取文案；少了这条兜底，从「通用」页点进「总助理」时标题会变成空白 ——
 * 那比不显示还糟：用户会以为自己点错了。
 */
export function settingsPageMeta(page: SettingsPage): { title: string; summary: string } {
  for (const group of settingsNavGroups()) {
    for (const item of group.items) {
      if (item.id === page) return { title: item.title, summary: item.summary }
    }
  }
  if (page === 'agent') return { title: '总助理', summary: '设置总助理的名字与性格，快速应答也按这个性格说话。' }
  if (page === 'reminders') return { title: '提醒', summary: '设置默认催办间隔；内容与「待办提醒」页相同。' }
  return { title: '设置', summary: '' }
}

/** 九项是否按"组顺序 → 项顺序"平铺后的完整列表。入口处按它编号（01–09）。 */
export function settingsNavItems(): readonly SettingsNavItem[] {
  return settingsNavGroups().flatMap(group => group.items)
}

/** 第几项（从 1 开始）；不在导航上的页面返回 null。 */
export function settingsNavOrdinal(page: SettingsPage): number | null {
  const index = settingsNavItems().findIndex(item => item.id === page)
  return index < 0 ? null : index + 1
}
