# dsh-personal-assistant

DeepSeek Harness（dsh）的**个人电脑助理插件**。跑在 dsh 会话里：记录你当天在电脑上做了什么、
把长期偏好记下来并自动生效、把桌面宠物和「1 总 + N 子」助理团接进当前会话，并提供成员定时自主任务、
技能自动形成、外部智能助理平台通用对接，以及一个收拢宠物配置/技能/待办/会议的工作台设置页。

宠物那一侧（Electron 外壳、语音、文档讲解）在 [`dsh-pet/`](../dsh-pet/README.md)。

## 安装

前置条件：Node.js ≥ 22、pnpm、dsh `0.2.1-rc.2`（与 peerDependencies 一致）。

从 GitHub 安装：

```bash
dsh plugin --profile web add "github:jiansiwen/dsh-pet-assistant#path:/dsh-personal-assistant"
```

从本地源码安装：

```bash
cd path/to/repo
dsh plugin --profile web add ./dsh-personal-assistant
```

安装后重启 dsh web 生效。仓库中已包含构建好的 `dist/`，安装时不需要执行构建脚本。

若想让「召唤宠物」自动拉起桌宠，在本机 profile 的 `cordis.patch.yml` 中为
`personal-assistant` 配置 `petDir`（指向本机的 dsh-pet 目录，见根 README）。

## 功能

### 活动记录与日报

- **开启个人助理模式**：后台采样前台窗口（Windows 与 macOS；进程名，以及授权后的窗口标题），
  分类为聊天 / 浏览器 / 文档 / 开发 / 会议 / AI / 终端等
- **我今天干了啥**：把活动片段增量解释为工作事项（如「与张三讨论了需求」），
  推断出来的结论标 `confidence: medium`，与证据直接支持的分开
- **随手记 / 聊天导出导入**：补充窗口采样看不到的信息
- **工作日报**：读长期偏好 → 生成草稿 → 交你确认 → 定稿落盘 Markdown 并自动退出助理模式。
  草稿是**版本化**的：每次保存产生新版本，确认时必须带回你看到的那一版的版本号与内容摘要，
  对不上就拒绝落盘（防止你确认的是 A、写出去的是 B）

### 记忆

- **偏好记忆（自动生效）**：记忆存在助理库（全局、无项目维度），已确认的部分**直接渲染进系统提示词**
  ——任何新会话、任何一天生成日报都自动遵守，不依赖模型记不记得去查
- **总助理记忆范围**：已确认的新增长期全局规则和通用经验默认由本地 DSH 子助理只读沿用。需要保密时可以先说「这条只给你知道」，也可以在桌宠「设置 → 助理团设置 → 总助理记忆范围」里逐条切换「私密（仅总助理）」或「团队共享」，或在对话中指定哪条规则要切换。
  变更影响后续的记忆注入，不会擦除已发生的对话或收回已发给模型的内容。历史未共享的内容不会因升级自动公开；项目规则和成员的独立记忆不在此范围。私密是使用范围，不是加密或密码保管功能。
- **自动学习**：可信入口的「记住：…」会记录明确、长期且不冲突的规则；「我更喜欢…」之类的相同表达要在三个不同会话或不同日期观察到才会记录。一次性要求、导入材料、成员自报和已删除的旧偏好不会自动生效。技能使用可以核对的独立样本，启用后在桌面汇报；可以在「记忆与技能」修改、停用或删除。技能不授予额外权限。
- 同一主题下出现互相矛盾的说法时，两条都**停下不注入**，并在提示词里单独列出请你挑一条
- 删除记忆会如实返回四类结果（已删除 / 已失效 / 仍保留 / 无法控制），不是笼统一句「忘了」

### 会话桥接

- **成员工作区**：在桌宠成员编辑器选择 DSH 已登记工作区。定时执行使用成员选定的工作区；总助理派单沿用实际发起会话的工作区。同一成员跨工作区使用不同工作会话，不覆盖原主会话。
- **成员会话**：新的本机成员会话按「成员名｜会话名」命名，使用宿主预设和成员权限。可从成员设置新开会话，也可对总助理说「给信使新开一个复盘会话」。用 `/assistant-member-continue 会话编号 你的原话` 可把消息直接递给指定成员，原生历史窗口不会使用总助理身份代跑任务。
- **企微汇报的回复**：本机成员的定时汇报和邮件值守在已配对私聊附编号，引用汇报或发送「`/接续 编号 你的回复`」可以回到原执行成员和会话。歧义先澄清；只有本人明确发送「`/新接续 编号 你的回复`」才另建会话。针对唯一邮件类别的「以后不用提醒」只抑制提醒，仍保留分析与邮件。

- **召唤桌面宠物**：把宠物绑定到当前会话——宠物的对话经 `agent.followup` 注入本会话，
  使用相同的模型与凭据，**宠物端不需要配置任何 API key**
