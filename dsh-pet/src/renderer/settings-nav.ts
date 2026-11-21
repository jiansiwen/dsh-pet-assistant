/**
 * 工作台放要处理的事，设置页放配置；两组共用同一份功能列表。
 *
 * 为什么单独一个纯逻辑文件：
 *
 * 1. **顺序与标题是产品决定**，不是渲染细节。用户在哪儿找"日报"、第一项是不是"对话"，
 *    这类判断错了，界面就难用；而它一旦写死在 `.tsx` 里，就只能靠开壳用眼睛数。
 * 2. 其他设置放在最后，不抢占常用功能的位置。
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
 * `chat` 不是"一个设置页"，点了会关掉面板直接开对话 —— 但它必须在这里，
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
        { id: 'mail', title: '邮件', summary: '查看值守结果与建议；配置收发邮箱。发信在对话里走审批。' },
        { id: 'wecom', title: '企业微信', summary: '配置企业微信连接与已配对会话。' },
        { id: 'report', title: '日报周报', summary: '把今天做的事整理成日报；工作台在独立窗口里。' },
        { id: 'meeting', title: '会议助手', summary: '查看录音状态，整理并核对会议纪要。' },
      ],
    },
    {
      id: 'settings',
      label: '设置',
      items: [
        { id: 'team', title: '助理团设置', summary: '管理成员、记忆范围、额度与定时任务。' },
        { id: 'doc', title: '文档与讲解', summary: '管理授权目录、阅读与讲解方式。' },
        { id: 'voice', title: '语音与声纹', summary: '配置唤醒词、声纹、外放插话与识别服务。' },
        { id: 'learning', title: '记忆与技能', summary: '查看技能、专属词库与工作资料。' },
        { id: 'appearance', title: '外观与交互', summary: '调整角色大小、透明度、停靠和快捷操作。' },
        { id: 'general', title: '其他设置', summary: '管理启动、托盘常驻、活动记录和环境检查。' },
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
  if (page === 'workbench') return { title: '工作台', summary: '查看待办、邮件、日报与会议，选择要处理的工作。' }
  if (page === 'settings') return { title: '设置', summary: '先看每项功能的当前配置，需要更改时再打开详情。' }
  for (const group of settingsNavGroups()) {
    for (const item of group.items) {
      if (item.id === page) return { title: item.title, summary: item.summary }
    }
  }
  if (page === 'agent') return { title: '总助理', summary: '设置总助理的名字与性格，快速应答也按这个性格说话。' }
  if (page === 'reminders') return { title: '提醒', summary: '设置默认催办间隔；内容与「待办提醒」页相同。' }
  return { title: '设置', summary: '' }
}

export function settingsOverview(page: SettingsPage): 'workbench' | 'settings' {
  return page === 'workbench' || page === 'reminders' || settingsNavGroups()[0].items.some(item => item.id === page)
    ? 'workbench' : 'settings'
}

export function settingsRows(overview: 'workbench' | 'settings', query: string, category?: SettingsPage): readonly SettingsNavItem[] {
  const search = query.trim().toLowerCase()
  return settingsNavGroups()[overview === 'workbench' ? 0 : 1].items
    .filter(item => (category === undefined || item.id === category) && `${item.title} ${item.summary}`.toLowerCase().includes(search))
}

/** 所有分类的完整功能列表。 */
export function settingsNavItems(): readonly SettingsNavItem[] {
  return settingsNavGroups().flatMap(group => group.items)
}

/** 第几项（从 1 开始）；不在导航上的页面返回 null。 */
export function settingsNavOrdinal(page: SettingsPage): number | null {
  const index = settingsNavItems().findIndex(item => item.id === page)
  return index < 0 ? null : index + 1
}
