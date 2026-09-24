/**
 * 宠物动作衔接实测：用真实渲染器 + 真实素材跑一遍动作序列，不连接模型、不录音、不写任何用户数据。
 *
 * 两段验证：
 *  1) 播放序列：对话四阶段、连续追问、收电脑中途再来一问、拖拽摔坐 —— 断言动作顺序、不重复
 *     坐下、不缩放松动、出帧不空白。
 *  2) 素材接缝：真实解码 PNG 求角色包围盒，断言站姿高度在各动作间一致、躺下与起身的首尾帧对齐。
 *
 * 用法：node scripts/verify-pet-renderer.mjs
 * 产物（截图与 report.json）写到系统临时目录，路径在结尾打印。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTIONS = ['idle', 'grab', 'drop', 'laptop-in', 'think', 'write', 'laptop-out', 'sleep-in', 'sleep-loop', 'sleep-out']
const frames = {}
for (const action of ACTIONS) {
  const directory = path.join(root, 'assets/pets/frames/panda', action)
  frames[action] = (await readdir(directory)).filter(name => /^f\d+\.png$/.test(name)).sort()
    .map(name => `/assets/pets/frames/panda/${action}/${name}`)
}
const output = await mkdtemp(path.join(tmpdir(), 'dsh-pet-renderer-'))
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
import React, { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import TeamStage from './src/renderer/TeamStage.tsx'
import VoiceApiSettings from './src/renderer/VoiceApiSettings.tsx'
import { manifestFor } from './src/renderer/character-manifest.ts'
const frames = ${JSON.stringify(frames)}
const samples = []
const phases = []
// 手柄的赋值发生在 TeamStage 的 effect 里，晚于渲染，所以这里一直握着 ref 本身。
let stageRef = null
// App 里拖拽是通过 onDragStart 把行为交出来、再在 window 的 mouseup 上收尾，这里照做。
let dragBehavior = null
// 用 App 真实使用的那个组件，而不是直接调 hook：属性接线（睡眠分钟数、手柄方法）也要一起验。
function Harness() {
  const ref = useRef(null)
  stageRef = ref
  const member = manifestFor({ assistantId: 'member-tangseng' })
  // idle 参数用来把待机阈值压到 1 分钟，好在实测里看到真实打盹。
  const idleParam = new URLSearchParams(location.search).get('idle')
  return <TeamStage members={[{ assistantId: member.assistantId, roleId: member.roleId, displayName: member.displayName, enabled: true }]}
    assistantActive={false} selectedId={member.assistantId} focusMode
    idleSleepMinutes={idleParam === null ? 120 : Number(idleParam)} sleepMinutes={20}
    exitStage="none" portalPhase="idle" proactive={null} onProactiveRespond={() => {}}
    onSelect={() => {}} onPersist={() => {}} onContextMenu={() => {}}
    onDragStart={(_event, behavior) => { dragBehavior = behavior; behavior.startDrag() }} handleRef={ref} />
}
function assert(value, message) { if (!value) throw new Error(message) }
function until(predicate, timeout = 10000, label = '') {
  if (typeof timeout === 'string') { label = timeout; timeout = 10000 }
  const start = performance.now()
  return new Promise((resolve, reject) => {
    function check() {
      if (predicate()) return resolve()
      if (performance.now() - start > timeout) {
        const slot = document.querySelector('.character-slot')
        return reject(new Error((label || 'until') + ' 等待超时，当前界面：' + JSON.stringify({
          hasStage: !!stageRef?.current, slotClass: slot?.className ?? null,
          sprite: document.querySelector('.pose-layer.pose-in img')?.src.split('/').slice(-2).join('/') ?? null,
          body: document.body.innerHTML.slice(0, 600),
        })))
      }
      requestAnimationFrame(check)
    }
    check()
  })
}
function load(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.src = src
    image.decode().then(() => resolve(image), reject)
  })
}
/** 角色包围盒：用画布读像素的 alpha 通道，量的是真实可见范围而不是画布尺寸。 */
async function metrics(src) {
  const image = await load(src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let top = 1e9, bottom = -1, left = 1e9, right = -1
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 24) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return { canvas: canvas.width + 'x' + canvas.height, top, bottom, left, right, height: bottom - top + 1, width: right - left + 1 }
}
/**
 * 语音接口设置的界面契约实测。
 *
 * 组件是真的、渲染器是真的、交互是真的；petApi 用内存版替身（与主进程契约同语义：
 * 编辑时省略密钥=保留，空串=清除）。主进程那一侧另有 store 的 27 项测试和 IPC 通道清单把守。
 */