- 宠物消息**串行注入**，与 web 页面输入共用同一 inbox，不产生交错
- **插件加载即监听**：桥接在 apply 时就起来（未绑定）并写出 `bridge.json`，桌面壳不必等网页召唤就能找到运行时。
  未绑定时 `/health` 如实报 `bound:false`；对话（`/chat`）、会话命令（`POST /session`）与三类审批一律回
  `503` + `code:"unbound"` 和可展示的原因，**不伪装成已连接**（`GET /session` 照常返回 `disconnected` 快照）
- **从桌面开始会话**：`POST /session/start`（聊天令牌鉴权）。已绑定且会话在线就原样返回当前绑定；否则经宿主
  `ctx.agents` 恢复插件上次自建的会话（id 记在助理库 `user_flags`），恢复失败就新建并在 `resumeError` 里如实给出原因，
  再走与召唤相同的 bind。宿主没有 `ctx.agents` 时回 `503` + `code:"agents-unavailable"`，不降级成假成功
- **会话所有权**：只有 `/session/start` 建出或恢复的会话归插件所有，插件卸载时按所有权释放；网页里创建、经召唤绑定过来的
  会话插件从不 dispose 也不 cancel。网页召唤到另一会话时照旧换绑，旧审批随之失效
- `agents` 不写进 `inject`：cordis 4 的 inject 每一项都是**必需**依赖（对象形式的值是拦截配置；cordis 3 的
  `{ required, optional }` 写法在这里会被当成两个服务名，插件永远起不来），写进去会让没有该服务的宿主里整个插件停在 pending。
  插件改用 `ctx.get('agents')` 现取，经它拿到的服务按调用方追踪，所有权因此落在本插件的 fiber 上

### 桌面专家助理团（可选，默认关闭）

- **编制**：1 总助理 + N 自定义子助理。成员名字 / 职责 / 性格 / 人设 / 形象 / 音色 / 能力 / 权限均可配置，
  每位成员独立会话 + 独立记忆；默认席位由 `teamSeats` 决定，未启用席位不播放假工作
- **派活**：`desktop_team_assign` 按成员目录职责自动选人，走真实子代理运行等真实结果；
  受管成员经 DSH 子代理工厂 spawn 时**继承总助理的宿主工具**，宿主未开放时回退插件会话＋只读网页桥
- **任务结单**：普通查询或分析直接结单；失败或缺少前提会显示具体阻碍。只有待本人完成或需要人工验收的任务可「确认完成」，操作审批另走真实审批卡。
- **可信审批**：专家默认只读。需要外部副作用时提出提案，由用户在桌面审批窗口决定；
  批准绑定「任务 + 操作目标 + 参数摘要 + 输入修订」的哈希，改任何一项旧批准即失效
- **执行点门禁**：门禁装在子代理自己的 agent ctx 上，没有有效批准就调不动 write / bash 这类工具；
  装在全局 ctx 会连用户自己的调用一起拦，所以不那样做
- **副作用代执行**：只有「副作用成员（总助理）× 副作用任务」才会启动可信执行器（目前由桌面点名总助理发起）。
  启动前先按随机运行标签 + 父会话装定向审批门禁，start() 返回前子代理发出的副作用调用一律拦截；
  启动后在精确的子代理 agent ctx 上装审批门禁，绑定调度器给出的任务、成员与输入修订（不取模型自报）。
  允许集合只有观测工具，加上 write / edit / str_replace_editor / bash / pwsh / job_kill 中按宿主参数定义核实过目标字段的那几个；
  每次副作用调用都先在桌面审批窗口生成审批卡（摘要由门禁按真实工具与目标生成），批准前调用停住等待，
  批准后只放行这一次；改参数、目标变化、过期、重放、转委派一律拒绝。bash / pwsh 按高风险走独立确认，
  每条命令单独批准，批准不授予后续任意 shell 能力
- **写类目标的范围**：write / edit / str_replace_editor 的目标先解析成真实路径（逐级解开符号链接 / 联接点）再比对，
  只能落在父会话工作目录之内；符号链接越界、相似前缀（D:/a 与 D:/ab）、路径穿越、悬空链接都拒绝，
  批准绑定的就是这条真实路径。会话没有工作目录时写类工具不开放
- **执行账本**：每个动作落库动作标识、成员、规范化目标、参数摘要、预登记与真正开始执行的时间、结果摘要与最终状态，
  重启后用 `desktop_team_status` 仍可查。进程停在执行前、执行中、执行后但回执没落库的任一位置，重启对账一律记
  unknown 等人工核查：任务不再被领取、相关审批卡作废、绝不自动重发；模型自报不能把 unknown 改成成功。
  子代理释放失败时门禁与额度先保留，退出只重试释放
- **预算与费用**：**默认不设累计 Token 预算**，`defaultBudgetTokens` 默认 0。
  后果是**团队任务的模型费用不封顶**：宿主只有单次输出上限（子代理沿用父会话每次请求的 maxTokens），没有累计硬上限；
  仍然生效的只有单次输出上限、墙钟超时（`taskTimeoutMs`，默认 10 分钟）与并发上限（推理 2 / 副作用 1）。
  显式给出非零预算的任务会如实拒启（`budget-unsupported`），不假装能守住

