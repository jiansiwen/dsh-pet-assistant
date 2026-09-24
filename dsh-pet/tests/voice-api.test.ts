import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { VoiceApiStore, synthesizeApi, transcribeApi } from '../src/main/voice-api.ts'
import type { ResolvedVoiceApi, VoiceApiInput, VoiceApiKind } from '../src/voice-api-types.ts'

const SECRET = 'sk-local-test-secret-do-not-disclose'
const MB = 1024 * 1024
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])
const WAV = new ArrayBuffer(44)
new Uint8Array(WAV).set(Buffer.from('RIFF'))
new Uint8Array(WAV).set(Buffer.from('WAVE'), 8)
const encryptionKey = randomBytes(32)
const codec = {
  encrypt(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes])
  },
  decrypt(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  },
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-voice-api-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'voice-api.json')
  return { root, file, store: new VoiceApiStore(file, codec) }
}
function input(kind: VoiceApiKind = 'tts'): VoiceApiInput {
  return { kind, name: '本地测试', endpoint: 'https://example.invalid/v1', model: 'test-model', voice: kind === 'tts' ? 'alloy' : '', apiKey: SECRET, provider: 'openai' }
}
function profile(endpoint: string, kind: VoiceApiKind = 'tts', apiKey = SECRET): ResolvedVoiceApi {
  return { ...input(kind), id: '11111111-1111-4111-8111-111111111111', endpoint, apiKey, voice: kind === 'tts' ? 'alloy' : '', provider: 'openai' }
}
function safe(error: unknown): boolean {
  assert.ok(error instanceof Error)
  assert.match(error.message, /[\u4e00-\u9fff]/)
  assert.doesNotMatch(error.message, /sk-local|SENSITIVE|127\.0\.0\.1|example\.invalid/)
  return true
}
async function serve(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | Promise<void>): Promise<string> {
  const errors: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      await handler(request, response, Buffer.concat(chunks))
    })().catch(error => { errors.push(error); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.deepEqual(errors, [])
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('配置增删改查、独立选择、加密重载与默认恢复', t => {
  const { file, store } = fixture(t)
  assert.deepEqual(store.snapshot(), { profiles: [], selected: { tts: null, asr: null } })
  assert.equal(store.resolve('tts'), null)
  assert.equal(store.resolve('asr'), null)
  const first = store.save(input()).profiles[0]
  assert.match(first.id, /^[0-9a-f-]{36}$/)
  assert.equal(first.endpoint, 'https://example.invalid/v1/audio/speech')
  assert.equal(first.hasKey, true)
  assert.equal(store.resolve('tts'), null)
  const asr = store.save(input('asr')).profiles[1]
  const other = store.save({ ...input(), name: '第二组' }).profiles[2]
  store.select('tts', first.id)
  store.select('asr', asr.id)
  assert.equal(store.resolve('tts')?.apiKey, SECRET)
  assert.equal(store.resolve('asr')?.endpoint, 'https://example.invalid/v1/audio/transcriptions')
  const disk = readFileSync(file, 'utf8')
  const saved = JSON.parse(disk)
  assert.equal(disk.includes(SECRET), false)
  assert.equal(disk.includes('apiKey'), false)
  assert.equal(codec.decrypt(Buffer.from(saved.profiles[0].encryptedKey, 'base64')), SECRET)
  const state = store.snapshot()
  assert.equal(JSON.stringify(state).includes(saved.profiles[0].encryptedKey), false)
  assert.equal(JSON.stringify(state).includes(SECRET), false)
  assert.equal('encryptedKey' in state.profiles[0], false)
  state.selected.tts = null
  state.profiles[0].name = '篡改副本'
  assert.equal(store.snapshot().profiles[0].name, '本地测试')
  assert.equal(store.resolve('tts')?.id, first.id)
  const loaded = new VoiceApiStore(file, codec)
  assert.deepEqual(loaded.snapshot(), store.snapshot())
  assert.equal(loaded.resolve('tts')?.apiKey, SECRET)
  loaded.select('tts', other.id)
  loaded.select('tts', null)
  assert.equal(loaded.resolve('tts'), null)
  assert.equal(loaded.resolve('asr')?.id, asr.id)
  loaded.select('tts', first.id)
  loaded.remove(other.id)
  assert.equal(loaded.resolve('tts')?.id, first.id)
  loaded.remove(first.id)
  assert.equal(loaded.resolve('tts'), null)
  loaded.remove(asr.id)
  assert.deepEqual(new VoiceApiStore(file, codec).snapshot(), { profiles: [], selected: { tts: null, asr: null } })
})

test('省略密钥保留、空串清除，非法密钥或加密异常不修改原状态', t => {
  const { file, store } = fixture(t)
  const id = store.save(input()).profiles[0].id
  store.select('tts', id)
  const { apiKey: _key, ...withoutKey } = input()
  store.save({ ...withoutKey, id, name: '改名' })
  assert.equal(store.resolve('tts')?.apiKey, SECRET)
  const before = readFileSync(file, 'utf8')
  for (const apiKey of [null, 12, '\r\nSENSITIVE', 'x'.repeat(4097)]) {
    assert.throws(() => store.save({ ...input(), id, apiKey }), safe)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
  const broken = new VoiceApiStore(file, { ...codec, encrypt() { throw new Error(SECRET) } })
  assert.throws(() => broken.save({ ...input(), id, apiKey: 'replacement' }), safe)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(broken.resolve('tts')?.apiKey, SECRET)
  store.save({ ...input(), id, apiKey: '' })
  assert.equal(store.snapshot().profiles[0].hasKey, false)
  assert.equal(store.resolve('tts')?.apiKey, '')
  assert.equal(new VoiceApiStore(file, codec).resolve('tts')?.apiKey, '')
})

test('种类、标识、数量、字段必填及长度校验', t => {
  const { store, file } = fixture(t)
  const id = store.save(input()).profiles[0].id
  const before = readFileSync(file, 'utf8')
  const invalid = [null, [], {}, { ...input(), kind: 'other' }, { ...input(), name: '' }, { ...input(), name: 'x'.repeat(101) }, { ...input(), model: '' }, { ...input(), model: 'x'.repeat(201) }, { ...input(), voice: '' }, { ...input(), voice: 'x'.repeat(201) }, { ...input(), endpoint: 'https://example.invalid/' + 'x'.repeat(2048) }, { ...input(), extra: SECRET }, { ...input(), id: 'custom-id' }, { ...input(), id: '11111111-1111-4111-8111-111111111111' }, { ...input('asr'), id }]
  for (const value of invalid) assert.throws(() => store.save(value), safe)
  assert.throws(() => store.select('asr', id), safe)
  assert.throws(() => store.select('other', null), safe)
  assert.throws(() => store.select('tts', undefined), safe)
  assert.throws(() => store.remove('bad'), safe)
  assert.throws(() => store.remove('11111111-1111-4111-8111-111111111111'), safe)
  assert.equal(readFileSync(file, 'utf8'), before)
  for (let i = 1; i < 20; i++) store.save(input(i % 2 ? 'tts' : 'asr'))
  assert.throws(() => store.save(input()), /数量/)
  store.save({ ...input(), id, name: '上限仍可编辑' })
  assert.equal(store.snapshot().profiles.length, 20)
})

test('地址仅允许安全协议或回环，追加正确端点且不重复', t => {
  const { store } = fixture(t)
  for (const endpoint of ['http://example.invalid/v1', 'ftp://localhost/v1', 'https://user:pass@example.invalid/v1', 'https://example.invalid/v1?key=SENSITIVE', 'https://example.invalid/v1#SENSITIVE', 'https://example.invalid/v1?', 'https://example.invalid/v1#', 'http://localhost.evil.invalid', 'http://192.168.1.1', 'http://[::]', 'http://128.0.0.1', 'https://example.invalid\\v1', 'not-a-url', 'https://example.invalid/v1/audio/transcriptions']) {
    assert.throws(() => store.save({ ...input(), endpoint }), safe)
  }
  for (const endpoint of ['http://localhost:123/v1', 'http://127.0.0.2:123/v1', 'http://[::1]:123/v1', 'https://example.invalid/v1/', 'https://example.invalid/v1/audio/speech/']) {
    const state = store.save({ ...input(), endpoint })
    const stored = state.profiles.at(-1)!.endpoint
    assert.ok(stored.endsWith('/v1/audio/speech'))
    assert.equal(stored.split('/audio/speech').length, 2)
  }
  const asr = store.save({ ...input('asr'), endpoint: 'https://example.invalid/audio/transcriptions' }).profiles.at(-1)!
  assert.equal(asr.endpoint, 'https://example.invalid/audio/transcriptions')
})

test('损坏文件、密文及解密失败报安全错误并完整保留原文件', t => {
  const { store, file } = fixture(t)
  const id = store.save(input()).profiles[0].id
  store.select('tts', id)
  const original = readFileSync(file, 'utf8')
  assert.throws(() => new VoiceApiStore(file, { ...codec, decrypt() { throw new Error(SECRET) } }), safe)
  assert.equal(readFileSync(file, 'utf8'), original)
  const document = JSON.parse(original)
  const corruptions = ['', '{SENSITIVE', 'null', '{}', '[]', JSON.stringify({ ...document, version: 2 }), JSON.stringify({ ...document, selected: { tts: null } }), JSON.stringify({ ...document, selected: { tts: null, asr: id } }), JSON.stringify({ ...document, profiles: [document.profiles[0], document.profiles[0]] }), JSON.stringify({ ...document, profiles: [{ ...document.profiles[0], encryptedKey: 'invalid!' }] }), JSON.stringify({ ...document, profiles: [{ ...document.profiles[0], encryptedKey: Buffer.from('SENSITIVE').toString('base64') }] }), 'x'.repeat(MB + 1)]
  for (const content of corruptions) {
    writeFileSync(file, content)
    assert.throws(() => new VoiceApiStore(file, codec), safe)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('原子替换失败不更新内存且清理临时文件', t => {
  const { store, file, root } = fixture(t)
  store.save(input())
  const before = store.snapshot()
  unlinkSync(file)
  mkdirSync(file)
  assert.throws(() => store.save(input('asr')), safe)
  assert.deepEqual(store.snapshot(), before)
  assert.deepEqual(readdirSync(root), ['voice-api.json'])
})

test('真实合成请求使用正确端点、认证头和JSON，返回有效音频', async t => {
  let calls = 0
  const base = await serve(t, (req, res, body) => {
    calls++
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/audio/speech')
    assert.equal(req.headers.authorization, calls === 1 ? `Bearer ${SECRET}` : undefined)
    assert.equal(req.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(body.toString()), { model: 'test-model', input: '你好', voice: 'alloy', response_format: 'mp3' })
    res.setHeader('content-type', calls === 1 ? 'audio/mpeg' : 'application/octet-stream')
    res.end(MP3)
  })
  assert.deepEqual(await synthesizeApi(profile(base + '/v1'), '你好'), MP3)
  assert.deepEqual(await synthesizeApi(profile(base + '/v1/audio/speech', 'tts', ''), '你好'), MP3)
  assert.equal(calls, 2)
})

test('真实识别请求使用multipart WAV及模型，缺少密钥不发认证头', async t => {
  let calls = 0
  const base = await serve(t, async (req, res, body) => {
    calls++
    assert.equal(req.url, '/v1/audio/transcriptions')
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, calls === 1 ? `Bearer ${SECRET}` : undefined)
    const mime = req.headers['content-type']!
    assert.match(mime, /^multipart\/form-data; boundary=/)
    const form = await new Response(Uint8Array.from(body), { headers: { 'content-type': mime } }).formData()
    assert.equal(form.get('model'), 'test-model')
    assert.equal(form.get('response_format'), 'json')
    const file = form.get('file') as File
    assert.equal(file.name, 'audio.wav')
    assert.equal(file.type, 'audio/wav')
    assert.deepEqual(await file.arrayBuffer(), WAV)
    assert.equal([...form.keys()].length, 3)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ text: '本地识别成功' }))
  })
  for (const key of [SECRET, '']) assert.deepEqual(await transcribeApi(profile(base + '/v1', 'asr', key), WAV), { ok: true, text: '本地识别成功' })
  assert.equal(calls, 2)
})

test('真实服务拒绝认证、错误MIME、伪音频、无效JSON及错误结果结构', async t => {
  const cases = [
    { status: 401, mime: 'text/plain', body: SECRET + 'SENSITIVE' },
    { status: 500, mime: 'text/plain', body: SECRET + 'SENSITIVE' },
    { status: 200, mime: 'text/html', body: '<html>SENSITIVE</html>' },
    { status: 200, mime: 'application/octet-stream', body: '<html>SENSITIVE</html>' },
    { status: 200, mime: 'audio/mpeg', body: 'ID3<html>SENSITIVE</html>' },
    { status: 200, mime: 'audio/wav', body: MP3 },
    { status: 200, mime: 'application/json', body: '{SENSITIVE' },
    { status: 200, mime: 'application/json', body: JSON.stringify({ text: 123, error: SECRET }) },
  ]
  let current = cases[0]
  const base = await serve(t, (_req, res) => { res.writeHead(current.status, { 'content-type': current.mime }); res.end(current.body) })
  for (const item of cases) {
    current = item
    await assert.rejects(synthesizeApi(profile(base), '你好'), safe)
    const result = await transcribeApi(profile(base, 'asr'), WAV)
    assert.equal(result.ok, false)
    safe(new Error(result.error))
  }
})

test('接受有效ID3标签，拒绝非法帧及空音频', async t => {
  let bytes = Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), MP3])
  const base = await serve(t, (_req, res) => { res.setHeader('content-type', 'audio/mpeg'); res.end(bytes) })
  assert.deepEqual(await synthesizeApi(profile(base), '你好'), bytes)
  for (const invalid of [Buffer.alloc(0), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([73, 68, 51, 4, 0, 0, 127, 127, 127, 127]), Buffer.from([0xff, 0xeb, 0x90, 0x64])]) {
    bytes = invalid
    await assert.rejects(synthesizeApi(profile(base), '你好'), safe)
  }
})

