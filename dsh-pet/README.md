# dsh-pet 桌面助理团

DeepSeek Harness 的桌面客户端 —— 配合 [dsh-personal-assistant](../dsh-personal-assistant/README.md) 插件，把一支专家助理团放到桌面上：能说话、能听唤醒词、能讲解你授权的文档，也把任务和审批画在你看得见的地方。

> 这是独立的 Electron 应用，**不是 dsh 插件**，不能通过 `dsh plugin add` 安装。
> 先安装 `dsh-personal-assistant` 插件，再按本文档运行桌宠。
>
> **素材许可**：`assets/` 下的动画帧、角色图片、生成提示词与源视频采用 CC BY-NC 4.0：
> 允许非商业使用、修改与分发，**禁止商业使用**，需署名。全文见 [ASSETS-LICENSE.md](./ASSETS-LICENSE.md)。
> 代码（`src/`、`scripts/` 等）采用 MIT。

## 功能

**角色与舞台**

- **多角色舞台**：编制里最多五席 —— 总助理（总助理）、助理1、助理2、助理3、助理4。默认启用三人（一个总助理 + 两位专家），改插件配置里的 `teamSeats` 再重启即可增减
- 每个角色可右键「换个形象」，目前有三套占位皮肤（国宝熊猫、眼镜女生 Q 版、眼镜男生 Q 版），选择按角色记住、重启后还在
- 角色空闲时会自发闲聊；凑够人数还会开四人麻将、五人开黑这类群体场景。任务一派下来，牌桌上的角色立刻站起来回座位
- 窗口透明置顶、可拖拽、位置记忆，不挡其他窗口的操作
- **漩涡退场动画**：会话关闭或手动退出时，身后展开漩涡通道 → 挥手告别 → 转身跳入 → 通道消散（约 4.3s）

**说话与听**

- **语音唤醒**：喊「小潘同学」把角色唤回来并弹出输入框，角色隐藏时也管用（纯本地，不上传）。
  喊两遍是刻意的 —— 单个「小潘」只有两个音节，日常对话里太容易误触发；
  四个音节既能明显降低误触发，说起来也不费劲。
  - Windows：默认用系统 `System.Speech`，也可在设置里切换为 sherpa KWS；
  - macOS：只能使用 sherpa KWS。默认**关闭**（开启后会持续占用麦克风），且目前属于**实验性**能力，
    未做 Mac 真机和噪声环境验收；需要先用 `bash scripts/setup-local-asr.sh` 安装唤醒模型，
    再到「右键宠物 → 宠物设置 → 常驻与语音」开启；
  - Linux：暂不提供唤醒，使用快捷键或点角色代替
  - 唤醒应答走**本地缓存 + 常驻播放进程**：启动时预热固定话术，喊完立即出声。
    Windows 上常驻进程只在启动时编译一次 MCI，不必每次唤醒都等 PowerShell 冷启动（约 2.5 秒）；
    缓存未命中时才临时合成，常驻进程不可用时自动回退到一次性播放