### 主动提醒

- 采样器带**最后键鼠输入**指标（`idleMs`，纯数值，不含任何窗口/应用身份）。
  无输入超过阈值（默认 8 分钟，`proactiveIdleMs` 可调）且角色可见、不在专注模式时，产生候选提醒
- 频控：一个连续空闲期最多提醒一次 + 全局冷却 60 分钟（`proactiveCooldownMs`）。
  "任务"边界没有可靠信号，所以取保守下界，宁少勿扰
- **先只显示无声小气泡**（「需要我一起看一下吗？」，固定文案，不是模型生成的 —— 界面上
  没有可被填充的资料位）。用户不回应就到此为止：不读取更多资料、不开始代理任务
- 点「好」→ 替你向总助理发一句话进入帮助流程，之后的副作用全部走已有的审批链；
  点「不用」→ 本次抑制；连续拒绝 3 次，气泡改为问「要不要干脆关掉」；
  关闭是**用户意愿，落库持久化**（`user_flags` 表），重启不会悄悄复活
- 策略在 [`src/proactive.ts`](./src/proactive.ts)（纯函数），桥接侧是 `/proactive/*` 反馈端点
  与 `/pet-state` 状态上报（专注/可见），显示与否由桌面壳按专注状态再挡一道

### 开启总开关与工具注入

- 「开启个人助理」是**工具注入闸门**：关闭时不向 dsh 注入本插件的工具，但**保留 AI 宠物壳**
  （关插件不等于关宠物）。`assistant-on` / `assistant-off` / `assistant-state` 读写该开关，选择持久化
- 采集与注入是两件事：工具开着但「等采集范围确认」或「被配置拦住」都会如实显示，不假装在采集

### 个人助理设置页（dsh 工作台）

工作台把原来散在桌宠右键菜单里的能力收进一个页面，列表类 tab 支持卡片内滚动：

- **待办 / 会议**：行内改标题、改期、改间隔、取消；待办改优先级走「提案 + 本人确认」，不直接改
- **宠物**：形象 / 随机动作 / 显示 / 上台退下，与桌宠右键菜单同一份配置（`assistant-pet-config` / `assistant-pet-set`）
- **技能**：查看自动形成与人工技能，增删改查、让它生效 / 退役 / 回滚；「待核实 / 够格」样本可确认属实或撤回
- **设置**：唤醒 / 播报 / 讲解模式等只读摘要；邮件 / 企业微信连接配置（`assistant-mail-config` / `assistant-wecom-config`）

### 子助理团：1 总 + N 子，独立会话与记忆

- 成员是**自定义**的（名字 / 职责 / 性格 / 人设 / 形象 / 音色），不再是固定角色；每位成员用**独立会话 + 独立记忆**
- **能力**按勾选绑定：企业微信接收 / 邮件 / 会议 / 文档 / 活动日报 / 提醒 / 操作电脑 / 外部平台对接；
  权限三档（每次询问 / 自动审批 / 完全访问），汇报两种（总助理汇总 / 成员自己播报）
- **记忆**：总助理的已确认记忆可**只读共享**给所有子助理；子助理另有私有记忆（`companion_member_remember` 提交候选，本人确认）
- **技能自动形成**：同类工作攒够样本（默认 3 次）后由模型总结成技能，计数归代码、正文归模型；
  `skillsAutoForm` / `skillsAutoActivate` 控制是否自动形成 / 默认生效（人工只做事后查验）；**扩权一律须本人批准**
- **沿用宿主工具**：成员会话经 DSH 子代理工厂 spawn 时继承总助理的宿主工具；宿主未开放时回退插件会话＋
  只读网页抓取桥（`companion_web_fetch`，仅 https 公开页、防内网 SSRF），不替代宿主工具

### 成员定时任务（到点自主干活再推送）

- [`src/member-scheduler.ts`](./src/member-scheduler.ts)：`daily` / `once` / `interval` 三种计划，到点让成员**用自己的工具真干活**
  （抓 GitHub 热门、整理日报等），再把结果推送给本人——不是发一条固定提醒
- 推送渠道：企业微信（文本带 `【成员名】` 前缀，同一机器人下分得清是谁）或桌面以成员形象+音色播报
- 成员可在**企业微信里改自己的定时任务**（`companion_member_schedule`：list / update 查询内容 / 时刻 / 频率 / 渠道），
  离开桌面也能调整；总助理也可用 `personal_assistant_member_schedule` 安排
- 自报播报带时间戳守卫：召唤 / 重连**不重播**旧汇报，只念新鲜结果

### 外部智能助理平台对接（通用、配置驱动）

- [`src/platform-connector.ts`](./src/platform-connector.ts)：单地址 POST `{service,appid,channel,sid,timestamp,sign,data}`，
  标准签名按字段名排序拼接键和值（对象值按键排序后转 JSON），再追加 `app_secret` 做 UTF-8 大写 MD5。旧默认模板自动用标准签名，显式自定义模板保留。