test('输入大小限制在发请求前执行，五千字边界可用', async t => {
  let calls = 0
  const base = await serve(t, (_req, res) => { calls++; res.setHeader('content-type', 'audio/mpeg'); res.end(MP3) })
  for (const text of ['', '  ', '中'.repeat(5001)]) await assert.rejects(synthesizeApi(profile(base), text), safe)
  for (const wav of [new ArrayBuffer(0), new ArrayBuffer(25 * MB + 1)]) {
    const result = await transcribeApi(profile(base, 'asr'), wav)
    assert.equal(result.ok, false)
    safe(new Error(result.error))
  }
  await assert.rejects(synthesizeApi(profile(base, 'asr'), '你好'), safe)
  assert.equal(calls, 0)
  await synthesizeApi(profile(base), '中'.repeat(5000))
  assert.equal(calls, 1)
})

test('响应限额同时检查声明长度与无长度流式响应', async t => {
  for (const kind of ['tts', 'asr'] as const) {
    for (const declared of [true, false]) {
      await t.test(`${kind}：${declared ? '声明长度' : '流式计数'}`, async sub => {
        const maximum = kind === 'tts' ? 20 * MB : MB
        const base = await serve(sub, (_req, res) => {
          res.setHeader('content-type', kind === 'tts' ? 'audio/mpeg' : 'application/json')
          if (declared) { res.setHeader('content-length', maximum + 1); res.flushHeaders() }
          else { res.write(Buffer.alloc(maximum)); res.end(Buffer.from('x')) }
        })
        if (kind === 'tts') await assert.rejects(synthesizeApi(profile(base), '你好'), /大小限制/)
        else {
          const result = await transcribeApi(profile(base, 'asr'), WAV)
          assert.equal(result.ok, false)
          assert.match(result.error!, /大小限制/)
        }
      })
    }
  }
})