- **按键听写**：说话录音在窗口里完成，说完自动停。识别走**进程内**解码（不 spawn 任何外部程序），
  所以模型装好后三个平台都能用：
  - Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-asr.ps1`
  - macOS / Linux：`bash scripts/setup-local-asr.sh`
  - 模型落到 `%APPDATA%\dsh-pet\local-asr`（macOS 为 `~/Library/Application Support/dsh-pet/local-asr`），
    新装约 300—350MB；若保留旧的 `streaming` 目录会更多。装好后识别**完全离线**
  - 实时上屏用纯中文 14M Zipformer（`streaming-zh-14m`），整句精修用 SenseVoice；旧安装里的
    `streaming` 目录仍兼容作过渡回退，但重跑安装脚本会安装准确率更高的 `streaming-zh-14m`
  - Zipformer 是真正的增量流式模型；SenseVoice 是整句模型，负责录音结束后的高准确率精修，
    不是实时识别器
  - Windows 上没装模型时还会回退系统自带的 `System.Speech` 引擎（能用但准确率有限）；
    macOS/Linux 没有这个兜底，模型缺失时听写不可用
  - 录音与识别只在本机处理，不上传任何音频
- **回答朗读**：语音发起的那一轮会把回答念出来；打字问的**不出声**（突然出声是用户没要求过的行为）。
  声音是微软 edge-tts 神经语音（默认「晓晓」，免费无需密钥）；**断网时自动回退本机合成**（音色机械但照常说话）。
  - Windows 用 PowerShell 的 MCI 播放，macOS 用系统自带的 `afplay` / `say`；**Linux 未实现**
  - 这一步会把要念的**文字**发到微软的合成服务；不接受的话拔网线用，回退路径不联网
- **打断**：朗读时界面出现「正在朗读」横条，点停止立刻闭嘴，排队的句子一起丢掉。打断后再问，交给模型的上下文只包含**实际念出来的那一半**。
  另有实验开关「外放插话」：打开后朗读改由界面 WebAudio 播放以取得回声参考，用户说
  「停一下 / 等等 / 打断一下」等明确口令时停止播报；当前仍是指令词式，不是任意开口即断，
  真实会场外放仍需实测

**面板（三页）**

- **对话**：与助理团说话，讲解正文和一句话提示都铺在这里
- **团队**：待批提案、任务、成员三块。**这一页不能签发批准** —— 它只能请主进程打开专用审批窗口，决定在那个窗口里做
- **文档**：授权目录管理、讲解提纲与进度、重名文件挑选

**文档讲解**

- 说「打开某某文档」用系统关联的应用打开它；说「讲讲某某文档」先报一句范围（共几段、大约几分钟），再逐段讲
- 讲解只带**当前那一段**的原文给模型，不反复塞整份文档
- 可以指着某一段追问，回答会带上那一段原文
- 回答分三部分标明：【原文】【解释】【补充】（文档之外的知识）
- 文档改动后旧的朗读定位失效，会提示重新从头算

**托盘**

- 隐藏 / 显示角色（截图、投屏、录屏用）
- 专注模式：角色还在，但不闲聊、不开牌局、不听唤醒词
- 启动助理团队（列出此刻真具备条件的 profile）、停止自有运行时
- 托盘常驻：隐藏角色后仍保留唤醒监听与启动入口
- 重新监听唤醒词

## 架构

```
dsh-pet (Electron)
 ├─ CompanionHost：托盘、运行时启停、握手状态机
 │   └─ runtime-launch：附着已有运行时，或 spawn `dsh --profile <name>`
 └─ BridgeClient：读 ~/.dsh/personal-assistant/bridge.json
     └─ HTTP 长轮询 ↔ dsh-personal-assistant 插件（运行在宿主 dsh 会话内）
         └─ agent.followup 注入会话 → 同一份历史 / 模型 / 凭据