- 本机专家勾选「对接外部智能助理平台」后可使用平台工具。平台智能体勾选后，可由 DSH 代为执行平台操作：列智能体、查会话、查聊天记录、向平台智能体提问、上传本地文件到知识库；查询和提问按该成员的汇报方式返回真实回执，上传是写操作。普通对话仍使用该成员绑定的聊天端点。
- 平台智能体可单独填写「应用 ID」「签名密钥」「签名接口地址」「用户标识」：四项都可留空，留空的那项沿用本机平台对接配置；填了就覆盖。签名密钥只上桥一程，落本机加密存储，快照与原生确认不回显明文；换了应用 ID 必须重填密钥。
- 配置命令 `assistant-platform-get` / `assistant-platform-set`；配置文件 `personal-assistant/platform-connector.json`。成员设置的聊天 API 密钥不替代 `app_secret`。

### 文档讲解（dsh-pet 侧）

- **表格照念**：md 表格不再整段跳过，格子转逗号逐行念，和屏幕看到的一致（只不念竖线 / 分隔行等格式符号）；
  代码 / 公式仍提示一句并停 10 秒看屏幕
- **音色一致**：开讲 / 交接前先暖成员音色缓存，交接、开场白、正文全程用成员自己的嗓子，不中途混入总助理
- **预读同会话**：打开文档时静默预读只给文档名 / 路径与工作区提示，模型用 `companion_document_read` 自己读；
  预读与后续提问在**同一条**成员文档会话，追问只发问题不重发原文

### 任务确认与取消

- 「等复核」和「等你回话」可在团队页「确认完成」（`POST /team/confirm`）。真实待批在独立审批卡处理，不能用「确认完成」替代；已受阻不要求点确认。
- 交给具备活动记录能力的成员导出历史日报时，先查指定日期的草稿。自动保存模式直接保存到日报目录的 `<日期>.md`；手动审批模式只生成 `drafts/<日期>-r<版本>.md` 副本，不改变发布状态。两种方式都不停止活动记录。

## 架构

```
dsh web（常驻）── 会话 S
 └─ dsh-personal-assistant 插件（profile 根作用域，单例）
     ├─ 会话桥接 SessionBridge：从 ToolRunContext.agent 捕获活体 agent；插件加载即监听（未绑定）
     │    → node:http 长轮询（127.0.0.1 随机端口 + token，零外部依赖）
     │    → POST /chat   GET /events?since=N   GET /team   POST /approval   GET /health
     │    → GET/POST /session（原生会话镜像）   POST /session/start（从桌面开始/恢复会话，经 ctx.agents）
     │    → POST /proactive/{accept,decline,disable,enable}   POST /pet-state（§2.7 反馈）
     │    → 写 ~/.dsh/personal-assistant/bridge.json（端口 + 聊天令牌；加载时不抢健康运行时，召唤时接管）
     │    → 写 ~/.dsh/personal-assistant/bridge-approval.json（审批凭据，与聊天令牌分离）
     │    → 配了 petDir 就 spawn `cmd /c pnpm start` 拉起宠物
     ├─ 采样器：插件托管子进程（不分离），插件卸载时由 ctx.effect 回收，不留孤儿进程
     │    → Windows：assets/sampler.ps1（PowerShell + user32）；macOS：assets/sampler-macos.js（osascript JXA）
     ├─ 助理库 assistant.sqlite：记忆 / 观察 / 日报版本 / 迁移批次
     ├─ 团队库 team.sqlite（teamEnabled 时）：成员编制 / 任务 / 提案 / 批准 / 操作记录
     └─ 系统提示词：偏好、模式状态、记忆冲突经 ctx.systemPrompt.variable 渲染进去
              ↕ HTTP 长轮询
 dsh-pet (Electron)
  └─ BridgeClient 读 bridge.json 接入；桥接消失（会话销毁）→ 漩涡退场动画 → 退出
```

两个库刻意分开：团队是可选功能（`teamEnabled` 默认关闭），记忆不是。混在一个库里，
关掉团队就得连带决定记忆放哪。

### 磁盘上都有什么

| 路径（相对 `~/.dsh`） | 内容 |
|---|---|
| `personal-assistant/assistant.sqlite` | 记忆、观察、日报版本、迁移批次 |
| `personal-assistant/samples/<yyyy-MM-dd>.jsonl` | 原始采样，一行一个 JSON |
| `personal-assistant/reports/` | 定稿日报 Markdown |
| `personal-assistant/bridge.json` | 桥接端口与聊天令牌（宠物读）。插件加载即写；另一运行时正健康服务时加载不抢、召唤时接管；卸载只删自己写的那份 |
| `personal-assistant/bridge-approval.json` | 审批凭据（只有桌面壳主进程读） |
| `personal-assistant/platform-connector.json` | 外部智能助理平台对接配置（endpoint/appid/secret/userId/assistId/signTemplate；secret 只存配置不入代码） |
| `desktop-team/team.sqlite` | 团队编制 / 任务 / 提案 / 批准 / 操作记录 / 成员定时计划与运行账本（`teamEnabled` 时） |
| `storages/personal_assistant/` | **旧版**存储域，默认只读导入新库，不自动删 |

