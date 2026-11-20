/**
 * 直接把合成子进程跑起来，喂一句真话，看它到底回不回音频。
 *
 * 这不是单测：它走的是**和应用里完全一样的那条路** —— 同一个 worker 脚本、
 * 同一份请求体构造、同一套认证头。区别只有两处：不播放音频、密钥从命令行给。
 *
 * 用法：node probe-tts.mjs <endpoint> <model> <voice>
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

const [endpoint, model, voice] = process.argv.slice(2)
const api = {
  kind: 'tts',
  name: 'probe',
  endpoint,
  model,
  voice: voice ?? '',
  voiceDesign: '',
  apiKey: process.env.MIMO_KEY ?? '',
  provider: 'mimo',
}

const worker = spawn(process.execPath, ['dist/main/tts-edge-worker.js'], {
  env: { ...process.env, DSH_TTS_CACHE_TEXTS: '[]', DSH_TTS_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let sawAudio = false
let out = ''
worker.stdout.setEncoding('utf8')
worker.stdout.on('data', chunk => {
  out += chunk
  for (const line of out.split('\n').slice(0, -1)) {
    const text = line.trim()
    if (text === '') continue
    let event
    try { event = JSON.parse(text) } catch { continue }
    if (event.audio?.b64) {
      sawAudio = true
      const bytes = Buffer.from(event.audio.b64, 'base64')
      mkdirSync('docs/demo', { recursive: true })
      writeFileSync('docs/demo/probe-tts.wav', bytes)
      console.log(`收到音频：${bytes.length} 字节 → docs/demo/probe-tts.wav（${event.audio.mime ?? '未知格式'}）`)
    } else if (event.ok === false) {
      console.log(`合成失败：${event.error}`)
    } else {
      console.log(`事件：${text.slice(0, 120)}`)
    }
  }
  out = out.slice(out.lastIndexOf('\n') + 1)
})

worker.on('exit', code => console.log(`worker 退出，退出码 ${code}${sawAudio ? '（曾收到音频）' : ''}`))

const text = '老板，我在这儿，能听见小潘说话吗？'
worker.stdin.write(JSON.stringify({
  speak: {
    id: 'probe#0',
    b64: Buffer.from(text, 'utf8').toString('base64'),
    api,
    /* 前瞻两句：验证数组协议真的被接受。 */
    next: ['第二句跟着念。', '第三句也得跟上。'].map((line, index) => ({
      id: `probe#${index + 1}`,
      b64: Buffer.from(line, 'utf8').toString('base64'),
      api,
    })),
  },
}) + '\n')

worker.on('error', e => console.log('worker error:', e.message))
setTimeout(() => { console.log('等待结束（70 秒）'); worker.stdin.write(JSON.stringify({ exit: true }) + '\n') }, 70_000)
