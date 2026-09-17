# dsh-pet 桌面助理团

DeepSeek Harness 的桌面客户端 —— 配合 [dsh-personal-assistant](../dsh-personal-assistant/README.md) 插件，把一支专家助理团放到桌面上：能说话、能听唤醒词、能讲解你授权的文档，也把任务和审批画在你看得见的地方。

## 功能

**角色与舞台**

- **多角色舞台**：编制里最多五席 —— 唐僧（总助理）、孙悟空、猪八戒、沙僧、白龙马。默认启用三人（一个总助理 + 两位专家），改插件配置里的 `teamSeats` 再重启即可增减
- 每个角色可右键「换个形象」，目前有三套占位皮肤（国宝熊猫、眼镜女生 Q 版、眼镜男生 Q 版），选择按角色记住、重启后还在
- 角色空闲时会自发闲聊；凑够人数还会开四人麻将、五人开黑这类群体场景。任务一派下来，牌桌上的角色立刻站起来回座位
- 窗口透明置顶、可拖拽、位置记忆，不挡其他窗口的操作
- **漩涡退场动画**：会话关闭或手动退出时，身后展开漩涡通道 → 挥手告别 → 转身跳入 → 通道消散（约 4.3s）

**说话与听**

- **语音唤醒**：喊「小潘」把角色唤回来并弹出输入框，角色隐藏时也管用（纯本地，不上传）
- **按键听写**：说话录音在窗口里完成，说完自动停。识别两条路自动选择：
  1. **本地 SenseVoice**（默认安装后生效）：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-asr.ps1` 下载约 230MB 模型到 `%APPDATA%\dsh-pet\local-asr`，之后**完全离线**、中文准确
  2. Windows 旧引擎兜底：模型没装时走它，能用但准确率有限
  - 录音只在本机处理，不上传任何音频
- **回答朗读**：语音发起的那一轮会把回答念出来；打字问的**不出声**（突然出声是用户没要求过的行为）。
  声音是微软 edge-tts 神经语音（默认「晓晓」，免费无需密钥）；**断网时自动回退本机合成**（音色机械但照常说话）。
  这一步会把要念的**文字**发到微软的合成服务；不接受的话拔网线用，回退路径不联网
- **打断**：朗读时界面出现「正在朗读」横条，点停止立刻闭嘴，排队的句子一起丢掉。打断后再问，交给模型的上下文只包含**实际念出来的那一半**

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

## 前置条件

1. 已安装 Node.js ≥ 22
2. 插件已装到某个 profile，且该 profile 有团队覆盖层（托盘的「启动助理团队」只列出真具备条件的）
3. 凭据沿用 dsh 已有配置（`~/.dsh/.credentials.yaml`），无需额外配置
4. 语音相关功能依赖 Windows 中文语音包：设置 → 时间和语言 → 语音 → 添加中文语音

## 运行

```powershell
cd D:\work\dsh-pet
pnpm install
pnpm run start
```

通常不需要手动启动：在 dsh 会话里说「召唤宠物」，插件会按 `petDir` 配置自动拉起。手动启动的壳会自动轮询等待桥接出现（每 2s 重试）。

> **国内网络**：Electron 二进制从 GitHub 下载可能很慢。安装依赖时可指定镜像：
> `ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" pnpm install`
> 若 `pnpm install` 后提示 Electron 未装好，可手动补跑：
> `ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" node node_modules/electron/install.js`

## 开发与验证

```powershell
pnpm run typecheck    # tsc --noEmit
pnpm test             # 474 条，node --test --experimental-test-module-mocks "tests/**/*.test.ts"
pnpm run build        # esbuild 打包到 dist/
```

> `pnpm test` 会打一条 Node 的 ExperimentalWarning（strip-only TypeScript 与 module mocks 还是实验特性），不影响结果。想静音就跑 `node --disable-warning=ExperimentalWarning --test --experimental-test-module-mocks "tests/**/*.test.ts"`。

模块分两层：纯逻辑写成能被 `node --test` 直接导入的 `.ts`（状态机、措辞、投影），界面上用户要读的字符串一律放在纯逻辑里（`team-panel.ts`、`doc-panel.ts`），`.tsx` 只负责画 —— 措辞错了就是界面在撒谎，这类问题得能被测试钉住，不能靠开壳用眼睛看。

