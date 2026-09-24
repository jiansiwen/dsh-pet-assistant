import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(path.join(tmpdir(), 'dsh-overlay-'))
for (const dir of ['main', 'preload', 'renderer', 'home']) await mkdir(path.join(output, dir))
await symlink(path.join(root, 'assets'), path.join(output, 'assets'), 'junction')
const fixture = `
const state = {
 sessionId:'test-session',bindingId:'test-binding',cursor:1,title:'桌面会话验证',status:'idle',hasMore:false,
 entries:[{id:'hello',seq:1,role:'assistant',kind:'text',text:'这里与原生 dsh 共享会话。拖动宠物时，对话会留在它的头顶。'}],
 model:{provider:'fixture',model:'model-a',label:'验证模型 A'},
 models:[{provider:'fixture',model:'model-a',label:'验证模型 A'},{provider:'fixture',model:'model-b',label:'验证模型 B'}],
 permissions:[{value:'workspace-write',label:'工作区写入'},{value:'read-only',label:'只读'}],permission:'workspace-write',
 capabilities:{prompt:true,cancel:true,models:true,permissions:true,history:true}
};
let callbacks;
globalThis.overlayFixture={state,calls:[],emit(status,entries=[]){state.status=status;state.cursor++;callbacks.onEvent({type:'session/update',payload:{...state,entries}})}};
export class BridgeClient {
 async connect(cb){ callbacks=cb; cb.onStatus('connected'); cb.onEvent({type:'session/update',payload:{...state,reset:true}}) }
 async getSession(){return {ok:true,state:structuredClone(state)}}
 async sessionCommand(command){
  globalThis.overlayFixture.calls.push(command);
  if(command.kind==='model') state.model=state.models.find(m=>m.model===command.model);
  if(command.kind==='permission') state.permission=command.value;
  if(command.kind==='prompt') {state.status='running';state.entries.push({id:'user-'+(++state.cursor),seq:state.cursor,role:'user',kind:'text',text:command.text})}
  if(command.kind==='cancel') state.status='idle';
  state.cursor++;
  callbacks.onEvent({type:'session/update',payload:{...state,entries:[...state.entries]}});
  return {ok:true};
 }
 async getTeam(){return {team:false,members:[],tasks:[],proposals:[]}}
 async chat(){return {ok:true,reply:'验证回答'}}
 async reportPetState(){} async respondProactive(){} dispose(){}
}
export const readBridgeInfo=()=>null;
export const readApprovalCredential=()=>null;
export const probeHealth=async()=>null;
`
const overrides = {
  'harness.ts': fixture,
  'wake.ts': 'export function startWakeListener(){} export function stopWakeListener(){}',
  'tts.ts': `export class Narrator { constructor(){} dispose(){} isSpeaking(){return false} interrupt(){} interruptedContext(){return ''} beginRound(){} generationStarted(){} generationEnded(){} feed(){} feedEnd(){} dropFeed(){} speak(){} resumeFrom(){return 0} } export function spawnTtsEdgeWorker(){throw new Error('验证不得启动语音进程')}`,
  'companion-host.ts': `export class CompanionHost { constructor(callbacks){this.callbacks=callbacks} start(){} noteBridgeChange(){} setStageVisible(value){this.callbacks.onStageVisible(value)} async startRuntime(){throw new Error('验证不得启动用户运行时')} async stopOwnRuntime(){} async shutdown(){} async stop(){} dispose(){} }`,
}
await build({
  entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(output, 'main/index.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22',
  plugins: [{ name: 'isolated-runtime', setup(builder) {
    builder.onLoad({ filter: /src[\\/]main[\\/](harness|wake|tts|companion-host)\.ts$/ }, args => ({ contents: overrides[path.basename(args.path)], loader: 'ts' }))
  } }],
})
await build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(output, 'preload/index.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: [path.join(root, 'src/renderer/main.tsx')], outfile: path.join(output, 'renderer/main.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } })
for (const file of ['index.html', 'styles.css']) await writeFile(path.join(output, 'renderer', file), await readFile(path.join(root, 'src/renderer', file)))
await symlink(path.join(root, 'node_modules'), path.join(output, 'node_modules'), 'junction')

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const relative = pathname === '/' ? 'renderer/index.html' : pathname.slice(1)
    const file = path.resolve(output, relative)
    if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return }
    const extensions = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }
    response.setHeader('Content-Type', extensions[path.extname(file)] ?? 'application/octet-stream')
    response.end(await readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
console.log('本地开发预览：', `http://127.0.0.1:${server.address().port}/renderer/index.html`)

const receiver = path.join(output, 'receiver.cjs')
await writeFile(receiver, `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');
let clickCount=0;
const statusFile=${JSON.stringify(path.join(output, 'receiver-status.json'))};
const report=()=>fs.writeFileSync(statusFile,JSON.stringify({ready:true,clicks:clickCount}));
fs.writeFileSync(statusFile,JSON.stringify({ready:false,phase:'started'}));
process.on('uncaughtException',error=>fs.writeFileSync(statusFile,JSON.stringify({ready:false,error:String(error)})));
app.setPath('userData',${JSON.stringify(path.join(output, 'receiver-profile'))});
app.whenReady().then(async()=>{
 fs.writeFileSync(statusFile,JSON.stringify({ready:false,phase:'app-ready'}));
 const window=new BrowserWindow({title:'dsh-overlay-click-receiver',x:40,y:60,width:340,height:210,webPreferences:{nodeIntegration:true,contextIsolation:false}});
 ipcMain.on('clicked',()=>{clickCount++;report()});
 await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify('<body style="margin:0;background:#e6ecef;font:16px Microsoft YaHei"><button style="width:100vw;height:100vh" onclick="require(\'electron\').ipcRenderer.send(\'clicked\')">隔离点击接收窗口</button></body>')}));
 window.setAlwaysOnTop(true); window.show(); window.focus(); report();
 fs.writeFileSync(${JSON.stringify(path.join(output, 'receiver.png'))},(await window.webContents.capturePage()).toPNG());
 window.webContents.on('console-message',event=>fs.appendFileSync(${JSON.stringify(path.join(output, 'receiver-console.txt'))},event.message+'\\n'));
});
setTimeout(()=>app.exit(0),120000);
`)
const clickScript = path.join(output, 'click.ps1')
await writeFile(clickScript, `param([int]$X, [int]$Y)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshTestClick {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
 [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$Old = New-Object DshTestClick+Point
[DshTestClick]::GetCursorPos([ref]$Old) | Out-Null
try {
 if (-not [DshTestClick]::SetCursorPos($X,$Y)) { throw ('SetCursorPos failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
 Start-Sleep -Milliseconds 200
 $Point = New-Object DshTestClick+Point
 [DshTestClick]::GetCursorPos([ref]$Point) | Out-Null
 $OwnerPid = [uint32]0
 [DshTestClick]::GetWindowThreadProcessId([DshTestClick]::WindowFromPoint($Point),[ref]$OwnerPid) | Out-Null
 Write-Output ("point="+$Point.X+","+$Point.Y+" owner="+$OwnerPid)
 [DshTestClick]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [DshTestClick]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 50
} finally { [DshTestClick]::SetCursorPos($Old.X,$Old.Y) | Out-Null }
`)
const runner = path.join(output, 'runner.cjs')
await writeFile(runner, `
const {app,BrowserWindow,Menu,screen}=require('electron');
const fs=require('node:fs'),{spawn}=require('node:child_process');
app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});
const reports={}; let contextMenu,receiver,clicks=0,receiverReady=false;
const originalMenu=Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate=(template)=>{contextMenu=originalMenu(template);return contextMenu};
const until=async(fn,label)=>{const start=Date.now();while(!await fn()){if(Date.now()-start>18000)throw new Error(label+'等待超时');await new Promise(r=>setTimeout(r,40))}};
const assert=(ok,label)=>{if(!ok)throw new Error(label);reports[label]=true};
async function run(){
 await import(${JSON.stringify(new URL('file:///' + path.join(output, 'main/index.mjs').replaceAll('\\', '/')).href)});
 await until(()=>BrowserWindow.getAllWindows().length,'主窗口');
 const win=BrowserWindow.getAllWindows()[0],wc=win.webContents;
 await until(()=>wc.executeJavaScript('!!window.petApi && !!document.querySelector(".character-slot")').catch(()=>false),'真实渲染器');
 wc.on('console-message',event=>{if(event.level>=2)console.error('渲染器：',event.message)});
 const evaluate=async code=>{try{return await wc.executeJavaScript(code,true)}catch(error){console.error('失败片段：',code);throw error}};
 const rect=selector=>evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})()');
 const click=async(selector,button='left')=>{const r=await rect(selector);const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);wc.sendInputEvent({type:'mouseDown',x,y,button,clickCount:1});wc.sendInputEvent({type:'mouseUp',x,y,button,clickCount:1})};
 await click('.character-slot');
 await until(()=>evaluate('!!document.querySelector(".chat-hud")'),'左键展开');
 await until(()=>evaluate('document.querySelector(".hud-status").textContent.includes("同步")'),'会话基线');
 assert(!(await evaluate('document.querySelector(".chat-hud").textContent.includes("睡眠")')),'头顶会话不混入设置');
 const pet=await rect('.character-slot'),hud=await rect('.chat-hud');
 assert(Math.abs(hud.bottom+8-pet.y)<2,'头顶初始锚点');
 global.overlayFixture.emit('running');
 await until(()=>evaluate('document.querySelector(".hud-status").textContent.includes("回复")'),'测试几何期间锁定');
 const drag=async(x,y)=>{win.focus();await evaluate('(()=>{const slot=document.querySelector(".character-slot"),r=slot.getBoundingClientRect();slot.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,clientX:r.x+75,clientY:r.y+75}));window.dispatchEvent(new MouseEvent("mousemove",{clientX:'+x+',clientY:'+y+'}));})()');await new Promise(r=>setTimeout(r,100));await evaluate('window.dispatchEvent(new MouseEvent("mouseup",{button:0,clientX:'+x+',clientY:'+y+'}))');await new Promise(r=>setTimeout(r,50));};
 await drag(600,250);
 await until(async()=>{const p=await rect('.character-slot'),h=await rect('.chat-hud');return Math.abs(h.bottom+8-p.y)<2},'拖动跟随');
 reports['拖动跟随']=true;
 await drag(600,80);
 await until(async()=>{const h=await rect('.chat-hud');return h.y<0},'顶部裁切'); reports['允许顶部出屏裁切']=true;
 await drag(650,Math.round(screen.getPrimaryDisplay().workArea.height-100));
 await evaluate('(()=>{const m=document.querySelector("select[aria-label=会话模型]");m.value=JSON.stringify(["fixture","model-b"]);m.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await until(()=>global.overlayFixture.state.model.model==='model-b','模型操作');reports['模型选择经真实IPC']=true;
 await evaluate('(()=>{const p=document.querySelector("select[aria-label=会话权限]");p.value="read-only";p.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await until(()=>global.overlayFixture.state.permission==='read-only','权限操作');reports['权限选择经真实IPC']=true;
 await evaluate('(()=>{const t=document.querySelector(".hud-composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,"验证中文输入");t.dispatchEvent(new Event("input",{bubbles:true}));t.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}))})()');
 assert(global.overlayFixture.calls.filter(c=>c.kind==='prompt').length===0,'中文输入法Enter不误发送');
 await until(()=>evaluate('!!document.querySelector("[aria-label=加入消息队列]")'),'输入状态提交');
 await click('[aria-label="加入消息队列"]');
 await until(()=>global.overlayFixture.calls.some(c=>c.kind==='prompt'),'发送');reports['发送经真实preload和IPC']=true;
 global.overlayFixture.state.entries.push({id:'think',seq:100,role:'assistant',kind:'think',text:'验证工具和思考可以展开，不占据整屏。'},{id:'tool',seq:101,role:'assistant',kind:'tool',name:'读取文件',text:'测试目录',result:'只读验证成功'});
 global.overlayFixture.state.cursor=102;
 global.overlayFixture.emit('running',global.overlayFixture.state.entries.slice(-2));
 await until(()=>evaluate('document.querySelectorAll(".hud-process").length===2'),'思考与工具条目');
 reports['思考与工具结果可展开']=true;
 // 测试截图使用自己的背景，不读取其他应用画面。
 for(const [name,color] of [['dark','#17222b'],['light','#edf2f5']]){
  await evaluate('document.body.style.background='+JSON.stringify(color));
  await new Promise(r=>setTimeout(r,100));
  fs.writeFileSync(${JSON.stringify(output)}+'/'+name+'.png',(await wc.capturePage()).toPNG());
 }
 await evaluate('document.body.style.background="transparent"');
 if (!${JSON.stringify(process.argv.includes('--renderer-only'))}) {
 receiver=spawn(process.execPath,[${JSON.stringify(receiver)}],{env:{...process.env},stdio:['pipe','pipe','pipe']});
 receiver.on('error',error=>console.error('接收器启动失败',error));
 receiver.on('exit',(code,signal)=>console.log('接收器退出',code,signal));
 console.log('接收器进程',receiver.pid,process.execPath);
 receiver.stderr.on('data',chunk=>console.error('隔离接收器：',String(chunk)));
 const receiverStatus=()=>{try{return JSON.parse(fs.readFileSync(${JSON.stringify(path.join(output, 'receiver-status.json'))},'utf8'))}catch{return {ready:false,clicks:0}}};
 await until(()=>receiverStatus().ready,'隔离外部窗口');
 const point=screen.dipToScreenPoint({x:180,y:150});
 const nativeClick=()=>new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',${JSON.stringify(clickScript)},'-X',String(point.x),'-Y',String(point.y)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stdout.on('data',x=>console.log('原生点击',String(x)));child.stderr.on('data',x=>error+=x);child.on('error',reject);child.on('exit',n=>n===0?resolve():reject(new Error(error)));
 });
 await nativeClick(); await until(()=>receiverStatus().clicks>=1,'工作期间点击穿透');
 assert(await evaluate('!!document.querySelector(".chat-hud")'),'运行中切外部应用仍悬浮');
 global.overlayFixture.emit('idle');
 await until(()=>evaluate('document.querySelector(".hud-status")?.textContent.includes("同步")'),'回复完成');
 assert(await evaluate('!!document.querySelector(".chat-hud")'),'完成后先保留回复');
 await nativeClick();await until(()=>receiverStatus().clicks>=2,'空闲点击穿透');
 await until(()=>evaluate('!document.querySelector(".chat-hud")'),'完成后下一次外部点击收起');
 reports['完成后下一次外部点击收起']=true;
 assert(await evaluate('!!document.querySelector(".character-slot")'),'收起后宠物仍在');
 } else {
   console.log('仅界面模式：未验证原生鼠标点击、跨应用收起、真实桌面置顶。');
   global.overlayFixture.emit('idle');
 }
 win.focus();
 await click('.character-slot','right');await until(()=>contextMenu?.items.some(item=>item.label==='宠物设置'),'右键菜单');
 assert(['宠物设置','团队管理','文档管理','会议','日报文件夹'].every(label=>contextMenu.items.some(item=>item.label===label)),'右键集中管理入口');
 contextMenu.closePopup(win);contextMenu.items.find(item=>item.label==='宠物设置').click();
 await until(()=>evaluate('!!document.querySelector(".pet-management")'),'设置面板');
 reports['右键打开独立设置面板']=true;
 await until(()=>evaluate('document.querySelector(".voice-api-settings")?.getAttribute("aria-busy")==="false"'),'语音设置初始化');
 fs.writeFileSync(${JSON.stringify(output)}+'/settings.png',(await wc.capturePage()).toPNG());
 console.log(JSON.stringify(reports,null,2));
 fs.writeFileSync(${JSON.stringify(output)}+'/report.json',JSON.stringify(reports,null,2));
}
run().then(()=>{receiver?.kill();app.exit(0)},error=>{console.error(error,JSON.stringify(reports));fs.writeFileSync(${JSON.stringify(output)}+'/failed.json',JSON.stringify({error:String(error),reports},null,2));receiver?.kill();app.exit(1)});
`)
const environment = { ...process.env, DSH_HOME: path.join(output, 'home') }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [runner], { env: environment, stdio: 'inherit' })
const timeout = setTimeout(() => child.kill(), 120_000)
try { process.exitCode = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1))) }
finally { clearTimeout(timeout); server.close(); console.log('验证产物：', output) }
