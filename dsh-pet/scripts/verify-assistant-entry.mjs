/** 真实 Electron 助理入口隔离验证；运行：node scripts/verify-assistant-entry.mjs。只在临时目录生成产物。 */
import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(path.join(tmpdir(), 'dsh-assistant-entry-'))
const name = `dsh-assistant-verify-${process.pid}`
const report = { output, name, checks: [], screenshots: [], console: [], events: [], sources: {},
  scope: '真实 main/preload/App/Narrator/文档读盘；桥接为内存原生队列边界，不证明真实 DSH 服务端接收。无模型、TTS 网络、真实麦克风或既有用户数据。',
  uncovered: ['真实模型与合成音质', '真实 DSH 服务端队列', '真实麦克风及 ASR 准确率', 'M1 任意语音插话'] }
const dirs = ['main', 'preload', 'renderer', 'profile', 'home', 'docs', 'runtime', 'shots', 'tmp']
await Promise.all(dirs.map(dir => mkdir(path.join(output, dir))))
await writeFile(path.join(output, 'docs/施工验证样本.md'), '# 施工验证样本\n第一段原文标记甲。这里只讨论隔离验证与授权范围。\n\n## 第二阶段\n第二段原文标记乙。这里讨论完成检查和收尾。\n')
await writeFile(path.join(output, 'profile/pet-settings.json'), JSON.stringify({ pet: 'panda', voiceConversation: true,
  docRoots: [path.join(output, 'docs')], docRecentDirs: [], idleSleepMinutes: 120, sleepMinutes: 20, trayResident: false,
  positions: { 'member-tangseng': { x: 850, y: 670 } } }))
await writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'module', name, main: 'runner.mjs' }))

// 仅替换外部边界；TTS 代理重新导出真实 Narrator，不改播放器与文档状态机。
const mocks = {
  wake: `export const startWakeListener = () => globalThis.__verify.log('唤醒边界禁用'); export const stopWakeListener = () => {};`,
  'pointer-watch': `export class PointerWatcher { setEnabled() {} dispose() {} }`,
  asr: `const v = globalThis.__verify;
export const streamingAvailable = () => true;
export const pcm16Base64ToFloat32 = b64 => { const b = Buffer.from(b64, 'base64'); return Float32Array.from(new Int16Array(b.buffer, b.byteOffset, b.length / 2), n => n / 32768); };
export const createStreamingSession = () => ({ feed(pcm) { v.frames++; v.samples += pcm.length; return ''; }, finalize() { return '合成语音验证'; } });
export const transcribeWav = async wav => { const b = Buffer.from(wav); v.log('识别边界', { bytes: b.length, riff: b.toString('ascii', 0, 4), sampleRate: b.readUInt32LE(24) }); return { ok: true, text: '合成语音验证' }; };`,
  tts: `export { Narrator } from ${JSON.stringify(path.join(root, 'src/main/tts.ts'))};
export function spawnTtsEdgeWorker(deliver) {
  const v = globalThis.__verify; queueMicrotask(() => deliver({ ready: true, voice: '无声测试传输' }));
  v.finishAudio = () => { const id = v.active?.id; if (!id) throw Error('没有待完成的假播放'); v.active = null; v.log('播放完成', { id }); deliver({ finished: { id } }); };
  return { write(line) { const command = JSON.parse(line);
    if (command.speak) { const { id, b64 } = command.speak; if (v.active) throw Error('假传输收到重叠播放'); v.active = { id, text: Buffer.from(b64, 'base64').toString() }; v.log('派发播放', v.active); queueMicrotask(() => deliver({ started: { id } })); }
    if (command.stop) { const id = v.active?.id; v.active = null; v.log('停止播放', { id }); queueMicrotask(() => deliver({ cancelled: { id } })); }
  }, close() { v.active = null; } };
}`,
  harness: `const v = globalThis.__verify;
export const readBridgeInfo = () => null; export const probeHealth = async () => null;
export class BridgeClient {
  state = { sessionId: '隔离会话', bindingId: '验证绑定', cursor: 0, title: '隔离施工验证', status: 'idle', entries: [], hasMore: false,
    model: null, models: [], permissions: [], permission: null, capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: false } };
  connect(callbacks) { this.callbacks = callbacks; callbacks.onStatus('connected'); this.publish(); }
  publish() { this.callbacks?.onEvent({ type: 'session/update', payload: structuredClone({ ...this.state, reset: true }) }); }
  add(role, text) { const seq = ++this.state.cursor; this.state.entries.push({ id: '条目' + seq, seq, role, kind: 'text', text }); }
  async getSession() { return { ok: true, state: structuredClone(this.state) }; }
  async getTeam() { return null; }
  async reportPetState() {} dispose() {}
  async sessionCommand(command) { v.log('原生队列边界', command); if (command.kind === 'prompt') { this.add('user', command.text); this.add('assistant', '合成文字回复，不应自动朗读。'); } this.publish(); return this.getSession(); }
  async chat(text, assistantId, signal, onDelta, bindingId) {
    const id = ++v.chatId; v.log('聊天边界', { id, text, assistantId, bindingId, streaming: !!onDelta });
    this.add('user', text); this.state.status = 'running'; this.publish();
    const first = '这是第一句合成解释。', rest = '这里是第二句合成解释。最后一句用于验证继续。';
    return new Promise(resolve => {
      const finish = () => { onDelta?.(rest); v.log('终稿', { id, aborted: !!signal?.aborted }); this.add('assistant', first + rest); this.state.status = 'idle'; this.publish(); resolve({ ok: true, reply: first + rest }); };
      setTimeout(() => { onDelta?.(first); v.log('首句增量', { id }); if (onDelta) v.releaseReply = finish; else finish(); }, 160);
    });
  }
}`,
}
const boundaries = { name: '隔离外部边界', setup(b) {
  b.onResolve({ filter: /[\\/](wake|pointer-watch|harness|tts|asr)\.ts$/ }, args => {
    if (args.namespace === 'isolated' && args.path === path.join(root, 'src/main/tts.ts')) return { path: args.path }
    return { path: path.basename(args.path, '.ts'), namespace: 'isolated' }
  })
  b.onLoad({ filter: /.*/, namespace: 'isolated' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: root }))
} }

