/**
 * 身份块（人格进主会话）的钉子用例。
 *
 * 钉的是**这件事真的接上了**：改版前 `agent.name` / `agent.persona` 落进设置文件后，
 * 生产代码里唯一的读者是设置快照回显（assistant-settings.ts:222），主会话提示词里
 * 一个字符都收不到 —— 用户在设置里写的性格对主对话完全无效。这里逐条钉住：
 *
 * 1. 有名字有性格 → 两样都出现；
 * 2. 只有名字 → 名字在、性格给中性默认，不编一个出来；
 * 3. 什么都没有 / undefined / null → **仍然是一段非空字符串**（宿主不接受空变量）；
 * 4. 首尾空白被裁掉（设置框里多敲的空格不该原样进提示词）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

void test('身份块：名字与性格都注入，且各自成行', async () => {
  const { renderIdentity } = await import('../src/tools.ts')
  const text = renderIdentity({ name: '小潘', persona: '说话简短，先给结论，不用感叹号。' })
  assert.match(text, /小潘/u)
  assert.match(text, /说话简短，先给结论，不用感叹号。/u)
  const lines = text.split('\n')
  assert.equal(lines.length, 2, '身份块是两行：你是谁 + 怎么说')
  assert.match(lines[0], /名字叫「小潘」/u)
  assert.match(lines[1], /^性格与说话方式/u)
})

void test('身份块：只给了名字时，性格用中性默认，不替用户编', async () => {
  const { renderIdentity } = await import('../src/tools.ts')
  const text = renderIdentity({ name: '小潘' })
  assert.match(text, /小潘/u)
  assert.match(text, /友好、干脆、说人话/u)
  assert.doesNotMatch(text, /用户自己写的/u, '用户没写性格，就不能说是他写的')
})

void test('身份块：没有配置也必须是非空字符串', async () => {
  const { renderIdentity } = await import('../src/tools.ts')
  for (const input of [undefined, null, {}, { name: '', persona: '' }, { name: '   ', persona: '  ' }]) {
    const text = renderIdentity(input as { name?: string; persona?: string } | undefined | null)
    assert.equal(typeof text, 'string')
    assert.ok(text.trim().length > 0, `输入 ${JSON.stringify(input)} 时不能返回空串`)
    assert.match(text, /个人电脑助理/u)
  }
})

void test('身份块：首尾空白裁掉，避免多敲的空格原样进提示词', async () => {
  const { renderIdentity } = await import('../src/tools.ts')
  const text = renderIdentity({ name: '  小潘  ', persona: '\n 简短  \n' })
  assert.match(text, /名字叫「小潘」/u)
  assert.match(text, /：简短$/mu)
  assert.doesNotMatch(text, /名字叫「\s/u)
})
