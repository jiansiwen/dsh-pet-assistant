/**
 * 真实 Electron 审批验收（只依赖已安装的 electron/esbuild）。
 * 运行：node D:/work/dsh-pet/scripts/verify-report-approval.mjs
 * 可选：--diagnose-read。仅在真实读卡失败后，替换测试进程里的读卡 handler，
 * 补上传给真实 verify 的当前编号，以继续诊断渲染/按钮。基线失败仍保留，退出码仍为 1；
 * 此模式不是生产链路通过，更不会修改任何生产文件。决定 IPC 始终使用真实实现。
 *
 * 使用真实 ApprovalWindow、页面、preload、webPreferences、BridgeClient 和 CDP。
 * HTTP 服务与审批令牌完全虚构；原生确认框只记录参数并用受控 Promise 回答，
 * 不验证系统原生对话框的实际绘制，也不验证插件落盘/停记录副作用。
 * 全部产物、截图、用户目录放系统临时目录，退出后删除；不加载主应用/舞台/语音/素材。
 */
import * as esbuild from 'esbuild'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = mkdtempSync(path.join(tmpdir(), 'dsh-report-approval-'))
let child
let closed = false
let watchdog
try {
  for (const dir of ['main', 'preload', 'renderer', 'profile', 'appdata', 'localappdata', 'home']) {
    mkdirSync(path.join(temporary, dir), { recursive: true })
  }
  const harness = `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { createHash, randomUUID } from 'node:crypto';
    import { createServer } from 'node:http';
    import { setTimeout as delay } from 'node:timers/promises';
    import { app, BrowserWindow, ipcMain, dialog, session, nativeImage } from 'electron';
    import { ApprovalWindow } from ${JSON.stringify(path.join(root, 'src/main/approval-window.ts'))};
    import { BridgeClient } from ${JSON.stringify(path.join(root, 'src/main/harness.ts'))};
    (${runElectronTests.toString()})();
  `
  const shared = { bundle: true, logLevel: 'warning', sourcemap: false }
  const result = await esbuild.build({
    ...shared, stdin: { contents: harness, resolveDir: root, sourcefile: 'approval-e2e-harness.mjs' },
    outfile: path.join(temporary, 'main/verify.mjs'), platform: 'node', format: 'esm',
    external: ['electron'], target: 'node22', metafile: true,
  })
  // 入口白名单防止未来间接导入主应用，测试期间意外启动麦克风或读取真实设置。
  const allowed = ['src/main/approval-window.ts', 'src/main/approval-policy.ts', 'src/main/harness.ts']
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input === 'approval-e2e-harness.mjs') continue
    if (!allowed.some(suffix => input.replaceAll('\\', '/').endsWith(suffix))) {
      throw new Error(`测试主进程意外包含额外模块：${input}`)
    }
  }
  await esbuild.build({
    ...shared, entryPoints: [path.join(root, 'src/preload/approval.ts')],
    outfile: path.join(temporary, 'preload/approval.cjs'), platform: 'node', format: 'cjs',
    external: ['electron'], target: 'node22',
  })
  await esbuild.build({
    ...shared, entryPoints: [path.join(root, 'src/renderer/approval-main.tsx')],
    outfile: path.join(temporary, 'renderer/approval.js'), platform: 'browser', format: 'iife',
    target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' },
  })
  cpSync(path.join(root, 'src/renderer/approval.html'), path.join(temporary, 'renderer/approval.html'))
  const env = {
    ...process.env, REPORT_APPROVAL_TEST_DIR: temporary,
    REPORT_APPROVAL_DIAGNOSE_READ: process.argv.includes('--diagnose-read') ? '1' : '0',
    DSH_HOME: path.join(temporary, 'dsh-home'), HOME: path.join(temporary, 'home'),
    USERPROFILE: path.join(temporary, 'home'), APPDATA: path.join(temporary, 'appdata'),
    LOCALAPPDATA: path.join(temporary, 'localappdata'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_INSPECT_RESUME_ON_START
  console.log(`隔离目录：${temporary}`)
  child = spawn(createRequire(import.meta.url)('electron'), [
    path.join(temporary, 'main/verify.mjs'), `--user-data-dir=${path.join(temporary, 'profile')}`,
  ], { cwd: temporary, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const stop = () => { if (!closed && child.connected) child.send('停止测试') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  watchdog = setTimeout(() => {
    if (closed) return
    console.error('测试超时，只终止本脚本创建的 Electron 进程树')
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else child.kill('SIGKILL')
  }, 120_000)
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { closed = true; resolve(code ?? 1) })
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  // 等 Electron 的进程句柄释放后再删；只处理本次 mkdtemp 的目录。
  if (!child || closed) {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    console.log(`清理完成：${!existsSync(temporary)}`)
  }
}

async function runElectronTests() {
  const base = process.env.REPORT_APPROVAL_TEST_DIR
  assert.ok(base && path.basename(base).startsWith('dsh-report-approval-'))
  app.setPath('userData', path.join(base, 'profile'))
  app.setPath('sessionData', path.join(base, 'profile'))
  app.setPath('appData', path.join(base, 'appdata'))
  const crashes = path.join(base, 'crashes')
  mkdirSync(crashes)
  app.setPath('crashDumps', crashes)
  app.on('window-all-closed', () => {})

  const epoch = randomUUID()
  const tokens = { chat: randomUUID(), report: randomUUID(), team: randomUUID() }
  const posts = []
  const dialogs = []
  const pendingResponses = []
  const results = []
  let proposals = []
  let snapshotEpoch = epoch
  let window
  let approvals
  let client
  let adapted = false
  let rendererReady = false
  let ending = false
  const reply = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.searchParams.get('token') === tokens.chat) {
      if (url.pathname === '/health') return reply(res, { ok: true, epoch })
      if (url.pathname === '/team') return reply(res, { team: false, epoch: snapshotEpoch, members: [], proposals })
      if (url.pathname === '/events') return // 长轮询由清理时关闭，不忙等也不注入事件。
    }
    if (req.method === 'POST' && ['/report-approval', '/approval'].includes(url.pathname)) {
      let text = ''
      for await (const chunk of req) text += chunk
      const credential = req.headers['x-dsh-approval-token']
      const tokenKind = Object.keys(tokens).find(key => tokens[key] === credential) ?? '未知'
      posts.push({ route: url.pathname, tokenKind, body: JSON.parse(text) })
      pendingResponses.push(() => reply(res, { ok: true, decision: JSON.parse(text).decision }))
      return
    }
    reply(res, { error: '测试服务拒绝未声明请求' }, 403)
  })

  const finish = () => {
    if (ending) return
    ending = true
    approvals?.dispose()
    client?.dispose()
    for (const item of dialogs) item.resolve({ response: 0 })
    pendingResponses.splice(0).forEach(done => done())
    server.closeAllConnections()
    server.close()
    app.exit(results.some(item => item.status === '失败' || item.status === '阻塞') ? 1 : 0)
  }
  process.on('message', message => {
    if (message === '停止测试') { results.push({ status: '失败', name: '测试被中止' }); finish() }
  })
  process.on('disconnect', finish)

  const record = (name, status, evidence) => {
    const entry = { name, status, diagnosticRead: adapted, evidence }
    results.push(entry)
    console.log(JSON.stringify(entry))
  }
  const until = async (predicate, description, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await predicate()
      if (value) return value
      await delay(25)
    }
    throw new Error(`等待超时：${description}`)
  }
  const cdp = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const screenshot = async name => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    const bytes = Buffer.from(data, 'base64')
    const image = nativeImage.createFromBuffer(bytes)
    assert.equal(image.isEmpty(), false, '必须产生实际浏览器截图')
    writeFileSync(path.join(base, `${name}.png`), bytes)
    return { size: image.getSize(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const htmlText = '<img src=x onerror="window.__approvalInjected=1"><script>window.__approvalInjected=2</script>'
  const content = `隔离日报开头\n${htmlText}\n` + Array.from({ length: 240 }, (_, i) => `第 ${i + 1} 行：今天完成本地审批测试，未连接任何云服务。`).join('\n') + '\n隔离日报末尾'
  const report = (id, overrides = {}) => ({
    kind: 'report', proposalId: id, reportId: '隔离日报', revision: 7,
    digest: createHash('sha256').update(content).digest('hex'), content, epoch,
    target: path.join(base, 'reports', '完整路径测试'.repeat(24), '隔离日报.md'),
    expiresAt: Date.now() + 300_000, state: 'pending', summary: '审批后写入隔离日报',
    tool: 'publish_report', risk: 'medium', ...overrides,
  })
  const open = async proposal => {
    approvals.clear()
    proposals = [proposal]
    assert.deepEqual(await approvals.request(proposal.proposalId), { ok: true })
    window = BrowserWindow.getAllWindows()[0]
    assert.ok(window, '真实审批窗口必须创建')
    await until(() => window.isVisible() && !window.webContents.isLoading(), '审批页面加载并登记')
    window.webContents.debugger.attach('1.3')
    await cdp('Page.enable')
    await until(() => evaluate('!!document.querySelector(".card, .card-empty-title")'), 'React 完成首次渲染')
    return proposal
  }
  const click = async (selector, count = 1) => {
    const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: count, ...point })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: count, ...point })
  }
  const caseRun = async (name, run, needsRenderer = false) => {
    if (needsRenderer && !rendererReady) return record(name, '阻塞', '真实读卡失败，不能声称完成按钮或全文验证')
    try { record(name, '通过', await run()) }
    catch (error) { record(name, '失败', error.message) }
    finally {
      dialogs.splice(0).forEach(item => item.resolve({ response: 0 }))
      pendingResponses.splice(0).forEach(done => done())
      approvals.clear()
    }
  }
  const decide = (proposalId, decision) => evaluate(`window.approvalCard.decide(${JSON.stringify(proposalId)},${JSON.stringify(decision)})`)
  const approveDialogs = () => dialogs.forEach(item => item.resolve({ response: 1 }))
  const assertPost = (post, proposalId, decision, route, tokenKind) => {
    assert.equal(post.route, route)
    assert.equal(post.tokenKind, tokenKind)
    assert.deepEqual(post.body, { proposalId, decision, epoch, windowId: window.webContents.id })
  }

  try {
    await app.whenReady()
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    // 页面只有本次临时构建的静态文件可加载，不访问真实用户文件或远程网络。
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const expected = new URL(`file:///${base.replaceAll('\\', '/')}/renderer/`).href
      callback({ cancel: !details.url.startsWith(expected) })
    })
    dialog.showMessageBox = async (...args) => new Promise(resolve => dialogs.push({ spec: args.at(-1), resolve }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const infoDir = path.join(process.env.DSH_HOME, 'personal-assistant')
    mkdirSync(infoDir, { recursive: true })
    writeFileSync(path.join(infoDir, 'bridge.json'), JSON.stringify({ port, token: tokens.chat, epoch }))
    writeFileSync(path.join(infoDir, 'bridge-approval.json'), JSON.stringify({ port, reportApprovalToken: tokens.report, approvalToken: tokens.team, epoch }))
    client = new BridgeClient()
    await client.connect({ onStatus() {}, onSessionEnded() {}, onEvent() {} })
    approvals = new ApprovalWindow(client)
    approvals.registerIpc()
    console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, fakeBridgePort: port }))

    await caseRun('真实首次读卡与浏览器渲染', async () => {
      const proposal = await open(report('baseline'))
      const pref = window.webContents.getLastWebPreferences()
      for (const key of ['contextIsolation', 'sandbox', 'webSecurity']) assert.equal(pref[key], true)
      for (const key of ['nodeIntegration', 'allowRunningInsecureContent', 'experimentalFeatures']) assert.equal(pref[key], false)
      assert.equal(pref.preload, path.join(base, 'preload/approval.cjs'))
      const actual = await evaluate('(async()=>({text:document.body.innerText,api:Object.keys(window.approvalCard),node:typeof require,pet:typeof window.petApi,view:await window.approvalCard.read()}))()')
      const image = await screenshot('baseline')
      console.log(JSON.stringify({ baseline: actual, screenshot: image, bounds: window.getBounds() }))
      assert.equal(actual.node, 'undefined')
      assert.equal(actual.pet, 'undefined')
      assert.deepEqual(actual.api.sort(), ['close', 'decide', 'onChanged', 'read'])
      assert.ok(actual.view, '真实 preload.read() 返回 null；窗口显示空卡')
      assert.equal(actual.view.proposalId, proposal.proposalId)
      assert.deepEqual(actual.view.report, { reportId: proposal.reportId, revision: proposal.revision, digest: proposal.digest, content })
      assert.ok(actual.text.includes('请确认这版日报'))
      rendererReady = true
      return { bounds: window.getBounds(), screenshot: image }
    })

    if (!rendererReady && process.env.REPORT_APPROVAL_DIAGNOSE_READ === '1') {
      // 仅测试读卡适配，不替换 decide、lookup、cardView、preload 或渲染器。
      // 仍调用真实 sender/URL/mainFrame 校验，诊断结果不计为真实读卡链路通过。
      ipcMain.removeHandler('approval-card-read')
      ipcMain.handle('approval-card-read', event => {
        const check = approvals.verify(event, proposals[0]?.proposalId ?? '')
        return check.ok ? approvals.view() : null
      })
      adapted = true
      await open(report('diagnostic-read'))
      rendererReady = await evaluate('!!document.querySelector(".card")')
      console.log(JSON.stringify({ diagnosticRead: true, rendererReady, warning: '基线失败仍保留；后续只是读卡适配后的诊断' }))
      approvals.clear()
    }

    await caseRun('长日报全文、滚动与固定批准按钮', async () => {
      const proposal = await open(report('long-report'))
      const read = await evaluate('window.approvalCard.read()')
      assert.equal(read.report.content, content)
      assert.equal(read.report.revision, 7)
      assert.equal(read.report.digest, proposal.digest)
      const before = await evaluate(`(() => {
        const scope=document.querySelector('.card-scope'), b=document.querySelector('.primary');
        const r=b.getBoundingClientRect();
        return {height:scope.clientHeight,scrollHeight:scope.scrollHeight,top:scope.scrollTop,
          button:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:[innerWidth,innerHeight],
          hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b,
          target:document.querySelector('.card-target').textContent,
          full:Array.from(document.querySelectorAll('.card-row')).find(x=>x.querySelector('dt').textContent==='日报全文').querySelector('dd').textContent,
          focused:document.activeElement.textContent}; })()`)
      assert.ok(before.height > 0 && before.scrollHeight > before.height)
      assert.equal(before.full, content)
      assert.equal(before.target, proposal.target)
      assert.equal(before.focused, '驳回')
      assert.ok(before.hit && before.button.y >= 0 && before.button.y + before.button.height <= before.viewport[1])
      const point = await evaluate(`(() => {const r=document.querySelector('.card-scope').getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()`)
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY: 800, ...point })
      await until(() => evaluate('document.querySelector(".card-scope").scrollTop > 0'), '真实滚轮推动内容')
      const top = await evaluate('document.querySelector(".card-scope").scrollTop')
      await evaluate('document.querySelector(".card-scope").scrollTop=1000000')
      const end = await evaluate(`(() => {const s=document.querySelector('.card-scope');return {top:s.scrollTop,max:s.scrollHeight-s.clientHeight,buttonY:document.querySelector('.primary').getBoundingClientRect().y};})()`)
      assert.ok(Math.abs(end.top - end.max) <= 1)
      assert.equal(end.buttonY, before.button.y)
      return { ...before, full: `${content.length} 字符，逐字相等`, wheelScrollTop: top, end, screenshot: await screenshot('long-report') }
    }, true)

    await caseRun('HTML 样文本不执行、不产生标签', async () => {
      await open(report('html-text'))
      const actual = await evaluate(`({injected:window.__approvalInjected??null,tags:document.querySelectorAll('#root img,#root script,#root iframe').length,text:document.querySelector('.card-scope').textContent.includes(${JSON.stringify(htmlText)})})`)
      assert.deepEqual(actual, { injected: null, tags: 0, text: true })
      return actual
    }, true)

    await caseRun('缺失绑定不可批准（真实决定 IPC）', async () => {
      const evidence = []
      for (const key of ['reportId', 'revision', 'digest', 'content', 'epoch', 'target', 'expiresAt']) {
        const proposal = report(`missing-${key}`)
        delete proposal[key]
        if (key === 'epoch') snapshotEpoch = undefined // 同时去掉合法的快照代次回退。
        await open(proposal)
        snapshotEpoch = epoch
        const before = posts.length
        const result = await decide(proposal.proposalId, 'approve')
        assert.equal(result.ok, false)
        assert.match(result.error, /绑定信息缺失/)
        assert.equal(posts.length, before)
        if (rendererReady) {
          assert.equal(await evaluate('document.querySelector(".primary").disabled'), true)
          assert.match(await evaluate('document.querySelector(".card-blocked").textContent'), /绑定信息缺失/)
        }
        evidence.push({ missing: key, result, posts: posts.length - before })
      }
      return evidence
    })

    await caseRun('旧 epoch 在发送前拒绝', async () => {
      const proposal = await open(report('old-epoch', { epoch: '旧代次' }))
      const before = posts.length
      const rejection = await decide(proposal.proposalId, 'reject')
      const approval = decide(proposal.proposalId, 'approve')
      await until(() => dialogs.length > 0, '日报原生确认调用')
      approveDialogs()
      const approved = await approval
      assert.equal(rejection.ok, false)
      assert.equal(approved.ok, false)
      assert.match(rejection.error, /会话已变化/)
      assert.match(approved.error, /会话已变化/)
      assert.equal(posts.length, before)
      return { rejection, approval: approved, posts: 0 }
    })

    for (const kind of ['report', 'team']) {
      for (const decision of ['reject', 'approve']) {
        await caseRun(`${kind === 'report' ? '日报' : '团队'}${decision === 'approve' ? '批准' : '驳回'}路由与独立令牌`, async () => {
          const proposal = await open(report(`${kind}-${decision}`, kind === 'team' ? { kind: 'team', tool: 'write_file', risk: 'low' } : {}))
          const before = posts.length
          const promise = decide(proposal.proposalId, decision)
          if (kind === 'report' && decision === 'approve') {
            await until(() => dialogs.length === 1, '原生确认接口')
            assert.equal(dialogs[0].spec.defaultId, 0)
            assert.equal(dialogs[0].spec.cancelId, 0)
            assert.ok(dialogs[0].spec.detail.includes(proposal.digest))
            assert.ok(dialogs[0].spec.detail.includes(proposal.target))
            approveDialogs()
          } else assert.equal(dialogs.length, 0)
          await until(() => posts.length > before, '审批 HTTP 请求')
          assert.equal(posts.length - before, 1)
          assertPost(posts.at(-1), proposal.proposalId, decision, kind === 'report' ? '/report-approval' : '/approval', kind)
          const evidence = posts.at(-1)
          // 成功会关闭窗口，先记录 HTTP；成功响应/关窗通过主进程状态验证。
          promise.catch(() => {})
          pendingResponses.splice(0).forEach(done => done())
          await until(() => window.isDestroyed(), '成功审批自动关闭窗口')
          return evidence
        })
      }
    }

    for (const decision of ['reject', 'approve']) {
      await caseRun(`真实按钮异步双击不双发：${decision === 'approve' ? '批准' : '驳回'}`, async () => {
        const proposal = await open(report(`double-click-${decision}`))
        const before = posts.length
        const selector = decision === 'approve' ? '.primary' : '.card-actions .card-btn:nth-child(2)'
        await click(selector)
        await until(() => evaluate('Array.from(document.querySelectorAll(".card-actions button")).every(b=>b.disabled)'), '按钮进入异步禁用态')
        await click(selector, 2)
        if (decision === 'approve') {
          assert.equal(dialogs.length, 1, '只应请求一次原生确认')
          approveDialogs()
        }
        await until(() => posts.length > before, '第一次按钮提交到 HTTP')
        await click(selector, 2)
        // HTTP 保持悬挂，给重复点击充分的 IPC/事件循环处理时间。
        await delay(120)
        assert.equal(posts.length - before, 1)
        assertPost(posts.at(-1), proposal.proposalId, decision, '/report-approval', 'report')
        pendingResponses.splice(0).forEach(done => done())
        await until(() => window.isDestroyed(), '异步请求成功后关窗')
        return { requests: posts.length - before, nativeDialogs: dialogs.length, pendingButtonsDisabled: true }
      }, true)
    }

    await caseRun('并发 preload 决定请求不双发（主进程防重）', async () => {
      const proposal = await open(report('concurrent-ipc'))
      const before = posts.length
      // 不直接调用私有 decide，走真实 contextBridge + ipcRenderer + 发送者校验。
      await evaluate(`window.__duplicates=Promise.all([window.approvalCard.decide(${JSON.stringify(proposal.proposalId)},'reject'),window.approvalCard.decide(${JSON.stringify(proposal.proposalId)},'reject')]); true`)
      await until(() => posts.length > before, '并发决定请求到达')
      await delay(120)
      const count = posts.length - before
      console.log(JSON.stringify({ concurrentIPC: posts.slice(before) }))
      assert.equal(count, 1, `同一提案并发 IPC 导致 ${count} 次 HTTP 请求`)
      return { requests: count }
    })
  } catch (error) {
    record('测试基础设施', '失败', error.stack ?? String(error))
  } finally {
    console.log(JSON.stringify({ summary: results.map(({ name, status, diagnosticRead }) => ({ name, status, diagnosticRead })), limitations: ['本地 bridge 是假的，未验证插件真实保存/停记录', '原生确认框仅验证参数，未绘制系统对话框', '截图随隔离目录清理；标准输出保留尺寸与 SHA-256'] }))
    finish()
  }
}
