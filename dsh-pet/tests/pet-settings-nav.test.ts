/**
 * 工作台与设置各有入口，分类后的结果保持可搜索。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  settingsNavGroups,
  settingsNavItems,
  settingsNavOrdinal,
  settingsOverview,
  settingsPageMeta,
  settingsRows,
} from '../src/renderer/settings-nav.ts'

describe('设置导航：工作与设置两组', () => {
  it('组顺序是「工作」在前、「设置」在后', () => {
    const groups = settingsNavGroups()
    assert.equal(groups.length, 2)
    assert.deepEqual(groups.map(group => group.label), ['工作', '设置'])
    assert.deepEqual(groups.map(group => group.id), ['work', 'settings'])
    assert.equal(settingsNavItems().length, 12)
  })

  it('各组标题与用途分开', () => {
    assert.deepEqual(settingsNavItems().map(item => item.title),
      ['对话', '待办提醒', '邮件', '企业微信', '日报周报', '会议助手', '助理团设置', '文档与讲解', '语音与声纹', '记忆与技能', '外观与交互', '其他设置'])
    assert.deepEqual(settingsNavItems().map(item => item.id),
      ['chat', 'todo', 'mail', 'wecom', 'report', 'meeting', 'team', 'doc', 'voice', 'learning', 'appearance', 'general'])
  })

  it('第一项是对话、最后一项是其他设置', () => {
    const items = settingsNavItems()
    assert.equal(items[0].id, 'chat')
    assert.equal(items[items.length - 1].id, 'general')
  })

  it('id 不重复，且每一项都有一句说明', () => {
    const ids = settingsNavItems().map(item => item.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const item of settingsNavItems()) assert.ok(item.summary.length > 0, `${item.id} 缺说明`)
  })

  it('工作与设置各 6 项', () => {
    const [work, settings] = settingsNavGroups()
    assert.equal(work.items.length, 6)
    assert.equal(settings.items.length, 6)
  })

  it('导航顺序连续；不在导航上的页面没有序号', () => {
    assert.deepEqual(settingsNavItems().map(item => settingsNavOrdinal(item.id)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal(settingsNavOrdinal('agent'), null)
    assert.equal(settingsNavOrdinal('reminders'), null)
  })

  it('搜索限定在当前总览与分类，关闭旧深链接返回正确的总览', () => {
    assert.deepEqual(settingsRows('settings', ' 声纹 ').map(item => item.id), ['voice'])
    assert.deepEqual(settingsRows('workbench', '声纹'), [])
    assert.deepEqual(settingsRows('settings', '', 'general').map(item => item.id), ['general'])
    assert.equal(settingsOverview('reminders'), 'workbench')
    assert.equal(settingsOverview('agent'), 'settings')
  })
})

describe('页面标题与说明', () => {
  it('导航内的页面取导航里的文案', () => {
    assert.equal(settingsPageMeta('chat').title, '对话')
    assert.equal(settingsPageMeta('doc').title, '文档与讲解')
    assert.equal(settingsPageMeta('general').title, '其他设置')
  })

  it('导航外的两个页面也有标题，不能让面板顶部空着', () => {
    assert.equal(settingsPageMeta('agent').title, '总助理')
    assert.equal(settingsPageMeta('reminders').title, '提醒')
    assert.ok(settingsPageMeta('agent').summary.length > 0)
  })
})

describe('文案里不出现实现词', () => {
  it('导航说明与入口卡片说明都用用户能懂的话', () => {
    const all = settingsNavItems().map(item => item.summary).join(' ')
    for (const word of ['FTS', 'ASR', 'token', 'prompt', 'embedding', 'IPC', 'API']) {
      assert.ok(!all.includes(word), `导航文案里出现了实现词「${word}」：${all}`)
    }
  })
})
