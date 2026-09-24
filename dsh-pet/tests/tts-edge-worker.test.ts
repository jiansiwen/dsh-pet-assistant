/** TTS 引擎独立回归：假合成、假子进程，不联网、不播放、不录音。 */
import assert from 'node:assert/strict'
import { ChildProcess, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAudioPlayer, TtsEdgeEngine, unsupportedAudioMessage, type WorkerEvent } from '../src/main/tts-edge-worker.ts'
import type { TtsOptions } from '../src/main/edge-tts.ts'
import type { ResolvedVoiceApi } from '../src/voice-api-types.ts'

const workerUrl = new URL('../src/main/tts-edge-worker.ts', import.meta.url)
const scriptDir = fileURLToPath(new URL('../src/main/', import.meta.url))
type Deps = ConstructorParameters<typeof TtsEdgeEngine>[0]

function deferred() {
  let resolve!: (audio: Buffer) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function makeEngine(overrides: Partial<Deps> = {}) {
  const events: WorkerEvent[] = []
  const plays: Array<(completed: boolean) => void> = []
  const fallbacks: Array<(completed: boolean) => void> = []
  let stops = 0
  const deps: Deps = {
    synthesize: async () => Buffer.from('假音频'),
    play: (_audio, done) => { plays.push(done) },
    fallback: (_text, done) => { fallbacks.push(done) },
    stopAudio: () => { stops++ },
    emit: (event) => { events.push(event) },
    ...overrides,
  }
  const engine = new TtsEdgeEngine(deps)
  return { engine, deps, events, plays, fallbacks, get stops() { return stops } }
}

function tempDirectory(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-tts-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 造一个播放器 + 假 spawner。
 *
 * 注入的是**完整命令**（命令名 + 参数），所以这里同时记下两者。`files` 只在 Windows 形状下
 * 有意义（那条路的最后一个参数就是文件路径）；macOS 的 `say` 不吃文件参数，
 * 相关用例改断言命令本身。
 */
function makePlayer(t: TestContext, platform: 'win32' | 'darwin' | 'linux' = 'win32') {
  const tmp = tempDirectory(t)
  const children: ChildProcess[] = []
  const files: string[] = []
  const argumentsList: string[][] = []
  const commands: string[] = []
  const killed: ChildProcess[] = []
  const player = createAudioPlayer(scriptDir, tmp, (spec) => {
    const child = new ChildProcess()
    child.kill = () => { killed.push(child); return true }
    children.push(child)
    commands.push(spec.command)
    argumentsList.push([...spec.args])
    files.push([...spec.args].at(-1)!)
    return child
  }, platform)
  return { player, children, files, argumentsList, commands, killed, dir: tmp }
}

test('源码直接导入无副作用；直接执行才启动协议且退出清理目录', (t) => {
  const temp = tempDirectory(t)
  const options = {
    encoding: 'utf8' as const, timeout: 10000,
    env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp },
    input: '{"stop":{}}\n{"exit":{}}\n',
  }
  const imported = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const listeners = [process.stdin.listenerCount('data'), process.stdin.listenerCount('end'), process.listenerCount('exit')];
    await import(${JSON.stringify(workerUrl.href)});
    assert.deepEqual([process.stdin.listenerCount('data'), process.stdin.listenerCount('end'), process.listenerCount('exit')], listeners);
  `], options)
  assert.ifError(imported.error)
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  assert.deepEqual(readdirSync(temp), [])

  const executed = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(workerUrl)], options)
  assert.ifError(executed.error)
  assert.equal(executed.status, 0, executed.stderr)
  assert.deepEqual(executed.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    { ready: true, voice: 'zh-CN-XiaoxiaoNeural' },
  ])
  assert.deepEqual(readdirSync(temp), [])
})

for (const completed of [true, false]) {
  test(`${completed ? 'finished' : 'cancelled'} 先释放会话，通知中立即派第二句；旧回调不重复结算`, async () => {
    const h = makeEngine()
    const emit = h.deps.emit
    h.deps.emit = (event) => {
      emit(event)
      if (('finished' in event && event.finished.id === '一') || ('cancelled' in event && event.cancelled.id === '一')) {
        assert.equal(h.engine.busy, false)
        h.engine.speak('二', '第二句。')
      }
    }
    h.engine.speak('一', '第一句。')
    assert.equal(h.engine.busy, true)
    await Promise.resolve()
    h.plays[0](completed)
    assert.equal(h.engine.busy, true)
    h.plays[0](!completed)
    await Promise.resolve()
    assert.equal(h.plays.length, 2)
    h.plays[1](true)
    h.engine.stop()
    assert.equal(h.engine.busy, false)
    assert.deepEqual(h.events, [
      { started: { id: '一' } },
      completed ? { finished: { id: '一' } } : { cancelled: { id: '一' } },
      { started: { id: '二' } }, { finished: { id: '二' } },
    ])
  })
}

test('生产合成选择：真实选择函数连接引擎，合成边界全部模拟且不出网', async (t) => {
  const api: ResolvedVoiceApi = {
    id: '自定义', kind: 'tts', name: '测试服务', endpoint: 'https://voice.invalid/v1',
    model: 'custom-model', voice: 'custom-voice', apiKey: 'test-key', provider: 'openai',
  }
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  const { synthesizeApi } = await import('../src/main/voice-api.ts')
  const edge = t.mock.fn<(options: TtsOptions & { signal: AbortSignal }) => Promise<Buffer>>(async () => audio)
  const custom = t.mock.fn(synthesizeApi)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(audio, {
    headers: { 'Content-Type': 'audio/mpeg' },
  }))
  t.mock.module(new URL('../src/main/edge-tts.ts', import.meta.url), {
    namedExports: { DEFAULT_TTS_VOICE: 'zh-CN-XiaoxiaoNeural', synthesizeSpeech: edge },
  })
  t.mock.module(new URL('../src/main/voice-api.ts', import.meta.url), {
    namedExports: { synthesizeApi: custom },
  })
  // 独立模块实例，确保调用的是生产选择函数，而不是只替换引擎的 synthesize。
  const { synthesizeForWorker } = await import(`${workerUrl.href}?production-selection`) as typeof import('../src/main/tts-edge-worker.ts')
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  t.beforeEach(() => {
    edge.mock.resetCalls()
    edge.mock.mockImplementation(async () => audio)
    custom.mock.resetCalls()
    custom.mock.mockImplementation(synthesizeApi)
    fetch.mock.resetCalls()
    fetch.mock.mockImplementation(async () => new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } }))
  })

  await t.test('默认分支保留音色、语速、音调以及原取消信号', async () => {
    const controller = new AbortController()
    assert.deepEqual(await synthesizeForWorker('默认句。', controller.signal), audio)
    assert.deepEqual(edge.mock.calls[0].arguments, [{
      text: '默认句。', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', signal: controller.signal,
    }])
    assert.equal(edge.mock.calls[0].arguments[0].signal, controller.signal)
    assert.equal(edge.mock.callCount(), 1)
    assert.equal(custom.mock.callCount(), 0)
    assert.equal(fetch.mock.callCount(), 0)
  })

  await t.test('自定义配置与信号原样传递，真实 API 客户端按配置组装请求', async () => {
    const controller = new AbortController()
    assert.deepEqual(await synthesizeForWorker('自定义句。', controller.signal, api), audio)
    assert.deepEqual(custom.mock.calls[0].arguments, [api, '自定义句。', controller.signal])
    assert.equal(custom.mock.calls[0].arguments[0], api)
    assert.equal(custom.mock.calls[0].arguments[2], controller.signal)
    assert.equal(custom.mock.callCount(), 1)
    assert.equal(edge.mock.callCount(), 0)
    assert.equal(fetch.mock.callCount(), 1)
    const [url, init] = fetch.mock.calls[0].arguments
    assert.equal(url, 'https://voice.invalid/v1/audio/speech')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
    assert.deepEqual(JSON.parse(init?.body as string), {
      model: api.model, input: '自定义句。', voice: api.voice, response_format: 'mp3',
    })
  })

  for (const profile of [undefined, api]) {
    const branch = profile ? '自定义' : '默认'
    await t.test(`${branch}分支收到已取消信号时不发起合成`, async () => {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(synthesizeForWorker('不应发送。', controller.signal, profile), { name: 'AbortError' })
      assert.equal(edge.mock.callCount(), 0)
      assert.equal(custom.mock.callCount(), 0)
      assert.equal(fetch.mock.callCount(), 0)
    })

    for (const lateFailure of [false, true]) {
      await t.test(`${branch}合成中取消透传信号，迟到${lateFailure ? '失败' : '成功'}不播放、不回退或干扰新句`, async () => {
        const pending = deferred()
        // 故意不响应取消，模拟不可中止的客户端或已完成的在途结果。
        if (profile) custom.mock.mockImplementationOnce(() => pending.promise)
        else edge.mock.mockImplementationOnce(() => pending.promise)
        const h = makeEngine({ synthesize: synthesizeForWorker })
        h.engine.speak('旧', '旧句。', profile)
        const signal = profile ? custom.mock.calls[0].arguments[2]! : edge.mock.calls[0].arguments[0].signal
        assert.equal(signal.aborted, false)
        h.engine.stop()
        h.engine.stop()
        assert.equal(signal.aborted, true)
        assert.equal(h.engine.busy, false)
        assert.deepEqual(h.events, [{ started: { id: '旧' } }, { cancelled: { id: '旧' } }])
        h.engine.speak('新', '新句。', profile)
        await flush()
        assert.equal(h.plays.length, 1)
        if (lateFailure) pending.reject(new Error('迟到失败'))
        else pending.resolve(audio)
        await flush()
        assert.equal(h.plays.length, 1)
        assert.equal(h.fallbacks.length, 0)
        assert.equal(h.stops, 0)
        assert.equal(h.engine.busy, true)
        h.plays[0](true)
        assert.deepEqual(h.events, [
          { started: { id: '旧' } }, { cancelled: { id: '旧' } },
          { started: { id: '新' } }, { finished: { id: '新' } },
        ])
        assert.equal(profile ? edge.mock.callCount() : custom.mock.callCount(), 0)
      })
    }
  }

  await t.test('自定义合成中停止确实取消 HTTP 请求，取消不变成服务错误', async () => {
    let requestSignal: AbortSignal | undefined
    fetch.mock.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(new DOMException('请求取消', 'AbortError')), { once: true })
    }))
    const h = makeEngine({ synthesize: synthesizeForWorker })
    h.engine.speak('一', '取消句。', api)
    assert.equal(requestSignal?.aborted, false)
    h.engine.stop()
    assert.equal(requestSignal?.aborted, true)
    await flush()
    assert.equal(h.engine.busy, false)
    assert.equal(h.plays.length, 0)
    assert.equal(h.fallbacks.length, 0)
    assert.equal(edge.mock.callCount(), 0)
    assert.deepEqual(h.events, [{ started: { id: '一' } }, { cancelled: { id: '一' } }])
    await assert.rejects(custom.mock.calls[0].result!, { name: 'AbortError' })
  })

  await t.test('自定义服务失败原样拒绝，装配后的引擎报错且不切默认或本地服务', async () => {
    fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }))
    const h = makeEngine({ synthesize: synthesizeForWorker })
    h.engine.speak('一', '失败句。', api)
    await flush()
    assert.equal(custom.mock.callCount(), 1)
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(edge.mock.callCount(), 0)
    assert.equal(h.fallbacks.length, 0)
    assert.equal(h.plays.length, 0)
    assert.equal(h.engine.busy, false)
    assert.deepEqual(h.events, [
      { started: { id: '一' } },
      { ok: false, error: '自定义语音 API 合成失败，请检查配置或服务状态；未切换到其他服务' },
    ])
  })
})

test('自定义 API 合成失败不偷换服务：报错收场，不走本地回退', async () => {
  const h = makeEngine({
    synthesize: async () => { throw new Error('自定义服务不可达') },
  })
  h.engine.speak('一', '第一句。', {
    id: 'p1', kind: 'tts', name: '我的服务', endpoint: 'https://example.com/v1',
    model: 'tts-1', voice: 'alloy', apiKey: 'sk-test', provider: 'openai',
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.fallbacks.length, 0, '退回本地机械声等于把用户挑的服务换掉')
  assert.equal(h.plays.length, 0)
  assert.equal(h.engine.busy, false)
  assert.equal(h.events.length, 2)
  assert.deepEqual(h.events[0], { started: { id: '一' } })
  assert.ok(('ok' in h.events[1]) && h.events[1].ok === false, '要如实报错，不能装作没念过')
})

test('自定义 API 合成成功照常播放，不吃本地回退', async () => {
  const h = makeEngine()
  h.engine.speak('一', '第一句。', {
    id: 'p1', kind: 'tts', name: '我的服务', endpoint: 'https://example.com/v1',
    model: 'tts-1', voice: 'alloy', apiKey: 'sk-test', provider: 'openai',
  })
  await Promise.resolve()
  assert.equal(h.plays.length, 1)
  assert.equal(h.fallbacks.length, 0)
})

test('合成和播放期间拒绝并发，不能覆盖原会话', async () => {  const pending = deferred()
  const h = makeEngine({ synthesize: () => pending.promise })
  h.engine.speak('一', '第一句。')
  h.engine.speak('合成期插队', '不要合成。')
  pending.resolve(Buffer.from('假音频'))
  await Promise.resolve()
  h.engine.speak('播放期插队', '不要播放。')
  h.plays[0](true)
  assert.equal(h.engine.busy, false)
  assert.deepEqual(h.events, [
    { started: { id: '一' } }, { ok: false, error: 'busy' },
    { ok: false, error: 'busy' }, { finished: { id: '一' } },
  ])
})

for (const lateFailure of [false, true]) {
  test(`合成期立即取消，旧合成迟到${lateFailure ? '失败' : '成功'}不干扰正在播放的新句`, async () => {
    const old = deferred()
    let calls = 0
    const h = makeEngine({ synthesize: () => ++calls === 1 ? old.promise : Promise.resolve(Buffer.from('新音频')) })
    h.engine.speak('旧', '旧句。')
    h.engine.stop()
    h.engine.stop()
    assert.equal(h.engine.busy, false)
    assert.equal(h.stops, 0)
    h.engine.speak('新', '新句。')
    await Promise.resolve()
    if (lateFailure) old.reject(new Error('迟到的合成失败'))
    else old.resolve(Buffer.from('迟到的旧音频'))
    await Promise.resolve()
    assert.equal(h.engine.busy, true)
    assert.equal(h.plays.length, 1)
    assert.equal(h.fallbacks.length, 0)
    assert.equal(h.stops, 0)
    h.plays[0](true)
    assert.deepEqual(h.events, [
      { started: { id: '旧' } }, { cancelled: { id: '旧' } },
      { started: { id: '新' } }, { finished: { id: '新' } },
    ])
  })
}

test('started 通知内取消后，不应再发起合成', async () => {
  let syntheses = 0
  const h = makeEngine({ synthesize: async () => { syntheses++; return Buffer.from('假音频') } })
  const emit = h.deps.emit
  h.deps.emit = (event) => { emit(event); if ('started' in event) h.engine.stop() }
  h.engine.speak('一', '不要合成。')
  await Promise.resolve()
  assert.equal(syntheses, 0)
  assert.equal(h.engine.busy, false)
  assert.deepEqual(h.events, [{ started: { id: '一' } }, { cancelled: { id: '一' } }])
})

for (const fallback of [false, true]) {
  test(`${fallback ? '本地回退' : '云合成后播放'}中取消：停旧音频后再通知，同步和迟到回调都只能结算一次`, async () => {
    const h = makeEngine(fallback ? { synthesize: async () => { throw new Error('离线') } } : {})
    const callbacks = fallback ? h.fallbacks : h.plays
    let stops = 0
    h.deps.stopAudio = () => { stops++; callbacks[0](true) }
    const emit = h.deps.emit
    h.deps.emit = (event) => {
      emit(event)
      if ('cancelled' in event) {
        assert.equal(stops, 1)
        assert.equal(h.engine.busy, false)
        h.engine.speak('二', '第二句。')
      }
    }
    h.engine.speak('一', '第一句。')
    await Promise.resolve()
    h.engine.stop()
    callbacks[0](false)
    await Promise.resolve()
    assert.equal(callbacks.length, 2)
    assert.equal(stops, 1)
    assert.equal(h.engine.busy, true)
    callbacks[1](true)
    assert.deepEqual(h.events, [
      { started: { id: '一' } }, { cancelled: { id: '一' } },
      { started: { id: '二' } }, { finished: { id: '二' } },
    ])
  })
}

for (const synchronous of [false, true]) {
  test(`合成${synchronous ? '同步抛错' : '异步拒绝'}只回退一次，回退完成后可接新句`, async () => {
    const h = makeEngine({ synthesize: () => {
      if (synchronous) throw new Error('同步失败')
      return Promise.reject(new Error('异步失败'))
    } })
    h.engine.speak('一', '回退句。')
    await Promise.resolve()
    assert.equal(h.plays.length, 0)
    assert.equal(h.fallbacks.length, 1)
    h.fallbacks[0](true)
    assert.equal(h.engine.busy, false)
    h.engine.speak('二', '下一句。')
    await Promise.resolve()
    h.fallbacks[1](true)
    assert.deepEqual(h.events, [
      { started: { id: '一' } }, { finished: { id: '一' } },
      { started: { id: '二' } }, { finished: { id: '二' } },
    ])
  })
}

for (const fallback of [false, true]) {
  for (const throws of [false, true]) {
    test(`${fallback ? '回退' : '播放'}${throws ? '启动抛错' : '返回失败'}必须取消而非完成，也不重播`, async () => {
      let calls = 0
      const failed: Deps['play'] = (_audio, done) => {
        calls++
        if (throws) throw new Error('启动失败')
        done(false)
        done(true)
      }
      const h = makeEngine(fallback ? {
        synthesize: async () => { throw new Error('离线') },
        fallback: (_text, done) => failed(Buffer.alloc(0), done),
      } : { play: failed })
      h.engine.speak('一', '失败句。')
      await Promise.resolve()
      assert.equal(h.engine.busy, false)
      assert.equal(calls, 1)
      assert.equal(h.fallbacks.length, 0)
      assert.equal(h.stops, throws ? 1 : 0)
      assert.deepEqual(h.events, [{ started: { id: '一' } }, { cancelled: { id: '一' } }])
    })
  }
}

test('停止音频抛错仍释放会话并且只报一次取消', async () => {
  const h = makeEngine({ stopAudio: () => { throw new Error('停止失败') } })
  h.engine.speak('一', '第一句。')
  await Promise.resolve()
  assert.throws(() => h.engine.stop(), /停止失败/)
  assert.equal(h.engine.busy, false)
  h.plays[0](true)
  assert.deepEqual(h.events, [{ started: { id: '一' } }, { cancelled: { id: '一' } }])
})

for (const outcome of ['成功', '非零退出', '信号退出', '启动错误'] as const) {
  test(`真实播放器管理逻辑：${outcome}的结果与临时文件清理`, (t) => {
    const h = makePlayer(t)
    const done: boolean[] = []
    h.player.play(Buffer.from('假 MP3'), value => done.push(value))
    assert.equal(readFileSync(h.files[0], 'utf8'), '假 MP3')
    // Windows 形状：命令是 powershell，参数以 `-File <script> -Path <file>` 收尾。
    assert.equal(h.commands[0], 'powershell')
    assert.deepEqual(h.argumentsList[0].slice(-4), ['-File', path.join(scriptDir, 'play.ps1'), '-Path', h.files[0]])
    if (outcome === '启动错误') h.children[0].emit('error', new Error('找不到播放器'))
    h.children[0].emit('close', outcome === '成功' ? 0 : outcome === '信号退出' ? null : 1)
    assert.deepEqual(done, [outcome === '成功'])
    assert.equal(existsSync(h.files[0]), false)
    h.player.stopAudio()
    assert.equal(h.killed.length, 0)
  })
}

test('回退参数保留中文，错误与关闭只回调一次并清理 WAV', (t) => {
  const h = makePlayer(t)
  const done: boolean[] = []
  h.player.fallback('中文回退。', value => done.push(value))
  assert.equal(h.commands[0], 'powershell')
  assert.deepEqual(h.argumentsList[0].slice(-6), [
    '-File', path.join(scriptDir, 'speak-once.ps1'),
    '-B64', Buffer.from('中文回退。').toString('base64'), '-OutPath', h.files[0],
  ])
  writeFileSync(h.files[0], '假 WAV')
  h.children[0].emit('error', new Error('回退失败'))
  h.children[0].emit('close', 0)
  assert.deepEqual(done, [false])
  assert.equal(existsSync(h.files[0]), false)
})

test('旧进程取消后即使退出码为零也不算完成；迟到事件不能清理或误杀新进程', (t) => {
  const h = makePlayer(t)
  const oldDone: boolean[] = []
  const newDone: boolean[] = []
  h.player.play(Buffer.from('旧音频'), value => oldDone.push(value))
  h.player.stopAudio()
  h.player.play(Buffer.from('新音频'), value => newDone.push(value))
  h.children[0].emit('close', 0)
  assert.deepEqual(oldDone, [false])
  assert.equal(existsSync(h.files[0]), false)
  assert.equal(existsSync(h.files[1]), true)
  assert.deepEqual(newDone, [])
  h.player.stopAudio()
  h.player.stopAudio()
  assert.deepEqual(h.killed, h.children)
  h.children[1].emit('close', null)
  assert.deepEqual(newDone, [false])
  assert.deepEqual(readdirSync(h.dir), [])
})

test('启动器抛错和文件写入失败都不能留下 MP3', (t) => {
  const dir = tempDirectory(t)
  const player = createAudioPlayer(scriptDir, dir, () => { throw new Error('启动失败') })
  assert.throws(() => player.play(Buffer.from('假音频'), () => assert.fail('不应完成')), /启动失败/)
  assert.deepEqual(readdirSync(dir), [])
  const absent = path.join(dir, '不存在的子目录')
  const unwritable = createAudioPlayer(scriptDir, absent, () => { throw new Error('不应启动') })
  assert.throws(() => unwritable.play(Buffer.from('假音频'), () => assert.fail('不应完成')), /ENOENT/)
  assert.deepEqual(readdirSync(dir), [])
})

// ── 跨平台：macOS 走 afplay / say，不碰任何 PowerShell 脚本 ──

test('macOS 播放走 afplay，参数只有文件路径', (t) => {
  const h = makePlayer(t, 'darwin')
  const done: boolean[] = []
  h.player.play(Buffer.from('假 MP3'), value => done.push(value))
  assert.equal(h.commands[0], 'afplay')
  assert.deepEqual(h.argumentsList[0], [h.files[0]])
  assert.equal(h.files[0].endsWith('.mp3'), true, '扩展名决定 afplay 怎么解码，不能改')
  h.children[0].emit('close', 0)
  assert.deepEqual(done, [true])
  assert.equal(existsSync(h.files[0]), false, '播完要清掉临时文件')
})

test('macOS 离线回退走 say，文本整段作为一个参数', (t) => {
  const h = makePlayer(t, 'darwin')
  const done: boolean[] = []
  const text = '断网了，这句话也要念出来。'
  h.player.fallback(text, value => done.push(value))
  assert.equal(h.commands[0], 'say')
  assert.deepEqual(h.argumentsList[0], [text])
  // say 直接出声，不落中间文件；这里清的是一个本就不存在的 wav，必须是无害的 no-op。
  h.children[0].emit('close', 0)
  assert.deepEqual(done, [true])
})

test('macOS 上打断仍能 kill 掉 afplay 进程（stopAudio 与平台无关）', (t) => {
  const h = makePlayer(t, 'darwin')
  const done: boolean[] = []
  h.player.play(Buffer.from('假 MP3'), value => done.push(value))
  h.player.stopAudio()
  assert.equal(h.killed.length, 1)
  // kill 之后即使退出码为零，也不能算"播完了"——用户按了停止。
  h.children[0].emit('close', 0)
  assert.deepEqual(done, [false])
})

test('Linux 上播放能力缺失：如实抛错、不 spawn、不留临时文件', (t) => {
  const h = makePlayer(t, 'linux')
  assert.throws(
    () => h.player.play(Buffer.from('假音频'), () => assert.fail('不应完成')),
    error => error instanceof Error && error.message.includes(unsupportedAudioMessage('linux')),
  )
  assert.equal(h.children.length, 0, '能力不存在时不该起进程')
  assert.deepEqual(readdirSync(h.dir), [], '抛错路径也要清掉刚写的文件')
})

test('Linux 上回退能力同样缺失', (t) => {
  const h = makePlayer(t, 'linux')
  assert.throws(
    () => h.player.fallback('说话', () => assert.fail('不应完成')),
    error => error instanceof Error && error.message.includes(unsupportedAudioMessage('linux')),
  )
  assert.equal(h.children.length, 0)
})
