/**
 * 语音新链路的纯函数单测：edge-tts 协议装配、wav 静音裁剪、渲染层 wav 编码。
 * 不出网、不开音频设备 —— 网络与真声的验证归真机。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSsml, generateSecMsGec, synthesizeSpeech, type WebSocketFactory, type WebSocketLike } from '../src/main/edge-tts.ts'
import { cleanSenseVoiceText, trimSilence } from '../src/main/asr.ts'
import { encodeWav, frameRms, noiseBaseline, pcm16Base64, resampleTo16k, speechThreshold, arrayBufferToBase64, BASELINE_FRAMES } from '../src/renderer/dictation.ts'

// ── edge-tts 协议 ──

test('Sec-MS-GEC 令牌：同一 5 分钟窗口内稳定，窗口推进时变化', () => {
  // 1_700_000_000 mod 300 = 200；+50 还在窗口内，+200 跨过 300s 取整边界。
  const t1 = 1_700_000_000
  const t2 = t1 + 50 // 同窗口
  const t3 = t1 + 200 // 跨窗口
  assert.equal(generateSecMsGec(t1), generateSecMsGec(t2))
  assert.notEqual(generateSecMsGec(t1), generateSecMsGec(t3))
  assert.match(generateSecMsGec(t1), /^[0-9A-F]{64}$/)
})

test('SSML：文本被转义，音色与语速进 prosody', () => {
  const ssml = buildSsml({ text: 'a<b>&"c"', voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%', pitch: '+0Hz' })
  assert.ok(ssml.includes('a&lt;b&gt;&amp;"c"'))
  assert.ok(ssml.includes("<voice name='zh-CN-XiaoxiaoNeural'>"))
  assert.ok(ssml.includes("rate='+10%'"))
  assert.ok(ssml.includes("xml:lang='zh-CN'"))
})

/** 可注入的假 WebSocket 工厂：open 后由测试通过返回的 deliver 投递消息。 */
function injectableFactory(): { factory: WebSocketFactory; sent: string[]; deliver: (data: unknown) => void } {
  const sent: string[] = []
  let deliver: ((data: unknown) => void) | null = null
  const factory: WebSocketFactory = (_url, _options) => ({
    addEventListener(type, listener) {
      const handler = listener as (event?: unknown) => void
      if (type === 'message') deliver = (data) => handler({ data })
      if (type === 'open') queueMicrotask(() => handler())
    },
    send(data: string) {
      sent.push(data)
    },
    close() { /* no-op */ },
  })
  return {
    factory,
    sent,
    deliver: (data) => {
      if (deliver === null) throw new Error('socket 尚未打开')
      deliver(data)
    },
  }
}

function mp3Frame(bytes: number): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  return Buffer.concat([header, Buffer.alloc(bytes)])
}