## 安装

```powershell
cd <插件目录>            # 例：D:\work\dsh-personal-assistant
pnpm install
pnpm run build

# 装到 web profile（推荐：web 常驻、会话寿命长，最适合挂载宠物）
cd <仓库根目录>          # 插件目录的上一级
npx @deepseek-ai/dsh plugin --profile web add ./dsh-personal-assistant
```

凭据沿用 dsh 已有配置（`~/.dsh/.credentials.yaml` 或环境变量），插件与宠物都不单独管理 key。

> 若 `dsh plugin add` 因环境问题失败，可手动复刻它做的事：profile 的 package.json 加
> `"dsh-personal-assistant": "link:<插件绝对路径>"` 依赖并加入 `dsh.profile.bundles`，
> 再在 profile 的 node_modules 里对插件目录建符号链接（junction 即可）。

### 桌面宠物（dsh-pet）

桌宠是独立的 Electron 应用，不在本插件包内；插件负责桥接（宠物与当前会话共用历史、模型与凭据）。
召唤宠物时按以下顺序找桌宠目录，找到即在其中执行 `pnpm start` 自动拉起：

1. profile 里给 `personal-assistant` 配置的 `config.petDir`；
2. 环境变量 `DSH_PET_DIR`；
3. 插件目录同级的 `dsh-pet`（从同一仓库克隆时天然满足：`dsh-personal-assistant` 与 `dsh-pet` 是兄弟目录）。

一个都找不到时，召唤只会绑定会话，工具返回里会说明去哪放 dsh-pet；你也可以随时在 dsh-pet 目录
手动运行 `pnpm start`——启动后会自动接入桥接，无需其它配置。


### 开启团队（可选）

团队是**覆盖层**，不需要新建 profile：

```powershell
dsh --profile web --patch <插件目录>/cordis.team.patch.yml
```

想常开就把那一条抄进该 profile 的 `cordis.patch.yml`。注意两点：

- 覆盖层用 `- id: personal-assistant` 而不是 `- insert:`。loader 对同 id 的 insert **不去重**，
  插件自带的 patch 已经 insert 过这一行，再 insert 一次会抛
  `duplicate loader entry id: personal-assistant`，整个 dsh 起不来。按 id 覆盖走的是另一条分支。
- `config` 是**整体替换，不是深合并**。如果 profile 层里给 personal-assistant 配过
  `petDir`，覆盖层里不写就会把它顶掉——想让「召唤宠物」自动拉起 dsh-pet，就在覆盖层的
  `config` 里写上你自己的 `petDir`（模板里默认注释掉，留空 = 只绑定会话、不自动拉起）。


写完补丁先跑 `dsh --profile web --dump-config`（零副作用）看最终 entry 列表，再真启动。

## 配置

`cordis.patch.yml` 里 `config` 下的字段（完整定义与默认值见 [`src/config.ts`](./src/config.ts)）：

```yaml
- insert:
    - id: personal-assistant
      name: dsh-personal-assistant
      config:
        # 采集
        sampleIntervalMs: 5000      # 采样间隔，最小 1000
        minSpanMs: 3000             # 低于此时长的片段视为噪声
        captureActivity: true       # 关掉后不开采样进程、不产生采样文件
        captureWindowTitles: true   # 关掉后采样脚本压根不调用 GetWindowText
        retentionActivityDays: 7    # 原始活动保留天数，超期真删文件

        # 路径
        reportDir: ''               # 留空 = ~/.dsh/personal-assistant/reports
        storePath: ''               # 留空 = ~/.dsh/personal-assistant/assistant.sqlite
        petDir: ''                  # dsh-pet 工程目录；留空 = 按「桌面宠物」一节的顺序自动查找

        # 记忆与迁移
        maxInjectedMemories: 40     # 注入提示词的记忆条数上限（限的是注入，不是存储）
        migrateLegacy: true         # 启动时把旧存储域只读导入新库
        deleteLegacyAfterMigration: false   # 导入后是否删旧数据；删除不可逆，默认不删

        # 分类
        customRules: []             # 追加规则：{ process: 正则, category, titleExtract? }

        # 团队（默认关闭）
        teamEnabled: false
        teamStorePath: ''           # 留空 = ~/.dsh/desktop-team/team.sqlite
        teamId: desktop-team
        teamSeats: []               # 留空 = 默认三人；写全五个才五人首发
        teamProvider: spawn         # spawn 不继承父上下文，fork 继承
        maxConcurrentInference: 2
        maxConcurrentSideEffect: 1  # 必须小于推理上限
        taskTimeoutMs: 600000
        defaultBudgetTokens: 0      # 0 = 不设累计预算（费用不封顶）；非零值会因宿主没有累计硬上限而拒启
        approvalTtlMs: 300000       # 批准有效期；运行时代次变化会让旧批准立即失效
        denyExpertTools: []         # 额外从只读专家手里禁用的工具名

        # 主动提醒
        proactiveEnabled: true      # 关闭后引擎彻底安静，也省掉评估定时器
        proactiveIdleMs: 480000     # 无输入多久后可以提醒（8 分钟）
        proactiveCooldownMs: 3600000 # 两次提醒的最小间隔（60 分钟）

        # 技能自动形成
        skillsAutoForm: true        # 同类工作攒够样本后自动让模型总结成技能
        skillsAutoActivate: true    # 自动形成的技能默认生效（人工只做事后查验）；扩权仍须本人批准

        # 写入方式与子助理会话
        approvalMode: manual        # manual=桌面逐条批准；auto=用户明确选择的自动记录（模型仍拿不到凭据）
        subAssistantIdleTtlMs: 480000   # 子助理会话空闲回收时长
        maxSubAssistantSessions: 8      # 子助理常驻会话上限（LRU 淘汰）
        maxDispatchDepth: 2             # 越权回退后最大重分派深度（防转发循环）
        subAssistantTimeoutMs: 600000   # 单次子助理分派超时
```

