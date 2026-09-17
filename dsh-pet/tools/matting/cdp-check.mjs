// CDP 验证：桌面宠物序列帧播放与动作调度
const base = 'http://127.0.0.1:9222'

async function main() {
  const targets = await (await fetch(`${base}/json`)).json()
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url))
  if (!page) throw new Error('未找到渲染页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
  await new Promise(r => (ws.onopen = r))
  const evalJs = expression =>
    send('Runtime.evaluate', { expression, returnByValue: true }).then(r => r.result.value)

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  await sleep(2500)

  // 1) 序列帧是否在播放：.pet-frame 的 src 应随时间变化
  const src1 = await evalJs(`document.querySelector('.pet-frame')?.currentSrc || document.querySelector('.pet-frame')?.src || null`)
  await sleep(700)
  const src2 = await evalJs(`document.querySelector('.pet-frame')?.currentSrc || document.querySelector('.pet-frame')?.src || null`)
  console.log('frame src 采样1:', src1 ? src1.slice(-24) : null)
  console.log('frame src 采样2:', src2 ? src2.slice(-24) : null)
  console.log(src1 && src2 && src1 !== src2 ? '✓ 序列帧在播放' : src1 ? '✗ 帧未变化（可能动作帧数=1）' : '· 当前动作无序列帧（回退路径）')

  // 2) 12 秒内观察动作调度与帧播放覆盖
  const seen = new Set()
  let frameHits = 0
  let samples = 0
  for (let i = 0; i < 24; i++) {
    const s = await evalJs(`({
      action: (document.querySelector('.pet-stage')?.className.match(/action-([a-z]+)/)||[])[1],
      hasFrame: !!document.querySelector('.pet-frame'),
      src: document.querySelector('.pet-frame')?.src || null
    })`)
    if (s) {
      samples++
      if (s.action) seen.add(s.action)
      if (s.hasFrame) frameHits++
    }
    await sleep(500)
  }
  console.log('12s 内出现的动作:', [...seen].join(', '))
  console.log(`帧播放采样命中 ${frameHits}/${samples}`)

  ws.close()
  process.exit(0)
}

main().catch(e => {
  console.error('验证失败:', e.message)
  process.exit(1)
})