// 驱动在真实主进程运行；DOM 操作用真实控件事件，不替换 petApi 或渲染组件。
async function drive(v, win, app, fs, path) {
  const r = v.report, wc = win.webContents
  const js = code => wc.executeJavaScript(code, true)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, label, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await pause(40) } throw Error('等待超时：' + label) }
  const check = (label, ok, detail = '') => { r.checks.push({ label, ok: !!ok, detail }); console.log((ok ? '通过：' : '失败：') + label) }
  const count = type => r.events.filter(e => e.type === type).length
  const click = async selector => { await until(() => js(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  const field = async (selector, text) => { await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`); await pause(60) }
  const send = async text => { await field('[aria-label="会话输入"]', text); await click('[aria-label="发送消息"], [aria-label="加入消息队列"]') }
  const shot = async name => { const file = path.join(r.output, 'shots', name + '.png'); fs.writeFileSync(file, (await wc.capturePage()).toPNG()); r.screenshots.push(file) }
  try {
    const prefs = wc.getLastWebPreferences()
    check('真实沙箱与上下文隔离', prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration, prefs)
    await until(() => js('!!window.petApi && !!document.querySelector(".character-slot")'), '真实 App 与 preload')
    wc.send('pet-summon', null)
    await until(() => js('!!document.querySelector(".chat-hud")'), '通过真实召唤事件打开会话')
    const state = await js('window.petApi.getState()')
    check('隔离配置开启语音会话', state.voiceConversation === true, app.getPath('userData'))
    await send('这是施工验证文字消息')
    await until(() => count('原生队列边界') === 1, '文字队列')
    await pause(250)
    check('DOM 文字发送一次且静音', count('原生队列边界') === 1 && count('聊天边界') === 0 && count('派发播放') === 0 && await js('document.querySelectorAll(".hud-message-user").length === 1'), '真实输入框 input 事件→发送按钮 DOM 点击→App→preload→session-command→内存队列边界')
    await shot('01-文字静音')

    await click('[aria-label="语音输入"]')
    await until(() => v.frames >= 3, 'Chromium 假麦克风真实 PCM 帧')
    await click('[aria-label="结束语音输入"]')
    await until(() => count('识别边界') === 1, '真实 WAV 经 preload 进入识别边界')
    const audio = r.events.find(e => e.type === '识别边界')
    check('麦克风按钮录制假流并停止', audio.bytes > 44 && audio.riff === 'RIFF', { ...audio, frames: v.frames, samples: v.samples })
    await until(async () => count('聊天边界') > 0 || await js('document.querySelector("[aria-label=会话输入]")?.value === "合成语音验证" && !!document.querySelector("[aria-label=语音输入]")'), '识别收尾')
    await pause(350)
    const automatic = count('聊天边界') === 1
    check('手动听写保留草稿，不自动发送', !automatic && await js('document.querySelector("[aria-label=会话输入]")?.value === "合成语音验证"'), '麦克风按钮用于听写；唤醒后的自动发送另行验证')
    await shot('02-录音停止')
    if (!automatic) await click('[aria-label="发送消息"]')
    r.voicePath = '麦克风开始与停止均为 DOM 点击，检查草稿后点击发送'
    await until(() => !!v.active && !!v.releaseReply, '首句实际交给假传输')
    check('语音首句先于终稿派发', count('终稿') === 0 && r.events.find(e => e.type === '聊天边界')?.streaming === true && count('派发播放') === 1, r.voicePath)
    await shot('03-终稿前首句播放')
    const plays = count('派发播放')
    await click('.hud-speech button')
    await until(() => !v.active, '停止朗读')
    v.releaseReply(); v.releaseReply = null
    await until(() => count('终稿') === 1, '主动投递停止后的迟到增量与终稿')
    await pause(300)
    check('停止后迟到增量和终稿不重播', count('派发播放') === plays && r.events.find(e => e.type === '终稿')?.aborted === true && await js('!document.querySelector(".hud-speech")'))
    await shot('04-停止后迟到结果')

    const beforeWake = count('聊天边界'), beforeFrames = v.frames
    wc.send('wake-triggered', null)
    await until(() => v.frames >= beforeFrames + 3, '唤醒触发假麦克风')
    await click('[aria-label="结束语音输入"]')
    await until(() => count('聊天边界') === beforeWake + 1 && !!v.active && !!v.releaseReply, '唤醒轮次自动发送并派发首句')
    check('唤醒后自动发送一次且使用流式语音入口', count('聊天边界') === beforeWake + 1 && r.events.filter(e => e.type === '聊天边界').at(-1).streaming === true, '模拟本地唤醒事件→真实 App 自动录音→DOM 停录→自动提交；不验证真实唤醒识别准确率')
    await click('.hud-speech button')
    v.releaseReply(); v.releaseReply = null
    await until(() => count('终稿') === count('聊天边界'), '唤醒轮次收尾')
    await pause(150)

    const queued = count('原生队列边界'), chats = count('聊天边界'), beforeDoc = count('派发播放')
    await send('讲讲施工验证样本')
    await until(() => js('!!document.querySelector(".doc-outline")'), '本地文档提纲自动打开')
    check('DOM 文档意图读授权合成文件且不进普通队列', count('原生队列边界') === queued && count('聊天边界') === chats && await js('document.querySelectorAll(".doc-row").length === 2'), await js('document.querySelector(".doc-title").title'))
    check('文字提纲不自动出声', count('派发播放') === beforeDoc && !v.active)
    check('本地结果 toast 可见', await js('document.querySelector(".toast[role=status]")?.textContent.includes("施工验证样本")'), '真实 App 接收 SessionResult.notice')
    await shot('05-文档提纲静音')
    await click('.doc-actions .primary')
    await until(() => v.active?.id.startsWith('doc-outline:'), '开始讲解范围说明')
    v.finishAudio()
    await until(() => v.active?.id.startsWith('doc:'), '文档首句')
    const utterance = v.active.id.split('#')[0]
    v.finishAudio()
    await until(() => v.active?.id === utterance + '#1', '第一句完成、第二句播放')
    const interrupted = { ...v.active }, askedBefore = count('聊天边界')
    await click('.doc-actions .danger')
    await until(() => !v.active, '文档暂停')
    await shot('06-文档暂停')
    const silent = count('派发播放')
    await field('#doc-ask-input', '这一段为什么需要隔离？')
    await click('.doc-ask-row button')
    await until(() => count('聊天边界') === askedBefore + 1 && count('终稿') === count('聊天边界'), '真实文档追问回执')
    await until(() => js('document.querySelector(".management-doc-log")?.textContent.includes("继续原来的讲解")'), '界面追问结果')
    const question = r.events.filter(e => e.type === '聊天边界').at(-1)
    check('暂停后 DOM 追问定位单段且保持静音', question.text.includes('第一段原文标记甲') && !question.text.includes('第二段原文标记乙') && count('派发播放') === silent && !v.active, '文档页输入框→问按钮→真实 doc-ask IPC')
    await shot('07-文档追问')
    const beforeResume = count('聊天边界')
    const resume = await js('window.petApi.getSession().then(r => window.petApi.sessionCommand({ kind: "prompt", bindingId: r.state.bindingId, text: "继续讲解", spoken: false }))')
    await until(() => !!v.active, '真实 IPC 继续讲解')
    check('继续从未完整播放句恢复且不重新生成', resume.ok && v.active.id === interrupted.id && v.active.text === interrupted.text && count('聊天边界') === beforeResume, '辅助路径：页面真实 petApi.sessionCommand→preload→session-command；未伪造状态或点击不存在的继续按钮')
    await shot('08-继续原句')
    v.finishAudio()
    await until(() => v.active?.id === utterance + '#2', '恢复后下一句')
    v.finishAudio()
    await until(() => js('document.querySelector(".doc-row .done")?.textContent === "已讲"'), '真实播放完成推进文档游标')
    check('完成后推进文档进度', true)
    await js('window.petApi.stopSpeech()')
  } catch (error) { r.failure = error.stack; check('驱动完成全部步骤', false, String(error)); await shot('99-失败现场').catch(() => {}) }
  finally {
    r.dom = await js('document.body.innerText').catch(() => '')
    r.rendererErrors = r.console.filter(e => e.level === 3 || e.level === 'error')
    check('渲染器无控制台错误', r.rendererErrors.length === 0, { errors: r.rendererErrors.length, warnings: r.console.filter(e => e.level === 2 || e.level === 'warning').length })
    r.ok = !r.failure && r.checks.every(c => c.ok)
    fs.writeFileSync(path.join(r.output, 'report.json'), JSON.stringify(r, null, 2))
    console.log('验证报告：' + path.join(r.output, 'report.json'))
    app.quit()
  }
}

try {
  const mainBuild = await build({ entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(output, 'main/index.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'pdfjs-dist'], plugins: [boundaries], metafile: true })
  for (const input of Object.keys(mainBuild.metafile.inputs).filter(p => !p.startsWith('isolated:'))) {
    const file = path.resolve(input); report.sources[file] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  await build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(output, 'preload/index.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const rendererBuild = await build({ entryPoints: [path.join(root, 'src/renderer/main.tsx')], outfile: path.join(output, 'renderer/main.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' }, metafile: true })
  for (const input of Object.keys(rendererBuild.metafile.inputs).filter(p => !p.includes('node_modules'))) {
    const file = path.resolve(input); report.sources[file] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  for (const file of ['index.html', 'styles.css']) await cp(path.join(root, 'src/renderer', file), path.join(output, 'renderer', file))
  await cp(path.join(root, 'assets/pets'), path.join(output, 'assets/pets'), { recursive: true })
  // 复制运行时并改可执行文件名，仅临时副本变化，避免与常驻宠物混淆；不安装、不动依赖。
  const electron = createRequire(import.meta.url)('electron')
  if (process.platform !== 'win32') throw Error('本验证脚本仅在 Windows 隔离副本运行')
  await cp(path.dirname(electron), path.join(output, 'runtime'), { recursive: true })
  const executable = path.join(output, 'runtime', name + '.exe')
  await rename(path.join(output, 'runtime/electron.exe'), executable)
  const runner = `import { app, session } from 'electron'; import fs from 'node:fs'; import path from 'node:path';
app.setName(${JSON.stringify(name)}); process.title = ${JSON.stringify(name)};
app.setPath('userData', ${JSON.stringify(path.join(output, 'profile'))}); app.setPath('sessionData', app.getPath('userData'));
app.setPath('crashDumps', ${JSON.stringify(path.join(output, 'profile'))}); app.setPath('temp', ${JSON.stringify(path.join(output, 'tmp'))});
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const v = globalThis.__verify = { report: ${JSON.stringify(report)}, frames: 0, samples: 0, chatId: 0, active: null, log(type, detail = {}) { this.report.events.push({ time: Date.now(), type, ...detail }); } };
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', event => { const { level, message, lineNumber, sourceId } = event; v.report.console.push({ level, message, line: lineNumber, source: sourceId }); });
  win.webContents.on('render-process-gone', (_e, details) => { v.report.failure = '渲染进程退出：' + JSON.stringify(details); });
  win.webContents.once('did-finish-load', () => (${drive.toString()})(v, win, app, fs, path));
});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => { v.log('阻止外网请求', { url: details.url }); done({ cancel: true }); }));
await import(${JSON.stringify(pathToFileURL(path.join(output, 'main/index.js')).href)});
`
  await writeFile(path.join(output, 'runner.mjs'), runner)
  const env = { ...process.env, DSH_HOME: path.join(output, 'home'), TMP: path.join(output, 'tmp'), TEMP: path.join(output, 'tmp') }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [path.join(output, 'runner.mjs')], { env, cwd: output, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; process.stdout.write(data) })
  const timeout = setTimeout(() => { logs += '\n验证超时，仅终止本脚本启动的子进程。'; child.kill() }, 90000)
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }) }
  finally { clearTimeout(timeout); await writeFile(path.join(output, 'electron.log'), logs) }
  const result = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
  process.exitCode = process.exitCode || (result.ok ? 0 : 1)
} catch (error) {
  report.failure = String(error.stack ?? error); report.ok = false
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error(error); process.exitCode = 1
} finally { console.log('隔离产物：' + output) }
