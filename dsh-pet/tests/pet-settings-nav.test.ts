/**
 * 设置面板九项导航的测试。
 *
 * 钉住的是主理人给的验收判据：**正好九项、两组、顺序固定、id 不重复、对话第一、通用最后**。
 * 这些是产品决定，不是渲染细节 —— 一旦有人顺手把"日报"挪进设置组、或给某页改名，
 * 用户找东西的路径就变了，而这种变化在界面上看不出来，只有用例能拦。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  settingsNavGroups,
  settingsNavItems,
  settingsNavOrdinal,
  settingsPageMeta,
} from '../src/renderer/settings-nav.ts'

describe('设置导航：九项两组', () => {
  it('正好九项，两组，组顺序是「工作」在前、「设置」在后', () => {
    const groups = settingsNavGroups()
    assert.equal(groups.length, 2)
    assert.deepEqual(groups.map(group => group.label), ['工作', '设置'])
    assert.deepEqual(groups.map(group => group.id), ['work', 'settings'])
    assert.equal(settingsNavItems().length, 9)
  })

  it('九项标题逐字固定', () => {
    assert.deepEqual(settingsNavItems().map(item => item.title),
      ['对话', '待办提醒', '邮件', '企业微信', '日报周报', '会议助手', '助理团', '文档与讲解', '通用'])
    assert.deepEqual(settingsNavItems().map(item => item.id),
      ['chat', 'todo', 'mail', 'wecom', 'report', 'meeting', 'team', 'doc', 'general'])
  })

  it('第一项是对话、最后一项是通用 —— 这两端是用户回面板的锚点', () => {
    const items = settingsNavItems()
    assert.equal(items[0].id, 'chat')
    assert.equal(items[items.length - 1].id, 'general')
  })

  it('id 不重复，且每一项都有一句说明', () => {
    const ids = settingsNavItems().map(item => item.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const item of settingsNavItems()) assert.ok(item.summary.length > 0, `${item.id} 缺说明`)
  })

  it('工作组 6 项、设置组 3 项', () => {
    const [work, settings] = settingsNavGroups()
    assert.equal(work.items.length, 6)
    assert.equal(settings.items.length, 3)
  })

  it('序号从 1 连续到 9；不在导航上的页面没有序号', () => {
    assert.deepEqual(settingsNavItems().map(item => settingsNavOrdinal(item.id)), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(settingsNavOrdinal('agent'), null)
    assert.equal(settingsNavOrdinal('reminders'), null)
  })
})

describe('页面标题与说明', () => {
  it('导航内的页面取导航里的文案', () => {
    assert.equal(settingsPageMeta('chat').title, '对话')
    assert.equal(settingsPageMeta('doc').title, '文档与讲解')
    assert.equal(settingsPageMeta('general').title, '通用')
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
