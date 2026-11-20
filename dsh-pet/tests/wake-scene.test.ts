/**
 * 唤醒的场景判定：声纹什么时候放过、播报中什么时候装没听见。
 *
 * 两条都是"场景决定行为"的纯逻辑，真机上极难复现（要有人在讲解中途插话、要电视正好在说话），
 * 所以判定抽成纯函数，这里逐条钉死；配置项另有归一化用例。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizeAudioPrefs } from '../src/main/audio-prefs.ts'
import { isPresenting, shouldIgnoreWakeDuringSpeech, shouldPassWithoutVoiceprint } from '../src/main/wake-scene.ts'

describe('讲解场景判定：暂停中的讲解仍算讲解', () => {
  // 真机链：讲解 → A 提问（pauseDocTalk 把 stopped 置 true）→ 回答 → 反问等 5 秒 → B 也想问。
  // 如果 presenting 判 stopped，这条链上 B 会被声纹挡在门外 —— 这正是要防的回归。
  const 讲解中 = { spoken: true, stopped: false }
  const 讲解暂停中 = { spoken: true, stopped: true }
  const 文字提纲 = { spoken: false, stopped: false }

  test('四种状态下的 presenting 取值', () => {
    assert.equal(isPresenting(讲解中), true, '讲解中')
    assert.equal(isPresenting(讲解暂停中), true, '讲解暂停中（插话/反问等待）—— 仍然是公开场合')
    assert.equal(isPresenting(null), false, '讲解已停止（stopDocTalk 清掉了 docTalk）')
    assert.equal(isPresenting(文字提纲), false, '无讲解 / 只是不出声的提纲')
  })

  test('讲解暂停中（stopped=true）非主人唤醒 → 放行', () => {
    // 第二个听众必须能喊进来：这是"多人连续提问"的核心场景。
    assert.equal(shouldPassWithoutVoiceprint({ presenting: isPresenting(讲解暂停中) }), true)
  })

  test('讲解已停止（docTalk=null）非主人唤醒 → 不因讲解放行（回到播报/声纹规则）', () => {
    assert.equal(shouldPassWithoutVoiceprint({ presenting: isPresenting(null) }), false)
  })

  test('文字提纲（不出声）非主人唤醒 → 不放行', () => {
    assert.equal(shouldPassWithoutVoiceprint({ presenting: isPresenting(文字提纲) }), false)
  })

  test('讲解暂停中也不受"播报中忽略唤醒"影响：B 说话时不会因为暂停而忽略', () => {
    assert.equal(shouldIgnoreWakeDuringSpeech({
      presenting: isPresenting(讲解暂停中), wakeDuringSpeech: false, speaking: true,
    }), false, '暂停中的讲解依然可以被打断提问')
  })
})

describe('声纹未通过时是否放行', () => {
  test('讲解中放行：听众提问不该被声纹挡住', () => {
    assert.equal(shouldPassWithoutVoiceprint({ presenting: true }), true)
  })

  test('非讲解（回答播报 / 待机）不放行：旁人、电视说话不能把它叫起来', () => {
    assert.equal(shouldPassWithoutVoiceprint({ presenting: false }), false)
  })
})

describe('播报中是否忽略唤醒', () => {
  const base = { presenting: false, wakeDuringSpeech: false, speaking: true }

  test('默认配置 + 正在播报 → 忽略（安静优先）', () => {
    assert.equal(shouldIgnoreWakeDuringSpeech(base), true)
  })

  test('讲解中永不忽略：打断提问是常态', () => {
    assert.equal(shouldIgnoreWakeDuringSpeech({ ...base, presenting: true }), false)
    // 讲解中即使把开关关着也照样响应。
    assert.equal(shouldIgnoreWakeDuringSpeech({ presenting: true, wakeDuringSpeech: false, speaking: true }), false)
  })

  test('用户打开「播报中也响应唤醒」→ 不忽略', () => {
    assert.equal(shouldIgnoreWakeDuringSpeech({ ...base, wakeDuringSpeech: true }), false)
  })

  test('没在播报 → 不忽略（跟开关无关）', () => {
    assert.equal(shouldIgnoreWakeDuringSpeech({ ...base, speaking: false }), false)
    assert.equal(shouldIgnoreWakeDuringSpeech({ ...base, speaking: false, wakeDuringSpeech: true }), false)
  })
})

describe('wakeDuringSpeech 配置项', () => {
  test('默认 false：播报中安静', () => {
    assert.equal(normalizeAudioPrefs({}, 'win32').wakeDuringSpeech, false)
    assert.equal(normalizeAudioPrefs({ wakeEnabled: true }, 'win32').wakeDuringSpeech, false)
  })

  test('只有明确的 true 才打开；非法值退回 false', () => {
    assert.equal(normalizeAudioPrefs({ wakeDuringSpeech: true }, 'win32').wakeDuringSpeech, true)
    for (const bad of ['true', 1, {}, null, []]) {
      assert.equal(normalizeAudioPrefs({ wakeDuringSpeech: bad }, 'win32').wakeDuringSpeech, false, JSON.stringify(bad))
    }
  })

  test('与声纹开关互不影响（两个开关各管一层）', () => {
    const both = normalizeAudioPrefs({ wakeVoiceprint: true, wakeDuringSpeech: true }, 'win32')
    assert.equal(both.wakeVoiceprint, true)
    assert.equal(both.wakeDuringSpeech, true)
    const onlyVoiceprint = normalizeAudioPrefs({ wakeVoiceprint: true }, 'win32')
    assert.equal(onlyVoiceprint.wakeVoiceprint, true)
    assert.equal(onlyVoiceprint.wakeDuringSpeech, false, '声纹开着不等于播报中也响应')
  })
})