async function runVoiceApiCheck() {
  const store = { profiles: [], selected: { tts: null, asr: null }, seq: 0 }
  const calls = []
  const state = () => ({ profiles: store.profiles.map(p => ({ ...p })), selected: { ...store.selected } })
  const find = (id) => store.profiles.find(p => p.id === id)
  window.petApi = {
    voiceApiState: async () => { calls.push(['state']); return { ok: true, state: state() } },
    voiceApiSave: async (input) => {
      calls.push(['save', JSON.parse(JSON.stringify(input))])
      if (input.id) {
        const profile = find(input.id)
        if (!profile) return { ok: false, error: '找不到这条配置' }
        profile.name = input.name; profile.endpoint = input.endpoint
        profile.model = input.model; profile.voice = input.voice ?? ''
        if (input.apiKey === '') profile.hasKey = false
        else if (typeof input.apiKey === 'string') profile.hasKey = true
      } else {
        store.seq += 1
        store.profiles.push({
          id: 'id' + store.seq, kind: input.kind, name: input.name, endpoint: input.endpoint,
          model: input.model, voice: input.voice ?? '', hasKey: typeof input.apiKey === 'string' && input.apiKey !== '',
        })
      }
      return { ok: true, state: state() }
    },
    voiceApiRemove: async (id) => {
      calls.push(['remove', id])
      store.profiles = store.profiles.filter(p => p.id !== id)
      for (const kind of ['tts', 'asr']) if (store.selected[kind] === id) store.selected[kind] = null
      return { ok: true, state: state() }
    },
    voiceApiSelect: async (kind, id) => {
      calls.push(['select', kind, id])
      if (id !== null && (find(id) ?? {}).kind !== kind) return { ok: false, error: '类型对不上' }
      store.selected[kind] = id
      return { ok: true, state: state() }
    },
  }
  createRoot(document.getElementById('root')).render(<VoiceApiSettings />)
  const checks = {}
  const $ = (selector) => document.querySelector(selector)
  const setField = async (element, value) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
  const setSelect = (element, value) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const click = async (text) => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(text))
    if (!el) throw new Error('找不到按钮"' + text + '"；DOM 中的按钮：' + [...document.querySelectorAll('button')].map(b => JSON.stringify(b.textContent)).join(', '))
    if (el.disabled || el.closest('fieldset')?.disabled === true) throw new Error('按钮"' + text + '"被禁用')
    el.click()
    await new Promise(r => setTimeout(r, 200))
  }
  // 每次操作后等 pending 结束再点下一个：disabled fieldset 会吞掉点击。
  const waitIdle = () => until(() => $('section[aria-label="语音接口设置"]')?.getAttribute('aria-busy') === 'false', 10000, 'waitIdle')

  await until(() => $('[name="selected-tts"]') !== null, 'step1-select')
  await waitIdle()
  // ① 新增一条 TTS 配置：落列表、标"已设置密钥"、密钥框清空。
  const step = (n) => (msg) => { try { return msg } catch (e) { throw new Error('step ' + n + ': ' + e.message) } }
  await click('新增配置')
  await until(() => $('[name="name"]') !== null, 'step4-form')
  await waitIdle()
  await setField($('[name="name"]'), '我的服务')
  await setField($('[name="endpoint"]'), 'https://example.com/v1')
  await setField($('[name="model"]'), 'tts-1')
  await setField($('[name="voice"]'), 'alloy')
  await setField($('[name="apiKey"]'), 'sk-secret')
  console.info('PET_PHASE:voice-add')
  await click('保存配置')
  await until(() => document.querySelectorAll('li').length === 1, 'step5')
  await waitIdle()
  checks.saved = true
  checks.keyNotEchoed = $('[name="apiKey"]') === null || $('[name="apiKey"]').value === ''
  checks.showsHasKey = document.body.textContent.includes('已设置密钥')

  // ② 在下拉框里选中它。
  setSelect($('[name="selected-tts"]'), store.profiles[0].id)
  await until(() => $('[name="selected-tts"]').value === store.profiles[0].id, 'step6')
  await waitIdle()
  checks.selectWorks = store.selected.tts === store.profiles[0].id

  // ③ 编辑且不填密钥：保持原密钥（保存请求里不该出现密钥字段）。
  await click('编辑')
  await until(() => $('[name="name"]') !== null, 'step7-edit')
  await waitIdle()
  checks.editKeyBlank = $('[name="apiKey"]').value === ''
  checks.editSaysNoEcho = document.body.textContent.includes('不回显')
  await setField($('[name="model"]'), 'tts-2')
  const beforeKeeps = calls.filter(c => c[0] === 'save').length
  await click('保存配置')
  await until(() => calls.filter(c => c[0] === 'save').length > beforeKeeps, 'step8')
  await waitIdle()
  const editPayload = calls.filter(c => c[0] === 'save').at(-1)[1]
  checks.keepsKey = !('apiKey' in editPayload)
  checks.hasKeyStill = store.profiles[0].hasKey === true

  // ④ 明确勾选清除密钥：这次必须真的带上空串。
  await click('编辑')
  await until(() => $('.voice-api-clear-key input') !== null, 'step9')
  await waitIdle()
  const box = $('.voice-api-clear-key input')
  box.click()
  await until(() => $('[name="apiKey"]').disabled === true, 'step10')
  const beforeClear = calls.filter(c => c[0] === 'save').length
  await click('保存配置')
  await until(() => calls.filter(c => c[0] === 'save').length > beforeClear, 'step11')
  await waitIdle()
  checks.clearKeySent = calls.filter(c => c[0] === 'save').at(-1)[1].apiKey === ''
  checks.showsNoKey = document.body.textContent.includes('未设置密钥')

  // ⑤ 删除：先确认才真删，删完回落默认方案。
  await click('删除')
  await until(() => document.body.textContent.includes('确定删除'))
  await click('确认删除')
  await until(() => document.querySelectorAll('li').length === 0, 'step12')
  await waitIdle()
  checks.deleted = store.profiles.length === 0
  checks.selectionReset = store.selected.tts === null && $('[name="selected-tts"]').value === ''
  return { mode: 'voice-api', checks, calls }
}