`teamSeats` 写 assistantId（`member-shaseng`）或 roleId（`shaseng`）都认，写错的名字会被忽略并记一条 warn。

`teamEnabled` 之外还有第二条开启路径：在会话里说「开启团队模式」（`personal_assistant_set_team_mode`），
团队服务会在运行中挂载，选择记在助理库的 user_flags 里，重启后仍然生效；「关闭团队模式」在有任务
执行中会被拒绝，空闲时卸载并清掉标记。profile 里显式 `teamEnabled: true` 时始终挂载，两种入口挂出来
的是同一种东西。唯一的不确定点是会话中途注册的委派工具何时进入模型工具清单——挂载后的团队页、
快照与审批是即时的，委派工具若当轮没出现，下一条消息再试或重启 dsh。
**默认配置下四人麻将、五人开黑这类群体场景凑不齐人，只有闲聊开得起来** —— 这是有意的：
桌面上多两个人是实打实的 CPU 与内存开销，所以做成开关而不是代码默认值。

## 工具清单

### 助理（始终注册，受开启总开关闸门）

| 工具 | 用途 |
|---|---|
| `personal_assistant_summon_pet` | 召唤桌面宠物并绑定当前会话 |
| `personal_assistant_set_team_mode` | 开启/关闭团队模式（运行时挂载/卸载团队服务，选择持久化） |
| `personal_assistant_member_schedule` | 为成员安排/查询/取消/立即执行定时自主任务（daily/once/interval，企微/桌面推送） |
| `personal_assistant_dispatch_subassistant` | 把任务分派给外部平台/本地 CLI 子助理（越权回退、防环） |
| `personal_assistant_start` | 开启助理模式 |
| `personal_assistant_stop` | 关闭助理模式（不出日报） |
| `personal_assistant_status` | 模式状态与今日概览 |
| `personal_assistant_today` | 指定日期的已解释事项、未解释片段、笔记和统计（默认今天） |
| `personal_assistant_commit_events` | 提交语义解释 |
| `personal_assistant_import_records` | 导入聊天记录 / 随手记 |
| `personal_assistant_save_draft` | 保存日报草稿（产生新版本，旧版本状态作废） |
| `personal_assistant_get_draft` | 按日期读取最新草稿与版本清单 |
| `personal_assistant_export_daily_report` | 把指定日期的已存日报写为本地 Markdown 文件，遵从已有发布设置、不停止活动记录 |
| `personal_assistant_submit_report` | 草稿 → 待确认，返回 revision / digest / targetPath |
| `personal_assistant_confirm_report` | 校验版本号与摘要后落盘定稿并退出模式 |
| `personal_assistant_remember_preference` | 记录长期偏好（必须给 topic） |
| `personal_assistant_list_preferences` | 列出全部记忆及状态 |
| `personal_assistant_forget_preference` | 删除记忆，返回四类结果 |

### 成员本地工具（按能力/权限注册到成员会话）

| 工具 | 用途 |
|---|---|
| `companion_member_remember` | 提交本成员私有记忆候选（本人确认后才生效） |
| `companion_member_request_quota` | 申请额度（不自行批准） |
| `companion_member_schedule` | 成员改自己的定时任务（list/update，企微绑定本人可用） |
| `companion_web_fetch` | 只读抓取公开 https 网页/API（防内网 SSRF；宿主工具不可用时的桥） |
| `companion_mail_unread` / `personal_assistant_send_mail` | 读未读 / 发信（mail 能力，发送需审批） |
| `companion_platform_*` | 外部平台查询/列智能体/查记录/上传知识库/上传文件/更新记忆/通用 call（platform 能力） |
| `personal_assistant_computer_*` | 看屏幕/点/输入/滚动（computer 能力，每次动作需桌面批准） |

