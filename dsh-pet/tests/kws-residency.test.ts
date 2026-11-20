/**
 * M1-02：本地唤醒（KWS）、四个独立开关的持久化与登录项规则、平台能力表。
 * KWS 会话用假 worker 测生命周期；真模型的检出数据另见 petsBak/dsh-pet/m1-kws-bench。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { AudioPrefsStore, loginItemAction, normalizeAudioPrefs, sanitizePatch } from '../src/main/audio-prefs.ts'
import { KWS_KEYWORD_LINES, WAKE_KEYWORD, kwsModelPaths, kwsModelProblem, missingKeywordTokens, startKws, wakeKeywordLines, type KwsWorkerLike, type KwsWorkerMessage } from '../src/main/kws.ts'
import { normalizeWakeName, wakeNameProblem } from '../src/main/wake-name.ts'
import { defaultWakeEnabled, defaultWakeEngine, kwsWakeDeviceVerified, loginItemSpec, wakeEngines } from '../src/main/platform.ts'
import { VoiceConversation } from '../src/voice-conversation.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-kws-test-'))
}

function installFakeModel(userData: string, tokens = 'x 1\niǎo 2\np 3\nān 4\nt 5\nóng 6\nué 7\n'): void {
  const paths = kwsModelPaths(userData)
  mkdirSync(paths.dir, { recursive: true })
  for (const file of [paths.encoder, paths.decoder, paths.joiner]) writeFileSync(file, 'onnx')
  writeFileSync(paths.tokens, tokens)
}

class FakeWorker implements KwsWorkerLike {
  posted: unknown[] = []
  terminated = 0
  private handlers = new Map<string, Array<(value: never) => void>>()
  postMessage(message: unknown): void {
    this.posted.push(message)
    // 模拟真 worker：收到 shutdown 后自己退出（优雅退出契约）。
    if ((message as { type?: string } | null)?.type === 'shutdown') queueMicrotask(() => this.emit('exit', 0))
  }
  on(event: string, listener: (value: never) => void): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  terminate(): void { this.terminated++ }
  emit(event: 'message', value: KwsWorkerMessage): void
  emit(event: 'exit', value: number): void
  emit(event: string, value: unknown): void { for (const h of this.handlers.get(event) ?? []) (h as (v: unknown) => void)(value) }
}

describe('唤醒词与模型', () => {
  test('唤醒词按拼音声母 + 带调韵母写成 keywords 行，与 System.Speech 是同一个词', () => {
    assert.equal(WAKE_KEYWORD, '小潘同学')
    assert.deepEqual(KWS_KEYWORD_LINES, ['x iǎo p ān t óng x ué @小潘同学'])
  })

  test('keywords 里的 token 必须都在模型 tokens.txt 里', () => {
    assert.deepEqual(missingKeywordTokens('x 1\niǎo 2\np 3\nān 4\nt 5\nóng 6\nué 7\n'), [])
    // 少了"同学"两个音节的 token 就要如实报缺（换唤醒词后最容易漏的就是这里）。
    assert.deepEqual(missingKeywordTokens('x 1\niǎo 2\np 3\nān 4\n'), ['t', 'óng', 'ué'])
  })

  test('自定义唤醒词同样拆成声母 + 带调韵母', () => {
    assert.deepEqual(wakeKeywordLines('潘潘'), ['p ān p ān @潘潘'])
    assert.deepEqual(wakeKeywordLines('小助手'), ['x iǎo zh ù sh ǒu @小助手'])
    assert.deepEqual(wakeKeywordLines('老王'), ['l ǎo w áng @老王'])
  })

  test('自定义唤醒词的读音模型不认识时，报"换名"而不是让用户重装模型', () => {
    const dir = tempDir()
    try {
      installFakeModel(dir)
      assert.equal(kwsModelProblem(dir, '潘潘'), null)
      assert.match(kwsModelProblem(dir, '小助手') ?? '', /模型不支持的读音/)
      assert.match(kwsModelProblem(dir, '阿福') ?? '', /模型不支持的读音/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('唤醒词规则：2–5 个汉字，其余回落默认', () => {
    assert.equal(normalizeWakeName('潘潘'), '潘潘')
    assert.equal(normalizeWakeName('小助手'), '小助手')
    assert.equal(normalizeWakeName('阿'), '小潘同学', '太短容易被日常说话误触发')
    assert.equal(normalizeWakeName('小潘同学你好'), '小潘同学', '超过 5 个字')
    assert.equal(normalizeWakeName('小潘123'), '小潘同学')
    assert.equal(wakeNameProblem('潘潘'), null)
    assert.match(wakeNameProblem('小潘123') ?? '', /2–5 个汉字/)
  })

  test('模型缺失 / 不匹配：给出能照做的原因，不是错误码', () => {
    const dir = tempDir()
    try {
      assert.match(kwsModelProblem(dir) ?? '', /本地唤醒模型没装.*setup-local-asr/)
      installFakeModel(dir, 'x 1\n')
      assert.match(kwsModelProblem(dir) ?? '', /不支持的读音/)
      installFakeModel(dir)
      assert.equal(kwsModelProblem(dir), null)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('本机装了真模型时：tokens 覆盖唤醒词（仅检查，不加载模型）', (t) => {
    const userData = path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support'), 'dsh-pet')
    if (!existsSync(kwsModelPaths(userData).tokens)) { t.skip('本机未安装 KWS 模型'); return }
    assert.deepEqual(missingKeywordTokens(readFileSync(kwsModelPaths(userData).tokens, 'utf8')), [])
  })
})

describe('KWS 会话生命周期（假 worker）', () => {
  test('加载前的 PCM 先攒着（有界），就绪后按序送出；检出回调唤醒；stop 终止线程且不再报', async () => {
    const dir = tempDir()
    try {
      installFakeModel(dir)
      const worker = new FakeWorker()
      const wakes: string[] = []
      const lost: string[] = []
      const session = startKws({ userDataDir: dir, keywordName: '潘潘', onWake: k => wakes.push(k), onLost: r => lost.push(r), createWorker: () => worker })
      assert.equal(readFileSync(kwsModelPaths(dir).keywords, 'utf8'), wakeKeywordLines('潘潘').join('\n') + '\n', 'keywords 文件由自定义唤醒词生成')
      for (let i = 0; i < 40; i++) session.feed(new Float32Array(1600))
      assert.equal(worker.posted.length, 0)
      worker.emit('message', { type: 'ready', loadMs: 10 })
      assert.equal(worker.posted.length, 20, '只保留最近 2 秒')
      worker.emit('message', { type: 'wake', keyword: '小潘同学', atMs: 1200 })
      assert.deepEqual(wakes, ['小潘同学'])
      session.stop()
      assert.ok(worker.posted.some(m => (m as { type?: string } | null)?.type === 'shutdown'), 'stop 先请 worker 自己退，不强杀原生线程')
      await tick()
      assert.equal(worker.terminated, 0, '优雅退出路径不 terminate')
      worker.emit('exit', 1)
      worker.emit('message', { type: 'wake', keyword: '小潘同学', atMs: 1500 })
      assert.deepEqual(lost, [], '自己停的不算丢失')
      assert.deepEqual(wakes, ['小潘同学'], '停了之后不再报唤醒')
      assert.equal(session.running, false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('声纹不通过只报 rejected，不唤醒；声纹模型加载失败则整体不可用', async () => {
    const dir = tempDir()
    try {
      installFakeModel(dir)
      const worker = new FakeWorker()
      const wakes: string[] = []
      const rejected: number[] = []
      const lost: string[] = []
      const session = startKws({
        userDataDir: dir,
        voiceprint: { model: path.join(dir, 'embedding.onnx'), embeddings: [[1, 0]], threshold: 0.65 },
        onWake: k => wakes.push(k),
        onRejected: score => rejected.push(score),
        onLost: r => lost.push(r),
        createWorker: () => worker,
      })
      worker.emit('message', { type: 'ready', loadMs: 1, voiceprint: true })
      worker.emit('message', { type: 'rejected', keyword: '小潘同学', score: 0.3 })
      assert.deepEqual(wakes, [])
      assert.deepEqual(rejected, [0.3])
      session.stop()

      const failedWorker = new FakeWorker()
      const failedLost: string[] = []
      const failed = startKws({
        userDataDir: dir,
        voiceprint: { model: 'missing.onnx', embeddings: [[1, 0]], threshold: 0.65 },
        onWake: () => {},
        onLost: r => failedLost.push(r),
        createWorker: () => failedWorker,
      })
      failedWorker.emit('message', { type: 'ready', loadMs: 1, voiceprint: false, voiceprintError: 'bad model' })
      assert.deepEqual(failedLost, ['声纹模型加载失败：bad model'])
      assert.equal(failed.running, false)
      assert.deepEqual(lost, [], '前一个会话的 stop 不应产生丢失')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('模型加载失败 / 线程意外退出：只报一次原因并自停，不重试刷错', async () => {
    const dir = tempDir()
    try {
      installFakeModel(dir)
      const worker = new FakeWorker()
      const lost: string[] = []
      const session = startKws({ userDataDir: dir, onWake: () => {}, onLost: r => lost.push(r), createWorker: () => worker })
      worker.emit('message', { type: 'error', stage: 'load', error: 'bad model' })
      worker.emit('exit', 1)
      assert.equal(lost.length, 1)
      assert.match(lost[0], /加载失败.*bad model/)
      assert.equal(session.running, false)
      assert.ok(worker.posted.some(m => (m as { type?: string } | null)?.type === 'shutdown'))
      assert.equal(worker.terminated, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('建线程同步失败：延后一拍报（不在仲裁器的 applyAudio 里同步重入）', async () => {
    const dir = tempDir()
    try {
      installFakeModel(dir)
      const lost: string[] = []
      startKws({ userDataDir: dir, onWake: () => {}, onLost: r => lost.push(r), createWorker: () => { throw new Error('no threads') } })
      assert.deepEqual(lost, [])
      await tick()
      assert.equal(lost.length, 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('四个独立开关', () => {
  test('缺省：Windows 唤醒开（既有行为）、macOS 唤醒关；开机自启、外放插话、播报中响应唤醒一律关', () => {
    // wakeDuringSpeech 默认 false = 播报中安静（讲解中例外，见 wake-scene.ts）。
    assert.deepEqual(normalizeAudioPrefs({}, 'win32'), { wakeEnabled: true, wakeEngine: 'kws', wakeName: '小潘同学', wakeVoiceprint: false, wakeVoiceprintThreshold: 0.65, wakeDuringSpeech: false, launchAtLogin: false, bargeIn: false })
    assert.deepEqual(normalizeAudioPrefs({}, 'darwin'), { wakeEnabled: false, wakeEngine: 'kws', wakeName: '小潘同学', wakeVoiceprint: false, wakeVoiceprintThreshold: 0.65, wakeDuringSpeech: false, launchAtLogin: false, bargeIn: false })
    assert.deepEqual(normalizeAudioPrefs({ wakeEnabled: true }, 'linux'), { wakeEnabled: false, wakeEngine: null, wakeName: '小潘同学', wakeVoiceprint: false, wakeVoiceprintThreshold: 0.65, wakeDuringSpeech: false, launchAtLogin: false, bargeIn: false }, '没有引擎的平台开关存了也是关')
  })

  test('只接受平台列出的引擎；未知键与非布尔值丢掉', () => {
    assert.equal(normalizeAudioPrefs({ wakeEngine: 'system' }, 'darwin').wakeEngine, 'kws', 'Mac 上没有 System.Speech')
    assert.equal(normalizeAudioPrefs({ wakeEngine: 'kws' }, 'win32').wakeEngine, 'kws')
    assert.deepEqual(sanitizePatch({ wakeEnabled: 'yes', bargeIn: true, evil: 1, wakeEngine: 'cloud' }, 'win32'), { bargeIn: true })
    assert.deepEqual(sanitizePatch({ wakeName: '潘潘' }, 'win32'), { wakeName: '潘潘' })
  })

  test('开机自启：只有用户把开关从关切到开 / 从开切到关时才碰登录项', () => {
    assert.equal(loginItemAction(false, false), 'none', '关着时绝不写启动项')
    assert.equal(loginItemAction(true, true), 'none')
    assert.equal(loginItemAction(false, true), 'enable')
    assert.equal(loginItemAction(true, false), 'disable', '关掉要把之前写的移除')
    assert.deepEqual(loginItemSpec('win32', true, { isPackaged: true, execPath: 'C:\\a.exe', appPath: 'C:\\app' }), { openAtLogin: true })
    assert.deepEqual(loginItemSpec('darwin', false, { isPackaged: false, execPath: '/e', appPath: '/app' }), { openAtLogin: false, path: '/e', args: ['/app'] }, '开发态要带上应用目录')
    assert.equal(loginItemSpec('linux', true, { isPackaged: true, execPath: '', appPath: '' }), null)
  })

  test('持久化：合并保存并返回新旧两份；损坏文件按缺省', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'audio-prefs.json')
      writeFileSync(file, '{broken')
      const store = new AudioPrefsStore(file, 'win32')
      assert.equal(store.get().wakeEnabled, true)
      const { previous, next } = store.update({ wakeEnabled: false, launchAtLogin: true })
      assert.equal(previous.wakeEnabled, true)
      assert.equal(next.wakeEnabled, false)
      assert.equal(next.launchAtLogin, true)
      assert.deepEqual(new AudioPrefsStore(file, 'win32').get(), next)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('平台能力表：Windows 两种引擎（KWS 默认，才能做声纹与自定义唤醒词）；macOS 只有 KWS', () => {
    assert.deepEqual(wakeEngines('win32'), ['system', 'kws'])
    assert.equal(defaultWakeEngine('win32'), 'kws', 'System.Speech 拿不到音频做声纹，也不支持改名')
    assert.deepEqual(wakeEngines('darwin'), ['kws'])
    assert.deepEqual(wakeEngines('linux'), [])
    assert.equal(defaultWakeEnabled('darwin'), false)
    assert.equal(kwsWakeDeviceVerified('darwin'), false)
  })
})

describe('连续对话里的插话（M1-05）', () => {
  test('生成 / 播放中插话：本轮作废、回到等着听，迟到的结果与播完回执都对不上号', () => {
    const conversation = new VoiceConversation()
    assert.ok(conversation.start('b', true, true, 0))
    assert.ok(conversation.record(conversation.generation, 'b', 1))
    const turn = conversation.submit(2)!
    assert.equal(conversation.phase, 'generating')
    assert.equal(conversation.interruptForBargeIn(3), true)
    assert.equal(conversation.phase, 'waiting')
    assert.equal(conversation.result(turn, true, 4), false, '被插话的那一轮结果不再推进')
    assert.equal(conversation.complete({ ...turn, outcome: 'stopped' }, 5), false)
    assert.equal(conversation.active, true, '连续对话没结束')
    assert.ok(conversation.record(conversation.generation, 'b', 6), '插话本身就是下一轮')
    assert.equal(conversation.interruptForBargeIn(7), false, '正在录音时不成立')
  })
})