```

壳**不保存** API 密钥与模型配置，凭据由 dsh 统一管理。运行时可以是用户自己起的（壳只附着），也可以是壳起的（壳记录所有权，退出时只停自己起的那个，绝不误杀用户的 dsh）。

只要还有活着的运行时就绝不启动第二个：`/health` 一时不通不等于运行时没了，再起一个会有两个进程抢同一份 `bridge.json` 与同一个采样器，现象是"角色自己重影了"。

桥接消失（web 服务停止 / 会话被销毁）时，角色播完退场动画后自动退出。

## 动画素材与播放

- 动作动画为 **24fps 透明 WebM**（VP9 alpha），放在 `assets/pets/webm/panda/`；动作切换由双 `<video>` 交叉淡入完成。
- 逐帧 PNG 只保留 `walk-stop` 的三帧作为 0.3 秒收步过渡；其余动作不再逐帧加载，素材体积从约 128MB 降到约 11MB。
- 循环动作交给 `video.loop`；一次性动作（`drop`、`sleep-in/out`、`laptop-in/out`、`walk-stop`）由 `ended` 事件驱动状态机。
- 素材许可见 [ASSETS-LICENSE.md](./ASSETS-LICENSE.md)（CC BY-NC 4.0，禁止商业使用）。

## 前置条件

1. 已安装 Node.js ≥ 22
2. 插件已装到某个 profile，且该 profile 有团队覆盖层（托盘的「启动助理团队」只列出真具备条件的）
3. 凭据沿用 dsh 已有配置（`~/.dsh/.credentials.yaml`），无需额外配置
4. 语音相关功能：装本地识别模型（Windows 见下；macOS/Linux 跑 `bash scripts/setup-local-asr.sh`）

## 平台支持

窗口层（透明、置顶、鼠标穿透、拖拽、动画、托盘）在三个系统上都可用。
**「说话与听」这一块按平台分档** —— 差异都收在 `src/main/platform.ts` 一处。

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 角色显示 / 悬浮 / 拖拽 | ✅ | ✅ | ✅ |
| 跟随切换桌面、浮在全屏之上 | ❌（系统限制） | ✅ | ✅ |
| 托盘显示/隐藏角色 | ✅ 单击 | ✅ 右键菜单 | ✅ 单击 |
| 面板分页 / 文档讲解 / 团队状态 | ✅ | ✅ | ✅ |
| 麦克风听写（按键说话） | ✅ | ✅ 需授权 | ✅ 需授权 |
| 本地语音识别（离线） | ✅ | ✅ | ✅ |
| 回答朗读 | ✅ | ✅ 走 `say` / `afplay` | ❌ 未实现 |
| 语音唤醒「小潘同学」 | ✅ 默认系统语音，可选 KWS | ⚠️ KWS，实验性、默认关闭 | ❌ |
| 会议录音 + 加密落盘 | ✅ DPAPI | ✅ 钥匙串 | ✅ libsecret |
| 「点面板外面自动收起」 | ✅ | ❌ | ❌ |
| 前台活动记录（插件侧） | ✅ | ❌ | ❌ |

**macOS 上比 Windows 多一件事**：`setVisibleOnAllWorkspaces` 在 Windows 上是空操作，
只有 macOS/Linux 才真正生效 —— 所以 Mac 上宠物能跟着你切换桌面、能浮在全屏应用之上。

**macOS 上的差异**：

- **语音唤醒**：只能使用 sherpa KWS，默认关闭并标为实验性。需要先运行
  `bash scripts/setup-local-asr.sh` 安装唤醒模型（`local-asr/kws/`），再到
  「右键宠物 → 宠物设置 → 常驻与语音」开启。开启后菜单栏会持续显示麦克风占用；
  Mac 真机和真实噪声环境尚未验收。没有 KWS 时仍可用快捷键 `Cmd+Option+P` 或点角色。
- **没有系统语音兜底**：Windows 缺本地模型时可回退 `System.Speech`；macOS 缺模型时听写明确不可用。
- **点面板外面收起**：需要全局鼠标钩子 + 辅助功能授权。替代入口：按 `Esc`，或点角色本身。
- **活动记录**（插件侧）：采样器读的是 Windows 前台窗口 API。

### 在 macOS 上运行

```bash
cd dsh-pet
pnpm install                                    # 必须重新装，不能拷 Windows 的 node_modules
bash scripts/setup-local-asr.sh                 # 装识别与KWS模型（新装约 300—350MB，只需一次）
pnpm run start
```

打包成独立 `.app`：

```bash
pnpm add -D electron-builder   # 首次打包前安装
pnpm run pack:mac    # 用 build/electron-builder.yml，含 Info.plist 权限声明
```

> **为什么打包配置不是可选的**：macOS 10.14+ 起，访问麦克风必须在 Info.plist 里声明
> `NSMicrophoneUsageDescription`，否则调 `getUserMedia` 时系统会**直接终止进程**
> —— 不是报错、不是拒绝，是进程消失。开发态 `pnpm start` 跑的是 Electron 自己的
> Info.plist（已声明），所以那时能说话；打包后才必须有这份配置。

## 运行

```powershell
cd dsh-pet
pnpm install
pnpm run start
```

通常不需要手动启动：在 dsh 会话里说「召唤宠物」，插件会按 `petDir` 配置自动拉起。手动启动的壳会自动轮询等待桥接出现（每 2s 重试）。

> **国内网络**：Electron 二进制从 GitHub 下载可能很慢。安装依赖时可指定镜像：
> `ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" pnpm install`
> 若 `pnpm install` 后提示 Electron 未装好，可手动补跑：
> `ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" node node_modules/electron/install.js`

