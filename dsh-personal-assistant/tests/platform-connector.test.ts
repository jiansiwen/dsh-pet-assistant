import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { buildSign, callPlatform, defaultPlatformConfig, md5Upper, platformTimestamp, readPlatformConfig, writePlatformConfig, type PlatformConfig } from '../src/platform-connector.ts'
import { SubAssistantDispatch } from '../src/sub-assistant-dispatch.ts'
import { SubAssistantRegistry } from '../src/sub-assistant-registry.ts'
import { TeamStore } from '../src/team-domain.ts'

function cfg(patch: Partial<PlatformConfig> = {}): PlatformConfig {
  return { ...defaultPlatformConfig(), enabled: true, endpoint: 'https://example.invalid/api/chat/realtime', appid: 'app1', secret: 's3cret', userId: 'u1', assistId: 'a1', ...patch }
}

test('标准签名按手册拼接排序后的字段名和值，旧默认模板自动按标准签名', () => {
  assert.equal(md5Upper('abc'), '900150983CD24FB0D6963F7D28E17F72')
  const fields = { sid: 'SID1', timestamp: '20261119090000', service: 'openplatform.getAssistantList',
    bizid: '', data: { z: [2, 1], a: { z: '考拉', a: 1 } } }
  const expected = md5Upper('appidapp1bizidchannelPCdata{"a":{"a":1,"z":"考拉"},"z":[2,1]}serviceopenplatform.getAssistantListsidSID1timestamp20261119090000s3cret')
  assert.equal(buildSign(cfg(), fields), expected)
  assert.equal(buildSign(cfg({ signTemplate: '{appid}{timestamp}{sid}{secret}' }), fields), expected)
  assert.equal(buildSign(cfg({ signTemplate: '{secret}{sid}' }), fields), md5Upper('s3cretSID1'))
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

test('callPlatform：缺签名密钥时本地拒绝，不发空密钥签名', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('不应发起请求'))
  assert.equal((await callPlatform(cfg({ enabled: false }), 'openplatform.realtimeChat', {})).ok, false)
  assert.equal((await callPlatform(cfg({ endpoint: '' }), 'openplatform.realtimeChat', {})).ok, false)
  assert.match((await callPlatform(cfg({ secret: '' }), 'openplatform.realtimeChat', {})).error ?? '', /app_secret/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('callPlatform：组装公共报文＋加签＋解析返回', async (t: TestContext) => {
  let captured: { body?: string; redirect?: string } = {}
  t.mock.method(globalThis, 'fetch', async (_url: string, init: { body: string; redirect: string }) => {
    captured = init
    return Response.json({ code: '0', desc: 'ok', data: '{"content":"你好"}' })
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
  assert.equal(env.bizid, '')
  assert.equal(env.data, JSON.stringify({ question: 'hi', user_id: 'u1' }))
  assert.equal(env.sign, md5Upper(`appidapp1bizidchannelPCdata${env.data}serviceopenplatform.realtimeChatsid${env.sid}timestamp${env.timestamp}s3cret`))
  assert.deepEqual(JSON.parse(String(env.data)), { question: 'hi', user_id: 'u1' })
  assert.equal(captured.redirect, 'error')
  assert.doesNotMatch(captured.body ?? '', /s3cret/)
})

test('生产回执：顶层 success/datas 也认，data 以 JSON 字符串发送', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    assert.equal(typeof body.data, 'string', 'data 必须是 JSON 字符串')
    return Response.json({ success: true, count: 2, pages: 1, datas: [{ assist_name: '甲' }, { assist_name: '乙' }] })
  })
  const res = await callPlatform(cfg(), 'openplatform.getAssistantList', { user_id: 'u1', page: 1, limit: 20 })
  assert.equal(res.ok, true)
  assert.equal((res.data as { count: number }).count, 2)
  assert.equal((res.data as { datas: unknown[] }).datas.length, 2)
})

test('callPlatform：HTTP 200 的字符串业务错误码如实返回', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: '100', desc: '签名校验失败' }))
  const res = await callPlatform(cfg(), 'openplatform.realtimeChat', {})
  assert.equal(res.ok, false)
  assert.equal(res.code, 100)
  assert.equal(res.desc, '签名校验失败')
})