主进程装配也测（`tests/desktop.e2e.test.ts`）：用 Node 的 `mock.module` 顶掉 `electron` 与两个真进程边界（`wake.ps1`、TTS 合成进程），导入真的 `src/main/index.ts` 走一遍 whenReady 装配，再从外面驱动 IPC —— 钉住通道清单（包括"舞台渲染器没有能直接签发批准的通道"这条安全性质）、唤醒仲裁的起停、紧急停止、退出次序。它测不了真窗口与真 PowerShell，那些归真机验证。可测性有三个前提，破坏了这条测试就死：本地导入统一写 `.ts` 后缀（strip-only 不做 `.js` 重写）、类不用构造函数参数属性（strip-only 不改写语法）、`mock.module` 必须发生在导入 `index.ts` 之前。

## 已知限制

这些不是待修的 bug，是当前实现的真实边界，界面上也照实写了：

- **文档讲解只支持 Markdown 与纯文本**（`.md .markdown .txt .log .csv .tsv .json`）。PDF、Word、Excel、PPT 与图片只能用系统关联**打开给你看**，讲不了 —— 结构化提取、OCR、加密文档解锁都还没实现
- **能用系统关联打开的是一份白名单**，不是黑名单。`.docm .xlsm .pptm` 不在里面（计划明确"不执行文档宏"，而打开就可能触发），`.exe .bat .cmd .ps1 .vbs .lnk .reg .msi` 也不在（那已经不是打开文档而是执行程序）
- **回答不是流式的**。桥接的 `chat` 一次性返回完整回复，所以"分句合成"只能在整段回答到手之后开始播：你会等全文算完才听到第一句
- **扬声器外放时喊话打断不了朗读**。系统回声消除让麦克风拾不到自己播出的声音，戴耳机时同样拾不到。普通模式下打断靠按键（「正在朗读」横条上的停止），这符合设计里"普通模式可先支持按键打断"，但和"耳机先验收再扬声器"的验收口径有差距
- **授权目录只能由原生对话框添加**。界面上没有任何通道能把一个路径字符串塞进授权列表；撤销则可以直接点（那是把权限交回去）。用户手加的目录和"打开文档时自动记下的最近目录"是两块，两块都能撤
- **角色形象是二维占位皮肤**，不是每个角色一套原创美术
- 日报保存在 `~/.dsh/personal-assistant/reports/YYYY-MM-DD.md`（面板 📁 按钮可直接打开）

## 排障

- **麦克风只有一个主人**：唤醒词常驻监听，按键说话时唤醒先让出设备、说完自动收回。两者同时收音的话，后起的那个只会拿到静音流 —— 界面上一切正常，说了却没反应
- 语音没反应先跑探针，它会报出这台机器上装了哪些中文识别器与合成音色、默认设备是什么：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-audio.ps1`
- **听写不准/没装本地模型**：看 `%APPDATA%\dsh-pet\local-asr` 里有没有 `bin\sherpa-onnx-offline.exe` 与 `model\model.int8.onnx`。没有就走的是旧引擎兜底，准确率有限；跑 `scripts\setup-local-asr.ps1` 安装（GitHub 不通时加 `-Mirror "https://gh-proxy.com/"`）
- **朗读没声音**：edge-tts 走微软服务，断网或被拦截时自动回退本机合成（音色变机械但能出声）。两者都失败才报错
- 探针若报出 **NVIDIA Virtual Audio Device (Wave Extensible)**，去「设置 → 系统 → 声音 → 输入」确认默认设备是真麦克风。默认输入被虚拟设备占走时，识别器会初始化成功却拿到静音流，表现和仲裁器修的那个故障一模一样但原因不同
- 唤醒监听初始化失败后**不会自动重试**（否则每三秒刷一条错误日志，用户看到的是一只一直在报错的宠物），修好设备后从托盘「重新监听唤醒词」叫回来
- 朗读失败会弹一句人话提示。这是个听不见的故障：界面上不报一句，用户只会觉得"它没反应"