## 语音服务接入（可选：MiMo / OpenAI 兼容）

默认识别走本机 SenseVoice / 流式 Zipformer，合成走微软 edge-tts，都不需要密钥。也可以在
「宠物设置 → 语音」里添加自定义语音服务，把识别与合成换成小米 MiMo（或任意 OpenAI 兼容接口）：

- 识别（ASR）：提供商选 MiMo，接口地址 `https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5-asr`；
- 合成（TTS）：提供商选 MiMo，接口地址 `https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5-tts`，
  音色 ID 填 `冰糖` / `茉莉` / `苏打` / `白桦` 之一（默认音色 `mimo_default`）。

API Key 只在添加配置时填一次，由桌面壳用系统密钥库（Windows DPAPI / macOS safeStorage）加密后
保存到用户目录（`%APPDATA%\dsh-pet\voice-apis.json`），不进仓库、不进日志。添加后在设置页选中
该配置即可生效；识别失败会如实报错，不会偷偷换回其他服务。

> 想让「随时说话打断」效果最好：打开「外放插话（实验）」（设置 → 通用 → 常驻与语音）。
> 打开后朗读改由界面播放，Chromium 的回声消除拿得到参考信号，外放时更容易把你的插话与
> 助理自己的声音分开；代价是朗读链路多一次界面往返。

## 开发与验证

```powershell
pnpm run typecheck    # tsc --noEmit
pnpm test             # node --test --experimental-test-module-mocks "tests/**/*.test.ts"
pnpm run build        # esbuild 打包到 dist/
```

> `pnpm test` 会打一条 Node 的 ExperimentalWarning（strip-only TypeScript 与 module mocks 还是实验特性），不影响结果。想静音就跑 `node --disable-warning=ExperimentalWarning --test --experimental-test-module-mocks "tests/**/*.test.ts"`。

模块分两层：纯逻辑写成能被 `node --test` 直接导入的 `.ts`（状态机、措辞、投影），界面上用户要读的字符串一律放在纯逻辑里（`team-panel.ts`、`doc-panel.ts`），`.tsx` 只负责画 —— 措辞错了就是界面在撒谎，这类问题得能被测试钉住，不能靠开壳用眼睛看。

主进程装配也测（`tests/desktop.e2e.test.ts`）：用 Node 的 `mock.module` 顶掉 `electron` 与两个真进程边界（`wake.ps1`、TTS 合成进程），导入真的 `src/main/index.ts` 走一遍 whenReady 装配，再从外面驱动 IPC —— 钉住通道清单（包括"舞台渲染器没有能直接签发批准的通道"这条安全性质）、唤醒仲裁的起停、紧急停止、退出次序。它测不了真窗口与真 PowerShell，那些归真机验证。可测性有三个前提，破坏了这条测试就死：本地导入统一写 `.ts` 后缀（strip-only 不做 `.js` 重写）、类不用构造函数参数属性（strip-only 不改写语法）、`mock.module` 必须发生在导入 `index.ts` 之前。

## 已知限制

这些不是待修的 bug，是当前实现的真实边界，界面上也照实写了：

