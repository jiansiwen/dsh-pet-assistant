/**
 * 端到端冒烟测试：SDK → dsh sdk profile → personal-assistant 插件 → 模型。
 * 用法：node scripts/smoke.mjs
 */
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createRequire } from 'node:module'
import path from 'node:path'

const nodeRequire = createRequire(import.meta.url)
const dshBin = path.join(path.dirname(nodeRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')

const harness = new DeepSeekHarness({
  launch: {
    command: process.execPath,
    args: [dshBin, '--profile', 'sdk'],
  },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: process.cwd(),
})

const sessionId = `smoke-${Date.now().toString(36)}`
const toolCalls = []

try {
  console.log('[smoke] 发送：开启个人助理模式')
  const r1 = await harness.run('请调用工具开启个人助理模式，然后用一句话确认。', {
    sessionId,
    onNotification: n => {
      if (n.method === 'session.event') {
        const ev = n.params.event
        if (ev.type === 'tool/call') {
          toolCalls.push(ev.name)
          console.log(`[smoke] 工具调用: ${ev.name}`)
        }
      }
    },
  })
  console.log('[smoke] 回复:', r1.finalResponse?.slice(0, 200))

  console.log('[smoke] 发送：查询助理状态')
  const r2 = await harness.run('调用工具查询个人助理的状态，简短告诉我结果。', { sessionId })
  console.log('[smoke] 回复:', r2.finalResponse?.slice(0, 300))

  console.log('[smoke] 发送：记住偏好')
  const r3 = await harness.run('请记住我的偏好：日报中不要包含浏览网页的时间。然后确认。', { sessionId })
  console.log('[smoke] 回复:', r3.finalResponse?.slice(0, 200))

  console.log('[smoke] 发送：列出偏好')
  const r4 = await harness.run('列出我的所有偏好。', { sessionId })
  console.log('[smoke] 回复:', r4.finalResponse?.slice(0, 300))

  console.log('[smoke] 发送：关闭模式')
  const r5 = await harness.run('请关闭个人助理模式。', { sessionId })
  console.log('[smoke] 回复:', r5.finalResponse?.slice(0, 200))

  console.log('[smoke] 工具调用汇总:', toolCalls)
  const ok = toolCalls.includes('personal_assistant_start')
    && toolCalls.includes('personal_assistant_status')
    && toolCalls.includes('personal_assistant_remember_preference')
    && toolCalls.includes('personal_assistant_list_preferences')
    && toolCalls.includes('personal_assistant_stop')
  console.log(ok ? '[smoke] PASS' : '[smoke] FAIL: 部分工具未被调用')
} catch (error) {
  console.error('[smoke] ERROR:', error)
} finally {
  await harness.close()
}
