/**
 * 语音指令识别的行为契约：说「总结会议纪要」应当能命中，普通总结不能。
 *
 * 这条规则来自现场需求：会议录完之后，用户希望直接说话就能出纪要，
 * 而不是必须去会议页点按钮。但"总结今天的工作"这类普通请求不能被误判成会议纪要。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

/** 与 src/main/index.ts 的 mentionsMeetingMinutes 同一条规则。 */
function mentionsMeetingMinutes(text: string): boolean {
  return /(会议|开会|录音|转写)/u.test(text) && /(纪要|总结|整理|归纳|摘要)/u.test(text)
}

describe('会议纪要语音指令', () => {
  for (const text of [
    '总结会议纪要',
    '帮我总结一下会议纪要',
    '整理一下刚才开会的纪要',
    '把录音转成会议纪要',
    '归纳一下会议内容',
    '生成会议摘要',
    '总结一下这次会议的纪要吧',
  ]) {
    test(`命中：「${text}」`, () => {
      assert.equal(mentionsMeetingMinutes(text), true)
    })
  }

  for (const text of [
    '总结今天的工作',
    '总结一下我今天干了啥',
    '帮我整理一下这个文件夹',
    '生成日报',
    '讲讲这份文档',
  ]) {
    test(`不误判：「${text}」`, () => {
      assert.equal(mentionsMeetingMinutes(text), false)
    })
  }
})
