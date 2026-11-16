/**
 * 成员会话的归属：必须建在**总助理当前的工作目录**下。
 *
 * 不这么做的时候，成员会话会落到进程默认目录，用户在会话列表里既看不出它属于谁、
 * 也找不到"小张刚才在哪儿说过话"——总助理嘴上说"交给我了"，痕迹却无处可寻。
 *
 * 另外记一条踩过的坑：cwd 不能由运行时直接读 `ctx.session`。运行时会在这个回调里
 * 被再次调用，那时的 ctx 已经换了上下文，直接读会拿到错东西甚至卡死（测试直接挂住）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveMemberCwd } from '../src/index.ts'

interface CreateOptions {
  sessionId: string
  meta?: { cwd?: string }
}

/** 按运行时的写法组装 create 参数：有 cwd 才带 meta，没有就不带。 */
function createArgs(sessionId: string, cwd: string | undefined): CreateOptions {
  const meta = typeof cwd === 'string' && cwd !== '' ? { cwd } : undefined
  return { sessionId, ...(meta === undefined ? {} : { meta }) }
}

void test('注入的 cwd 会带进 create 的 meta，成员会话挂在同一工作区', () => {
  const args = createArgs('member-1', 'D:\\work\\proj')
  assert.deepEqual(args.meta, { cwd: 'D:\\work\\proj' })
})

void test('拿不到 cwd 时不伪造 meta，交给宿主按默认处理', () => {
  assert.equal(createArgs('member-2', undefined).meta, undefined)
  assert.equal(createArgs('member-3', '').meta, undefined)
})

void test('sessionId 原样透传，不因加 meta 而改', () => {
  assert.equal(createArgs('member-x', 'C:\\a').sessionId, 'member-x')
})

void test('cwd 优先取总助理绑定会话的真实目录，而非进程目录', () => {
  // 绑定会话 cwd 存在时压倒一切：插件根 ctx 的 header 与进程目录都是错的退路。
  assert.equal(resolveMemberCwd('D:\\work\\dsh-github', 'C:\\wrong-header', 'C:\\Users\\lakala\\.dsh\\profiles\\desktop'), 'D:\\work\\dsh-github')
})

void test('绑定会话 cwd 缺失时退回 ctx 会话 header，再退回进程目录', () => {
  assert.equal(resolveMemberCwd(null, 'C:\\header-cwd', 'C:\\process'), 'C:\\header-cwd')
  assert.equal(resolveMemberCwd('', 'C:\\header-cwd', 'C:\\process'), 'C:\\header-cwd')
  assert.equal(resolveMemberCwd(undefined, 'C:\\header-cwd', 'C:\\process'), 'C:\\header-cwd')
  assert.equal(resolveMemberCwd(null, undefined, 'C:\\process'), 'C:\\process')
  assert.equal(resolveMemberCwd(null, '', 'C:\\process'), 'C:\\process')
  assert.equal(resolveMemberCwd(null, 42, 'C:\\process'), 'C:\\process')
})
