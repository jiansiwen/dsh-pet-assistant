# dsh-personal-assistant

DeepSeek Harness（dsh）的**个人电脑助理插件**。跑在 dsh 会话里，负责三件事：记录你当天在电脑上做了什么、
把你的长期偏好记下来并自动生效、把桌面宠物和专家助理团接进当前会话。

宠物那一侧（Electron 外壳、语音、文档讲解）在 [`dsh-pet/`](../dsh-pet/README.md)。

## 功能

### 活动记录与日报

- **开启个人助理模式**：后台采样 Windows 前台窗口（进程名，以及授权后的窗口标题），
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
- 同一主题下出现互相矛盾的说法时，两条都**停下不注入**，并在提示词里单独列出请你挑一条
- 删除记忆会如实返回四类结果（已删除 / 已失效 / 仍保留 / 无法控制），不是笼统一句「忘了」

### 会话桥接

- **召唤桌面宠物**：把宠物绑定到当前会话——宠物的对话经 `agent.followup` 注入本会话，
  使用相同的模型与凭据，**宠物端不需要配置任何 API key**
- 宠物消息**串行注入**，与 web 页面输入共用同一 inbox，不产生交错

### 桌面专家助理团（可选，默认关闭）

- **编制**：唐僧（总助理，可执行副作用）+ 孙悟空 / 猪八戒（只读专家）+ 沙僧 / 白龙马（未启用席位）。
  默认只有前三人上台，谁上台由配置 `teamSeats` 决定
- **派活**：`desktop_team_assign` 把任务交给指定成员，走真实子代理运行
  （`spawn` 不继承父上下文，专家只看得到任务材料），等真实结果回来
- **可信审批**：专家默认只读。需要外部副作用时提出提案，由用户在桌面审批窗口决定；
  批准绑定「任务 + 操作目标 + 参数摘要 + 输入修订」的哈希，改任何一项旧批准即失效
- **执行点门禁**：门禁装在子代理自己的 agent ctx 上，没有有效批准就调不动 write / bash 这类工具；
  装在全局 ctx 会连用户自己的调用一起拦，所以不那样做

### 主动提醒（design.md §2.7）

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

## 架构

```
dsh web（常驻）── 会话 S
 └─ dsh-personal-assistant 插件（profile 根作用域，单例）
     ├─ 会话桥接 SessionBridge：从 ToolRunContext.agent 捕获活体 agent
     │    → node:http 长轮询（127.0.0.1 随机端口 + token，零外部依赖）
     │    → POST /chat   GET /events?since=N   GET /team   POST /approval   GET /health
     │    → POST /proactive/{accept,decline,disable,enable}   POST /pet-state（§2.7 反馈）
     │    → 写 ~/.dsh/personal-assistant/bridge.json（端口 + 聊天令牌）
     │    → 写 ~/.dsh/personal-assistant/bridge-approval.json（审批凭据，与聊天令牌分离）
     │    → 配了 petDir 就 spawn `cmd /c pnpm start` 拉起宠物
     ├─ 采样器：插件托管子进程（不分离），插件卸载时由 ctx.effect 回收，不留孤儿进程
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
| `personal-assistant/bridge.json` | 桥接端口与聊天令牌（宠物读） |
| `personal-assistant/bridge-approval.json` | 审批凭据（只有桌面壳主进程读） |
| `desktop-team/team.sqlite` | 团队编制与任务（`teamEnabled` 时） |
| `storages/personal_assistant/` | **旧版**存储域，默认只读导入新库，不自动删 |

## 安装

```powershell
cd D:\work\dsh-personal-assistant
pnpm install
pnpm run build