window.runPetCheck = async () => {
  // 语音接口设置模式：真实组件 + 内存版 petApi，验证增删改选与密钥不回显的界面契约。
  if (new URLSearchParams(location.search).has('voice-api')) return runVoiceApiCheck()
  await Promise.all(Object.values(frames).flat().map(src => load(src)))
  createRoot(document.getElementById('root')).render(<Harness />)
  await until(() => stageRef?.current)
  const stage = stageRef.current
  const action = () => document.querySelector('.character-slot')?.className.match(/action-([a-z-]+)/)?.[1]
  const sprite = () => document.querySelector('.pose-layer.pose-in img')
  // 拖起时类名仍是 idle（抓取只是临时换帧），所以拖动要看实际播放的帧。
  const phaseNow = () => { const src = sprite()?.src ?? ''; return src.includes('/grab/') ? 'grab' : action() }
  let last = '', lastPhase = '', recording = true
  const decodeWait = {}
  function sample() {
    const image = sprite()
    const phase = phaseNow()
    if (image && phase && phase !== lastPhase) {
      lastPhase = phase
      phases.push(phase)
      console.info('PET_PHASE:' + phase)
      // 换动作后这一帧什么时候真正可显示：等太久用户就会看到一瞬间的空白。
      const started = performance.now()
      const poll = () => {
        if (image.complete && image.naturalWidth > 0) {
          decodeWait[phase] = Math.round(performance.now() - started)
          return
        }
        requestAnimationFrame(poll)
      }
      poll()
    }
    if (image && image.src !== last) {
      const rect = image.getBoundingClientRect()
      samples.push({ phase, src: image.src.split('/').slice(-2).join('/'), time: performance.now(),
        boxHeight: Math.round(rect.height), decoded: image.complete && image.naturalWidth > 0 })
      last = image.src
    }
    for (const layer of document.querySelectorAll('.pose-layer')) {
      assert(getComputedStyle(layer).transform === 'none', '切换动作不应缩放或位移')
    }
    if (recording) requestAnimationFrame(sample)
  }
  sample()
  const who = 'member-tangseng'
  // 打盹模式（?idle=1）：等真实的 1 分钟待机阈值，看躺下 → 睡 → 唤醒起身。
  if (new URLSearchParams(location.search).has('idle')) {
    await until(() => action() === 'sleep-in', 90000)
    await until(() => action() === 'sleep-loop', 20000)
    stageRef.current.wakeOf(who)
    await until(() => action() === 'sleep-out', 12000)
    await until(() => action() === 'idle', 12000)
    recording = false
    // 只考核睡眠三段：待机那几十秒本来就在等阈值，混进来量到的是空转不是停顿。
    const napPhasesSet = new Set(['sleep-in', 'sleep-loop', 'sleep-out'])
    const napGaps = samples.slice(1).flatMap((sample, i) =>
      sample.phase === samples[i].phase && napPhasesSet.has(sample.phase) ? [sample.time - samples[i].time] : [])
    return { mode: 'nap', phases, framesObserved: samples.length,
      maxFrameGapMs: Math.max(...napGaps), maxDecodeWaitMs: Math.max(...Object.values(decodeWait)), decodeWait }
  }
  // 先确认手柄找得到这个角色（气泡出现即代表行为实例已注册），再验动作。
  stage.sayTo(who, '自检')
  const bubbleShown = await new Promise(resolve => {
    const started = performance.now()
    const poll = () => {
      if (document.querySelector('.pet-bubble')) return resolve(true)
      if (performance.now() - started > 2000) return resolve(false)
      requestAnimationFrame(poll)
    }
    poll()
  })
  assert(bubbleShown, '手柄没找到角色行为实例：说句话也不出气泡')
  // 手柄方法要等行为实例注册完才生效，这里重发几次直到动作真的变了。
  const trail = []
  window.petTrail = () => trail
  window.petPhases = () => phases
  const nudge = async (event, expected) => {
    const started = performance.now()
    while (action() !== expected && performance.now() - started < 3000) {
      trail.push({ at: Math.round(performance.now() - started), before: action() })
      stage.conversationOf(who, event)
      await new Promise(resolve => requestAnimationFrame(resolve))
      trail[trail.length - 1].after = action()
    }
  }
  await nudge({ type: 'start', id: 1 }, 'laptop-in')
  await until(() => action() === 'think')
  // 流式出字：第一片增量到就开始敲键盘，不必等整段回复。
  stage.conversationOf(who, { type: 'delta', id: 1 })
  await until(() => action() === 'write')
  stage.conversationOf(who, { type: 'reply', id: 1 })
  await until(() => action() === 'laptop-out')
  await until(() => action() === 'idle')
  // 第二轮：从待机重新坐下打开电脑。
  stage.conversationOf(who, { type: 'start', id: 2 })
  await until(() => action() === 'laptop-in')
  await until(() => action() === 'think')
  const sitsBefore = phases.filter(p => p === 'laptop-in').length
  // 人还坐在电脑前再问一句：不能重播"坐下掏电脑"。
  stage.conversationOf(who, { type: 'start', id: 3 })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert(action() === 'think', '坐着续问不该重播坐下：' + action())
  assert(phases.filter(p => p === 'laptop-in').length === sitsBefore, '坐着续问不能重复坐下')
  stage.conversationOf(who, { type: 'delta', id: 3 })
  await until(() => action() === 'write')
  stage.conversationOf(who, { type: 'reply', id: 3 })
  await until(() => action() === 'laptop-out')
  await until(() => action() === 'idle')
  // 待机时被拎起来摔一跤：拖起看抓取帧，松手要演完摔坐再回待机。
  const slot = document.querySelector('.character-slot')
  const rect = slot.getBoundingClientRect()
  const origin = { x: rect.left + 60, y: rect.top + 60 }
  slot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...origin }))
  await until(() => phaseNow() === 'grab', 4000)
  assert(dragBehavior !== null, '拖拽没有把行为交给 App 那一侧')
  // App 在 window 上监听移动与松手再转给行为。要先有按下时的一拍，第二次移动才越过拖动阈值。
  dragBehavior.dragMove(origin.x, origin.y)
  dragBehavior.dragMove(origin.x + 120, origin.y + 80)
  dragBehavior.endDrag()
  await until(() => action() === 'drop', 4000)
  await until(() => action() === 'idle', 12000)
  recording = false
  const gaps = samples.slice(1).flatMap((sample, i) => sample.phase === samples[i].phase ? [sample.time - samples[i].time] : [])
  const maxFrameGapMs = Math.max(...gaps)
  const maxDecodeWaitMs = Math.max(...Object.values(decodeWait))
  assert(samples.every(s => s.boxHeight === 150), '有动作渲染高度不是 150px：' + JSON.stringify(samples.find(s => s.boxHeight !== 150)))

  const box = {}
  for (const [action, list] of Object.entries(frames)) {
    box[action] = { first: await metrics(list[0]), last: await metrics(list[list.length - 1]), count: list.length }
  }
  // 只比真正的站姿：坐着敲键盘、掉落途中本来就矮，不能拿它们当基准。
  const standing = { idle: box.idle.first.height, 'sleep-in.first': box['sleep-in'].first.height,
    'sleep-out.last': box['sleep-out'].last.height }
  const heights = Object.values(standing)
  const spread = (Math.max(...heights) - Math.min(...heights)) / Math.min(...heights)
  // 接缝：躺下末帧→睡首帧、睡末帧→起身首帧。同一段视频裁出来的，身体位置该对得上；
  // 只有呼吸起伏会让顶边差几像素，底边/左右必须几乎重合。
  const edges = (a, b) => ({ top: Math.abs(a.top - b.top), bottom: Math.abs(a.bottom - b.bottom),
    left: Math.abs(a.left - b.left), right: Math.abs(a.right - b.right) })
  const seams = {
    'sleep-in→sleep-loop': edges(box['sleep-in'].last, box['sleep-loop'].first),
    'sleep-loop→sleep-out': edges(box['sleep-loop'].last, box['sleep-out'].first),
  }
  return { mode: 'dialog', phases, trail, framesObserved: samples.length, maxFrameGapMs, maxDecodeWaitMs, decodeWait,
    standing, standingSpread: spread, seams,
    canvas: Object.fromEntries(Object.entries(box).map(([action, value]) => [action, value.first.canvas + '/' + value.count])) }
}
`,
  },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  // 设置页的样式不在这些契约断言范围里；实测页不落 CSS 产物，给空加载器。
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/pet.css"><style>body{background:#dee9e5;margin:0;font-family:Arial}h2{margin:32px;color:#23352c}</style><h2>宠物动作实测（不连接模型、不录音）</h2><div id="root"></div><script src="/test.js"></script>'
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return }
    if (url.pathname === '/test.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return }
    if (url.pathname === '/pet.css') { response.setHeader('Content-Type', 'text/css'); response.end(await readFile(path.join(root, 'src/renderer/pet-anim.css'))); return }
    if (!/^\/assets\/pets\/frames\/panda\/[a-z-]+\/f\d+\.png$/.test(url.pathname)) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', 'image/png')
    response.end(await readFile(path.join(root, url.pathname.slice(1))))
  } catch { response.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const electronMain = path.join(output, 'runner.cjs')
await writeFile(electronMain, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(output, 'profile'))});
app.whenReady().then(async () => {
  // 窗口摆到屏幕外：截的是 webContents，与屏幕位置无关；真实鼠标划过宠物会刷新
  // “互动时间”，把打盹那段的 60 秒待机计时一次次推后 —— 那是环境干扰，不是产品缺陷。
  const win = new BrowserWindow({ width: 720, height: 430, x: -3000, y: 100, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  let shot = 0;
  const captures = [];
  win.webContents.on('render-process-gone', (_event, details) => console.error('验证渲染进程退出', JSON.stringify(details)));
  win.webContents.on('console-message', (_event, _level, message) => {
    if (!message.startsWith('PET_PHASE:')) return;
    const file = ${JSON.stringify(output)} + '/' + String(++shot).padStart(2, '0') + '-' + message.slice(10) + '.png';
    captures.push(win.webContents.capturePage().then(image => fs.writeFileSync(file, image.toPNG())));
  });
  try {
    const reports = {};
    for (const [name, query] of ${JSON.stringify(process.argv.includes('--voice-api-only') ? [['voice-api', '?voice-api=1']] : [['dialog', ''], ['nap', '?idle=1'], ['voice-api', '?voice-api=1']])}) {
      await win.loadURL(${JSON.stringify(url)} + query);
      const report = await win.webContents.executeJavaScript('window.runPetCheck()');
      reports[name] = report;
      await Promise.all(captures.splice(0));
      fs.writeFileSync(${JSON.stringify(output)} + '/' + name + '.json', JSON.stringify(report, null, 2));
      console.log(name, JSON.stringify({ phases: report.phases, trail: report.trail, framesObserved: report.framesObserved, maxFrameGapMs: Math.round(report.maxFrameGapMs), maxDecodeWaitMs: report.maxDecodeWaitMs, decodeWait: report.decodeWait, standingSpread: report.standingSpread, seams: report.seams, canvas: report.canvas }));
    }
    console.log('验证产物：' + ${JSON.stringify(output)});
    const dialog = reports.dialog, nap = reports.nap;
    if (dialog && nap) {
    if (dialog.maxFrameGapMs >= 400) throw new Error('对话动作帧间停顿超过 400ms：' + dialog.maxFrameGapMs);
    if (nap.maxFrameGapMs >= 400) throw new Error('打盹帧间停顿超过 400ms：' + nap.maxFrameGapMs);
    for (const [name, report] of Object.entries(reports)) {
      if (report.maxDecodeWaitMs >= 120) throw new Error(name + ' 换动作后空白可见超过 120ms：' + JSON.stringify(report.decodeWait));
    }
    if (dialog.standingSpread > 0.04) throw new Error('站姿高度不一致：' + JSON.stringify(dialog.standing));
    for (const [name, gap] of Object.entries(dialog.seams)) {
      if (Math.max(gap.bottom, gap.left, gap.right) > 8) throw new Error('接缝身体位置未对齐 ' + name + '：' + JSON.stringify(gap));
      if (gap.top > 16) throw new Error('接缝起伏过大 ' + name + '：' + JSON.stringify(gap));
    }
    // 打盹必须走完躺下→睡→起身，不能从躺着直接跳回站立。
    const napPhases = nap.phases.join('→');
    for (const step of ['sleep-in', 'sleep-loop', 'sleep-out', 'idle']) {
      if (!nap.phases.includes(step)) throw new Error('打盹缺了 ' + step + '：' + napPhases);
    }
    if (nap.phases.indexOf('sleep-in') > nap.phases.indexOf('sleep-loop') || nap.phases.indexOf('sleep-loop') > nap.phases.indexOf('sleep-out')) {
      throw new Error('打盹顺序不对：' + napPhases);
    }
    }
    // 语音接口设置：保存 / 不回显 / 保留密钥 / 显式清除 / 选择 / 删除回落默认。
    const ui = reports['voice-api'];
    for (const [label, passed] of Object.entries(ui.checks)) {
      if (!passed) throw new Error('语音接口设置契约未通过：' + label + '；调用轨迹 ' + JSON.stringify(ui.calls));
    }
    app.exit(0);
  } catch (error) {
    const trail = await win.webContents.executeJavaScript('window.petTrail ? window.petTrail() : null').catch(() => null);
    const slot = await win.webContents.executeJavaScript("document.querySelector('.character-slot')?.className ?? null").catch(() => null);
    const phasesSoFar = await win.webContents.executeJavaScript('window.petPhases ? window.petPhases() : null').catch(() => null);
    console.error(String(error), error?.message, error?.stack, '页面：', win.webContents.getURL(), '调用轨迹：', JSON.stringify(trail), '动作时序：', JSON.stringify(phasesSoFar), '当前类名：', slot);
    app.exit(1);
  }
});
`)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [electronMain], { env: environment, stdio: 'inherit' })
const timeout = setTimeout(() => child.kill(), 300000)
try {
  process.exitCode = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
} finally {
  clearTimeout(timeout)
  server.close()
  console.log(`验证产物：${output}`)
}
