# 个人电脑助理 · AI 桌面宠物

基于 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness)（dsh）的个人电脑助理：
一句话开启「助理模式」，它记录你当天在电脑上做了什么、记住你的长期偏好、晚上出一份日报；
桌面上站着几个角色，可以打字或说话跟它们交流，也可以把任务派给专家真实执行。

> **许可证**：代码 MIT 开源；桌宠的动画、图片、提示词与源视频素材为 CC BY-NC 4.0，
> 允许非商业使用、修改与分发，**禁止商业使用**。

仓库包含两个部分：

| 目录 | 说明 | 安装方式 |
|---|---|---|
| [`dsh-personal-assistant/`](./dsh-personal-assistant/README.md) | dsh 插件（助理大脑）：活动跟踪、语义解释、日报版本化、记忆、会话桥接、专家团队与审批 | `dsh plugin add` |
| [`dsh-pet/`](./dsh-pet/README.md) | Electron 桌面外壳（交互身体）：多角色舞台、语音、面板、文档讲解 | 独立应用，源码运行或自行打包 |

> 桌宠动作使用 24fps 透明 WebM，`dsh-pet/assets` 约 11MB；代码 MIT，素材 CC BY-NC 4.0。

> dsh-pet **不是** dsh 插件，不能通过 `dsh plugin add` 安装。先装插件，再按需运行桌宠。

## 快速开始

### 1. 安装插件

前置条件：Node.js ≥ 22、pnpm、dsh `0.2.1-rc.2`（与插件的 peerDependencies 一致）。

从 GitHub 直接安装：

```bash
dsh plugin --profile web add "github:jiansiwen/dsh-pet-assistant#path:/dsh-personal-assistant"
```

从本地源码安装：

```bash
cd path/to/repo
dsh plugin --profile web add ./dsh-personal-assistant
```

安装后重启 dsh web；插件会随 profile 一起加载。插件自带的构建产物已经在 `dist/` 中，
从 GitHub 安装时不需要本地构建，也不会要求执行安装脚本。

### 2. 启动桌宠（可选）

```bash
cd dsh-pet
pnpm install
pnpm start
```

桌宠启动后会自动寻找插件写出的桥接文件（`~/.dsh/personal-assistant/bridge.json`）并接入当前会话。

如果希望「在 dsh 里说召唤宠物」时自动拉起桌宠，在本机 profile 的 `cordis.patch.yml` 里
给 `personal-assistant` 这一行补上 `config.petDir`，指向你本机的 dsh-pet 目录：

```yaml
- id: personal-assistant
  name: dsh-personal-assistant
  config:
    petDir: /absolute/path/to/dsh-pet
```

注意 dsh 的 `config` 是整体替换而非深合并：覆盖时要把需要的字段一起写上。
不配置 `petDir` 时，召唤只会把宠物绑定到会话，桌宠需要你自行启动。

### 3. 使用

1. 打开 dsh web，新建会话，说「召唤宠物」或「开启个人助理模式」
2. 桌面角色出现，对话与模型凭据都沿用当前 dsh 会话，桌宠不需要单独配置 API key
3. 随时「记一下：…」补充信息，或问「我今天干了啥」
4. 说「总结今日工作内容」→ 审阅草稿 → 指导修改 → 确认
5. 日报保存到 `~/.dsh/personal-assistant/reports/`

首次使用桌宠的语音功能时，需要安装本地识别模型（约 700MB，之后完全离线）：

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-asr.ps1
# macOS / Linux
bash scripts/setup-local-asr.sh
```

## 架构

```
dsh web（常驻）── 会话 S
 └─ dsh-personal-assistant 插件（profile 根作用域，单例）
     ├─ SessionBridge：从 ToolRunContext.agent 捕获活体 agent
     │    → node:http 长轮询（127.0.0.1 随机端口 + token）
     │    → 写 ~/.dsh/personal-assistant/bridge.json
     ├─ 宠物消息经 agent.followup 注入会话 S → 写入同一份会话历史
     ├─ 采样器：插件托管子进程，插件卸载时自动回收
     ├─ 助理库 assistant.sqlite：记忆 / 观察 / 日报版本
     ├─ 团队库 team.sqlite（可选）：编制 / 任务 / 提案 / 批准
     └─ 偏好、模式状态经 ctx.systemPrompt 渲染进系统提示词
              ↕ HTTP 长轮询
 dsh-pet (Electron)
  ├─ CompanionHost：托盘、运行时启停、握手状态机
  ├─ BridgeClient：读 bridge.json 接入；桥接消失 → 退场动画 → 退出
  └─ 舞台 / 面板 / 语音 / 文档讲解
```

## 平台支持

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 插件：活动采样 | ✅ | ✅（未真机验证） | ❌ |
| 插件：日报 / 记忆 / 会话桥接 | ✅ | ✅ | ✅ |
| 桌宠：窗口、舞台、面板、文档 | ✅ | ✅ | ✅ |
| 本地语音识别（离线） | ✅ | ✅ | ✅ |
| 回答朗读 | ✅ | ✅ | ❌ |
| 语音唤醒「小潘同学」 | ✅ | ⚠️ KWS，实验性、默认关闭 | ❌ |
| 会议录音加密落盘 | ✅ DPAPI | ✅ 钥匙串 | ✅ libsecret |

语音唤醒、朗读等差异的细节见 [`dsh-pet/README.md`](./dsh-pet/README.md#平台支持)。

## 隐私边界

- 只采集**前台窗口**的进程名，以及授权后的窗口标题；不读取应用内容
- 采样保留期到期会**真删**采样文件（默认 7 天）
- 聊天内容只能由你主动导入；锁屏期间记为 idle
- 审批凭据与聊天令牌分离，只写给桌面壳主进程，不进入模型上下文
- 文档讲解只在授权目录内查找，白名单扩展名才允许用系统关联打开
- 语音识别在本机完成，录音与转写不上传（自定义在线语音服务除外，需你主动配置）
- 已知偏离：`~/.dsh/personal-assistant/` 下的 SQLite 库目前是**明文落盘**，没有静态加密；
  介意的话请勿开启助理模式，或自行加密磁盘

## 开发

两个包各自独立安装依赖：

```bash
cd dsh-personal-assistant && pnpm install
pnpm run typecheck && pnpm test && pnpm run build

cd ../dsh-pet && pnpm install
pnpm run typecheck && pnpm test && pnpm run build
```

修改插件源码后必须重新 `pnpm run build`，并同步提交 `dist/`；从 GitHub 安装的用户拿到的就是
仓库里的构建产物。桌宠的 `dist/` 不入库，用户首次运行 `pnpm start` 时会自动构建。

## 已知限制

- 插件回复不是流式的：桌宠要等整段回答算完才开始朗读
- 活动采样在 macOS 上尚未真机验证；分类规则仍以 Windows 进程名为主
- 桌宠的角色形象目前是三套占位皮肤（熊猫、眼镜女生、眼镜男生），不是每个角色一套原创美术
- 专家团队默认关闭；开启后模型费用不设累计上限，只受单次输出、超时与并发约束

## 许可证

- **代码**：[MIT](./LICENSE)
- **素材**（桌宠的动画帧、角色图片、生成提示词、源视频等）：
  [CC BY-NC 4.0](./ASSETS-LICENSE.md)——允许非商业使用、修改与分发，禁止商业使用，需署名。

商业使用素材需要单独授权。