# 装到 web profile（推荐：web 常驻、会话寿命长，最适合挂载宠物）
cd D:\work
npx @deepseek-ai/dsh plugin --profile web add ./dsh-personal-assistant
```

凭据沿用 dsh 已有配置（`~/.dsh/.credentials.yaml` 或环境变量），插件与宠物都不单独管理 key。

> 若 `dsh plugin add` 因环境问题失败，可手动复刻它做的事：profile 的 package.json 加
> `"dsh-personal-assistant": "link:<插件绝对路径>"` 依赖并加入 `dsh.profile.bundles`，
> 再在 profile 的 node_modules 里对插件目录建符号链接（junction 即可）。

### 开启团队（可选）

团队是**覆盖层**，不需要新建 profile：

```powershell
dsh --profile web --patch D:/work/dsh-personal-assistant/cordis.team.patch.yml
```

想常开就把那一条抄进该 profile 的 `cordis.patch.yml`。注意两点：

- 覆盖层用 `- id: personal-assistant` 而不是 `- insert:`。loader 对同 id 的 insert **不去重**，
  插件自带的 patch 已经 insert 过这一行，再 insert 一次会抛
  `duplicate loader entry id: personal-assistant`，整个 dsh 起不来。按 id 覆盖走的是另一条分支。
- `config` 是**整体替换，不是深合并**。所以覆盖层里必须把 `petDir` 一起重复写上，
  否则 bundle 层给的 `petDir` 会被顶掉，召唤宠物时就再也不会自动拉起 dsh-pet。

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
        petDir: ''                  # dsh-pet 工程目录；留空则召唤时不自动拉起

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
        defaultBudgetTokens: 200000
        approvalTtlMs: 300000       # 批准有效期；运行时代次变化会让旧批准立即失效
        denyExpertTools: []         # 额外从只读专家手里禁用的工具名

        # 主动提醒（design.md §2.7）
        proactiveEnabled: true      # 关闭后引擎彻底安静，也省掉评估定时器
        proactiveIdleMs: 480000     # 无输入多久后可以提醒（8 分钟）
        proactiveCooldownMs: 3600000 # 两次提醒的最小间隔（60 分钟）
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

### 助理（15 个，始终注册）

| 工具 | 用途 |
|---|---|
| `personal_assistant_summon_pet` | 召唤桌面宠物并绑定当前会话 |
| `personal_assistant_set_team_mode` | 开启/关闭团队模式（运行时挂载/卸载团队服务，选择持久化） |
| `personal_assistant_start` | 开启助理模式 |
| `personal_assistant_stop` | 关闭助理模式（不出日报） |
| `personal_assistant_status` | 模式状态与今日概览 |
| `personal_assistant_today` | 已解释事项 + 未解释片段 + 笔记 + 统计 |
| `personal_assistant_commit_events` | 提交语义解释 |
| `personal_assistant_import_records` | 导入聊天记录 / 随手记 |
| `personal_assistant_save_draft` | 保存日报草稿（产生新版本，旧版本状态作废） |
| `personal_assistant_get_draft` | 读取最新草稿与历史版本清单 |
| `personal_assistant_submit_report` | 草稿 → 待确认，返回 revision / digest / targetPath |
| `personal_assistant_confirm_report` | 校验版本号与摘要后落盘定稿并退出模式 |
| `personal_assistant_remember_preference` | 记录长期偏好（必须给 topic） |
| `personal_assistant_list_preferences` | 列出全部记忆及状态 |
| `personal_assistant_forget_preference` | 删除记忆，返回四类结果 |

### 团队（6 个，仅 `teamEnabled` 时注册）

| 工具 | 用途 |
|---|---|
| `desktop_team_start` | 把当前会话登记为总助理宿主，写入编制 |
| `desktop_team_assign` | 派任务给指定成员并等真实结果 |
| `desktop_team_status` | 成员 / 任务 / 待批提案 / 已执行操作 |
| `desktop_team_cancel` | 取消任务（已发生的外部副作用不撤回，会列出来） |
| `desktop_team_propose_action` | 提交副作用提案走用户审批 |
| `desktop_team_finish_operation` | 回填操作结果（succeeded / failed / unknown） |

## 隐私与授权

**分级授权落在采集侧，不是先写进去再声称不会用。**

- `captureWindowTitles: false` 时，`assets/sampler.ps1` **压根不调用 `GetWindowText`**，
  未授权的标题不会先落进 JSONL 再被过滤。代价是活动只剩进程名，
  日报只能说到「用了 Word」而说不出「在写哪份文档」
- `captureActivity: false` 时不开采样进程、不产生任何采样文件
- 只采集**前台窗口**，不读取任何应用内容；聊天内容只能由你主动导入
- 锁屏 / 无前台窗口期间记为 idle
- 保留期到点是**真删 JSONL 文件**，不是只删库里的派生观察——只删派生数据的话
  「保留 N 天」就是一句空话。语义事项和用户笔记是已经确认过的成果，不被保留期抹掉，留到你自己删为止
- 审批凭据与聊天令牌分离，只写给桌面壳主进程，**不进入模型上下文**
- 网页 / 文档 / 聊天 / 转写 / 专家消息一律视为不可信输入，不能提升权限；团队成员不能伪造 UI 批准

## 已知限制

这些是当前实现的真实边界，不是待修的 bug：

- **仅支持 Windows**（采样依赖 PowerShell + user32）
- **`~/.dsh/profiles/headless/cordis.patch.yml` 当前起不来**：它 insert 了 `id: personal-assistant`，
  与插件自带的 patch 撞同一个 id → `duplicate loader entry id`。修法是删掉 profile 层那几行。
  `~/.dsh` 在工作区外，改它需要你自己动手。开发与验证走 `web` profile
- **回复不是流式的**：桥接的 `chat` 一次性返回全文，桌面壳要等整段算完才能开始念
- **两个 SQLite 库都是明文落盘，没有静态加密**。`design.md` §9.3（第 452 行）把
  「数据密钥 + Windows DPAPI 保护 + 密钥恢复/丢失提示」写成敏感录音与正文启用前的准入条件，
  阶段 C 的依赖栏也写着「安全存储准入」——**这道闸目前没有实现**。库里现在存着的敏感内容包括
  窗口标题（`activity_span` 观察）、日报正文（版本化全文）与记忆原文。
  没做的原因不是忘了：`node:sqlite` 是裸驱动，加密要么落在驱动层（换 SQLCipher 一类的方案），
  要么落在字段层（只加密敏感列），两条路都得先决定密钥怎么存、用户换了机器或丢了密钥怎么办，
  而选错了会把用户已经攒下的记忆锁死。计划原文的要求是「未实现则禁用该类持久采集」，
  所以严格按计划，日报正文与窗口标题的持久化现在就该是关着的——这是**用户已拍板的偏离**
  （2026-09-06：暂缓加密），将来要补时，DPAPI + 数据密钥的技术路线已验证可行
- 团队阶段（编制落库、审批链路、状态机）已在 web profile 真机启动验证过；
  **桌面壳那一段端到端流程（多角色舞台、语音、文档讲解、群体场景、资源目标）尚未真机验证**，
  目前只有单测与构建覆盖。**注意：常驻的 dsh web 服务加载的是启动当时的插件构建——
  升级后必须重启 dsh web 才生效**，重启后跑 `node scripts/verify-restart.mjs` 一键确认
- 阶段 F 只做了**不被加密准入闸挡住的部分**（空闲提醒与授权执行，§2.7）；分轨录音、转写、
  纪要被闸挡住暂缓 —— 准入闸（design.md §9.3：敏感录音与正文启用前必须先实现数据密钥 +
  Windows DPAPI 保护 + 密钥恢复提示，未实现则禁用该类持久采集）留待你日后拍板补加密时再开

## 开发与验证

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm test            # 119 条单测，node --test "tests/**/*.test.ts"
pnpm run smoke       # 三套件冒烟
pnpm run build       # esbuild 打包到 dist/

# 重启 dsh web 之后跑一次：自动确认新构建已生效（schema v2 / 桥接健康 / 采样指标）
node scripts/verify-restart.mjs
```

