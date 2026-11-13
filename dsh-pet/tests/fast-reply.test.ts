/**
 * 快速应答（快嘴旁路）测试：
 * - 配置校验与密钥加密（明文绝不落盘、密钥不可用时拒绝保存）；
 * - 生成链路（人设提示词、超时/取消/失败一律静默返回 null）；
 * - 临时话语的播出语义：照常出声，但不进"打断后要告诉模型的内容"，
 *   否则旁路等于间接进了 DSH 会话。
 *
 * 跑法：`npm test`。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { FastReplyService, ackSystemPrompt, clampAck, type FastReplyDeps } from '../src/main/fast-reply.ts'
import { Narrator, type TtsWorkerEvent } from '../src/main/tts.ts'

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
type FakeReply = { ok: boolean; status: number; content?: unknown } | 'hang' | 'error'

function fixture(context?: FastReplyDeps['context']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fast-reply-'))
  const key = Buffer.alloc(32, 7)
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal }> = []
  let reply: FakeReply = { ok: true, status: 200, content: '好嘞，我这就去办。' }
  const fetchImpl = async (url: string, init: FetchInit) => {
    const current = reply
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal })
    if (current === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    if (current === 'error') throw new Error('network down')
    return { ok: current.ok, status: current.status, json: async () => ({ choices: [{ message: { content: current.content } }] }) }
  }
  const service = new FastReplyService(dir, {
    key: () => key,
    fetch: fetchImpl,
    context: context ?? (async () => ({ name: '小潘', persona: '温柔干练，偶尔俏皮' })),
  })
  const enable = () => service.save({ enabled: true, baseUrl: 'https://api.example.com/v1', model: 'fast-model' })
  return { dir, key, service, requests, enable, setReply: (next: FakeReply) => { reply = next }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('缺省关闭：未启用时一次请求都不发', async () => {
  const f = fixture()
  try {
    const snapshot = f.service.snapshot()
    assert.equal(snapshot.enabled, false)
    assert.equal(snapshot.secretConfigured, false)
    assert.equal(await f.service.generate('帮我整理会议记录', new AbortController().signal), null)
    assert.equal(f.requests.length, 0)
  } finally { f.cleanup() }
})

test('配置校验：开启必须先有端点与模型；数值有范围', () => {
  const f = fixture()
  try {
    assert.throws(() => f.service.save({ enabled: true }), /开启前请先填写/)
    assert.throws(() => f.service.save({ baseUrl: 'ftp://x' }), /http/)
    assert.throws(() => f.service.save({ timeoutMs: 100 }), /超时/)
    assert.throws(() => f.service.save({ maxChars: 500 }), /长度/)
    f.enable()
    assert.equal(f.service.load().enabled, true)
    assert.equal(f.service.load().baseUrl, 'https://api.example.com/v1')
    // 重新实例化（同一密钥）后配置仍在。
    const reopened = new FastReplyService(f.dir, { key: () => f.key })
    assert.equal(reopened.load().model, 'fast-model')
  } finally { f.cleanup() }
})

test('密钥只加密落盘：配置与密钥文件都不含明文，重启可解', async () => {
  const f = fixture()
  try {
    f.service.save({ apiKey: 'sk-secret-123' })
    assert.equal(f.service.snapshot().secretConfigured, true)
    const configRaw = readFileSync(path.join(f.dir, 'fast-reply', 'config.json'), 'utf8')
    const secretRaw = readFileSync(path.join(f.dir, 'fast-reply', 'secret'), 'utf8')
    assert.ok(!configRaw.includes('sk-secret-123'))
    assert.ok(!secretRaw.includes('sk-secret-123'))
    const reopened = new FastReplyService(f.dir, { key: () => f.key })
    assert.equal(reopened.snapshot().secretConfigured, true)
    // 清空密钥后状态如实回落。
    reopened.save({ apiKey: '' })
    assert.equal(reopened.snapshot().secretConfigured, false)
  } finally { f.cleanup() }
})

test('系统密钥不可用时拒绝保存密钥，不明文兜底', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fast-reply-nokey-'))
  try {
    const service = new FastReplyService(dir, { key: () => null })
    assert.throws(() => service.save({ apiKey: 'sk-x' }), /密钥存储不可用/)
    // 不带密钥的普通配置仍可保存。
    service.save({ baseUrl: 'https://api.example.com/v1', model: 'm' })
    assert.equal(service.load().model, 'm')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('生成：人设进系统提示词、原话进用户消息、密钥走 Authorization', async () => {
  const f = fixture()
  try {
    f.enable()
    f.service.save({ apiKey: 'sk-secret-123' })
    const ack = await f.service.generate('帮我把今天的会议记录整理一下', new AbortController().signal)
    assert.equal(ack, '好嘞，我这就去办。')
    assert.equal(f.requests.length, 1)
    const request = f.requests[0]
    assert.equal(request.url, 'https://api.example.com/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer sk-secret-123')
    assert.equal(request.body.model, 'fast-model')
    assert.equal(request.body.stream, false)
    const messages = request.body.messages as Array<{ role: string; content: string }>
    assert.equal(messages[0].role, 'system')
    assert.ok(messages[0].content.includes('温柔干练，偶尔俏皮'))
    assert.ok(messages[0].content.includes('小潘'))
    assert.ok(messages[0].content.includes('禁止编造事实'))
    assert.equal(messages[1].content, '帮我把今天的会议记录整理一下')
  } finally { f.cleanup() }
})

test('端点已带 /chat/completions 时不重复拼接', async () => {
  const f = fixture()
  try {
    f.service.save({ enabled: true, baseUrl: 'https://api.example.com/v1/chat/completions', model: 'm' })
    await f.service.generate('你好', new AbortController().signal)
    assert.equal(f.requests[0].url, 'https://api.example.com/v1/chat/completions')
  } finally { f.cleanup() }
})

test('超时静默返回 null，不拖住主轨', async () => {
  const f = fixture()
  try {
    f.service.save({ enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', timeoutMs: 500 })
    f.setReply('hang')
    const startedAt = Date.now()
    assert.equal(await f.service.generate('你好', new AbortController().signal), null)
    assert.ok(Date.now() - startedAt < 2000, '超时必须及时收手')
  } finally { f.cleanup() }
})

test('外部取消：已中止的信号不再发请求', async () => {
  const f = fixture()
  try {
    f.enable()
    const controller = new AbortController()
    controller.abort()
    assert.equal(await f.service.generate('你好', controller.signal), null)
    assert.equal(f.requests.length, 0)
  } finally { f.cleanup() }
})

test('服务异常一律 null：非 200 / 网络错误 / 空内容 / 结构不对', async () => {
  const f = fixture()
  try {
    f.enable()
    const signal = new AbortController().signal
    f.setReply({ ok: false, status: 401, content: '好嘞。' })
    assert.equal(await f.service.generate('你好', signal), null)
    f.setReply('error')
    assert.equal(await f.service.generate('你好', signal), null)
    f.setReply({ ok: true, status: 200, content: '   ' })
    assert.equal(await f.service.generate('你好', signal), null)
    f.setReply({ ok: true, status: 200, content: 42 })
    assert.equal(await f.service.generate('你好', signal), null)
  } finally { f.cleanup() }
})

test('人设取不到就用默认性格，不挡快嘴', async () => {
  const f = fixture(async () => { throw new Error('bridge offline') })
  try {
    f.enable()
    assert.equal(await f.service.generate('你好', new AbortController().signal), '好嘞，我这就去办。')
    const system = (f.requests[0].body.messages as Array<{ content: string }>)[0].content
    assert.ok(system.includes('友好、干练'))
  } finally { f.cleanup() }
})

test('测试连接：不要求已开启；缺配置如实报错', async () => {
  const f = fixture()
  try {
    assert.equal((await f.service.test()).ok, false)
    f.service.save({ baseUrl: 'https://api.example.com/v1', model: 'm' })
    const result = await f.service.test()
    assert.equal(result.ok, true)
    assert.equal(result.sample, '好嘞，我这就去办。')
    assert.equal(f.service.load().enabled, false, '测试不应顺手开启')
  } finally { f.cleanup() }
})

test('clampAck：去引号、压换行、取第一句、限长', () => {
  assert.equal(clampAck('"好嘞，马上办。" 后面还有第二句。', 40), '好嘞，马上办。')
  assert.equal(clampAck('好嘞\n马上办', 40), '好嘞 马上办')
  assert.equal(clampAck('这是一句特别特别长的应答没有任何标点一直说下去说到天荒地老海枯石烂', 10), '这是一句特别特别长的…')
  assert.equal(clampAck('   ', 40), '')
  assert.equal(clampAck('收到！', 40), '收到！')
})

test('ackSystemPrompt：名字、性格、字数都进提示词', () => {
  const prompt = ackSystemPrompt('小潘', '毒舌但靠谱', 30)
  assert.ok(prompt.includes('小潘'))
  assert.ok(prompt.includes('毒舌但靠谱'))
  assert.ok(prompt.includes('30'))
})

test('临时话语照常播出，但不进打断后要告诉模型的内容', () => {
  const lines: string[] = []
  let deliver: (event: TtsWorkerEvent) => void = () => { throw new Error('合成进程还没被拉起') }
  const narrator = new Narrator(d => {
    deliver = d
    return { write: line => lines.push(line), close: () => {} }
  })
  narrator.beginRound()
  narrator.speak({ utteranceId: 'ack-1', text: '好嘞，马上办。', ephemeral: true })
  deliver({ ready: true })
  assert.ok(lines.some(line => line.includes('"speak"')), '临时话语也要真的播')
  deliver({ finished: { id: 'ack-1#0' } })
  narrator.speak({ utteranceId: 'main-1', text: '正式回答第一句。' })
  deliver({ finished: { id: 'main-1#0' } })
  narrator.interrupt('drop-queue')
  const context = narrator.interruptedContext()
  assert.ok(context !== null && context.includes('正式回答第一句'))
  assert.ok(!context.includes('好嘞'), '旁路内容不能混进给模型的打断说明')
})

test('临时话语播到一半被掐：也不算对模型说过', () => {
  let deliver: (event: TtsWorkerEvent) => void = () => { throw new Error('合成进程还没被拉起') }
  const lines: string[] = []
  const narrator = new Narrator(d => {
    deliver = d
    return { write: line => lines.push(line), close: () => {} }
  })
  narrator.beginRound()
  narrator.speak({ utteranceId: 'ack-2', text: '好嘞，这就去查那个文件。', ephemeral: true })
  deliver({ ready: true })
  narrator.interrupt('drop-queue')
  assert.ok(lines.includes('{"stop":{}}'), '接管时要真的掐断音频')
  deliver({ cancelled: { id: 'ack-2#0' } })
  assert.equal(narrator.interruptedContext(), null, '只播过旁路时，等于没对模型说过任何话')
})