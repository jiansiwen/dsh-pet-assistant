import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { buildSign, callPlatform, defaultPlatformConfig, md5Upper, platformTimestamp, readPlatformConfig, writePlatformConfig, type PlatformConfig } from '../src/platform-connector.ts'

function cfg(patch: Partial<PlatformConfig> = {}): PlatformConfig {
  return { ...defaultPlatformConfig(), enabled: true, endpoint: 'https://example.invalid/api/chat/realtime', appid: 'app1', secret: 's3cret', userId: 'u1', assistId: 'a1', ...patch }
}

test('md5Upper 与 buildSign：32 位大写、模板可配置', () => {
  assert.equal(md5Upper('abc'), '900150983CD24FB0D6963F7D28E17F72')
  const c = cfg()
  const s = buildSign(c, { sid: 'SID1', timestamp: '20261119090000' })
  assert.equal(s, md5Upper('app120261119090000SID1s3cret'))
  assert.match(s, /^[0-9A-F]{32}$/)
  const custom = buildSign(cfg({ signTemplate: '{secret}{sid}' }), { sid: 'X', timestamp: 'T' })
  assert.equal(custom, md5Upper('s3cretX'))
})

test('platformTimestamp 格式 yyyyMMddHHmmss', () => {
  const ts = platformTimestamp(new Date(2026, 10, 19, 9, 5, 7))
  assert.equal(ts, '20261119090507')
})

test('配置读写：缺省安全、patch 合并、secret 落盘', (t: TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-platform-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const before = readPlatformConfig(dir)
  assert.equal(before.enabled, false)
  assert.equal(before.endpoint, '')
  const after = writePlatformConfig(dir, { enabled: true, endpoint: 'https://x/y', appid: 'a', secret: 'k' })
  assert.equal(after.enabled, true)
  assert.equal(readPlatformConfig(dir).secret, 'k')
})

test('callPlatform：未启用/未配置如实拒绝', async () => {
  assert.equal((await callPlatform(cfg({ enabled: false }), 'openplatform.realtimeChat', {})).ok, false)
  assert.equal((await callPlatform(cfg({ endpoint: '' }), 'openplatform.realtimeChat', {})).ok, false)
})

test('callPlatform：组装公共报文＋加签＋解析返回', async (t: TestContext) => {
  let captured: { body?: string } = {}
  t.mock.method(globalThis, 'fetch', async (_url: string, init: { body: string }) => {
    captured.body = init.body
    return { json: async () => ({ code: 0, desc: 'ok', data: { content: '你好' } }) } as never
  })
  const res = await callPlatform(cfg(), 'openplatform.realtimeChat', { question: 'hi', user_id: 'u1' })
  assert.equal(res.ok, true)
  assert.equal((res.data as { content: string }).content, '你好')
  const env = JSON.parse(captured.body!) as Record<string, unknown>
  assert.equal(env.service, 'openplatform.realtimeChat')
  assert.equal(env.appid, 'app1')
  assert.equal(env.channel, 'PC')
  assert.match(String(env.sid), /^[0-9A-F]{32}$/)
  assert.match(String(env.timestamp), /^\d{14}$/)
  assert.equal(env.sign, buildSign(cfg(), { sid: String(env.sid), timestamp: String(env.timestamp) }))
  assert.deepEqual(env.data, { question: 'hi', user_id: 'u1' })
})

test('callPlatform：业务错误码如实返回', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ code: 100, desc: '签名校验失败' }) }) as never)
  const res = await callPlatform(cfg(), 'openplatform.realtimeChat', {})
  assert.equal(res.ok, false)
  assert.equal(res.code, 100)
})