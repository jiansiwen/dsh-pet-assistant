/**
 * 运行时状态行的文案与语气映射。
 *
 * 这几个函数看着只是查表，但有两条顺序规则一旦被改掉，用户看到的结论就是错的：
 * 失败必须压过"已连接"，稳态必须收起进展播报。所以逐条钉住。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  RUNTIME_LABEL,
  operationLabels,
  runtimeCanStart,
  runtimeDetail,
  runtimeLabel,
  runtimeTone,
} from '../src/renderer/runtime-status.ts'
import type { CompanionState, OperationalState } from '../src/renderer/types.js'

const operational: OperationalState = {
  connection: 'connected', listener: 'wake-requested', activity: null, meeting: 'idle', speaking: false, execution: 'idle',
}
const labels = (patch: Partial<OperationalState> = {}) => Object.fromEntries(operationLabels({ ...operational, ...patch }).map(item => [item.label, item.value]))

test('连接、监听申请和采集证据分开，静音不代表任务停止', () => {
  const view = labels()
  assert.equal(Object.keys(view).length, 6)
  assert.equal(view['会话连接'], '已连接')
  assert.match(view['麦克风'], /未验证实际收音/)
  assert.equal(view['活动记录'], '未取得采集状态')
  assert.match(view['朗读'], /不代表后台任务已停止/)
  assert.match(view['模型会话'], /不代表所有外部操作已停止/)
})

test('采样进程与模式分开，断连不展示旧采集快照', () => {
  assert.match(labels({ activity: { active: true, capturing: false, titles: true } })['活动记录'], /未在采样/)
  assert.match(labels({ activity: { active: true, capturing: true, titles: false } })['活动记录'], /不含标题/)
  assert.equal(labels({ activity: { active: false, capturing: false, titles: false } })['活动记录'], '已关闭')
  assert.equal(labels({ connection: 'disconnected', activity: { active: true, capturing: true, titles: true } })['活动记录'], '未取得采集状态')
})

test('会议录音、转写和朗读互不替代', () => {
  assert.match(labels({ meeting: 'recording', speaking: false, listener: 'meeting' })['会议'], /音轨状态请看会议页/)
  assert.equal(labels({ meeting: 'transcribing' })['会议'], '正在转写')
  assert.equal(labels({ meeting: null })['会议'], '未取得会议状态')
  assert.equal(labels({ speaking: true, listener: 'unavailable' })['朗读'], '合成或播放中')
})

function state(patch: Partial<CompanionState> = {}): CompanionState {
  return {
    link: 'none',
    stageVisible: true,
    focusMode: false,
    presentationMode: false,
    trayResident: false,
    profile: 'web',
    lastStage: null,
    lastMessage: null,
    lastFailed: false,
    ownPid: null,
    ...patch,
  }
}

describe('runtimeTone：失败压过一切', () => {
  test('连上了但契约核对没过，仍然是错误语气', () => {
    // 这正是"改造前的构建"那种情况：显示成已连接，用户会对着一个没有团队模式的运行时一直等。
    assert.equal(runtimeTone(state({ link: 'attached-own', lastFailed: true })), 'error')
    assert.equal(runtimeTone(state({ link: 'attached-external', lastFailed: true })), 'error')
  })

  test('连接状态各自对应一种语气', () => {
    assert.equal(runtimeTone(state({ link: 'attached-own' })), 'ok')
    assert.equal(runtimeTone(state({ link: 'attached-external' })), 'ok')
    assert.equal(runtimeTone(state({ link: 'starting' })), 'busy')
    assert.equal(runtimeTone(state({ link: 'booted' })), 'busy')
    assert.equal(runtimeTone(state({ link: 'none' })), 'idle')
  })

  test('一次成功上报会清掉之前的失败语气', () => {
    assert.equal(runtimeTone(state({ link: 'attached-own', lastFailed: false })), 'ok')
  })
})

describe('runtimeLabel：五种连接状态各有各的话，不能混', () => {
  test('每种状态都有一句互不相同的说明', () => {
    const links = Object.keys(RUNTIME_LABEL) as Array<CompanionState['link']>
    assert.equal(links.length, 5)
    assert.equal(new Set(Object.values(RUNTIME_LABEL)).size, links.length)
    for (const link of links) {
      assert.equal(runtimeLabel(state({ link })), RUNTIME_LABEL[link])
    }
  })

  test('本壳启动的与用户自己启动的要分得出来：停止按钮只对前者有效', () => {
    assert.match(RUNTIME_LABEL['attached-external'], /你自己启动/)
    assert.doesNotMatch(RUNTIME_LABEL['attached-own'], /你自己启动/)
  })

  test('运行时起来了但没人召唤，标签里就要写明白在等什么', () => {
    assert.match(RUNTIME_LABEL.booted, /等待会话召唤/)
  })
})

describe('runtimeDetail：只在用户需要下一步动作时摊开', () => {
  test('出错时摊开：那句话里带着补救动作', () => {
    const message = '插件目录里没有 cordis.team.patch.yml：这份插件构建早于团队模式，请更新插件后重试'
    assert.equal(runtimeDetail(state({ link: 'none', lastFailed: true, lastMessage: message })), message)
  })

  test('启动中摊开：进度值得看', () => {
    const message = '启动 dsh --profile web'
    assert.equal(runtimeDetail(state({ link: 'starting', lastMessage: message })), message)
  })

  test('等待召唤时摊开：那是待办，不写出来用户不知道下一步该干什么', () => {
    const message = '运行时已启动（pid 1），但还没有会话召唤助理'
    assert.equal(runtimeDetail(state({ link: 'booted', lastStage: 'await-bridge', lastMessage: message })), message)
  })

  test('就绪后收起：进展播报长期挂在面板上只是噪音', () => {
    assert.equal(
      runtimeDetail(state({ link: 'attached-own', lastStage: 'ready', lastMessage: '团队模式已就绪' })),
      null,
    )
  })

  test('还没连上也没有新消息时不给空行', () => {
    assert.equal(runtimeDetail(state()), null)
  })
})

describe('runtimeCanStart：已连接时不该再给启动按钮', () => {
  test('未连接与只起来了进程时都能启动', () => {
    assert.equal(runtimeCanStart(state({ link: 'none' })), true)
    assert.equal(runtimeCanStart(state({ link: 'booted' })), true)
  })

  test('启动中不给：点了也只会撞上去重保护', () => {
    assert.equal(runtimeCanStart(state({ link: 'starting' })), false)
  })

  test('已连接不给：点了只会重新附着一次，用户以为自己在重启', () => {
    assert.equal(runtimeCanStart(state({ link: 'attached-own' })), false)
    assert.equal(runtimeCanStart(state({ link: 'attached-external' })), false)
  })

  test('失败之后仍然给：重试是唯一的出路', () => {
    assert.equal(runtimeCanStart(state({ link: 'none', lastFailed: true })), true)
  })
})
