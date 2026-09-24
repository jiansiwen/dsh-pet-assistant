# dsh-pet 在 macOS 上的兼容性评估

> 结论基于对 `dsh-pet/src`、`dsh-personal-assistant/src` 的逐处平台核查，外加本机实证实验。
> 所有判断都标了 `文件:行号`，可直接复核。

## 一句话结论

**能显示、能悬浮，而且悬浮能力在 macOS 上比 Windows 更强。**
但「宠物」里凡是**说话、听、录音**的部分都绑死在 Windows 上，需要改代码或补权限才能在 Mac 上用。

---

## 一、能正常悬浮（零改动，开箱可用）

窗口层的创建代码（`dsh-pet/src/main/index.ts:134-158`）用的全是跨平台 API：

| 能力 | 调用 | macOS 支持 |
|---|---|---|
| 透明无边框 | `transparent: true, frame: false` | 支持 |
| 置顶 | `setAlwaysOnTop(true, 'screen-saver')` | 支持（`screen-saver` 层级 macOS 有）|
| 鼠标穿透 | `setIgnoreMouseEvents(true, { forward: true })` | **支持**（`forward` 官方标注 *macOS* *Windows*）|
| 全桌面可见 | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` | **仅 macOS/Linux 有效** |
| 角色拖拽 | 渲染层 `mousemove` + `mouseState` IPC（`App.tsx:616-641`）| 支持 |
| 帧序列动画 | CSS `@keyframes` + `<img>` 序列帧 | 支持 |
| 托盘 | `Tray` + `nativeImage` | 支持 |

### 关键点：macOS 上的悬浮反而更好

`win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`（`index.ts:157`）
**在 Windows 上是空操作**（官方文档原话："This API does nothing on Windows"），
但在 macOS 上真生效 —— 意味着：

- 切到别的桌面（Space），宠物**跟着过去**
- 别的应用全屏时，宠物**仍在最上层**

这是你在 Windows 上拿不到的效果。

### 一个容易误判的点

`screen.screenToDipPoint`（`index.ts:77`）官方标注只支持 *Windows* *Linux*，**macOS 不在列表**。
但它只在 `pointerWatcher` 的回调里被调用，而 `pointerWatcher.start()` 在非 win32 会**提前 return**
（`pointer-watch.ts:93-96`）→ 回调永不触发 → **不会踩到这个坑**。属于"已被早退保护"。

---

## 二、需要改代码 / 补权限（可运行但降级）

### 1. 麦克风：必须补 Info.plist（否则直接崩，不是"没反应"）

macOS 10.14+ 起，访问麦克风**必须**在 Info.plist 里声明 `NSMicrophoneUsageDescription`，
否则应用在调用 `getUserMedia` 时会被系统**直接终止**（不是返回错误，是 crash）。

受影响功能：按键听写（`dictation.ts:220`）、会议录音（`meeting-panel.tsx:102`）。

项目目前**没有打包配置**（无 `electron-builder.yml`、`package.json` 里也没有 `build` 字段），
所以是开发态运行 —— 这一条取决于你用什么方式启动 Electron。

### 2. 鼠标监听辅助进程：非 Windows 直接报错

`pointer-watch.ts:93-96`：

```ts
if (platform() !== 'win32') {
  this.report('鼠标监听仅支持 Windows。')
  return
}
```

它跑的是 `assets/pointer-watch.ps1`（Windows 低级鼠标钩子）。

**影响范围有限**，别误判成"穿透坏了"：

- **穿透本身照常工作** —— 判定完全在渲染层（`stage-layout.ts:201` 的 `hitTest` +
  `App.tsx:616-641` 的 `mouseState` IPC），不经过 PowerShell
- 失效的只是**"点击面板外面自动收起面板"**（`index.ts:75-91` 的 overlay dismiss）
- 副作用：会往界面推一条 toast「鼠标监听仅支持 Windows。」

**绕过办法**：收起面板改用 `Esc` 或点面板上的关闭按钮。

### 3. 托盘单击显示/隐藏：macOS 上很可能失效

`companion-host.ts:454-457` 建托盘后立刻调了 `rebuildTray()` → `setContextMenu(...)`。
macOS 上一旦设了右键菜单，点击托盘图标会**直接弹出菜单**，
官方文档明确写了同类事件（`mouse-up`）"will not be emitted if you have set a context menu"。

**绕过办法**：菜单里已经有「隐藏角色 / 显示角色」项（`companion-host.ts:474-478`），
右键点开就能用 —— 功能不缺，只是少了一个"单击"的快捷方式。

### 4. 托盘图标在 macOS 上会显得"脏"

`companion-host.ts:450-453` 用 `assets/pets/panda.png` 缩到 16×16。
macOS 期望的是 **Template Image**（文件名以 `Template` 结尾，16×16 + 32×32@2x），
否则不会跟随浅色/深色菜单栏自动反色。彩色熊猫图标能显示，但在深色菜单栏上会不协调。

### 5. 全局快捷键：`Ctrl+Alt+P`

`index.ts:1386` 用的是 `CommandOrControl+Alt+P`，macOS 上映射成 `Ctrl+Option+P`。
能注册，但 macOS 上更习惯用 `Cmd`。属于体验问题，不是故障。

### 6. Dock 图标不会隐藏

窗口设了 `skipTaskbar: true`（`index.ts:146`），但这是 Windows/Linux 的语义。
macOS 上要隐藏 Dock 图标得调 `app.dock.hide()`，代码里没有 → **Dock 里会多一个图标**。
对"桌面宠物"这种常驻形态来说略显突兀。

---

## 三、完全不可用（无替代实现）

### 1. 本地语音识别

两条路都是 Windows-only：

- **流式**（`asr.ts:71-98`）：`import sherpa from 'sherpa-onnx-node'` —— 原生模块本身跨平台
- **整句 SenseVoice**（`asr.ts:248-263`）：调用 `local-asr/bin/sherpa-onnx-offline.exe` —— **`.exe`**
- **兜底**（`asr.ts:265-286`）：spawn `powershell` 跑 `asr-wave.ps1`（Windows `System.Speech`）
- **模型安装**（`scripts/setup-local-asr.ps1:21`）：下载的是
  `sherpa-onnx-v1.13.7-**win-x64**-static-MD-Release-no-tts.tar.bz2`

> ⚠️ **实证**：我在本机把 `os.platform()` 伪造成 `darwin` 后 `require('sherpa-onnx-node')`，
> 得到的是：
> ```
> Could not find sherpa-onnx-node. Tried
>   ./node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node
> ```
> 这只证明"Windows 机器上没有 darwin 二进制"（显然）。
> **如果你在 Mac 上全新 `pnpm install`**，`sherpa-onnx-node` 的 `optionalDependencies`
> 里有 `sherpa-onnx-darwin-arm64` / `-darwin-x64`，pnpm 会按平台装上 → **原生模块其实能加载**。
>
> 真正卡死的是**外围管路**：取模型的脚本是 PowerShell、下的是 win-x64 包、
> 可用性检查写死了 `.exe`（`asr.ts:47`）。所以结论不变：**开箱不可用**。

### 2. TTS 朗读与离线回退

`play.ps1` 用 `winmm.dll` 的 MCI 播放（`play.ps1:22`），`speak-once.ps1` 用
`System.Speech`（`speak-once.ps1:12-13`）—— 都是 Windows 专有。

edge-tts 的**合成**部分（`edge-tts.ts`）是纯 HTTP，本身能跑；
但**播放**这一步没有 macOS 实现 → 朗读整条链路不通。

### 3. 会议录音加密落盘

`dpapi.ts:105-106`：

```ts
if (platform !== 'win32') return { status: 'unsupported' }
```

密钥用 Windows DPAPI 保护。拿不到密钥时 `meeting-store.ts:160` 会**拒绝 startMeeting**
（"会议录制依赖 Windows DPAPI 保护密钥，当前系统不支持。"）—— 这个设计是对的：
录了却加密不了，等于把参会者的话明文留在磁盘上。

### 4. 活动采集（插件侧）

`dsh-personal-assistant` 的采样器同样是 PowerShell（`sampler.ts:82-84` 的 `sampler.ps1`，
采 Windows 前台窗口）。`captureActivity` 默认 `true`（`config.ts:105`），
但在 macOS 上这个子进程起不来 → 采集不可用。

---

## 四、⚠️ 迁移时的两个硬坑

### 1. 不要在 Mac 上直接拷贝 Windows 的 `node_modules`

里面有 `sherpa-onnx-win-x64`、`koffi-win32-x64`、`@napi-rs/canvas-win32-x64-msvc`、
`@img/sharp-win32-x64`、`node-addon-require-builtin-win32-x64-msvc` 等一堆 **win32 原生二进制**。
必须在 Mac 上重新 `pnpm install`。

### 2. 好消息：`pnpm install` 本身不会因平台字段报错

我实测了你的 pnpm 10.32.1：在 Windows 上装一个 `os: ["darwin"]` 的**直接依赖**，
pnpm **不报错、照常装**（实测 `fsevents` 成功安装，exit 0）。

所以 `package.json:21` 那个 `"sherpa-onnx-win-x64": "^1.13.7"` 不会挡住 Mac 上的安装 ——
它只会装一个用不上的 win 二进制在那儿。真正的失败发生在 **`require()` 时**（见上文实证）。

---

## 五、建议的改造清单（按性价比排序）

| 优先级 | 改动 | 工作量 |
|---|---|---|
| P0 | 补 `NSMicrophoneUsageDescription` + 麦克风 entitlement | 小 |
| P0 | 把 3 个 `.ps1` 音频脚本换成跨平台实现（Node 播放库 / `afplay`）| 中 |
| P1 | `pointer-watch` 加 macOS 实现（或优雅降级：不报 toast）| 中 |
| P1 | 托盘图标出 `Template` 版，并 `app.dock.hide()` | 小 |
| P1 | ASR 模型安装脚本补 macOS 分支（下 `darwin-arm64` 包）| 中 |
| P2 | 会议密钥改用 macOS Keychain（`safeStorage` 已经是跨平台的，可直接替代 DPAPI）| 中 |
| P2 | 插件侧活动采集补 macOS（AppleScript / `osascript` 取前台窗口）| 中 |

> 顺带一提：`meeting-store.ts` 用的 `node:sqlite` 是 Node 22 内置的，跨平台；
> `safeStorage`（Electron 内置）在 macOS 走 Keychain —— 这两处不用改，替换 DPAPI 时可直接用。

---

## 附：本次核查用到的实证手段

1. **平台伪造实验** —— 覆写 `os.platform()` 后 `require`，看真实报错路径
   （`dsh-pet/_simulate-mac.cjs`）
2. **pnpm 行为实验** —— 在 win32 上装 `os:["darwin"]` 的直接依赖，验证是否报错
3. **Electron 官方文档核对** —— `setIgnoreMouseEvents` 的 `forward` 选项、
   `setVisibleOnAllWorkspaces` 的平台标注、`Tray` 的 macOS 注意事项
4. **原生模块布局核查** —— 确认 `.pnpm` 下只有 `sherpa-onnx-win-x64`