`pnpm run smoke` 依次跑（前一个失败就短路，避免两份错误输出互相盖住）：

1. **团队存储 / 审批链路 / 任务状态机**（`scripts/smoke-team.ts`）
2. **会话桥接 HTTP 契约与回复归属**（`scripts/smoke-bridge.ts`）
3. **插件入口装配**（`scripts/smoke-apply.ts`）：用假宿主跑真 `apply()`，
   是装配顺序、迁移闸门、保留期、工具接线的唯一覆盖。它刻意不启真采样进程

冒烟要先打成 bundle 再跑，不能 `node` 直接执行 `.ts`：源码里有 TS 参数属性。
bundle 落在包内 `node_modules/.dsh-smoke` 而不是系统临时目录——桥接运行时要真 import
`@deepseek-ai/dsh-llm`，external 出来的裸标识符按产物文件位置向上找 node_modules，
放临时目录会直接 `ERR_MODULE_NOT_FOUND`。

单测能直接跑 `.ts` 的前提是**模块不沾 electron、不用参数属性、本地值导入写 `.ts` 后缀**
（Node 的 strip-only TypeScript 不会把 `.js` 重写成 `.ts`）。新模块一律用显式字段，
公共口径抽成纯函数模块（`spans.ts` / `time.ts` 是范例）。

## 排障

| 现象 | 原因与处理 |
|---|---|
| `duplicate loader entry id: personal-assistant` | profile 层与插件层都 insert 了同一 id。删掉 profile 层那几行，或改用 `- id:` 覆盖 |
| 覆盖配置后宠物不自动拉起了 | `config` 是整体替换。覆盖层里必须把 `petDir` 一起写上 |
| 开启助理模式被拒，提示迁移未完成 | 旧数据没搬完时采集闸门会拦住，避免新旧两套记录搅在一起。看日志里的 `migration <id>` 行 |
| 日报说不出在写哪份文档 | `captureWindowTitles` 关着，活动只剩进程名 |
| 宠物自己重影了 | 起了两个运行时抢同一份 `bridge.json` 与采样器。桌面壳的逻辑是只要还有活着的运行时就绝不启动第二个 |
| 专家说调不动 write / bash | 执行点门禁生效了，需要走 `desktop_team_propose_action` 让用户批 |
| 批准明明给过却说失效 | 计划摘要变了（目标 / 参数 / 输入修订任一），或运行时代次变了，或超过 `approvalTtlMs` |