test('callPlatform：SSE 聊天回执逐帧累积正文', async (t: TestContext) => {
  const sse = [
    'data:{"content":"收到，","success":true}',
    '',
    'data:{"content":"已连通。","success":true}',
    '',
    'data:{"created":1795501109,"finishReason":"stop","message_id":23598679,"success":true}',
    '',
  ].join('\n')
  t.mock.method(globalThis, 'fetch', async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
  const res = await callPlatform(cfg(), 'openplatform.realtimeChat', { question: 'hi', user_id: 'u1' })
  assert.equal(res.ok, true)
  assert.equal((res.data as { content: string }).content, '收到，已连通。')
  assert.equal((res.data as { messageId: number }).messageId, 23598679)
})

test('外部智能体获授平台能力后由 DSH 执行只读查询，不把数据和凭据转发给聊天端点', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const draft = { displayName: '考拉', description: '', persona: '', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 1024, capabilities: ['platform'] as const, allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, kind: 'platform' as const, reportMode: 'self' as const,
    binding: { kind: 'platform' as const, endpoint: 'https://chat.example.invalid/v1', model: '', agentId: '42', secretId: '仅聊天使用' } }
  const member = store.directory.create({ ...draft, capabilities: [...draft.capabilities] })
  const denied = store.directory.create({ ...draft, displayName: '未授权成员', capabilities: [] })
  const report = t.mock.fn()
  let response = { code: '0', data: { success: true, count: 4, datas: [{ assist_name: '只读样例', private_field: '不转发私有字段' }] } }
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, cfg().endpoint)
    assert.equal(JSON.parse(String(init.body)).service, 'openplatform.getAssistantList')
    return Response.json(response)
  })
  const dispatch = new SubAssistantDispatch({ directory: store.directory, ledger: store,
    registry: new SubAssistantRegistry({ idleTtlMs: 60000, maxSessions: 1, resolveKey: () => assert.fail('只读查询不能取聊天密钥') }),
    platformConfig: () => cfg(), onSelfReport: report, maxDispatchDepth: 1, timeoutMs: 5000 })
  const query = { platformQuery: 'list_assistants' as const }
  assert.equal((await dispatch.dispatch(denied.assistantId, '列出智能体', 'denied', query)).status, 'refused')
  assert.equal(fetch.mock.callCount(), 0)
  const result = await dispatch.dispatch(member.assistantId, '列出智能体', 'allowed', query)
  assert.equal(result.status, 'completed', result.text)
  assert.match(result.text, /共 4 个/)
  assert.match(result.text, /只读样例/)
  assert.doesNotMatch(result.text, /不转发私有字段/)
  assert.equal(report.mock.calls[0]?.arguments[0]?.assistantId, member.assistantId)
  assert.equal((await dispatch.dispatch(member.assistantId, '列出智能体', 'allowed', query)).runId, result.runId)
  assert.equal(fetch.mock.callCount(), 1)
  response = { code: '0', data: { success: false, count: 0, datas: [] } }
  const failed = await dispatch.dispatch(member.assistantId, '列出智能体', 'failed', query)
  assert.equal(failed.status, 'failed')
  assert.doesNotMatch(failed.text, /共 0 个/)
  assert.equal(report.mock.callCount(), 1)
})

test('成员的只读查询用自己的应用 ID、签名密钥和签名接口地址；缺密钥时如实拒绝', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const base = { displayName: '考拉', description: '', persona: '', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 1024, capabilities: ['platform'] as const, allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, kind: 'platform' as const, reportMode: 'self' as const,
    binding: { kind: 'platform' as const, endpoint: 'https://chat.example.invalid/v1', model: '', agentId: '42',
      secretId: '', appId: '10001', appSecretId: 'vault-entry', signEndpoint: 'https://sign.example.invalid/sign/realtime', signUserId: 'member-user' } }
  const member = store.directory.create({ ...base, capabilities: [...base.capabilities] })
  const missing = store.directory.create({ ...base, displayName: '缺签名', capabilities: [...base.capabilities],
    binding: { ...base.binding, appId: '10001', appSecretId: '' } })
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://sign.example.invalid/sign/realtime', '成员的签名接口地址要覆盖本机配置')
    const body = JSON.parse(String(init.body)) as Record<string, string>
    assert.equal(body.appid, '10001')
    assert.equal(typeof body.data, 'string')
    assert.equal((JSON.parse(body.data) as { user_id: string }).user_id, 'member-user', '成员的用户标识要覆盖本机配置')
    assert.doesNotMatch(JSON.stringify(body), /s3cret/u, '全局签名密钥不能落到成员请求里')
    const expected = md5Upper(`appid10001bizidchannelPCdata${body.data}serviceopenplatform.getAssistantListsid${body.sid}timestamp${body.timestamp}member-sign-secret`)
    assert.equal(body.sign, expected)
    return Response.json({ success: true, count: 1, pages: 1, datas: [{ assist_name: '甲的智能体' }] })
  })
  const dispatch = new SubAssistantDispatch({ directory: store.directory, ledger: store,
    registry: new SubAssistantRegistry({ idleTtlMs: 60000, maxSessions: 1, resolveKey: () => '' }),
    platformConfig: () => cfg(), resolveSecret: id => id === 'vault-entry' ? 'member-sign-secret' : '',
    maxDispatchDepth: 1, timeoutMs: 5000 })
  const refused = await dispatch.dispatch(missing.assistantId, '列出智能体', 'missing', { platformQuery: 'list_assistants' })
  assert.equal(refused.status, 'failed')
  assert.match(refused.text, /签名密钥还没配置/u)
  assert.equal(fetch.mock.callCount(), 0)
  const result = await dispatch.dispatch(member.assistantId, '列出智能体', 'member', { platformQuery: 'list_assistants' })
  assert.equal(result.status, 'completed', result.text)
  assert.match(result.text, /甲的智能体/u)
  assert.equal(fetch.mock.callCount(), 1)
})