test('重定向不跟随且不向目标泄露认证头', async t => {
  let targetCalls = 0
  const target = await serve(t, (_req, res) => { targetCalls++; res.end(SECRET) })
  const base = await serve(t, (_req, res) => { res.writeHead(307, { location: target + '/SENSITIVE' }); res.end() })
  await assert.rejects(synthesizeApi(profile(base), '你好'), safe)
  const result = await transcribeApi(profile(base, 'asr'), WAV)
  assert.equal(result.ok, false)
  safe(new Error(result.error))
  assert.equal(targetCalls, 0)
})

test('取消保留AbortError且不泄露取消原因，覆盖请求前及响应流中', async t => {
  for (const kind of ['tts', 'asr'] as const) {
    for (const phase of ['请求前', '等待响应头', '读取响应体']) {
      await t.test(`${kind}：${phase}`, async sub => {
        const controller = new AbortController()
        let notify!: () => void
        const received = new Promise<void>(resolve => { notify = resolve })
        let calls = 0
        const base = await serve(sub, (_req, res) => {
          calls++
          if (phase === '读取响应体') {
            res.setHeader('content-type', kind === 'tts' ? 'audio/mpeg' : 'application/json')
            res.write(kind === 'tts' ? MP3 : '{"text":"')
          }
          notify()
        })
        if (phase === '请求前') controller.abort(new Error(SECRET))
        const pending = kind === 'tts' ? synthesizeApi(profile(base), '你好', controller.signal) : transcribeApi(profile(base, 'asr'), WAV, controller.signal)
        const rejected = assert.rejects(pending, error => { safe(error); assert.equal((error as Error).name, 'AbortError'); return true })
        if (phase !== '请求前') {
          await received
          // 等待事件循环消费已发送的响应头及首个数据块。
          await new Promise(resolve => setImmediate(resolve))
          controller.abort(new Error(SECRET))
        }
        await rejected
        assert.equal(calls, phase === '请求前' ? 0 : 1)
      })
    }
  }
})

test('六十秒超时覆盖等待响应头与读取响应体', async t => {
  for (const kind of ['tts', 'asr'] as const) {
    await t.test(kind, async sub => {
      let notify!: () => void
      const received = new Promise<void>(resolve => { notify = resolve })
      const base = await serve(sub, (_req, res) => {
        if (kind === 'asr') { res.setHeader('content-type', 'application/json'); res.write('{"text":"') }
        notify()
      })
      sub.mock.timers.enable({ apis: ['setTimeout'] })
      const pending = kind === 'tts' ? synthesizeApi(profile(base), '你好') : transcribeApi(profile(base, 'asr'), WAV)
      const check = kind === 'tts' ? assert.rejects(pending, /超时/) : pending.then(result => { assert.equal((result as { ok: boolean }).ok, false); assert.match((result as { error: string }).error, /超时/) })
      await received
      await new Promise(resolve => setImmediate(resolve))
      sub.mock.timers.tick(60_000)
      await check
    })
  }
})