### 斜杠命令（工作台 / 会话快捷入口）

`assistant-on/off/state`（总开关）、`assistant-pet-config/set`（宠物配置）、`assistant-task-set`（待办改删）、
`assistant-meeting-set`（会议改名/删除）、`assistant-set-task-priority`（待办优先级提案）、
`assistant-skills` / `assistant-skill-set`（技能查验/增删改/生效/退役/回滚/证据确认）、
`assistant-platform-get/set`（外部平台配置）、`assistant-mail-config` / `assistant-wecom-config`（连接配置）、
`assistant-settings-summary`、以及只读列表 `assistant-todo-list/count`、`assistant-meeting-today/list/history`、
`assistant-report-list`、`assistant-team-list`、`assistant-today-summary`、`assistant-set-option`。

### 团队（6 个，仅 `teamEnabled` 时注册）

| 工具 | 用途 |
|---|---|
| `desktop_team_start` | 把当前会话登记为总助理宿主，写入编制 |
| `desktop_team_assign` | 派任务给指定成员并等真实结果 |
| `desktop_team_status` | 成员 / 任务 / 待批提案 / 执行账本（目标、开始与结束时间、状态） |
| `desktop_team_cancel` | 取消任务（已发生的外部副作用不撤回，会列出来） |
| `desktop_team_propose_action` | 提交副作用提案走用户审批（写类目标按会话工作区规范化成真实路径） |
| `desktop_team_finish_operation` | 查询一次副作用的可信执行记录（只读，不接受模型自报结账） |

## 隐私与授权

**分级授权落在采集侧，不是先写进去再声称不会用。**

- `captureWindowTitles: false` 时，`assets/sampler.ps1` **压根不调用 `GetWindowText`**，macOS 的
  `assets/sampler-macos.js` 也**完全不碰 System Events**，未授权的标题不会先落进 JSONL 再被过滤。代价是活动只剩进程名，
  日报只能说到「用了 Word」而说不出「在写哪份文档」
- 两个平台都先按排除名单判定应用、命中就只记 `excluded`，**判定在读标题之前**，被排除的应用一次标题都不读
- macOS 上应用名、pid 与空闲时间（`ioreg` 的 `HIDIdleTime`）不需要任何权限；读窗口标题要给拉起 dsh 的应用
  「辅助功能」权限，并允许它控制「System Events」（自动化）。缺权限时样本如实写
  `titleUnavailable: "accessibility" | "automation"` 且不带标题，模式状态里也会提示原因，不拿应用名冒充标题
- `captureActivity: false` 时不开采样进程、不产生任何采样文件
- 只采集**前台窗口**，不读取任何应用内容；聊天内容只能由你主动导入
- 锁屏 / 无前台窗口期间记为 idle（macOS 上前台是登录窗口或屏保时同样记 idle）
- 保留期到点是**真删 JSONL 文件**，不是只删库里的派生观察——只删派生数据的话
  「保留 N 天」就是一句空话。语义事项和用户笔记是已经确认过的成果，不被保留期抹掉，留到你自己删为止
- 审批凭据与聊天令牌分离，只写给桌面壳主进程，**不进入模型上下文**
- 网页 / 文档 / 聊天 / 转写 / 专家消息一律视为不可信输入，不能提升权限；团队成员不能伪造 UI 批准

## 已知限制

这些是当前实现的真实边界，不是待修的 bug：

- **采样只支持 Windows 与 macOS**（Windows：PowerShell + user32；macOS：系统自带 `osascript -l JavaScript`，不加依赖）。
  其他平台（如 Linux）如实拒绝开启采集。**macOS 版尚未真机验证**。
  分类规则仍以 Windows 进程名为主，macOS 应用（如 `Google Chrome`、`Microsoft Word`）多数会归到 other，可用 `customRules` 补
- **从桌面开始会话依赖宿主的 `ctx.agents`**：部分宿主没有该服务时会返回 `agents-unavailable`；
  恢复失败时插件新建会话并如实给出原因
- **回复不是流式的**：桥接的 `chat` 一次性返回全文，桌面壳要等整段算完才能开始念
- **两个 SQLite 库都是明文落盘，没有静态加密**：库里存着窗口标题、日报正文与记忆原文。
  介意的话请勿开启助理模式，或自行加密磁盘
- 常驻的 dsh web 加载的是启动当时的插件构建：升级插件后必须重启 dsh web 才生效
- **成员沿用宿主工具依赖 DSH 开放子代理工厂**：宿主未向插件开放 subagents/预置组合时，成员回退插件会话＋
  只读网页桥；纯定时自主运行没有核心创建的父会话可 spawn，拿不到宿主核心工具，这是 DSH 侧能力边界
- **外部平台对接需配置独立签名凭据**：在本机通过 `assistant-platform-set` 填写同一环境的 `endpoint`、`appid`、`secret` 和 `userId`，不把密钥发给模型。遵循标准协议时无需自填 `signTemplate`。
- **企业微信接收能力全系统最多一位成员持有**（避免多成员抢同一渠道）；推送通知不要求该能力，
  只要企微已配置且收件会话已绑定（deliverHere）