test('平台成员的对话、会话、聊天记录与知识库上传都走成员凭据', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sqlFile = path.join(dir, 'wpos_svr_trans_order.sql')
  writeFileSync(sqlFile, 'CREATE TABLE t (id int);')
  const base = { displayName: '考拉', description: '', persona: '', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 1024, capabilities: ['platform'] as const, allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, kind: 'platform' as const, reportMode: 'self' as const,
    binding: { kind: 'platform' as const, endpoint: 'https://chat.example.invalid/v1', model: '', agentId: '1360',
      secretId: '', appId: '10001', appSecretId: 'vault', signEndpoint: 'https://sign.example.invalid/realtime', signUserId: '210' } }
  const member = store.directory.create({ ...base, capabilities: [...base.capabilities] })
  const seen: Array<{ url: string; service: string; appid: string; data: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { service: string; appid: string; data: string }
    seen.push({ url, service: body.service, appid: body.appid, data: JSON.parse(body.data) as Record<string, unknown> })
    if (body.service === 'openplatform.realtimeChat') {
      return new Response('data:{"content":"平台收到","success":true}\n\ndata:{"finishReason":"stop","message_id":9,"success":true}\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    }
    if (body.service === 'openplatform.getSessionList') {
      return Response.json({ success: true, count: 1, datas: [{ chat_id: '210_1360', session_name: '测试会话' }] })
    }
    if (body.service === 'openplatform.getChatList') {
      return Response.json({ success: true, count: 1, datas: [{ question: '你好' }] })
    }
    if (body.service === 'aiagent.upload.knowledge') {
      return Response.json({ success: true, data: [{ success: true, fileCode: 'fc-1' }] })
    }
    throw new Error(`意外的 service ${body.service}`)
  })
  const dispatch = new SubAssistantDispatch({ directory: store.directory, ledger: store,
    registry: new SubAssistantRegistry({ idleTtlMs: 60000, maxSessions: 1, resolveKey: () => '' }),
    platformConfig: () => cfg(), resolveSecret: id => id === 'vault' ? 'member-secret' : '',
    maxDispatchDepth: 1, timeoutMs: 5000 })
  const chat = await dispatch.dispatch(member.assistantId, '问一下', 'chat-1', { platformChat: { question: '你好' } })
  assert.equal(chat.status, 'completed', chat.text)
  assert.match(chat.text, /平台收到/u)
  const sessions = await dispatch.dispatch(member.assistantId, '查会话', 'session-1', { platformQuery: 'list_sessions' })
  assert.equal(sessions.status, 'completed', sessions.text)
  assert.match(sessions.text, /测试会话/u)
  const chats = await dispatch.dispatch(member.assistantId, '查记录', 'chats-1', { platformQuery: 'list_chats' })
  assert.equal(chats.status, 'completed', chats.text)
  assert.match(chats.text, /你好/u)
  const upload = await dispatch.dispatch(member.assistantId, '传表结构', 'upload-1', { platformUpload: { filePath: sqlFile } })
  assert.equal(upload.status, 'completed', upload.text)
  assert.match(upload.text, /wpos_svr_trans_order\.txt/u)
  assert.match(upload.text, /已上传/u)
  assert.ok(seen.every(item => item.url === 'https://sign.example.invalid/realtime'), '成员的签名接口地址要覆盖本机配置')
  assert.ok(seen.every(item => item.appid === '10001'), '成员的 appId 要覆盖本机配置')
  assert.ok(seen.every(item => item.data.user_id === '210'), '成员的用户标识要覆盖本机配置')
  const uploadCall = seen.find(item => item.service === 'aiagent.upload.knowledge')!
  assert.equal(uploadCall.data.assist_id, '1360')
  assert.equal((uploadCall.data.files as Array<{ file_ext: string }>)[0]!.file_ext, 'txt')
})

test('本机专家的平台凭据逐项覆盖本机配置', async () => {
  const { platformConfigFor } = await import('../src/member-runtime.ts')
  const auth = { appId: '10001', appSecretId: 'vault-entry', signEndpoint: 'https://sign.example.invalid/realtime', signUserId: '210' }
  const config = platformConfigFor({ kind: 'expert', platformAuth: auth } as never,
    { config: () => cfg(), secret: id => id === 'vault-entry' ? 'member-secret' : '' })
  assert.equal(config.endpoint, 'https://sign.example.invalid/realtime')
  assert.equal(config.appid, '10001')
  assert.equal(config.secret, 'member-secret')
  assert.equal(config.userId, '210')
  const plain = platformConfigFor({ kind: 'expert', platformAuth: null } as never, { config: () => cfg() })
  assert.equal(plain.endpoint, cfg().endpoint)
  assert.equal(plain.appid, 'app1')
  assert.equal(plain.secret, 's3cret')
})