- **文档讲解支持 Markdown、纯文本和可提取文本层的 PDF**（`.md .markdown .txt .log .csv .tsv .json .pdf`）。
  Word、Excel、PPT 与图片只能用系统关联**打开给你看**，讲不了；扫描版 PDF、OCR、加密文档解锁都还没实现
- **能用系统关联打开的是一份白名单**，不是黑名单。`.docm .xlsm .pptm` 不在里面（计划明确"不执行文档宏"，而打开就可能触发），`.exe .bat .cmd .ps1 .vbs .lnk .reg .msi` 也不在（那已经不是打开文档而是执行程序）
- **流式回答取决于宿主模型**。桥接已有文字增量和分句 TTS，宿主吐 `text-delta` 时可以边收边念；
  模型只吐思考增量或整个回复一次到达时，第一句仍会晚。界面不伪造逐字流式。
- **自然语音打断仍是实验能力**。普通模式用「正在朗读」横条停止；打开「外放插话」后使用
  明确的打断口令，不是任意开口即断。外置音箱、回声消除和误触发必须在真实会场验收，
  不能拿单测或按键打断成功代替
- **授权目录只能由原生对话框添加**。界面上没有任何通道能把一个路径字符串塞进授权列表；撤销则可以直接点（那是把权限交回去）。用户手加的目录和"打开文档时自动记下的最近目录"是两块，两块都能撤
- **角色形象是二维占位皮肤**，不是每个角色一套原创美术
- 日报保存在 `~/.dsh/personal-assistant/reports/YYYY-MM-DD.md`（面板 📁 按钮可直接打开）

## 排障

- **麦克风只有一个主人**：唤醒词常驻监听，按键说话时唤醒先让出设备、说完自动收回。两者同时收音的话，后起的那个只会拿到静音流 —— 界面上一切正常，说了却没反应
- 语音没反应先检查系统默认输入设备；确认默认输入不是虚拟音频设备，输出设备也正常。
  只有使用 Windows `System.Speech` 时才依赖系统中文语音包（设置 → 时间和语言 → 语音）；
  sherpa 本地流式识别和 KWS 都是应用内的 ONNX 模型，不依赖系统语音包
- **听写不准/没装本地模型**：检查 `%APPDATA%\dsh-pet\local-asr` 下的
  `streaming-zh-14m/`（或旧 `streaming/`）、`model/model.int8.onnx` 和 `tokens.txt`。
  Windows 缺模型会回退 `System.Speech`，准确率有限；macOS 缺模型则听写不可用。
  重跑 `scripts\setup-local-asr.ps1` 安装（GitHub 不通时加 `-Mirror "https://gh-proxy.com/"`）。
  macOS 使用 `bash scripts/setup-local-asr.sh`。
- **唤醒不工作**：macOS 默认关闭且需要 KWS 模型，这不是“系统完全不支持唤醒”。确认
  已运行安装脚本、已在「宠物设置 → 常驻与语音」开启、麦克风权限已允许，并查看是否出现
  “本地唤醒模型已加载”。KWS 目前未做 Mac 真机与噪声环境验收。
- **朗读没声音**：edge-tts 走微软服务，断网或被拦截时自动回退本机合成（音色变机械但能出声）。两者都失败才报错
- 如果默认输入是 **NVIDIA Virtual Audio Device (Wave Extensible)**，去「设置 → 系统 → 声音 → 输入」确认默认设备是真麦克风。默认输入被虚拟设备占走时，识别器会初始化成功却拿到静音流，表现和仲裁器修的那个故障一模一样但原因不同
- 唤醒监听初始化失败后不会高频重试；主进程每隔约 20 秒做一次幂等恢复。修好设备或模型后，
  也可从托盘「重新监听唤醒词」立即重试
- 朗读失败会弹一句人话提示。这是个听不见的故障：界面上不报一句，用户只会觉得"它没反应"