- 桌宠的多角色舞台、语音、文档讲解以单测/e2e 覆盖为主，真机验收持续进行

## 开发与验证

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm test            # node --test "tests/**/*.test.ts"
pnpm run build       # esbuild 打包到 dist/
```

修改源码后必须重新构建，并把新的 `dist/index-*.js` 与 `package.json` 的 `main` 一起提交；
从 GitHub 安装的用户直接使用仓库里的构建产物。

单测能直接跑 `.ts` 的前提是**模块不沾 electron、不用参数属性、本地值导入写 `.ts` 后缀**
（Node 的 strip-only TypeScript 不会把 `.js` 重写成 `.ts`）。新模块一律用显式字段，
公共口径抽成纯函数模块（`spans.ts` / `time.ts` 是范例）。
`tsconfig.json` 只对 `src` 做类型检查；`tests` 由 `pnpm test` 直接运行，不参与 `tsc`。

## 许可证

代码采用 MIT，见 [LICENSE](./LICENSE)。桌宠的动画、图片、提示词与源视频素材采用
[CC BY-NC 4.0](../ASSETS-LICENSE.md)，禁止商业使用。

## 排障

| 现象 | 原因与处理 |
|---|---|
| `duplicate loader entry id: personal-assistant` | profile 层与插件层都 insert 了同一 id。删掉 profile 层那几行，或改用 `- id:` 覆盖 |
| 覆盖配置后宠物不自动拉起了 | `config` 是整体替换：覆盖层里没写 `petDir` 就会留空。要自动拉起就在覆盖层里写上你自己的 `petDir` |
| 开启助理模式被拒，提示迁移未完成 | 旧数据没搬完时采集闸门会拦住，避免新旧两套记录搅在一起。看日志里的 `migration <id>` 行 |
| 日报说不出在写哪份文档 | `captureWindowTitles` 关着，活动只剩进程名；macOS 上若样本带 `titleUnavailable`，是拉起 dsh 的应用缺「辅助功能」或「自动化（System Events）」权限 |
| 宠物自己重影了 | 起了两个运行时抢同一份 `bridge.json` 与采样器。桌面壳的逻辑是只要还有活着的运行时就绝不启动第二个 |
| 专家说调不动 write / bash | 执行点门禁生效了，需要走 `desktop_team_propose_action` 让用户批 |
| 批准明明给过却说失效 | 计划摘要变了（目标 / 参数 / 输入修订任一），或运行时代次变了，或超过 `approvalTtlMs` |
| 副作用任务的调用停住不动 | 在等桌面审批窗口的决定；批准前不会执行，驳回或到期（`approvalTtlMs`）就拒绝 |
| 任务停在 unknown | 有副作用结果不明（进程中断、工具报错或子代理没能释放），先人工核查真实外部状态；不会自动重发 |
| 带预算的任务拒启 `budget-unsupported` | 宿主没有累计硬上限，非零累计预算守不住；默认按 0 提交即可 |
| 宠物说「还没有连上 dsh 会话」（`503`，`code: unbound`） | 桥接已起但没绑定会话：在 dsh 里召唤宠物，或调 `POST /session/start` 从桌面开始。未绑定时对话与审批都不受理，待办留着，绑定后再处理 |
| `/session/start` 回 `agents-unavailable` | 当前宿主没有 `ctx.agents`（或还没装上）：只能在 dsh 里召唤宠物；插件不会退化成假成功 |
| 开始会话回 `created` 且带 `resumeError` | 上次自建的会话恢复不了（例如宿主没配会话持久化），已新建并如实给出原因；旧会话记录不会被删 |
| 新起的运行时没写 `bridge.json` | 另一个运行时正健康地占着它，加载时不抢；在这个运行时里召唤宠物即可接管 |
| 列表查询未发起：缺少 `app_secret`，或平台返回「签名校验失败」（业务码 100） | 用 `assistant-platform-get` 检查配置；确认测试/生产端点与 `appid`、平台分配的 `app_secret` 对应，不用成员聊天 API 密钥替代 |
| 企微消息分不清是哪个助理 | 推送已带 `【成员名】` 前缀；若看不到，确认该成员定时计划渠道为 wecom 且收件会话已绑定 |
| 召唤宠物重播旧英文汇报 | 自报播报有时间守卫，只念 60 秒内新鲜汇报；旧版无 `at` 的事件不念。升级后重启桌宠即可 |
| 讲解 md 表格没念 | 旧版会整段跳过；新版表格照念（格子转逗号）。确认桌宠已加载新构建 |
| 讲解中途混入总助理声音 | 成员音色缓存冷时回退总助理所致；新版开讲/交接前先暖缓存，全程成员嗓子。重启桌宠加载新构建 |
| 成员说改不了定时任务（企微） | 成员需有 `companion_member_schedule`（装配了 memberSchedule 即注册）；企微绑定本人可直接改自己的计划 |