test('合成：音频帧被剥掉协议头收集，turn.end 结束', async () => {
  const audio = mp3Frame(64)
  const frame = Buffer.concat([(() => { const b = Buffer.alloc(2); b.writeUInt16BE(8, 0); return b })(), Buffer.alloc(8), audio])
  const { factory, deliver } = injectableFactory()
  const pending = synthesizeSpeech(
    { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz' },
    { webSocketFactory: factory, nowSeconds: () => 1_700_000_000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver(frame)
  deliver('Path:turn.end')
  const result = await pending
  assert.deepEqual(Buffer.from(result), audio)
})

test('合成：turn.end 先于任何音频 = 服务端拒绝，抛错而不是返回空', async () => {
  const { factory, deliver } = injectableFactory()
  const pending = synthesizeSpeech(
    { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz' },
    { webSocketFactory: factory, nowSeconds: () => 1_700_000_000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver('Path:turn.end')
  await assert.rejects(pending, /未返回音频/)
})

test('默认合成在请求前取消时不创建连接', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(synthesizeSpeech(
    { text: '不应发出', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', signal: controller.signal },
    { webSocketFactory: () => { throw new Error('不应创建连接') } },
  ), { name: 'AbortError' })
})

for (const phase of ['连接前', '收到部分音频'] as const) {
  test(`默认合成${phase}取消会关闭连接，迟到事件不恢复请求`, async () => {
    const handlers = new Map<string, (event?: unknown) => void>()
    let closed = 0
    let sent = 0
    const factory: WebSocketFactory = () => ({
      addEventListener(type, listener) { handlers.set(type, listener as (event?: unknown) => void) },
      send() { sent++ },
      close() { closed++; handlers.get('close')?.() },
    })
    const controller = new AbortController()
    const pending = synthesizeSpeech(
      { text: '取消这段语音', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', signal: controller.signal },
      { webSocketFactory: factory },
    )
    if (phase === '收到部分音频') {
      handlers.get('open')?.()
      handlers.get('message')?.({ data: Buffer.from([0, 0, 1, 2, 3]) })
    }
    const previous = sent
    controller.abort()
    await assert.rejects(pending, /已取消/)
    handlers.get('open')?.()
    handlers.get('message')?.({ data: 'Path:turn.end' })
    assert.equal(closed, 1)
    assert.equal(sent, previous)
  })
}

test('默认合成连接提前关闭不能将半截音频当成功', async () => {
  const handlers = new Map<string, (event?: unknown) => void>()
  const factory: WebSocketFactory = () => ({
    addEventListener(type, listener) { handlers.set(type, listener as (event?: unknown) => void) },
    send() {},
    close() {},
  })
  const pending = synthesizeSpeech(
    { text: '还没讲完', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz' },
    { webSocketFactory: factory },
  )
  handlers.get('message')?.({ data: Buffer.from([0, 0, 1, 2, 3]) })
  handlers.get('close')?.()
  await assert.rejects(pending, /合成完成前关闭/)
})

// ── wav 静音裁剪 ──

/** 造一段 16k mono wav。level 是 16bit 线性幅度（满幅 32767）；0 = 静音。 */
function makeWav(chunks: Array<{ ms: number; level: number }>, sampleRate = 16000): Buffer {
  const samples: number[] = []
  for (const chunk of chunks) {
    const count = Math.floor((sampleRate * chunk.ms) / 1000)
    for (let i = 0; i < count; i++) {
      samples.push(chunk.level === 0 ? 0 : Math.round(chunk.level * 32767 * Math.sin((i * 2 * Math.PI) / 32)))
    }
  }
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, 44 + i * 2))
  return buffer
}

test('裁静音：头部与尾部的沉默被裁掉，中间一句不碰', () => {
  // 1000ms 静音 + 1000ms 有声 + 1000ms 静音；有声段幅度 0.5（远超阈值）。
  const wav = makeWav([{ ms: 1000, level: 0 }, { ms: 1000, level: 0.5 }, { ms: 1000, level: 0 }])
  const trimmed = trimSilence(wav, { threshold: 300 })
  const dataLength = trimmed.readUInt32LE(40)
  // 保留段 = 1000ms 有声 + 前后各 150ms 保护垫 + 帧取整
  assert.ok(dataLength > 16000 * 2 * 0.9, `裁得太狠：${dataLength} 字节`)
  assert.ok(dataLength < 16000 * 2 * 1.6, `几乎没裁：${dataLength} 字节`)
})

test('裁静音：全程静音返回空，调用方据此回退到原样识别', () => {
  const wav = makeWav([{ ms: 800, level: 0 }])
  assert.equal(trimSilence(wav).length, 0)
})

test('裁静音：8bit mono（MCI 回退录音的格式）裁剪并转成 16bit', () => {
  // 8bit 无符号，中心 128。500ms 静音 + 500ms 有声（满幅一半）+ 500ms 静音。
  const sampleRate = 16000
  const samples: number[] = []
  for (let i = 0; i < 500 * (sampleRate / 1000); i++) samples.push(128)
  for (let i = 0; i < 500 * (sampleRate / 1000); i++) samples.push(128 + Math.round(96 * Math.sin((i * 2 * Math.PI) / 32)))
  for (let i = 0; i < 500 * (sampleRate / 1000); i++) samples.push(128)
  const wav = Buffer.alloc(44 + samples.length)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + samples.length, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate, 28)
  wav.writeUInt16LE(1, 32)
  wav.writeUInt16LE(8, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(samples.length, 40)
  samples.forEach((sample, i) => wav.writeUInt8(sample, 44 + i))
  const trimmed = trimSilence(wav, { threshold: 3000 })
  // 输出转成了 16bit：fmt 的 bitspersample=16，byteRate=sampleRate*2
  assert.equal(trimmed.readUInt16LE(34), 16)
  assert.equal(trimmed.readUInt32LE(28), sampleRate * 2)
  const dataLength = trimmed.readUInt32LE(40)
  // 500ms 有声 ± 150ms 垫 ×2（字节）
  assert.ok(dataLength > sampleRate * 2 * 0.4 && dataLength < sampleRate * 2 * 1.1, `dataLength=${dataLength}`)
})

test('裁静音：非 PCM、多声道、其他位深一律原样返回', () => {
  const wav = makeWav([{ ms: 500, level: 0.5 }])
  // 把 fmt 的 format tag 改成非 PCM
  const floatWav = Buffer.from(wav)
  floatWav.writeUInt16LE(3, 20)
  assert.deepEqual(trimSilence(floatWav), floatWav)
})

test('裁静音：解析不动的字节原样返回，不猜', () => {
  const junk = Buffer.from('this is not a wav')
  assert.deepEqual(trimSilence(junk), junk)
})

test('SenseVoice 文本清洗：去掉时间戳标记，只剩标记等于没听到', () => {
  // 旧实现是解析 `sherpa-onnx-offline.exe` 的 stdout（JSON 行 / 旧 Text: 行两种格式），
  // 现在改成进程内调 Node API，那层 stdout 解析连同 `.exe` 一起删掉了 —— 结果对象直接有
  // `text` 字段，不用猜格式。留下的只有"清洗"这一步，它仍然必要：
  // SenseVoice 会把时间戳标记（`| 1|`）混在正文里。
  assert.equal(cleanSenseVoiceText('今天下午三点开会请提前准备会议材料'), '今天下午三点开会请提前准备会议材料')
  assert.equal(cleanSenseVoiceText('今天| 1|天气| 2|不错| 3|'), '今天 天气 不错')
  assert.equal(cleanSenseVoiceText('| 3|'), null, '只剩时间戳标记等于没听到')
  assert.equal(cleanSenseVoiceText('   '), null)
  assert.equal(cleanSenseVoiceText('|1.00|真的吗'), '真的吗')
})

// ── 渲染层录音 ──

test('frameRms：静音接近零，等幅波按幅度对半', () => {
  const silence = new Float32Array(1024)
  assert.ok(frameRms(silence) < 0.001)
  const tone = new Float32Array(1024).map((_, i) => Math.sin((i * 2 * Math.PI) / 8))
  const rms = frameRms(tone)
  assert.ok(Math.abs(rms - Math.SQRT1_2) < 0.02, `方均根应是 √1/2，实际 ${rms}`)
})

test('encodeWav：44 字节头 + 16bit mono，样本限幅', () => {
  const samples = new Float32Array([0, 0.5, 2, -2])
  const buffer = encodeWav(samples, 16000)
  const view = new DataView(buffer)
  assert.equal(buffer.byteLength, 44 + 4 * 2)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getInt16(44 + 0, true), 0)
  assert.equal(view.getInt16(44 + 2, true), 16383) // 0.5 * 32767
  assert.equal(view.getInt16(44 + 4, true), 32767) // 限幅
  assert.equal(view.getInt16(44 + 6, true), -32768) // 限幅
  // 有声阈值之下，全零 RMS 判为无声
  // 开口阈值是自适应的：以噪声基线为准，不是固定常数
  assert.ok(frameRms(new Float32Array(2048)) < speechThreshold(0.01))
})

test('base64 编码：与 Node 的 Buffer 编码逐字节一致，且跨块边界不丢数据', () => {
  // 跨越 0x8000 分块边界：长度故意取 chunk+1
  const bytes = new Uint8Array(0x8000 + 1)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  assert.equal(arrayBufferToBase64(buffer), Buffer.from(bytes).toString('base64'))
  assert.equal(arrayBufferToBase64(new ArrayBuffer(0)), '')
})

test('重采样：48k→16k 精确三倍抽取，直流电平保持', () => {
  const samples = new Float32Array(4800).map((_, i) => (i % 3 === 0 ? 0.9 : 0)) // 每 3 个一个脉冲
  const out = resampleTo16k(samples, 48000)
  assert.equal(out.length, 1600)
  // 线性插值下 1600 个非零输出点附近会取到脉冲——抽验首帧接近源电平
  assert.ok(Math.max(...out) > 0.3)
  assert.equal(resampleTo16k(new Float32Array([0.5, 0.5]), 16000).length, 2, '已是 16k 时原样返回')
})

test('pcm16Base64：Float32 → Int16 PCM 编码与限幅', () => {
  const decoded = Buffer.from(pcm16Base64(new Float32Array([0, 0.5, 2, -2])), 'base64')
  assert.equal(decoded.readInt16LE(0), 0)
  assert.equal(decoded.readInt16LE(2), 16383)
  assert.equal(decoded.readInt16LE(4), 32767)
  assert.equal(decoded.readInt16LE(6), -32768)
})

test('自适应阈值：跟噪声基线走，不被偶发响声抬高，极安静房间有下限', () => {
  // 这台机器实测背景 RMS 就有 0.013：固定阈值 0.02 会把说话当静音——这是听写失灵的根因
  assert.ok(speechThreshold(0.013) > 0.013, '阈值必须高过底噪')
  assert.ok(speechThreshold(0.013) < 0.06, '阈值又不能高到吞掉正常说话')
  // 中位数：一帧敲门声不改变基线（六帧取中间两数的平均 = 0.0115）
  assert.equal(noiseBaseline([0.01, 0.012, 0.011, 0.4, 0.01, 0.012]), 0.0115)
  // 极安静房间：2.5 倍基线可能低到辨不出话，0.005 是保险丝
  assert.equal(speechThreshold(0), 0.005)
  assert.equal(speechThreshold(0.001), 0.005)
  assert.equal(BASELINE_FRAMES, 10)
})
