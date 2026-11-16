# dsh-pet-assistant 项目全景知识库

> **生成信息**：基于仓库提交 `7557b4d`（dev 分支）通读两侧全部源码生成；生成时间 2026-11-02。
> **信息来源与可信度**：以**源码**为第一事实；仓库内三份 README（根 / 插件 / 桌宠）为辅。
> 文档与代码不一致处用 **⚠️ 文档漂移** 显式标出，以代码为准。
> 行号引用格式 `文件.ts:行号`，路径相对于仓库根目录。

---

## 0. 使用说明

本文件是给"人 + AI 会话"共用的项目知识底座：开发前先查这里，改完代码后回来更新对应章节。

- **章节结构**：1–3 仓库与契约总览；4 插件（大脑）；5 桌宠（身体）；6 构建；7 测试；8 设计决策与不变量；9 已知限制；10 附录。
- **核对方式**：所有工具名、配置字段、HTTP 端点、SQLite 表名均已用 grep 对源码逐一核实（见 §4.12、§4.11、§3.3、§4.10）。
- **维护约定**：新增模块时在对应"逐文件地图"补一行；契约变化（端点/表结构/工具）必须同步 §3 与 §8。

### 代码规模（实测）

| 项 | 数量 | 说明 |
|---|---|---|
| 插件源码 | 61 个 `.ts`/`.tsx`，27,881 行 | `dsh-personal-assistant/src/`（含 `client/index.tsx`） |
| 插件测试 | 77 个 `.test.ts` | `dsh-personal-assistant/tests/` |
| 桌宠源码 | 117 个 `.ts`/`.tsx`，40,995 行 | `dsh-pet/src/`（main 55 / renderer 47 / preload 7 / 根 7 / types 1） |
| 桌宠测试 | 79 个 `.test.ts` | `dsh-pet/tests/`（另有 `meeting-fixtures.ts`、`pdf-fixtures.ts` 两个非测试辅助） |
| PowerShell 脚本 | 13 个 | 插件 3（`assets/sampler.ps1`、`assets/computer.ps1`、`tests/fixtures/computer-vision-synthetic.ps1`）+ 桌宠 10（`src/main/` 8：asr-wave/play/play-host/record/speak-once/wake/wake-grammar/win-uia，`assets/pointer-watch.ps1`、`scripts/setup-local-asr.ps1`） |
| 桌宠静态资源 | 9.6 MB | `dsh-pet/assets/`（⚠️ 根 README 写"约 11MB"，实测 9.6MB） |
| 代码知识图谱 | 361 文件 / 9,359 节点 / 92,614 边 | `.code-review-graph/graph.db`，构建于本提交 |

---

## 1. 项目定位与仓库总览

**一句话**：基于 [DeepSeek Harness（dsh）](https://github.com/deepseek-harness/deepseek-harness) 的个人电脑助理——记录你当天在电脑上做了什么、记住长期偏好、晚上出日报；桌面上站着几个可对话的角色，可以把任务派给专家真实执行。

仓库是**无 workspace 的双包结构**，两个包各自独立 `pnpm install`：

| 目录 | 角色 | 技术栈 | 安装方式 |
|---|---|---|---|
| `dsh-personal-assistant/` | **助理大脑**（dsh 插件）：活动跟踪、语义解释、日报版本化、记忆、会话桥接、专家团队与审批、渠道与会议 | TypeScript + esbuild，跑在 dsh web 进程内（cordis 4 插件） | `dsh plugin --profile web add ./dsh-personal-assistant` |
| `dsh-pet/` | **交互身体**（Electron 桌面壳）：多角色舞台、语音（ASR/TTS/唤醒）、会议录音、文档讲解、审批窗口 | Electron 37 + React 18 + esbuild（9 个 bundle） | 独立应用，`pnpm start` 源码运行或 electron-builder 打包 |

**关键关系**：
- dsh-pet **不是** dsh 插件，不能 `dsh plugin add`；先装插件，再按需启动桌宠。
- 桌宠不需要独立 API key：对话与模型凭据沿用绑定的 dsh 会话。
- 插件发布产物在 `dist/`，**从 GitHub 安装的用户拿到的就是仓库里的构建产物**（改源码必须同步提交 `dist/`）。

**许可证**：代码 MIT；桌宠动画/图片/提示词/源视频素材 CC BY-NC 4.0（禁商用），见 `LICENSE`、`ASSETS-LICENSE.md`。

**平台支持**（根 README §平台支持，代码分支核实一致）：

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 插件：活动采样 | ✅ | ✅（未真机验证） | ❌ |
| 插件：日报/记忆/会话桥接 | ✅ | ✅ | ✅ |
| 桌宠：窗口/舞台/面板/文档 | ✅ | ✅ | ✅ |
| 本地语音识别（离线） | ✅ | ✅ | ✅ |
| 回答朗读 | ✅ | ✅ | ❌ |
| 语音唤醒「小潘同学」 | ✅ | ⚠️ KWS 实验性、默认关 | ❌ |
| 会议录音加密落盘 | ✅ DPAPI | ✅ 钥匙串 | ✅ libsecret |
| 桌面动作（读窗口/WPS） | ✅ win-uia.ps1 | ⚠️ 部分（AppleScript） | ❌ |

---

## 2. 顶层架构与运行形态

### 2.1 进程与组件图

```
dsh web（宿主进程，常驻）
 └─ cordis 4 插件 dsh-personal-assistant（profile 根作用域，单例）
     ├─ apply() 装配（src/index.ts:271）
     │    ├─ 助理库 assistant.sqlite（记忆/观察/日报版本/事项/资料/删除账本）
     │    ├─ 团队库 desktop-team/team.sqlite（可选，teamEnabled 默认 false）
     │    ├─ SessionBridge：node:http 监听 127.0.0.1 随机端口
     │    │     → 写 <DSH_HOME>/personal-assistant/bridge.json（端口+token+epoch+pid+startedAt）
     │    │     → 写 bridge-approval.json（5 类审批凭据，仅桌宠主进程读）
     │    ├─ 采样器：插件 spawn 子进程跑 sampler.ps1 / sampler-macos.js，写 samples/YYYY-MM-DD.jsonl
     │    ├─ 保留期清理定时器、企微提醒投递循环（3s）
     │    └─ ctx.systemPrompt：记忆/模式/写入方式渲染进系统提示词
     │            ↕ HTTP 长轮询（Bearer token：chat / approval / report / assistant / companion）
     ├─ ChannelManager：邮件(POP3/IMAP)、企微、渠道会话工具（只读工具）
     └─ MemberRuntime / TeamService / CompanionTaskRuntime（成员、专家子代理、任务）
  ↕ 桥接
 dsh-pet（Electron 应用，单实例锁）
  ├─ 主进程 main/index.ts（4,489 行）：窗口、IPC、语音仲裁、会议、文档讲解、桌面动作
  │    ├─ CompanionHost（壳层）：托盘、分阶段启动握手、运行时所有权、专注/演示模式
  │    ├─ BridgeClient（harness.ts）：读 bridge.json 连桥接；断连→退场/收起
  │    ├─ ApprovalWindow / ReportWorkbench / CompanionTasks / MemberEditor（专用窗口）
  │    └─ 会议录音(meeting-recorder)、TTS(asr/tts/kws/wake)、文档(document/doc-*)
  ├─ preload（7 个 .cjs，contextBridge 暴露各窗口 API）
  └─ renderer（React 舞台 index.html + 6 个独立窗口页）
```

### 2.2 三层生命周期（刻意分离，勿混淆）

1. **窗口层**（`dsh-pet/src/main/index.ts`）：建透明置顶窗、鼠标穿透、自愈重载、退场动画。
2. **壳层**（`companion-host.ts`）：托盘常驻、启动 dsh 团队运行时的分阶段握手、运行时所有权。
3. **桥接层**（`harness.ts` ↔ 插件 `bridge.ts`）：会话绑定与命令通道。

壳活着 ≠ 角色可见；角色可见 ≠ 运行时连上；桥接连上 ≠ 会话已绑定（`/health` 的 `bound` 如实区分）。

### 2.3 启动与绑定时序

1. dsh web 启动 → 插件 `apply()`：开库 → 注册工具 → 启动 SessionBridge（**未绑定**也监听）→ 写 `bridge.json`。
2. 桌宠启动（用户 `pnpm start` 或插件 `personal_assistant_summon_pet` 在 `petDir` 执行 `pnpm start`）→ 读 `bridge.json` → 连接并长轮询 `/events`。
3. 绑定会话两条路：
   - **网页召唤**：用户在 dsh 说「召唤宠物」/会话头部「绑定会话」按钮（client 插件执行 `/bind-pet`）→ `bridge.bind(agent)`。
   - **桌面开始**：桌宠 `POST /session/start`（聊天令牌）→ 已绑定且存活返回 `existing`；否则经 `ctx.agents` 恢复插件上次自建会话（id 存助理库 `user_flags`，键 `session.id`）→ `resumed`；恢复失败新建 `created`（带 `resumeError` 如实说明）。
4. 会话销毁 → 插件 `onAgentDisposed` 推 `session-ended` → 桌宠：托盘常驻则只收起角色，否则退场动画 + 退出（`main/index.ts:4372-4379`）。

### 2.4 端到端数据流（典型场景）

**「我今天干了啥」**：`personal_assistant_today` → 读 `samples/*.jsonl` 聚合成 `ActivitySpan`（`spans.ts`，minSpanMs=3000 过滤噪声）→ `personal_assistant_commit_events` 增量语义解释 → `confirm_work_items` 需可信审批（auto 模式除外）→ `personal_assistant_save_draft` 版本化草稿（revision+digest）→ 桌面审批窗口确认 → `POST /report-approval` 批准 → 落盘 `reports/YYYY-MM-DD.md`（先 `beginPublish` 登记再写文件，中断由 `reconcilePublishJobs` 对账）。

**宠物发一句话**：桌宠 `POST /chat`（chat token）→ 插件造 `UserMessage`（记住 id）→ `agent.followup` 注入 → 因果折叠（`onAgentIdle` 按消息 id 定位轮次，`completed` 且无混入才结算）→ `reply` 事件推回桌宠；超时 5 分钟（`REPLY_TIMEOUT_MS=300_000`）先 `inbox.remove` 撤回，撤不回如实报 timeout 且不 cancel 共享会话。

**一次副作用审批**（团队工具链）：模型调 `desktop_team_propose_action` → `ApprovalService` 生成 `action_proposals` 行（params_digest=真实参数规范化摘要，input_revision=当前输入修订）→ 桥接推 `approval` 事件 → 桌宠**专用审批窗口**展示（`approval-card.tsx`，默认焦点在驳回）→ 用户点批准 → 主进程用 `bridge-approval.json` 的 approval 凭据 `POST /approval`（聊天令牌无效）→ `approvals` 落单次消费行 → 执行点 `gate.ts` 消费时**重新校验**摘要/代次/期限/任务状态 → 执行一次后 `operations` 记账；任何一项不匹配即拒绝且不执行。

**渠道入站一条消息**：企微 WebSocket → `wecom.ts` 分发 → `channels.ts` 冻结快照 → 白名单/配对检查（陌生人单聊走配对码）→ `channel_messages` 摘要去重 → 按会话串行队列 → `channel-assistant` 子代理（独立预算门禁+工具白名单）→ 回复只走 `replyStream(req_id)`；结果 unknown 不重发不转主动发送，执行/回复中重启的记录入账 `unknown` 待人工核查。

**会议纪要生成**：用户在会议页点"用模型生成纪要" → 主进程弹**原生对话框**（列出发什么/发给谁）→ 同意后 `meeting-minutes.ts` 拼提示词（会议文字包随机 nonce 围栏，声明不可信）→ 模型回复经 `parseModelReply`（非法 JSON 如实失败）→ `validateModelMinutes` **逐条核对来源**（段存在/属本场/属当前版本/字重合，模型补的负责人/期限改"待确认"）→ 渲染层审阅改稿 → 本人确认 → 定稿入 `minutes` 表（digest+confirmedAt）；后续 `meeting.artifact.read` 取正文必须 sha256 与登记一致。

**帮助任务改一个文件**：主动提醒点"好" → `help_candidates`（只用已有事实）→ `help_choose` 提交范围审批 → 用户在审批窗口授权（`help_contexts` 落表）→ 模型 `desktop_team_open_help_task` → `read`（授权内，返回全文哈希作基线）→ `propose_change`（不写文件；diff 严格套基线，hash 不符拒绝）→ 审批窗口看真实 diff → 批准 → 可信执行器 `apply_change`：临时文件+fsync+改名，**批准后文件被外部改动则冲突零写入** → `run_verification`（参数数组、真实退出码、前后目录快照）→ 账本推出 verdict；有 unknown 即阻塞后续并等人工 `review_unknown`。

---

## 3. 跨包契约层

两侧**唯一**的硬契约：两个 JSON 凭据文件 + 一套 HTTP API + 一组共享类型。改任何一处两侧都要动。

### 3.1 磁盘布局

| 路径（`<DSH_HOME>` = `$DSH_HOME` 或 `~/.dsh`） | 写者 | 内容 |
|---|---|---|
| `<DSH_HOME>/personal-assistant/bridge.json` | 插件 | 桥接端口 + chat token + 代次 + 写者 pid/startedAt（0600） |
| `<DSH_HOME>/personal-assistant/bridge-approval.json` | 插件 | 5 类审批凭据 + epoch + port（0600）；**仅桌宠主进程读** |
| `<DSH_HOME>/personal-assistant/assistant.sqlite` | 插件 | 助理库（schema v2，WAL）：记忆/观察/日报/事项/资料/删除账本等 |
| `<DSH_HOME>/personal-assistant/assistant-legacy.sqlite` | 插件 | 旧存储域 `personal_assistant`（version 0）只读导入源 |
| `<DSH_HOME>/personal-assistant/samples/YYYY-MM-DD.jsonl` | 采样子进程 | 前台窗口采样（每行一条 Sample） |
| `<DSH_HOME>/personal-assistant/reports/YYYY-MM-DD.md` | 插件 | 定稿日报（Markdown） |
| `<DSH_HOME>/personal-assistant/screenshots/` | 插件 | 电脑操作截图（computer.ps1） |
| `<DSH_HOME>/personal-assistant/channels.json` / `channels.log` | 插件 | 渠道配置 / 日志 |
| `<DSH_HOME>/personal-assistant/wecom.json` / `wecom.secret` | 插件 | 企微配置 / 加密凭据 |
| `<DSH_HOME>/desktop-team/team.sqlite` | 插件 | 团队库（`teamEnabled` 时） |
| `<DSH_HOME>/dsh-pet/launch.log` | 插件 | 召唤拉起桌宠的启动日志 |
| 桌宠 `userData/pet-settings.json` | 桌宠 | 舞台/语音/文档/会议等全部设置（`settings.ts:78`） |
| 桌宠 `userData/meeting.sqlite` | 桌宠 | 会议库（录音/转写/纪要/讲解状态，`meeting-store.ts`） |
| 桌宠 `userData/voice-apis.json` | 桌宠 | 自配 TTS/ASR 服务，**密钥经 safeStorage 加密**（`main/index.ts:3379`） |
| 桌宠 `userData/companion-owner.json` | 桌宠 | 运行时所有权记录（pid+startedAt+instanceId，`companion-host.ts:635`） |

### 3.2 两个凭据文件的结构

**`bridge.json`**（插件 `bridge.ts:1413-1431` 写出；桌宠 `harness.ts:113` 读取）：

```jsonc
{
  "port": 49233,          // 127.0.0.1 随机端口
  "token": "<sha256 hex>", // 聊天令牌：发消息/读快照，签不出批准
  "epoch": "<uuid>",       // 会话代次；旧文件可缺省（失去代次隔离但仍可用）
  "pid": 12345,            // 写者的运行时进程号
  "startedAt": 1730000000000 // 启动时刻：pid+startedAt 才能区分"我启动的"与"本来就在跑的"
}
```

**`bridge-approval.json`**（同处写出；桌宠 `harness.ts:123-150` 读取，**只进主进程**）：

```jsonc
{
  "approvalToken": "...",        // POST /approval（团队动作）
  "reportApprovalToken": "...",  // POST /report-approval（日报发布/删除）
  "assistantApprovalToken": "...",// POST /assistant-approval（日报编辑/工作事项确认/记忆/项目证据/删除操作/截图审批）
  "companionOwnerToken": "...",  // /companion/v1/* subject=owner（任务与提醒窗、成员、助手设置）
  "companionExecutorToken": "...",// /companion/v1/desktop/claim（桌面提醒执行循环）
  "epoch": "...", "port": 49233
}
```

凭据设计的三条铁律（两侧注释反复强调）：
1. **聊天令牌与审批凭据分离**：`bridge.json.token` 能发消息，**签不出批准**；审批只认 `x-dsh-approval-token` 等独立头。
2. **审批凭据不进模型上下文、不经 IPC 给渲染层**：桌宠只有主进程读它（`harness.ts:9-13` 明言"这不是操作系统沙箱，任意本地文件读取者仍可能获得它"）。
3. **会话销毁/断连即失效**：`onAgentDisposed` 清 4 类凭据；桌宠断连清审批卡（`main/index.ts:4370`）。

### 3.3 HTTP API 总表（插件 `bridge.ts`）

鉴权：`Authorization: Bearer <token>`，token 为 sha256 hex，`timingSafeEqual` 比较。**除 `/health` 外全部要求鉴权**；未绑定会话时对话/会话命令/审批回 `503 {code:"unbound"}`（绝不伪装已连接），`GET /session` 照常返回 `disconnected` 快照。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/health` | 无 | 探活：`{ok,bound,epoch,ownerPid,startedAt,approvalCredentials:{approval,report,assistant,companionOwner,companionExecutor}}` |
| GET | `/session` | chat | 当前会话完整消息页（分页 `beforeSeq`、`bindingId` 校验） |
| POST | `/session` | chat | 绑定会话内命令：`prompt` / `cancel`（run·mute·pause·resume + 定向 taskId/requestId）/ `model` / `permission` |
| POST | `/session/start` | chat | 从桌面开始/恢复会话 → `{outcome: existing\|resumed\|created, owned, resumeError?}`；宿主无 `ctx.agents` → `503 agents-unavailable` |
| GET | `/events?since=N` | chat | 长轮询事件流；每事件带 `seq`+`epoch`，环形保留 512 条（`EVENT_RETENTION`） |
| POST | `/chat` | chat | 宠物发消息（串行队列，一次只在飞一条） |
| POST | `/chat/cancel` | chat | 按 requestId 定向取消（`scope` 同上）→ `CancelReceipt` |
| POST | `/team/cancel` `/team/pause` | chat | 按团队任务 id 定向取消/暂停子代理 |
| GET | `/team` | chat | 成员/任务/待批提案快照 |
| POST | `/approval` | **approval** | 团队动作批/驳（带 `epoch`+`windowId`） |
| POST | `/report-approval` | **report** | 日报发布/删除批/驳 |
| POST | `/assistant-approval` | **assistant** | 助理动作批/驳（含 `windowId`） |
| GET/POST | `/workbench/*` | chat | 日报工作台（视图/逐条修订/请求发布/请求删除；只生成待批，不能批准） |
| POST | `/proactive/{accept,decline,disable,enable}` | chat | 主动提醒反馈（白名单四选一） |
| POST | `/pet-state` | chat | 桌宠上报 `{focus,visible,meeting}`（主动提醒候选闸门） |
| POST | `/evidence/intake` | chat | 外部证据上报（窗口文字/会议纪要） |
| POST | `/companion/v1/*` | **companion owner** | 任务与提醒/成员等命令（`task-runtime.ts` 处理） |
| GET/POST | `/companion/v1/settings`、`/settings/wecom`、`/settings/reminders`、`/settings/agent`、`/settings/wecom/reconnect` | **companion owner** | 助理设置读写（`assistant-settings.ts:48-49` 注册；zod 校验+事务回滚+STALE_REVISION 409） |
| POST | `/companion/v1/desktop/claim` | **companion executor** | 桌面提醒执行器领取投递 |
| POST | `/companion/v1/desktop/result` | **companion owner** | 执行结果回执 |
| POST | `/executor/v1/*` | **companion executor** | 可信执行器回执 |

事件类型（`BridgeEvent`，桌宠 `harness.ts:353-412` 逐类转发）：`reply`（宠物请求回复，attribution=causal/task）、`team/*`（member/task/proposal/operation 等）、`session/update`（会话快照增量）、`session-ended`、`desktop/command` 与 `desktop/cancel`（桌面端单动作命令）、`proactive`（固定文案气泡）、`notice`（邮件/成员值守通知，>1h 不弹）。

### 3.4 会话快照与命令类型（`dsh-pet/src/session-types.ts`，插件侧同构）

- `SessionSnapshot`：`{sessionId, bindingId, cursor, title, status: idle|running|waiting|disconnected, entries[], hasMore, model, models[], permissions[], capabilities{prompt,cancel,models,permissions,history}, error?}`
- `SessionEntry`：`{id, seq, role, kind: text|think|tool, text, name?, result?, status?, streaming?, turn?}`
- `CancelReceipt`：`{state: not-executed|cancelling|terminated|partially-executed|unknown, evidence{kind,at?,requestId?,taskId?,...}, message}`——**回执描述被取消那次运行的真实状态，不是 HTTP 请求的结果**；`unknown` 时桌面如实报"结果未知"，绝不猜成功。

### 3.5 伴随（Companion）任务协议（插件 `src/companion-contract.ts` ↔ 桌宠 `src/companion-types.ts`）

- **任务种类** `COMPANION_TASK_KINDS`：`reminder` / `mail-send` / `mail-analyze` / `context-analyze` / `document-translate` / `desktop-action` / `meeting` / `presentation` / `skill-run` / `memory-maintain` / `agent`。
- **阻塞原因** `COMPANION_BLOCKERS`：`device-offline` / `budget` / `credentials` / `permission` / `input-changed` / `manual-pause`。
- **任务状态**（`TASK_LABELS`）：`created` 已创建 / `queued` 排队中 / `running` 进行中 / `awaiting-approval` 等待批准 / `awaiting-user` 等待处理 / `review` 待复核 / `done` 已完成 / `failed` 失败 / `cancelled` 已取消 / `unknown` 结果未知。
- **提醒计划** `ReminderSchedule`：`once` / `interval`（60s–31,536,000s）/ `daily`（`HH:mm`+时区），zod `strict()` 校验，时区经 `Intl.DateTimeFormat` 验证。
- **提醒回应**：`ack` / `snooze`（必须带 `snoozedUntil`）/ `cancel`；`reminderResponseSchema` 约束"snooze 必须有时间，其他不能带"。
- **协议版本**：`companionCommandSchema.protocolVersion = 1`，带 `commandId`+`expectedRevision`+`expiresAt`（乐观并发 + 过期）。
- **错误形状**：`CompanionError{code, message, status=409}`；HTTP 包装 `CompanionReply{ok,status,data,code?,error?,approvalWindow?}`。

### 3.6 桌宠 IPC 契约（概览，完整清单见 §5.8）

- **凭据边界**：审批卡读取/决定 IPC 只在 `ApprovalWindow` 注册（`main/index.ts:3771-3774` 注释："舞台不再有直接批准这条通道"）。
- **来源核验**：几乎所有敏感 `ipcMain.handle/on` 先过 `stageSender(event)`（只认舞台窗口 + `event.senderFrame.url` 必须是 `index.html`）；阅读视图/审批页走各自控制器的 `checkSender`。
- **preload 分包**：`index.cjs`（舞台 petApi，约 20+ 方法）/ `approval.cjs`（只暴露读卡片+提交决定）/ `doc-view.cjs`（凭令牌取会话/字节/页许可，**无路径接口**）/ `companion-tasks` / `member-editor` / `office-view` / `report-workbench`。

### 3.7 共享类型文件清单（改契约两侧同步）

| 类型 | 插件侧 | 桌宠侧 |
|---|---|---|
| 会话快照/命令/取消回执 | `bridge.ts` + `session-mirror.ts`（同构推导） | `src/session-types.ts` |
| 伴随任务协议 | `src/companion-contract.ts`（zod，权威） | `src/companion-types.ts`（手写校验，含 UI 文案表） |
| 证据接收 | `src/evidence-intake.ts` | `src/evidence-types.ts` |
| 成员类型 | `src/member-*.ts` | `src/member-types.ts` |
| 语音服务配置 | —（插件不碰） | `src/voice-api-types.ts` |
| 助手设置 | `src/assistant-settings.ts` | `src/assistant-settings-types.ts` |
| 团队快照/提案 | `src/team-domain.ts` | `src/renderer/types.ts`（TeamSnapshot 等） |

## 4. 插件 dsh-personal-assistant

dsh 插件（cordis 4，profile 根作用域单例），入口 `src/index.ts`（1,122 行）。
`export const inject = ['tools', 'storageDomain', 'systemPrompt']`——**只声明必需服务**；
`agents` 服务刻意不写进 inject（cordis 4 中 inject 每一项都是必需依赖，写进去会让没有它的宿主整个插件停在 pending），用到时 `ctx.get('agents')` 现取（`index.ts:60-65`）。
装配顺序：开助理库 → 迁移旧域 → 建各存储类 → 注册工具 → 启动 SessionBridge → 渠道/邮件/企微/会议 → 团队挂载（teamEnabled 时）→ 保留期与投递循环。

（§4.1–§4.10 的逐文件地图、功能域详解与数据模型见下文，按域补入。）

### 4.1 逐文件地图（dsh-personal-assistant/src，61 个文件 / 27,881 行）

**A. 核心与跨包契约（7）**

| 文件 | 行 | 职责 |
|---|---|---|
| `index.ts` | 1122 | 插件入口 `apply(ctx, config)`：装配全部服务与工具、注册宿主命令、启动桥接与采样器（详见 §4.2） |
| `config.ts` | 154 | schemastery 配置模式，30 项顶层 + `customRules` 3 子字段（见 §4.11） |
| `bridge.ts` | 2403 | HTTP 桥接服务：端点/鉴权/事件折叠/会话所有权/取消回执（见 §3） |
| `tools.ts` | 1532 | 35 个 `personal_assistant_*` 工具 + 系统提示词装配（见 §4.3） |
| `store.ts` | 160 | SQLite 工具层：WAL、`inTransaction`（savepoint 可嵌套）、`dryRun`、`text()` |
| `domain.ts` | 109 | 旧存储域 v0 契约：`days`/`preferences`/`semantic_events`/`reports` 四表的读写类型 |
| `companion-contract.ts` | 135 | 桌宠任务/提醒/阻塞项/回执的 zod 契约（§3 companion 协议的权威定义） |

**B. 活动采样 / 观察 / 日报 / 记忆（16）**

| 文件 | 行 | 职责 |
|---|---|---|
| `sampler.ts` | 378 | 采样子进程托管：平台脚本选择（win32→`sampler.ps1`、darwin→`sampler-macos.js`）、环境变量契约（`DSH_SAMPLE_DIR/TITLES/EXCLUDED_*`）、JSONL 读写、保留期真删（`pruneSampleFiles` 用 `unlinkSync`）、`pruneSampleRange` 区间删除 |
| `classifier.ts` | 148 | 进程名→类别（chat/browser/document/dev/meeting/ai/terminal/idle/other），自定义规则优先，浏览器标题命中 AI 关键词改判 `ai`，标题截 200 字符 |
| `spans.ts` | 70 | 纯函数聚合：连续同「进程+分类+标题」且间隔 ≤3×采样间隔合并为片段，短于 `minSpanMs` 丢弃（tracker 与迁移共用口径） |
| `tracker.ts` | 260 | 活动跟踪器：管理采样子进程生命周期（= 助理模式生命周期，dispose 必调否则留孤儿进程）、模式状态、按需聚合；旧域只写 `days` 表 |
| `observation.ts` | 305 | 观察库：`observations`/`deleted_activity_ranges`/`activity_retention_boundary` 三表；与删除区间重叠的 `activity_span` **静默不写**（防备份还原让已删时段复活）；保留期边界只进不退 |
| `retention.ts` | 69 | 保留期执行：按 `retentionStartDate` 真删采样文件、观察、记忆、日报与工作事项的历史 |
| `report.ts` | 935 | 日报状态机：草稿→待确认→已批准→发布中→已归档/已撤销；确认绑定 `reportId+revision+digest+targetPath` 四样；发布走临时文件→校验摘要→原子改名，作业状态入库可崩溃对账 |
| `report-approval.ts` | 342 | 日报可信审批：独立于团队的专用凭据通道（`POST /report-approval`），模型只能提交，消费一次立即发布 |
| `workbench.ts` | 727 | 日报工作台服务：挂在 `/workbench/*`（聊天令牌），只读视图+逐条修订+请求发布/删除（生成待批提案），**无任何"批准"入口**，不接受渲染层指定路径或正文 |
| `change-set.ts` | 657 | 改动提案纯逻辑与原子提交：diff 严格套基线（不做模糊匹配）、审阅差异由插件重算不采信模型统计、临时文件+fsync+改名、冲突零写入 |
| `deletion.ts` | 694 | 六类删除（草稿条目/日报版本/时间段活动/导入资料/长期记忆/导出文件）分开处理，无"全部清空"；除草稿修订外全部走可信审批 |
| `memory.ts` | 1009 | 长期记忆：来源（`memory_sources`+删除传播）、范围（global/project）、状态（candidate/confirmed/conflicting/expired，只有用户能抬 confirmed）、删除账本 `deletion_ledger` |
| `work-items.ts` | 445 | 工作事项：来源必须本地可查（查不到整批拒绝）、证据类型由系统判定不采信模型自报、`user_confirmed` 只能由可信闭包设置、来源被删→`evidence_removed` |
| `materials.ts` | 483 | 资料库：按内容摘要去重、`modelVisible` 单独记账（读取≠允许发模型）、删除留墓碑、返回正文必包"不可信资料"边界 |
| `migrate.ts` | 466 | 旧域+采样 JSONL 只读迁移：旧域不原地升级、保留旧 id/时间/来源不凭空补证据、迁移失败不启动采集；批次层 `(batch_id, source_digest)` 幂等 |
| `legacy.ts` / `time.ts` | 137/34 | 旧数据只读适配器（依赖收窄为 `LegacyTables`）；本机日期归属纯函数（避开 tracker 参数属性语法以进 `node --test`） |

**C. 团队 / 审批 / 成员 / 任务运行（20）**

| 文件 | 行 | 职责 |
|---|---|---|
| `team.ts` | 1153 | 团队服务：稳定成员身份、任务状态机、子代理委派（回复归属由 `SubagentRun.result` 决定不靠 idle 猜）；副作用任务启动前装定向审批门禁、启动后在精确子代理 ctx 装门禁 |
| `team-domain.ts` | 2625 | 团队数据层（单写入者）：`assistants`/`tasks`/`task_runs`/`action_proposals`/`approvals`/`operations`/`change_*`/`verifications`/`operation_reviews`/`events_outbox`/提醒调度组/`channel_inbound`/邮件账本组等 ~40 张表 |
| `approval.ts` | 790 | 审批签发与消费：批准只能由可信交互主体（桌面壳主进程的独立审批凭据）签发；执行点消费时重新校验摘要、期限与范围 |
| `assistant-approval.ts` | 156 | 助理敏感操作：模型只提交固定快照（`content/target/epoch/expiresAt`），`POST /assistant-approval` 一次消费执行 |
| `gate.ts` | 429 | 执行点权限：**明确允许只读集合**，未知工具与再委派默认拒绝；`DELEGATION_TOOL_CANDIDATES`（subagent/workflow/send_message…）拦截再委派；写类目标 realpath 规范化比对（父会话工作目录内，含相似前缀/穿越/悬空拒绝） |
| `task-runtime.ts` | 863 | 桌宠任务运行时：companion 命令/输入/上下文/提醒的 zod 校验与账本流转，重放同 id 返回同一任务 |
| `team-tools.ts` | 583 | 团队 12 工具注册与提示词编排：点名解析失败即拒绝不静默换人；批准 id 不进模型上下文（模型只持 proposalId） |
| `task-tools.ts` | 141 | 渠道会话任务工具 7 个：解析 `channel-<hex>-<uuid>` 会话身份，渠道执行器单独领取 |
| `member-runtime.ts` | 555 | 成员执行器：12 个动态成员工具（只读工具集 `READ_ONLY_ALLOW_TOOLS`/`CHILD_LOCAL_TOOLS`）、额度账本、模型调用 |
| `member-directory.ts` | 530 | 成员名录：`assistant_profiles`/`member_channel_sessions`/`member_quota_*`/`member_usage` 表与迁移 |
| `member-management.ts` | 177 | 成员管理命令：草稿生成、权限三档、CAS 保存、删除 |
| `member-contract.ts` | 96 | 成员能力/权限/配额的类型与标签常量 |
| `member-assistant.ts` | 138 | 成员助理侧：默认模型解析（从当前 profile 补丁读 provider/model） |
| `member-memory.ts` | 116 | 成员记忆：`MEMORY_KINDS` 分类读写，忙碌时拒绝修改 |
| `reminders.ts` | 383 | 提醒生命周期：创建→领取→投递→本人回应同一任务账本；企业微信提醒只发已绑定会话 |
| `scheduler.ts` | 50 | 调度纯函数：`firstScheduleAt`/`nextScheduleAt`（Intl 时区日历计算） |
| `host-agents.ts` | 33 | `hostAgentRegistry(ctx)`：inject 不声明 agents/llm（无这些服务的宿主也要能装载），生产 `ctx.get` 现取 |
| `desktop-commands.ts` | 104 | 桌面命令等待器：`desktop/command` 事件推送、一次性回执（同 id 只结算一次）、超时与取消 |
| `verify-command.ts` | 269 | 验证命令可信执行：程序绝对路径绑定进批准、**绝不经 shell**、只传基础环境变量（凭据变量不传）、超时杀整棵进程树、输出首尾截断 |

**D. 渠道 / 邮件 / 会议交接 / 电脑操作 / 主动帮助 / 证据（17）**

| 文件 | 行 | 职责 |
|---|---|---|
| `channels.ts` | 443 | 渠道统一管理：白名单+配对绑定、跨重启去重（`channel_messages` 摘要）、按会话串行队列、整句"允许/拒绝"交回统一审批、`deliverHere` 防无授权群发、回复 not-sent/unknown 二分且一律不自动重发 |
| `channel-agent-settings.ts` | 174 | 渠道 agent 局部钩子：每轮 token 预算门禁（输入+输出+缓存读写不重叠求和）、provider/model/maxTokens 覆盖、助理名/人设注入；必须在原始 agentCtx 上调用 |
| `wecom.ts` | 142 | 企微智能机器人 WebSocket 适配器：只用 req_id 走 `replyStream`、无限重连、失败→unknown 不转主动发送 |
| `mail.ts` | 279 | SMTP 发送：DPAPI 解密口令（`mail.secret`）、发送账本先登记后发送、回执全量校验（accepted/rejected 与期望收件人全等）、unknown/partial 拒绝自动重发 |
| `mail-watch.ts` | 372 | IMAP 未读值守：UIDVALIDITY 代次防重、逐页推进不跳缺口、只抓内联片段（≤64KB）、分析先落库再通知、提示词声明邮件正文是外部材料 |
| `meeting-mail.ts` | 153 | 纪要→邮件交接：模型只给产物编号，正文由桌面重验的固定产物取得（sha256 全等校验）；发送接受后 +120s 安排企微催办 |
| `meeting-presentation-tools.ts` | 133 | 录音与讲解的桌面命令代理：只做参数校验与转发，授权/开录/回执由桌宠产生 |
| `computer.ts` | 443 | 电脑操作 7 工具：目标授权（120s 过期）→动作授权→执行三级令牌；窗口身份只来自 PowerShell 快照从不来自模型参数；截图仅 win32；apply 消费发生在任何 await 之前（不可重放） |
| `computer-vision.ts` | 204 | 单次截图分析：`MAX_IMAGE_BYTES=8MB`、服务身份用 `Symbol.for('cordis.original')` 比较、`tools: []` 绝不调工具、PNG 结构粗验、失败三分法 |
| `assets/computer.ps1` | 340 | Windows 辅助进程：前台身份核验（**前台必须是目标窗口否则拒绝**）、UIA 控件树（密码控件显示"受保护输入"不递归）、SendInput 注入、GDI 截屏 |
| `proactive.ts` | 283 | 主动帮助策略引擎（纯函数）：13 种跳过原因的判定顺序（disabled→focus→meeting→stale-sample→…→already-reminded→cooldown）；连续拒绝 3 次改发 suggest-disable；`proactive_disabled` 落 `user_flags` |
| `help-context.ts` | 538 | 帮助授权表 `help_contexts` + episode 状态机 `help_episodes`（offered→accepted→scope-pending→scoped→closed，offer TTL 30min、active 2h）；候选只来自已有事实，不为出候选读项目 |
| `help-task.ts` | 1327 | 帮助任务可信执行全链路：授权→读取→改动提案→桌面批准→临时文件+改名应用（基线哈希冲突零写入）→验证命令（参数数组+真实退出码）→unknown 人工复核→verdict 完全由账本推出；`.git` 拒读写 |
| `evidence-import.ts` | 267 | 项目证据拉取：realpath 授权边界、文件 ≤256KB/≤400 行、`git diff` 禁 fsmonitor/textconv、批准后重读 digest 一致才登记 `modelVisible:true` |
| `evidence-intake.ts` | 178 | 桌面壳证据收件（`POST /evidence/intake`）：kind 白名单、空正文拒收、默认 `modelVisible:false`、digest 不一致收下但警告 |
| `assistant-settings.ts` | 364 | 助理设置服务：zod 严格校验、事务目录 journal+回滚（恢复顺序固定：先禁 wecom→恢复 secret→settings→wecom）、企微密钥 DPAPI 加密写入（仅 Windows，非 win32 报 `CREDENTIALS_UNSUPPORTED`） |
| `session-mirror.ts` | 364 | 面板原生会话镜像：只投影真人输入（`source.kind==''|'user'`）、换绑 stale 丢弃、分页 50 条、权限白名单走 `/permission` 命令 |
| `pet-dir.ts` | 53 | 桌宠目录解析：`config.petDir` > `DSH_PET_DIR` > 插件同级 `dsh-pet`，缺失时返回原因供 UI 解释 |

**E. 客户端（1）**：`client/index.tsx`（199 行，见 §4.2 末）。

### 4.2 会话装配与宿主接入（`index.ts`）

`apply(ctx, config)` 是唯一入口，`inject = ['tools', 'storageDomain', 'systemPrompt']`（L65）；`agents`/`llm`/`commands` 等宿主服务**不在 inject 里**，经 `ctx.get` 现取（`host-agents.ts`），保证没有这些服务的宿主也能装载。装配顺序（行号为 `index.ts`）：

1. **解析默认模型**（L106-120）：新会话不自动继承桌面默认模型，从当前 profile 补丁文本里正则读出 `provider/model`。
2. **存储域 + SQLite**：打开 `assistant.sqlite`（v2），实例化各 Store（L327-331）。
3. **采样器**（L306-318、L408）：脚本路径 `../assets/<samplerScriptName(platform)>`；`ActivityTracker` 生命周期即助理模式生命周期。
4. **桥接**（L460）：`new SessionBridge({...})`，持有 chat token 与 approval 双凭据文件。
5. **团队与成员**（L477-512）：`TeamStore(teamStorePath)`（独立 `team.sqlite`）→ `MemberRuntime` → `MemberAssistant` → `MailWatcher.start()` → `ApprovalService` → `CompanionTaskRuntime.start()`。
6. **工具注册**（`ctx.effect(..., 'personal-assistant:*')` 幂等标签）：companion（L532）→ computer（L535，条件注册）→ mail（L543）→ meeting-mail（L658）→ meeting-presentation（L667）→ assistant tools（L856，35 个）→ help episode tools（L928）→ team tools（L1070，可注销回退）。
7. **设置与渠道**（L567-636）：`AssistantSettings`（含企微连接互斥：渠道处理消息时拒绝重连）→ `ChannelManager`（渠道 agent 用固定工具白名单+`tokenBudget:0`）。
8. **主动帮助**（L696）：`ProactiveHelpFlow` 装配。
9. **审批服务三件套**（L746-749）：`AssistantApprovalService`（epoch=桥接代次、TTL≥10s）、`ReportApprovalService`（挂到 bridge）、团队 `ApprovalService`。
10. **用户命令**（L882、L194-301）：`registerUserCommands` 经宿主 `commands` 服务注册 `/summon-pet`（召唤+绑定+拉起）、`/bind-pet`（只绑定）、`/assistant-on`、`/assistant-off`；**不经模型、不产生消息**；宿主无 commands 服务静默跳过，晚到则等它出现（`ctx.inject(['commands'], ...)`）。
11. **团队服务**（L1045-1083）：`TeamService` + 条件注册团队工具；`agent/status`、`agent/disposed` 事件接线（L935-938）。

**客户端**：`client/index.tsx` 注入 `['slots','uiSession','remote','remote.commands']`，渲染三处 UI——左侧导航「个人助理」面板（`sidebar.panellist`，PANEL_ID `personal-assistant`，order 30）、主区面板（按钮「召唤宠物」→`/summon-pet`、「开启个人助理」→`/assistant-on`，经 `remote.commands.execute`）、会话头部「绑定会话」按钮（`/bind-pet`，order 20）。全部走宿主命令通道，不另建通信。

### 4.3 工具与系统提示词层（`tools.ts`）

- 35 个 `personal_assistant_*` 工具在 `registerAssistantTools(ctx, tracker, deps)` 中注册（完整清单见 §4.12 A–D 组）。
- 系统提示词经 `systemPrompt` 服务按 section 注册（order 分层）：核心行为规则、活动/日报口径、记忆规则（candidate/confirmed 状态机）、团队协作、渠道不可信材料声明、主动帮助引导（`personal-assistant-proactive-help` order 155）、渠道 agent 人设（`personal-assistant:channel-agent` order 160）。
- **不可信材料边界**在提示词与代码两侧同时落实：聊天/网页/文件/邮件/截图正文一律声明为数据而非指令（`channels.ts:150-152`、`mail-watch.ts:345`、`computer.ts:253`、`computer-vision.ts:160`、`evidence-import.ts:214`）。
- 工具默认**只提交待批**：`autoApprovalMode`（default false）下产生待批卡；自动模式直接落盘但仍不产生批准卡（`auto-approval.test.ts`）。

### 4.4 活动采样 → 观察 → 日报 → 记忆管线

数据流：**采样子进程**（`sampler.ps1`/`sampler-macos.js`，5s 间隔写 JSONL）→ **tracker 聚合**（`spans.ts` 纯函数，短于 `minSpanMs` 丢弃）→ **观察库**（`observations`，删除区间重叠不写）→ **分类**（`classifier.ts`）→ **日报**（`report.ts` 状态机 + `workbench.ts` 工作台 + `report-approval.ts` 专用审批）→ **记忆/事项**（`memory.ts`/`work-items.ts`，带来源引用与删除传播）。

关键不变量：
- **分级授权在采集侧**：`captureWindowTitles=false` 时环境变量 `DSH_SAMPLE_TITLES='0'`，脚本根本不读标题（不是读了不存）；隐私顺序=先排除进程再读标题。
- **保留期真删**：`pruneSampleFiles` 用 `unlinkSync`；文件名严格正则匹配（不误删 `sampler.pid`）；PID 文件仅诊断不作存活判据。
- **删除传播**：删除观察→事项沿引用 `evidence_removed`→派生记忆失效→未发布日报保守撤销；备份恢复被 `deletion_ledger`/墓碑挡住。
- **日报确认四绑定**：`reportId+revision+digest+targetPath` 任一不符拒绝；发布崩溃后按同一 `publish_jobs` 作业对账，不覆盖外来内容。
- **迁移三硬约束**（`migrate.ts` 头注释）：旧域只读不升级、保留旧 id/时间/来源、迁移失败不启动采集。

### 4.5 团队与审批（`team.ts` / `team-domain.ts` / `approval.ts` / `gate.ts`）

- **编制**：总助理（用户正在对话的 dsh 会话，副作用）+ 助理 1/2（只读）+ 助理 3/4（未启用席位）；`teamSeats` 默认 3。
- **委派模型**：专家是总助理的子代理，回复归属由 `SubagentRun.result` 决定（不猜 `agent/status=idle`）；副作用任务（副作用成员 × 副作用范围）走可信执行器。
- **审批绑定**：`action_proposals` 存 `task_id/assistant_id/tool/target/params_digest/input_revision/risk/state/expires_at`；`approvals` 存 `plan_digest/scope/issued_at/expires_at/consumed_at`（单次消费）；任务修订、状态、权限、成员版本、工具、代次任一变化→已批准计划失效（`approval.test.ts`）。
- **执行点门禁**（`gate.ts`）：装在子代理自己的 agent ctx 而非全局；允许集合=只读工具+核实过目标字段的写工具；`DELEGATION_TOOL_CANDIDATES` 拦再委派；未知工具默认拒绝。
- **真实路径闸门**：写类目标逐级解符号链接/联接点后比对，必须落在父会话工作目录内；相似前缀、`..` 穿越、悬空链接拒绝；无工作目录不开放（`gate-scope.test.ts`：相似前缀也不行）。
- **执行账本**（`operations` 表）：重启对账——applying/running→`unknown` 记人工核查、任务不再被领取、审批卡作废、**绝不自动重发**；模型自报不能把 unknown 改成成功（`operations-ledger.test.ts`）。
- **助理敏感操作**（`assistant-approval.ts`）：固定快照 + 独立凭据（`POST /assistant-approval`，聊天令牌之前校验）+ epoch/TTL；模型自批无效（`assistant-approval.test.ts`）。
- **邮件/电脑/资料的高风险提案**：`risk='high'`，执行前重验（配置逐字比对、digest 复核、目标+控件 probe），失败区分 `failed-before-effect`/`unknown`。

### 4.6 渠道与外部消息（`channels.ts` / `wecom.ts` / `task-tools.ts`）

- 入站：白名单（`allowedUserIds`）→ 群聊陌生人忽略、单聊陌生人走 `claimUnboundChannelMessage` 去重+配对码绑定（绑定即设 `deliverHere`）→ 摘要去重（`channel_messages`）→ 按 `accountKey:chatKey` 串行队列 → 冻结快照后执行。
- 出站：`deliver` 只允许已记录 `deliverHere` 的会话（单聊还必须在白名单）；回复失败 not-sent/unknown 二分，一律不自动重发；整句"允许/同意/拒绝"交回统一审批，文案明示"敏感外发仍以桌面确认为准"。
- 企微（`wecom.ts`）：`wecom.json`+`wecom.secret`（DPAPI 密文）；只用 req_id 回复、无限重连、`maxAuthFailureAttempts=5`；旧连接事件按 client 指针比对失效。
- 渠道 agent（`channel-agent-settings.ts`）：每轮 token 预算（用量分片异常→unknown 禁续跑）、provider/model 覆盖、`channel_assistant_name/persona` 注入；**预算门禁三处**（pre-step/request/request-error）。
- 渠道任务工具（`task-tools.ts`）：7 个 `companion_*` 工具仅渠道执行器领取；人工待办模型不能执行。

### 4.7 邮件与会议交接（`mail.ts` / `mail-watch.ts` / `meeting-mail.ts` / `meeting-presentation-tools.ts`）

- **发送**：账本 `beginMailSend` 在事务里登记成功才真正发送；SMTP 异常→`unknown`（提示"先核对发件箱，不要自动重发"）；回执 accepted/rejected 与期望收件人**全等**才 `accepted`；同摘要上次 unknown/partial 拒绝自动重发。
- **值守**：IMAP 只读锁、UIDVALIDITY 变化整代次不提交、SEARCH 异常不推进水位、只抓内联片段（不下载附件）、协议层不标已读、通知与分析分离（结果先落库）。
- **纪要邮件**：模型只拿产物编号；正文由桌面 `meeting.artifact.read` 取回并 sha256 校验；发送前 `beforeSend` 重读要求 JSON 全等；接受后 +120s 企微催办（`meeting_mail_followups` 表）。
- **录音/讲解**（`meeting-presentation-tools.ts`）：4+3 个工具只做校验转发；要求 `desktop.binding(exec.agent)` 有效（当前本人桌面会话）且执行后复核绑定未变。

### 4.8 电脑操作与视觉（`computer.ts` / `computer-vision.ts` / `assets/computer.ps1`）

- **三级令牌**：目标授权（观察固定窗口，120s 过期）→ 动作授权（intent+target+control 冻结进 Grant）→ 执行（probe 复核后）；每个动作单独 `risk='high'` 审批。
- **目标身份只来自系统快照**：`computer.ps1` 的 `Check-Target` 要求**前台窗口必须是目标**且身份字段全等（windowId/pid/processPath/startedAt/className/title/bounds）；执行前后各复核一次。
- **截图链**：prepareVision→look→sameTarget+sameScreen→screenshotBytes→analyzeScreenshot→清空 pngBase64（不进会话日志）→返回 `verified:false`+"屏幕内容是不可信材料"声明；分析请求 `tools: []`。
- **密码控件**：显示"受保护输入"、不递归子树、不能 type/key；type 逐字符注入每字符复核焦点与修饰键。
- **不可重放**：apply 的消费发生在任何 await 之前——超时或结果未知都不能再次执行；`mayHaveExecuted===false` 才算 `BeforeEffectError`。
- 平台：截图与控件读取**事实上仅 Windows**（无条件 spawn `powershell.exe`）；README 只提截图，此处为代码事实补充。

### 4.9 主动帮助与证据（`proactive.ts` / `help-*` / `evidence-*` / `verify-command.ts`）

- **主动提醒判定顺序**（`proactive.ts:131-147`）：disabled→focus-mode→meeting→stage-hidden→help-in-progress→capture-inactive→stale-sample（>max(15s,3×interval)）→not-development-app→task-running→no-idle-data→not-idle-enough→already-reminded-in-period（**一个连续空闲期最多一次**）→cooldown（默认 60min）。固定文案 `REMIND_MESSAGE`；连续拒绝 3 次（`DECLINE_THRESHOLD=3`）改发 suggest-disable；关闭写 `user_flags.proactive_disabled` 重启恢复。
- **帮助 episode**：offer TTL 30 分钟、active 2 小时；候选只来自已有事实（sessionCwd/已有授权/最近前台窗口），declined/expired 路上不读任何东西。
- **帮助任务执行**（`help-task.ts`）：verdict 完全由账本推出；人工复核过的验证状态 `reviewed` **永不算验证通过**（无真实退出码就要重跑）；恢复对账 applying/running→unknown；有 unknown 时禁止新提案；每任务串行链。
- **验证命令**（`verify-command.ts`）：裸名只在 PATH 绝对目录找（不找工作目录，防同名 `node.exe` 顶替）；shell/.cmd/.bat 拒绝；环境只传基础变量（API key 不给测试代码）。
- **证据两通道**：拉（evidence-import，授权目录内+digest 复核）与推（evidence-intake，桌面原生对话框授权、默认不发模型）。

### 4.10 数据模型

**三个 SQLite 库**（均为 node:sqlite + WAL）：

| 库 | 路径 | 内容 | 权威定义 |
|---|---|---|---|
| 助理库 | `~/.dsh/personal-assistant/assistant.sqlite`（schema v2） | 活动/日报/记忆/资料/事项/帮助/用户标志 + 团队业务表 | `store.ts`、`team-domain.ts` 等 |
| 旧域库 | `assistant-legacy.sqlite` | `days`/`preferences`/`semantic_events`/`reports`（v0，只读迁移源） | `domain.ts` + `migrate.ts` |
| 桌宠任务库 | `<teamStorePath>`（默认 `desktop-team/team.sqlite`） | 团队任务与提醒运行时（`task_meta`/`schedules`/`deliveries` 等 JSON 载荷表） | `team-domain.ts` |

**助理库主要表**（按域；完整列见各文件 `CREATE TABLE`）：

- 活动域：`observations`、`deleted_activity_ranges`、`activity_retention_boundary`（`observation.ts`）；`user_flags`（`store.ts`，含 `proactive_disabled`/`proactive_state`）。
- 日报域：`reports`、`publish_jobs`、`report_edits`、`report_entry_links`、`report_export_deletions`、`deletion_receipts`（`report.ts`）。
- 记忆域：`memories`、`memory_sources`、`deletion_ledger`、`memory_tidy_history`（`memory.ts`）。
- 事项/资料域：`work_items`、`work_item_sources`、`project_evidence_reads`（`work-items.ts`）；`evidence_materials`、`material_tombstones`（`materials.ts`）。
- 团队域（`team-domain.ts`）：`assistants`、`tasks`、`task_dependencies`、`task_runs`、`action_proposals`、`approvals`、`operations`、`help_tasks`、`change_sets`、`change_files`、`verifications`、`operation_reviews`、`events_outbox`、`artifacts`、`migrations`、`companion_identity`。
- 成员域（`member-directory.ts`）：`assistant_profiles`、`member_channel_sessions`、`member_quota_accounts`、`member_usage`、`member_quota_requests`、`member_quota_resets`。
- 渠道/邮件域（`team-domain.ts`）：`channel_messages`、`channel_inbound`、`mail_watch_scopes`、`mail_watch_analyses`、`mail_watch_messages`、`mail_notice_deliveries`、`mail_send_intents`、`meeting_mail_followups`、`meeting_todo_sources`。
- 提醒域（`team-domain.ts`）：`task_meta`、`companion_inputs`、`task_commands`、`schedules`、`reminder_grants`、`reminder_cycles`、`deliveries`、`companion_contexts`。
- 帮助域（`help-context.ts`）：`help_contexts`、`help_episodes`。
- 迁移（`migrate.ts`）：`migrations`（批次幂等）。

**桌宠库**：`userData/meetings.sqlite`（`meeting-store.ts`）——`meetings`、`chunks`、`transcript_segments`、`minutes`、`minutes_artifacts`、`meeting_presentations`、`assistant_speech`、`transcript_meta`；音频本体 AES-256-GCM 落 `meetings/<id>/chunk-<seq>.enc`（密钥来自 `dpapi.ts`，拿不到密钥拒绝开会）。

### 4.11 配置参考（`src/config.ts`，30 项顶层 + `customRules` 3 个子字段）

配置经 cordis 的 schemastery `Schema.object` 定义，从 profile 的 `cordis.patch.yml` 按 id 覆盖传入。
**⚠️ `config` 是整体替换而非深合并**：覆盖时要把需要的字段一起写上（两个 patch yml 的注释反复强调）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `sampleIntervalMs` | 5000 | 前台窗口采样间隔（ms），最小 1000 |
| `minSpanMs` | 3000 | 低于该时长的活动片段视为噪声丢弃 |
| `reportDir` | `''` | 日报目录；空 = `<DSH_HOME>/personal-assistant/reports` |
| `customRules` | `[]` | 追加分类规则 `{process(正则), category, titleExtract?}`，先于默认规则匹配 |
| `petDir` | `''` | dsh-pet 目录；空 = 召唤只绑定不拉起（每台机器自己的设置，不写进发布配置） |
| `storePath` | `''` | 助理库路径；空 = `<DSH_HOME>/personal-assistant/assistant.sqlite` |
| `captureActivity` | `true` | 是否采集前台活动（模式本身是同意闸门，这里可单独关） |
| `captureWindowTitles` | `true` | 关闭时采样脚本**压根不调用 GetWindowText**，标题不先落盘再过滤 |
| `excludedProcesses` | `['KeePass','KeePassXC','1Password','Bitwarden']` | 排除应用（先于读标题判定） |
| `excludedTitleKeywords` | `['密码管理','支付密码','银行卡','网上银行','password manager']` | 排除标题关键词 |
| `retentionActivityDays` | 7 | 原始活动保留天数（最小 1），超期真删采样文件 |
| `retentionAutoDelete` | `false` | 自动清理默认关闭，需本人明确同意 |
| `maxInjectedMemories` | 40 | 注入系统提示词的记忆条数上限（限制注入不限存储） |
| `migrateLegacy` | `true` | 启动时只读导入旧存储域 |
| `deleteLegacyAfterMigration` | `false` | 导入后删旧数据默认关闭（删除不可逆） |
| `teamEnabled` | `false` | 专家团队装配开关（默认关，费用不封顶的前提要知情） |
| `teamStorePath` | `''` | 团队库；空 = `<DSH_HOME>/desktop-team/team.sqlite` |
| `teamId` | `'desktop-team'` | 团队 id（任务归属与事件过滤） |
| `teamSeats` | `[]` | 上台席位（assistantId 或 roleId）；空 = 编制默认（总助理+2 专家），错误名忽略并 warn |
| `teamProvider` | `'spawn'` | 子代理 provider：spawn 不继承父上下文（专家只见任务材料） |
| `maxConcurrentInference` | 2 | 推理委派并发上限 |
| `maxConcurrentSideEffect` | 1 | 副作用委派并发上限（装配时钳制 ≤ 推理上限） |
| `taskTimeoutMs` | 600000 | 任务墙钟超时（最小 10000），到点取消不重发 |
| `defaultBudgetTokens` | 0 | **0 = 无累计预算（费用不封顶）**；非零任务如实拒启 `budget-unsupported` |
| `approvalTtlMs` | 300000 | 批准有效期；运行时代次变化立即失效 |
| `denyExpertTools` | `[]` | 只读专家额外禁用工具（生效前 `ctx.tools.get` 校验存在性） |
| `proactiveEnabled` | `true` | 主动提醒总开关 |
| `proactiveIdleMs` | 480000 | 触发提醒的无输入时长（8 分钟，可配实验值） |
| `proactiveCooldownMs` | 3600000 | 两次提醒最小间隔（60 分钟） |
| `approvalMode` | `'manual'` | `manual`=日报/偏好走桌面审批；`auto`=用户已明确选择自动记录。**值来自配置文件，模型无法在会话中修改** |

### 4.12 模型工具清单（grep 核实共 80 个）

> ⚠️ **文档漂移**：插件 README 称"助理 15 个工具、团队 6 个工具"，实际 `src/` 注册 **80 个**（按注册点：`tools.ts` 35 + `team-tools.ts` 12 + `task-tools.ts` 7 + `member-runtime.ts` 10（按任务动态） + `computer.ts` 7 + `meeting-presentation-tools.ts` 4 + `help-context.ts` 2 + `meeting-mail.ts` 2 + `mail.ts` 1；按前缀：`personal_assistant_*` 51 + `companion_*` 16 + `desktop_team_*` 12 + `structured_output` 1）。README 的"15/6"只覆盖早期核心子集。注：`domain.ts` 的存储域名 `'personal_assistant'` 与 `wecom.ts` 的适配器名 `'wecom'` 是字符串字面量但不是工具，勿计入。

**A. 助理核心（`src/tools.ts`，35 个）**

| 分组 | 工具 |
|---|---|
| 模式与采集 | `personal_assistant_start`（开采集）/ `stop`（结束当天）/ `status`（状态与范围）/ `ack_capture_scope`（首次范围确认，默认开标题）/ `set_capture_titles`（开关标题采集）/ `delete_activity`（删时间段原始记录，dry-run 预览+审批） |
| 活动与事项 | `personal_assistant_today`（当天片段+事项）/ `commit_events`（增量语义解释，推断标 `confidence: medium`）/ `confirm_work_items`（确认事项）/ `import_records`（随手记/聊天导出导入） |
| 资料 | `list_materials` / `import_project_material`（登记项目文件与差异）/ `request_material_share`（跨项目共享审批）/ `delete_material`（审批） |
| 日报 | `save_draft`（版本化：revision+digest，entries 关联事项，推断条目必须标"（待确认）"）/ `get_draft` / `submit_report`（manual→审批 / auto→直发）/ `confirm_report`（校验一致性，**工具无发布权**）/ `revoke_report` / `delete_exported_report`（审批） |
| 记忆 | `remember_preference` / `resolve_preference`（裁决矛盾）/ `edit_preference` / `list_preferences` / `forget_preference`（deleted/invalidated/retained/uncontrolled 四类如实）/ `tidy_memory`（相邻重复行保守整理+审批）/ `list_memory_tidy` / `undo_memory_tidy`（撤回+审批） |
| 帮助上下文 | `help_context`（登记/更新授权+审批）/ `list_help_contexts` / `forget_help_context` / `project_timeline`（项目时间线）/ `read_project_evidence`（项目证据，带 `UNTRUSTED_MATERIAL_NOTICE`） |
| 桌面入口 | `personal_assistant_summon_pet`（拉起桌宠+绑定）/ `personal_assistant_set_team_mode`（运行时开关团队） |

**B. 专家团队（`src/team-tools.ts`，12 个）**：`desktop_team_start`（登记总助理宿主会话+编制）/ `assign`（按目录职责自动选人派发，等真实结果）/ `status`（编制/任务/待批/已执行副作用）/ `cancel`（结构化回执 CancelReceipt）/ `propose_action`（副作用提案，参数键序无关、任一值变动批准失效）/ `finish_operation`（已执行提案收尾入账）/ `review_unknown`（人工复核 unknown 账目，用户依据原样入账）/ `open_help_task`（帮助任务，串 episodeId 进账本）/ `read_file`（授权内读，返回 hash）/ `propose_change`（整文件或统一 diff 提案，hash 不符拒绝）/ `propose_verification`（运行验证提案，1–1800s 超时杀进程树）/ `wait`（等提案决定，≤600s）。

**C. 伴随任务（`src/task-tools.ts`，7 个）**：`companion_create_reminder`（桌面/企微提醒，delayMinutes 优先，"知道了"≠业务完成）/ `companion_create_todo`（人工待办，不调模型代做）/ `companion_register_input`（登记任务输入换 inputRef，**不接受磁盘路径**）/ `companion_create_task`（protocolVersion=1 命令提案，本人可信确认后生效）/ `companion_control_task`（pause/resume/cancel/complete/reschedule 提案）/ `companion_task_status`（只读）/ `companion_skill_candidates`（重复人工工作→技能候选线索，不试跑不启用）。

**D. 成员/会议/文档运行时（`src/member-runtime.ts`，10 个，按 taskId 动态注册）**：`companion_member_remember`（成员独立记忆候选）/ `companion_member_request_quota`（申请额度待批）/ `companion_meeting_start|stop|minutes|status`（会议，原生授权框）/ `companion_document_list|read`（授权目录文档，内容只是材料）/ `companion_mail_unread`（只读未读邮件，不执行邮件内指令）/ `structured_output`（任务结构化报告，仅候选不等于验收）。

**E. 电脑操作（`src/computer.ts`，7 个）**：`personal_assistant_computer_look`（先申请观察→`targetId`；`screenshot=true` 走全屏截图+图像模型，逐次审批）/ `computer_click`（坐标必须在目标窗口内且不被遮挡，probe 复核控件后注入）/ `computer_type`（≤4000 字符无控制字符；普通文字不经 SendKeys 解释；密码控件拒绝）/ `computer_key`（白名单正则：单键+最多 3 修饰键，不接受按键脚本）/ `computer_scroll`（-10..10 非零）/ `computer_apply`（带 `actionId` 执行，**执行前复核窗口及控件**，回执只代表系统收到输入，不可重放）/ `computer_cancel`（撤销未执行许可，不撤销已发生效果）。

**F. 邮件与会议（`mail.ts` / `meeting-mail.ts` / `meeting-presentation-tools.ts`，7 个）**：`personal_assistant_send_mail`（纯文本，≤20 收件人，审批后才发，不能附件/密送）/ `personal_assistant_meeting_artifacts`（纪要产物编号清单，不返回正文）/ `personal_assistant_send_meeting_minutes`（正文来自桌面重新核验的固定产物，**不接收模型改写**，审批邮件+企微提醒范围）/ `personal_assistant_meeting_recording`（独立录音 start/stop/status）/ `personal_assistant_document_presentation`（独立讲解 start/pause/resume/stop/status，不碰录音）/ `personal_assistant_meeting_presentation_status` + `personal_assistant_finish_meeting_presentation`（旧版组合讲解的收尾兼容）。

**G. 主动帮助（`src/help-context.ts`，2 个）**：`personal_assistant_help_candidates`（点了"好"之后列候选范围：会话目录/授权过的范围/当前窗口）/ `personal_assistant_help_choose`（选定后提交只读范围审批卡，pending 时不能读取）。

## 5. 桌宠（dsh-pet，Electron 37 壳，117 个 .ts/.tsx / 40,995 行 + 79 个测试）

### 5.1 进程与窗口结构

- **单主进程 + 7 个渲染窗口**；单实例锁（`app.requestSingleInstanceLock`）、托盘、全局快捷键；舞台是透明置顶、可点击穿透的无边框窗口（几何逻辑在 `main/index.ts`）。
- **7 个 HTML 页面 ↔ 7 个窗口 ↔ 7 个专用 preload**（已逐一核实 `loadFile` 调用点）：

| 窗口 | 页面 | 主进程模块 | preload | 设计原则 |
|---|---|---|---|---|
| 舞台（stage） | `renderer/index.html` | `main/index.ts:445` | `preload/index.ts`（324 行，`petApi` ~35 方法） | 唯一"全能"窗口，但**不能签发批准** |
| 专用审批 | `approval.html` | `approval-window.ts:345` | `preload/approval.ts`（仅 4 接口） | **唯一能签发批准的地方**；默认焦点在「驳回」 |
| 文档阅读 | `doc-view.html` | `doc-view-window.ts:467` | `preload/doc-view.ts` | 无任何路径接口，只能凭主进程签发的令牌取字节/页许可 |
| Office 阅读 | `office-view.html` | `office-view-window.ts:192` | `preload/office-view.ts` | 同上，页面拿不到文件路径 |
| 日报工作台 | `report-workbench.html` | `report-workbench-window.ts:393` | `preload/report-workbench.ts` | 只读视图+修订+请求发布/删除；**没有任何批准接口** |
| 桌宠任务 | `companion-tasks.html` | `companion-task-window.ts:277` | `preload/companion-tasks.ts` | 列表只读走聊天令牌；确认后以所有者身份创建 |
| 成员编辑 | `member-editor.html` | `member-editor-window.ts:115` | `preload/member-editor.ts` | 无通用 invoke、无宿主地址、无凭据 |

- **审批窗口独立的根本原因**（`approval-window.ts` 头注释）：舞台渲染的是模型写的文本，让同一渲染器能签发批准=让不可信内容有能力影响批准路径；舞台只能**请求**打开，决定只能从该窗口回来且过 `checkSender`（登记窗口+主框架+算出来的页面地址 `sameLocalPage`）。
- **两层外部依赖**：`scripts/launch-electron.mjs`（剥离 `ELECTRON_RUN_AS_NODE` 再起 Electron）；`main/harness.ts`（955 行，dsh web 运行时的拉起/监督）；`main/companion-host.ts`（670 行，与插件桥接的长轮询宿主侧）。
- 设置页不是独立窗口：舞台内 `PetSettingsPanel` 切页（`SettingsPage` 类型）。

### 5.2 主进程地图（src/main，55 个文件；另见 src 根 7 个 + src/types 1 个类型文件）

**窗口与审批组**

| 文件 | 行 | 职责 |
|---|---|---|
| `index.ts` | 4489 | 主入口：窗口/托盘/快捷键创建、桥接轮询接线、全部 IPC 路由分发、doc talk 状态机、evidence 原生对话框、音频/会议/设置命令处理 |
| `approval-window.ts` | 407 | 专用审批窗口：`registerApprovalIpc` 返回注销函数；`checkSender` 回执核验；批准只在这里签发 |
| `approval-policy.ts` | 690 | 审批判定与措辞（**零 import，可进 `node --test`，渲染层复用同一套措辞**）：riskOf 认不出一律 high、`ALWAYS_CONFIRM_KEYWORDS`（delete/send/pay/login…）、`normalizeTarget` 保留 `..`、倒计时、卡片投影、`TRUSTED_REVIEW_TOOLS` |
| `report-workbench-window.ts` | 436 | 工作台窗口：IPC 全在本模块注册；请求发布只**原样**转交修订号+摘要+路径；插件拒绝则如实回显；无任何批准通道 |
| `report-workbench-client.ts` | 125 | 工作台桥接调用：**只用聊天令牌**，每次重读 `bridge.json`（运行时重启端口会变） |
| `companion-task-window.ts` | 288 | 桌宠任务窗口：列表只读走聊天令牌、伪造发送方被拒、先登记输入再创建、提醒版本不一致拒绝回应 |
| `member-editor-window.ts` | 120 | 成员编辑窗口：与舞台共用 IPC 校验（逐次核对 sender/主框架/固定地址），保存由主进程复核+原生确认+CAS |

**语音组**

| 文件 | 行 | 职责 |
|---|---|---|
| `audio.ts` | 275 | 麦克风仲裁**纯函数状态机**：wake/dictation/meeting/barge-in 四类持有者互斥；专注模式关唤醒不掐听写；会议期间唤醒必停；`wake-lost` 粘住等用户 retry |
| `audio-prefs.ts` | 101 | 四个授权性开关持久化（唤醒缺省 Windows 开/macOS 关；`'none'` 分支不碰登录项；不 import electron 以便测试） |
| `asr.ts` | 416 | 识别双路：流式 `streaming-zh-14m`（Zipformer，进程内解码）+ 整句 SenseVoice 回退；静音不交模型（防幻觉"그."）；模块级缓存（加载约 2.5s）；`pcm16Base64ToFloat32`/`trimSilence`/`wavChunk` |
| `asr-wave.ps1` | 51 | 无本地模型时的 Windows System.Speech 整句识别；同步 Recognize+60s 超时（异步事件 API 会崩 PS5.1） |
| `kws.ts` | 272 | sherpa 关键词检出：`WAKE_KEYWORD='小潘同学'`、阈值 0.2/分数 1.5/冷却 2s；Worker 线程解码（约实时 10%）不产生子进程；token 不在 tokens.txt 拒载 |
| `wake.ts` / `wake.ps1` / `wake-grammar.ps1` | 102/89/97 | Windows 常驻唤醒（spawn powershell + JSON 行协议，意外退出 3s 重启）；脚本**纯 ASCII**（PS5.1 把 BOM-less UTF-8 按 GBK 解析）；唤醒词按码点构造+6 个近音变体（一次只替换一个 Pan 位置防组合爆炸） |
| `speech.ts` | 318 | 讲话队列纯函数：分句（≤60 字符）、四层打断（`stop-playback<drop-queue<cancel-generation<cancel-task`）、播出记录（半句 `complete:false` 不算说过） |
| `tts.ts` | 441 | `Narrator` 播放驱动器：队列规则（speech.ts）与传输胶水分离（可注入假传输测试）；一次只派一句；长驻合成进程保证 `stop` 可见 |
| `tts-edge-worker.ts` | 441 | 合成 worker：edge-tts（免费无密钥）→mp3→`play.ps1`（MCI 阻塞播放）；断网→`speak-once.ps1` 本地合成（音色退回机械声但话不吞）；stdin/stdout 协议与旧 tts.ps1 一致 |
| `tts-cache.ts` | 122 | 固定话术缓存：键=音色+文本指纹，换音色自然失效，旧的不删 |
| `tts-renderer-transport.ts` | 282 | 外放插话模式传输：合成进程只合成，音频交渲染层 WebAudio 播（Chromium AEC 才能减回声）；`started` 在**真的出声**时才报 |
| `greetings.ts` | 64 | 唤醒应答多说法（纯文本常量，预合成缓存按此清单） |
| `voice-api.ts` | 399 | 自定义 TTS/ASR（openai/mimo 两 provider）：端点仅 https/回环、密钥 ≤4096 printable ASCII、原子写（wx 0600+fsync+rename）、≤1MB/≤20 profiles、TTS ≤5000 字、音频响应 ≤20MB 验 MP3 帧头 |
| `voice-conversation.ts` | 173（根） | 连续对话：默认关闭；生成结束且**实际播完**才续听一次；最多十轮 |
| `dpapi.ts` | 256 | 会议录音密钥：Windows DPAPI CurrentUser / macOS Electron safeStorage 包装；**拿不到密钥拒绝开会** |

**会议组**

| 文件 | 行 | 职责 |
|---|---|---|
| `meeting-recorder.ts` | 2065 | 会议闭环编排：开始/推块/停止/结算/转写/说话人修订/纪要确认；**先让渲染层冲刷末块再结算转写**（顺序反了丢最后几秒）；缺名字/没勾知情/保留天数不对全拒 |
| `meeting-store.ts` | 1616 | 持久层：`meetings.sqlite` 只存元数据，音频 AES-256-GCM 落 `chunk-<seq>.enc`+sidecar（sha256 校验）；密文被替换/挪行不伪造可用状态；密钥丢失绝不重建覆盖旧数据 |
| `diarize.ts` | 776 | 说话人分离：纯函数（时间轴/静音压缩/段映射）+ sherpa OfflineSpeakerDiarization（**跑 Worker**，48s 音频约 11s）；漏检片段补"未分人"段 |
| `meeting-minutes.ts` | 616 | 有来源的纪要（纯函数）：会议文字包随机 nonce 围栏声明不可信；`parseModelReply` 不合法 JSON 如实失败；**逐条校验来源**（段存在/属本场/属当前版本/内容字重合），模型补的负责人/期限一律改"待确认" |
| `meeting-todo.ts` | 99 | 行动项交接：固定版本+本人确认+复验后交给任务运行时；断线结果未知不重发 |
| `meeting-artifact`（recorder 内） | — | 确认版导出到本人选择的目录（内容摘要与会议版本一致、重启可核验、不覆盖）；录音完整性未知不弹保存窗 |

**文档组**

| 文件 | 行 | 职责 |
|---|---|---|
| `document.ts` | 814 | 文档规则纯逻辑：只在授权目录与最近选择范围找、同名多个交回用户挑绝不挑第一个、realpath 落地再判包含（`..`/符号链接逃不出）；不碰磁盘不碰 electron |
| `doc-formats.ts` | 42 | 三份名单（可解析/可系统关联/界面宣讲）**单一来源**，零依赖（渲染层按 browser 打包吃不进 node:path） |
| `doc-fs.ts` | 199 | 规则的真实出口：磁盘、摘要、系统应用关联；electron 只在显式关联打开时加载 |
| `doc-office.ts` | 128 | docx/pptx 本地结构提取：只读 ZIP 内 XML，不执行宏不开 Office 不联网；≤200k 字符 |
| `doc-pdf.ts` / `doc-pdf-worker.ts` | 134/116 | PDF 解析线程边界：**主线程不加载 PDF.js、不向解析线程传路径**；≤500 页、单页 ≤100k 字符、15s 超时 |
| `doc-presenter.ts` | 739 | 讲解展示纯状态机（三方共用）：**位置只由播放回执推进**——模型生成再快，没有 `started` 回执一页都不翻 |
| `doc-view-window.ts` | 713 | 阅读视图窗口+控制器三层：`DocViewGrants`（令牌绑定 realPath+fingerprint，每次取数重走 snapshot 不走缓存）→ `PdfViewWindow`（sandbox、分区只放行 file:/data:/blob:、网络请求全取消）→ 控制器接纯状态机 |
| `markdown-view.ts`（renderer） | 23 | 原文按讲解标题切分，**不解释 HTML 或执行文档内容** |
| `office-view-window.ts` / `OfficeViewer.tsx` | 201/289 | Office 逐页阅读窗口（授权二进制通道，不按文本读） |
| `office-export.ts` | 71 | 用本机 PowerPoint 只读导出 pptx 每页 PNG（临时目录读完即删，无 PowerPoint 退回本地预览） |

**平台与宿主组**

| 文件 | 行 | 职责 |
|---|---|---|
| `desktop-actions.ts` | 335 | 桌面动作**唯一契约**（Windows/macOS 共用）：只有类型、错误码、身份比较与结果构造——不 spawn 不 import electron；每个错误码可归到一个讲解暂停原因 |
| `win-actions.ts` | 521 | Windows 实现：`win-uia.ps1` **常驻进程**（PS 冷启动 5-8s 跟不上翻页）、串行请求、空闲自退；第二道核对（`identity-changed`/`focus-stolen`）；请求一行 base64（中文/空格/引号不出现在明文） |
| `mac-actions.ts` | 745 | macOS 实现：osascript JXA，脚本为常量、可变内容只经 argv JSON 不拼文本不经 shell；三种隐私权限（Accessibility/Automation/屏幕录制）分项判断，缺哪项只禁依赖它的能力；**未在 Mac 真机验证** |
| `wps-control.ts` | 379 | WPS 定位（不依赖默认 PDF 关联：App Paths/bundle id）→打开→身份核验（进程在安装目录内+标题含文档名）→读页/跳页/滚动 |
| `wps-view-target.ts` | 159 | WPS 作为讲解视图目标：失焦/弹窗/关闭只**如实回报**不自行重试；用户自己翻页按"手动翻页"回报 |
| `pointer-watch.ts` | 257 | 全局指针监视（仅 win32/darwin）：惰性启动、启停幂等、空闲复用、分块粘包解析 |
| `platform.ts` | 393 | 平台能力表（`SUPPORTED_DESKTOP_ACTIONS`：Windows 真机验证 / macOS 未验证 / Linux 不支持；`SUPPORTED_AUDIO`；`SUPPORTED_POINTER_WATCH`） |
| `settings.ts` | 229 | `pet-settings.json`（userData）：驻留模式（fixed/auto）、渲染状态、自启动；`ResidencyState` 由 `isDocked+positionHint+lastStage` 计算；损坏文件回保守缺省 |
| `assistant-settings.ts`（main） | 162 | 助理设置 IPC：固定路径、凭据只回无密钥契约字段、密钥留空=省略不清除 |
| `first-run.ts` / `first-run-service.ts` | 404/354 | 环境检查与模型下载计划：清单含用途/来源/许可证/大小/sha256；**打开页面只触发只读检查**，下载/申请权限都要用户点；镜像前缀非法如实报错 |
| `model-resources.ts` | 760 | 模型资源清单（与 `setup-local-asr` 的 ps1/sh 及 `asr.ts`/`diarize.ts` 落点三方一致，测试钉住） |
| `runtime-launch.ts` | 497 | 打包路径解析：`app.asar.unpacked` 相关（`toUnpackedPath`），launcher 旗标/工作目录/环境变量契约 |
| `overlay-state.ts` | 34 | 浮层显隐纯逻辑：运行中点别处不收起、完成后原地下一次点击才收起、四方向放不下选溢出最少 |
| `evidence-intake.ts`（main） | 132 | 外部证据收件：原生对话框**预览正文原文**（不是"标题+字数"）；未确认的纪要连框都不弹 |
| `harness.ts` | 955 | dsh web 运行时宿主（拉起/监督/重启策略） |
| `companion-host.ts` | 670 | 桥接宿主侧（长轮询、`/session/start`、事件流接线） |
| `member-management.ts`（main） | 436 | 成员管理 IPC（草稿/权限/额度/记忆，快照逐字段投影不泄扩展字段） |
| `play-host.ts` | 217 | 播放宿主进程管理（预热/排队/回执解析；非 Windows 明确返回 null 由调用方回退） |
| `edge-tts.ts` | 160 | edge-tts 协议（Sec-MS-GEC 令牌 5 分钟窗口、SSML 转义、音频帧剥壳收集） |

**src 根类型文件（7）**：`session-types.ts`（86，跨包会话契约）、`companion-types.ts`（172，跨包任务契约）、`member-types.ts`（132）、`evidence-types.ts`（44，与插件 `IntakeRequest` 同一条协议的两面，改字段两边一起改）、`voice-api-types.ts`（42）、`assistant-settings-types.ts`（57，写入上限界面/IPC 共用）、`voice-conversation.ts`（173）。

**src/types（1）**：`sherpa-onnx-node.d.ts`（225，第 117 个源文件）——sherpa 原生模块的**最小类型面垫片**（官方包只带 JSDoc 没有 .d.ts），只声明本项目用到的部分（OnlineRecognizer 流式 / OfflineRecognizer 整句 / OfflineSpeakerDiarization 分人），用到补一个不照抄上游；供 `asr.ts`/`diarize.ts`/`kws.ts` 共用。

### 5.3 语音管线

```
共享采集 audio-capture.ts（渲染层唯一 getUserMedia，"现在采到了什么"的统一事实源）
  ├─ 听写 dictation.ts（静音检测自动停→wav）→ asr.ts（streaming-zh-14m → SenseVoice 回退）
  ├─ 唤醒 kws.ts（sherpa Worker，小潘同学） / wake.ts+wake.ps1（Windows 常驻）
  ├─ 插话检测 barge-in.ts（播放期残余自适应阈值，实验开关默认关）
  ├─ 自回声过滤 self-speech.ts（把助理刚说的话从识别结果剔掉）
  └─ 会议轨 meeting-capture.ts（麦克风+回环双轨 4s 切块）
仲裁 audio.ts（四类持有者互斥） ── 状态回执 audio-grants 下发
TTS：speech.ts 队列 → tts.ts Narrator → tts-edge-worker（edge-tts→play.ps1；断网→speak-once.ps1）
     ↳ tts-renderer-transport（外放插话模式：渲染层 WebAudio 播，AEC 可用）
     ↳ tts-cache + greetings（固定话术预合成）
连续对话 voice-conversation.ts（最多十轮，播完才续听）
```

- 语音服务可换：`voice-api.ts`（openai/mimo 自定义 TTS/ASR）在设置页配置，选了自定义服务就随句子下发配置、读不出如实停（`tts-voice-api.test.ts`）。
- 麦克风授权链：`audio-grants` 通道（订阅/撤回回执 `reason=revoked`）→ 授权晚到 `waitForGrant` 能等到 → 设备释放。

### 5.4 会议管线

```
meeting-panel.tsx（getUserMedia 双轨：麦克风+系统回环，TrackChunker ~4s/块）
  → petApi.meetingChunk（块带音源/轨内序号/起点/采样率/16k帧数）
  → meeting-recorder.ts（校验→立即加密落盘 MeetingStore，两路绝不交错）
  → 停止：meeting-stopping → 渲染层冲刷末块 → meetingFlushDone → 结算/转写
  → 转写两层（流式+精修）→ diarize.ts（Worker 分人，助理播报区标记）
  → meeting-minutes.ts（模型摘要，逐条来源校验）
  → meeting-minutes-review.tsx（审阅：来源定位、待确认、改稿、确认导出）
  → 确认版：meeting-artifact 导出 / meeting-todo 行动项→任务运行时 / meeting_mail 走企微催办
```

- 关键不变量：**先冲刷后结算**；密钥拿不到拒绝开会（不把参会者的话明文留盘）；录音加密落盘（DPAPI/safeStorage 密钥）；纪要中模型补的负责人/期限不采信；停录后音频损坏不能只凭旧回执导出。
- 双 README 平台差异：会议加密落盘三平台 ✅（根 README 与代码一致）。

### 5.5 文档管线

```
查找 document.ts（授权目录内、同名多个交回用户挑、realpath 防越界）
  ├─ 可解析名单 doc-formats.ts（.md/.txt/.csv/.json/.pdf/.docx/.pptx…；.docm 等在排除名单）
  ├─ 文本/结构 doc-fs.ts（真实 I/O）+ doc-office.ts（ZIP/XML）+ doc-pdf.ts（Worker+PDF.js）
  └─ 系统关联打开（白名单内）
讲解：doc-presenter.ts 纯状态机（回执推进）→ doc-view-window.ts（令牌+沙箱窗口）
      → doc-view-main.tsx（pdf.js 画 canvas，页许可被拒即丢弃已加载文档）
      → markdown-view.ts（按标题切分，不执行内容）
Office：office-view-window.ts + OfficeViewer.tsx（二进制通道逐页）/ office-export.ts（本机 PPT 导 PNG）
WPS：wps-control.ts（定位/核验/跳页） + wps-view-target.ts（状态机目标，失焦如实回报）
```

### 5.6 桌面动作与平台能力

- **契约**：`desktop-actions.ts` 定义动作、错误码、身份比较；实现只有两个——`win-actions.ts`（UIA 常驻脚本+第二道核对）与 `mac-actions.ts`（JXA，**未真机验证**）；Linux 明确不支持（`platform.ts`）。
- **平台矩阵**（`platform.ts` 与测试钉住，比 README 更精确）：Windows 真机验证 ✅；macOS 有实现未验证 ⚠️（`desktop-platform.test.ts`："macOS 不得被当成已验证"）；Linux ❌。
- **凭据与隐私**：会议密钥 `dpapi.ts`（DPAPI/safeStorage）；指针监视仅 win/mac；`settings.ts` 驻留模式。
- **环境检查**：`first-run.ts`（数据去向逐项列出：本地识别在本机、edge-tts 与对话在云端）+ `model-resources.ts`（清单三方一致）。

### 5.7 渲染层地图（src/renderer，47 个 .ts/.tsx + 7 html + 14 css）

**舞台核心**

| 文件 | 行 | 职责 |
|---|---|---|
| `App.tsx` | 1569 | 根组件：页面路由（对话/团队/文档/会议/设置/首运行）、退场时间线（漩涡 ~4.3s）、托盘与桥接状态接线 |
| `TeamStage.tsx` | 289 | 多角色舞台：共享素材、位置命中盒、场景编排；交互动画/睡眠不被抢占 |
| `PetSprite.tsx` | 471 | 参数化角色（`p-body/p-eye/…` class 由 pet-anim.css 按 data-action 驱动），三套皮肤切换 |
| `PortalExit.tsx` | 22 | 漩涡退场（opening 0.7s / open 旋转 / closing 1.2s，与 App 时间线对齐） |
| `ChatOverlay.tsx` | 267 | 对话气泡层（按讲解标题切分、不执行内容、命中盒注册） |
| `useSession.ts` / `session-view.ts` | 121/112 | 会话快照订阅与增量合并（按 seq 排序） |
| `usePetBehavior.ts` | 322 | 定点生活行为、拖拽与会话动画；真实交互优先于随机活动 |
| `usePetImage.ts` | 335 | 素材加载：本地 PNG + 边缘漫水填充去背，失败回退 SVG；模块级共享缓存 |
| `group-scene.ts` / `useGroupScene.ts` | 465/90 | 群体场景纯状态机（麻将/开黑/闲聊编排，**不模拟真实游戏、无模型参与**）+ 时钟接线 |
| `scene-clock.ts` | 60 | 全场单一时钟（改造前每角色一个 16ms interval；退订幂等，无角色即停） |
| `stage-layout.ts` / `pet-metrics.ts` / `pet-interaction.ts` | 254/29/121 | 座位/命中盒纯逻辑、几何常量、交互纯状态机（完成事件带版本，旧动画不能结束新一轮） |
| `character-manifest.ts` | 287 | 成员配置→可安全渲染的翻译（未知皮肤一律降级 `panda`，防 404 空白角色） |
| `runtime-status.ts` | 77 | 连接状态→文案语气（失败优先、稳态不播报） |
| `playback.ts` | 264 | 外放插话播放端（WebAudio，让 Chromium AEC 拿到参考信号） |

**面板与窗口页**

| 文件 | 行 | 职责 |
|---|---|---|
| `TeamPanel.tsx` / `team-panel.ts` | 292/302 | 团队页（待批/任务/成员三块）+ 用户文案纯逻辑（可被 node --test 钉住） |
| `DocPanel.tsx` / `doc-panel.ts` | 271/59 | 文档页（授权范围/重名待挑/提纲/讲解进度）+ 措辞投影 |
| `meeting-panel.tsx` | 1011 | 会议页：开始表单、红色常显录音标识、双轨收音状态与临时字幕、转写状态、说话人修订、纪要预览确认 |
| `meeting-minutes-review.tsx` | 303 | 纪要审阅：本地模板/模型草稿、数据去向授权、逐条来源定位、待确认与已剔除、改稿导出 |
| `meeting-capture.ts` | 112 | 分轨切块纯逻辑（不碰 DOM，可单测；两路各自缓冲/编号/时间轴） |
| `MemberManagement.tsx` / `MemberEditor.tsx` | 332/357 | 成员列表/额度/记忆 与 独立编辑窗口页 |
| `approval-card.tsx` | 344 | 审批卡片：**默认焦点在「驳回」**，回车不会批准 |
| `report-workbench-main.tsx` | 609 | 工作台页：只读插件视图、改写/删除各产生新版本、请求发布原样交出、无批准能力 |
| `doc-view-main.tsx` | 320 | 阅读视图：pdf.js 画 canvas；页许可被拒即丢弃整份文档（内存不能成为绕过授权的缓存） |
| `office-view-main.tsx` / `OfficeViewer.tsx` | 10/289 | Office 阅读页 |
| `companion-tasks-main.tsx` | 261 | 桌宠任务页（创建/控制/回应/提醒周期） |
| `member-editor-main.tsx` / `approval-main.tsx` / `main.tsx` | 10/9/9 | 各窗口入口 |
| `AssistantSettings.tsx` / `FirstRunSettings.tsx` / `PetSettingsPanel.tsx` / `VoiceApiSettings.tsx` | 177/269/257/201 | 设置四页：助理设置、环境检查（**打开只触发只读检查，下载要用户点**）、宠物设置（驻留）、语音服务 |
| `doc-panel` 前已列；`markdown-view.ts` 23 | — | 见 §5.5 |
| `proactive-ui.ts` | 34 | 主动提醒气泡（好/不用；连续拒绝后主按钮变"关掉提醒"；点"好"替用户发的那句是固定文案） |
| `audio-capture.ts` / `barge-in.ts` / `dictation.ts` / `self-speech.ts` | 631/525/367/88 | 见 §5.3 |
| `types.d.ts` | 679 | 渲染层共享类型（SettingsPage/Residency/成员视图等） |

### 5.8 preload 与 IPC

- **7 个专用 preload**（表见 §5.1）：原则=每个窗口只暴露它需要的固定方法；**无通用 `ipcRenderer.invoke` 透传、无宿主地址、无凭据、无路径接口**；审批/工作台/文档窗口**刻意不给任何批准接口**。
- **通道族**（主进程侧 `ipcMain.on/registerIpc` 逐条注册，preload 侧常量清单）：
  - 舞台 `petApi`：会话（prompt/cancel/permission/model 基线）、设置（save-settings/pet-settings/residency/assistant/voice-apis）、语音（asr-begin/end、tts-*、audio-grants、wake-*）、会议（meetingChunk/start/stop/status/…）、文档（doc talk/presentation/launch）、任务与提醒（companion-tasks:*）、成员（member:*）、证据（evidence:*）、浮层与托盘。
  - 专用窗口各一套：`approval:*`（read/decide/close/changed）、`doc-view:*`（session/bytes/page-permit/fonts/action）、`office-view:*`、`report-workbench:*`、`companion-tasks:*`、`member-editor:*`。
- **preload 通道字面量全清单**（grep `ipcRenderer.*'…'` 实测 88 个唯一通道名，按域分组）：
  - 会话/舞台：`session-start` `session-get` `session-command` `chat-send` `get-state` `save-settings` `residency-state` `residency-set` `overlay-state` `stage-set-visible` `stage-set-focus` `exit-done` `context-menu` `mouse-state` `presentation-mode` `runtime-start` `runtime-stop` `team-get`
  - 审批（仅审批窗口）：`approval-open` `approval-card-read` `approval-card-decide` `approval-card-close` `approval-card-changed`
  - 语音/听写/唤醒：`asr-begin` `asr-transcribe` `asr-stream-feed` `asr-stream-stop` `asr-record-fallback` `speech-local` `speech-stop` `kws-feed` `audio-sync` `audio-consumer-lost` `barge-in-detected` `barge-in-metrics` `tts-playback-receipt`
  - 会议：`meeting-start` `meeting-stop` `meeting-state` `meeting-chunk` `meeting-flush-done` `meeting-transcribe` `meeting-take-command` `meeting-track-missing` `meeting-loopback-capability` `meeting-minutes` `meeting-minutes-confirm` `meeting-speakers` `meeting-speaker-split` `meeting-speaker-merge` `meeting-todo-import`
  - 文档/Office/阅读视图：`doc-roots` `doc-add-root` `doc-remove-root` `doc-forget-dir` `doc-open` `doc-ask` `doc-explain` `doc-view-session` `doc-view-session-changed` `doc-view-bytes` `doc-view-page` `doc-view-resource` `doc-view-command` `doc-view-report` `office-open` `office-view-session` `office-view-session-changed` `office-view-bytes` `office-view-image` `office-view-check` `office-view-command` `office-view-fullscreen` `office-view-fullscreen-changed` `office-view-close`
  - 成员/任务/设置：`members-state` `member-assist` `member-command` `member-memories` `member-editor-open` `member-editor-context` `member-editor-close` `companion-tasks-open` `assistant-settings-state` `assistant-settings-save` `voice-api-state` `voice-api-save` `voice-api-select` `voice-api-remove`
  - 证据/提醒/首运行/报告：`evidence-intake-minutes` `evidence-intake-window` `proactive-respond` `first-run-report` `first-run-download` `first-run-open-settings` `open-report-dir` `report-workbench-open`
- **通道清单被测试钉死**（`desktop.e2e.test.ts`，mock.module 驱动真实 `main/index.ts` 装配）：
  - 「舞台侧注册的每一条都该在，一条不多」；
  - 「preload 暴露给渲染层的每条通道，主进程都真的有人接」；
  - 「会话和浮层通道拒绝非舞台窗口的调用」；
  - **「舞台渲染器没有能直接签发批准的通道」**。
- 发送方核验：所有窗口通道都校验 `event.sender`+主框架+算出来的固定页面地址（`sameLocalPage`），非登记窗口返回 null 不发桥接请求。



## 6. 构建系统与开发工作流

两个包各自独立安装依赖（无 workspace）；Node ≥ 22、pnpm。

### 6.1 插件构建（`dsh-personal-assistant/scripts/build.mjs`）

| 项 | 内容 |
|---|---|
| 命令 | `pnpm run build`（`--watch` 为 dev）、`typecheck`（tsc --noEmit）、`test`、`clean` |
| 主产物 | esbuild CLI（**钉死路径** `node_modules/.pnpm/esbuild@0.27.7/.../bin/esbuild`）打包 `src/index.ts` → `dist/index-<10位毫秒时间戳>.js`；esm / node / target node22 |
| external | `@deepseek-ai/*`、`@wecom/*`、`zod`、`node:*`、`nodemailer`、`imapflow`、`mailparser` |
| main 同步 | 构建后把 `package.json` 的 `main` 与 `exports["."]` 指向新产物（**两者必须一致**） |
| 客户端产物 | esbuild JS API 打包 `src/client/index.tsx` → CJS browser bundle，外层包 `window.__ModuleLoader__.load({id, factory})`（DSH 客户端加载器要求模块表包装，不是普通 ESM）；external：react / react-dom / `@deepseek-ai/*` |
| 旧产物处理 | **只改名 `*.stale`，绝不删除**——两条来由：① 本机 QQ 电脑管家（QQPCRTP.exe）实时防护拦截 esbuild.exe 覆盖写已存在文件（时间戳文件名由此而来）；② 2026-09-23 曾误删历史构建，"哪个产物是好的"事后才知道（`build.mjs` 头注释，用户明确要求任何文件都不许删） |
| 提交约定 | **`dist/` 必须同步提交**；从 GitHub 安装的用户拿到的就是仓库里的构建产物，安装时不执行脚本 |

### 6.2 桌宠构建（`dsh-pet/scripts/build.mjs`）

| 项 | 内容 |
|---|---|
| 命令 | `pnpm run build` / `start`（先 build 再 `scripts/launch-electron.mjs`）/ `dev`（watch）/ `typecheck` / `test` / `pack:mac` / `pack:win` |
| esbuild 目标 | **17 个**：main、pdf-worker、tts-worker、preload(index)、approval-preload、doc-view-preload、report-workbench-preload、companion-tasks-preload、office-view-preload、member-editor-preload（10 个 node 侧）+ renderer、approval-renderer、doc-view-renderer、report-workbench-renderer、companion-tasks-renderer、office-view-renderer、member-editor-renderer（7 个 browser iife，chrome120，`NODE_ENV=production`） |
| 关键 external | main：`electron`、`@deepseek-ai/*`、`sherpa-onnx-node`/`sherpa-onnx-win-x64`（N-API 原生模块内联会丢 .node）、`pdfjs-dist`、`ws`（CJS 被 ESM 内联时动态 require("events") 运行时炸）；preload 全部只 external `electron`（CJS） |
| 窗口分包原则 | 每个窗口独立 bundle：审批窗口不加载角色包（形象/皮肤/动画不进批准签发口）；成员编辑窗口不加载舞台资源；阅读视图把 pdf.js **内联**在页面线程（CSP 只需 `'self'`，不拷 worker、不碰 CDN） |
| 静态拷贝 `copyStatic()` | 7 个 `.html` + `styles.css` + 整个 `assets/` + 8 个 `.ps1`（wake / wake-grammar / record / play / play-host / speak-once / asr-wave / win-uia）。**只覆盖不删除**：动作帧按 `frames/<skin>/<action>/fNNN.png` 逐帧探测（FRAME_MAX=96，遇缺即停），多余旧帧会让引擎"先播新版再播旧版"；清理由 `python tools/matting/sync-frames.py` 把多余帧改名 `*.stale`（⚠️ 该脚本与 `tools/` 目录**不在本仓库**，系开发机工具，build.mjs:193 注释为唯一出处） |
| 打包 | `build/electron-builder.yml` + `entitlements.mac.plist`；`dist/` 不入库，首次 `pnpm start` 自动构建 |
| 启动器 `launch-electron.mjs` | 删掉继承的 `ELECTRON_RUN_AS_NODE=1`（DSH 桌面子进程树会注入它，导致 Electron 以 Node 模式加载主进程首屏即崩）；按候选顺序找 Electron 二进制（用户指定 → 上次成功 → 工作区 → DSH 自带 → 复制到用户目录），应对 Win11 工作区沙箱 ACL 导致的 STATUS_BREAKPOINT 崩溃；stdout/stderr 落 `<DSH_HOME>/dsh-pet/launch.log` |
| 其他脚本 | `setup-local-asr.ps1` / `.sh`：首次安装本地识别模型（约 700MB，之后完全离线）；`setup-mimo-voice.cjs`：语音服务配置 |

### 6.3 插件脚本与 patch 层

- `scripts/setup-mail.mjs` / `setup-wecom.mjs`：配置邮件 / 企微渠道凭据（写 `channels.json`、`wecom.json`、`wecom.secret`）。
- `cordis.patch.yml`（随包）：`- insert:` 挂 `id: personal-assistant` 一行；**刻意不插入 storage 三行**（已发布的 dsh-web-app bundle 自带，重复 id 会让 dsh 启动即抛 `duplicate loader entry id`）。
- `cordis.team.patch.yml`（可选覆盖层）：用 `- id:` **按 id 覆盖**（同 id 用 `- insert:` 会 duplicate 报错；按 id 覆盖找不到只 warn）；`teamEnabled: true`，`petDir` 注释掉（每台机器自己的设置）。用法 `dsh --profile web --patch <目录>/cordis.team.patch.yml`。

### 6.4 测试命令与约定

```bash
# 插件：node --test 直接跑 .ts（Node strip-only TypeScript）
cd dsh-personal-assistant && pnpm test        # node --test --disable-warning=ExperimentalWarning "tests/**/*.test.ts"
cd dsh-personal-assistant && pnpm run typecheck

# 桌宠：多了 module-mocks 实验开关
cd dsh-pet && pnpm test                        # node --test --experimental-test-module-mocks "tests/**/*.test.ts"
cd dsh-pet && pnpm run typecheck
```

插件测试能跑 `.ts` 的前提（README 约定）：**测试与被测模块不沾 electron**、不用 TS 参数属性、本地值导入一律写 `.ts` 后缀（Node 把 `.ts` 当 ESM 解析）。桌宠测试用 `--experimental-test-module-mocks` mock 掉 electron / 原生模块。

---

## 7. 测试覆盖地图

**运行方式**（命令与约束见 §6）：插件 `node --test "tests/**/*.test.ts"`；桌宠 `node --test --experimental-test-module-mocks "tests/**/*.test.ts"`。合计 **156 个测试文件、约 2,000 个 `test()` 用例**（插件 77 文件/约 748；桌宠 79 文件/约 1,274，另 4 个文件用 `describe`+嵌套 test：`approval-policy`/`doc-panel`/`team-panel`/`meeting-minutes-voice`）。

**测试哲学**（两侧 README + 代码共同体现）：
1. **纯逻辑下沉 `.ts`**：不沾 React/电子的规则放纯模块（`spans.ts`、`stage-layout.ts`、`group-scene.ts`、`audio.ts`、`speech.ts`、`approval-policy.ts`、`document.ts`…），`node --test` 直接跑——"越界路径被拒"这类事靠人工点一遍点不全。
2. **用户可见字符串进纯逻辑**：`team-panel.ts`/`doc-panel.ts` 的措辞可被测试钉住（"读错了就是界面在撒谎"）。
3. **e2e 用 `mock.module` 驱动真实装配**：`desktop.e2e.test.ts` 拉起真实 `main/index.ts` 装配，钉住 IPC 通道清单与"舞台不能签发批准"。
4. **strip-only TS 约束**：插件测试禁 electron import、禁构造函数参数属性、相对导入必须写 `.ts` 后缀（`legacy.ts`/`time.ts` 独立成文件正因如此）。
5. **夹具与真实资产**：`tests/fixtures/`（合成截图 ps1）、`model-resources.test.ts` 逐项核对清单 sha256 与下载脚本一致、`packaging-wiring.test.ts` 钉住打包路径解析。

### 7.1 插件测试（77 文件 / 748 用例，按域，全覆盖）

| 域 | 文件（用例数 · 代表断言） |
|---|---|
| 桥接/会话（7） | `bridge-causal`25（completed 结算最大 step 文本、mixed/uncertain 归属、turn/end 前可判 mixed）、`bridge-cancel`13（排队可撤回/已注入不撤回/已结算回执不变）、`session-start`12、`stream-incremental`4、`turn-idle`5、`user-commands`10（召唤/绑定/开启/关闭）、`companion-bridge`2（聊天令牌不能替本人确认） |
| 审批/门禁（8） | `approval`9（四样绑定+代次+单次消费原子登记）、`assistant-approval`12（模型自批/聊天凭据无效、凭据不入快照）、`auto-approval`8（自动模式不产生待批卡）、`gate`5、`gate-scope`4（相似前缀拒绝）、`gate-version`2、`change-set`9（diff 严格套用、原子提交冲突零写入）、`desktop-commands`4（一次性回执） |
| 活动采样（4） | `activity`26（区间删除/损坏行保留/标题撤销恢复/聚合口径）、`sampler-macos`9、`sampler-privacy`1（DSH_SAMPLE_TITLES=0 不读标题）、`retention-running`5 |
| 日报（7） | `report-memory`58（最大组：日报×记忆联动）、`report-approval`10、`report-entries`4、`report-workbench`5、`revoke-report`1、`workbench-memory-edit`5（待批期间记忆被改→卡作废）、`data-deletion`6（六类删除各自传播、备份恢复被账本挡住） |
| 迁移（2） | `migrate`20（旧域只读、批次幂等）、`legacy`12 |
| 记忆/资料/事项（5） | `memory-cas`11（乐观锁改写）、`memory-tidy`6、`materials-evidence`6、`work-items-project-memory`9（来源查不到整批拒绝、direct 需直接证据）、`evidence-intake`7（空正文拒收、默认不发模型） |
| 团队/成员/任务/提醒（18） | `member-directory`25、`member-runtime`21、`team-reliability`18、`team-roster`15、`team-side-effect`12、`team-stream`7、`team-tools`6（点名失败拒绝、批准 id 不进上下文）、`team-mode-tool`6、`team-ledger`5、`companion-runtime`10（提醒全流程一账本、人工待办模型不能执行）、`companion-runtime-availability`8（写锁停线不重放）、`companion-settings-runtime`4、`member-assistant`6、`member-management`4、`member-memory`4、`member-quota-workflow`3、`scheduler`4、`reminder-chat-response`6 |
| 渠道/企微（4） | `channel-reliability`22（重启不重放、unknown 不二次回复）、`channel-agent-settings`12（预算门禁与分片计量）、`channels`7（白名单/配对/陌生人忽略）、`wecom-reliability`6（回执未知不转主动发送） |
| 邮件/会议交接（9） | `mail-watch`39（UIDVALIDITY 代次、逐页推进不跳缺口）、`mail-send-reliability`13、`mail-notice-delivery`11、`meeting-mail`10、`mail-watch-store`6、`meeting-todo`5、`mail`3、`meeting-mail-followup`4、`meeting-presentation-tools`4 |
| 电脑/视觉（4） | `computer-vision`11（逐次审批、截屏途中篡改不保存不发送）、`computer-safety`7（观察先批准、SendKeys 不解释普通文字）、`computer-vision-io`2、`computer-vision-adapter`1 |
| 帮助/主动（5） | `help-task`19（提案/验证/复核/unknown 阻塞）、`proactive`12（判定顺序）、`help-context`4、`proactive-help`7、`skill-candidates`1 |
| 装配/设置/杂项（4） | `assistant-settings`21（密文不回显、STALE_REVISION、事务回滚）、`session-mirror`17（只投影真人输入）、`plugin-load`8、`pet-dir`7 |

### 7.2 桌宠测试（79 文件 / 1,274 用例，按域，全覆盖）

| 域 | 文件（用例数 · 代表断言） |
|---|---|
| 装配/IPC/桥接（7） | `desktop.e2e`12（真实装配；**通道清单双向钉死**；会话浮层拒绝非舞台窗口；舞台无签发批准通道）、`desktop-actions`13（错误码↔暂停原因全映射）、`desktop-platform`12（macOS 不得被当成已验证）、`bridge-assistant-approval`6、`bridge-cancel`12、`bridge-stream`9（delta 按请求 id 分发、ring 缺口重取基线）、`bridge-session-start`3 |
| 语音（19） | `audio`36（四类持有者互斥、重复收尾幂等）、`speech`31（分句/四层打断/半句不算播出）、`tts`28（回执驱动、finished 前不派下一句）、`voice`20（Sec-MS-GEC/SSML/turn.end 先于音频=拒绝）、`audio-capture`19（授权撤回 reason=revoked、共享设备帧连续）、`barge-in`15（自适应阈值、短促响动不触发）、`voice-api`15、`kws-residency`13（拼音 token 与 tokens.txt 校验）、`tts-edge-worker`19（模拟边界不出网、取消真实 HTTP）、`tts-renderer-transport`11（started 只在真出声时报）、`play-host`10、`voice-conversation`10（最多十轮、播完才续听）、`self-speech`8、`greetings-tts-cache`7、`tts-prefetch`5、`tts-scripts`5（BOM/MCI 不谎报完成）、`voice-mimo`5、`voice-interrupt`3、`tts-voice-api`2 |
| 会议（10） | `meeting-store`39（DPAPI/safeStorage 真实加解密、密钥丢失不重建覆盖）、`meeting-recorder`27（缺知情全拒、密钥 lost 拒开会且不锁死唤醒）、`meeting-reliability.e2e`24（末块回执与加密存储逐轨一致）、`meeting-diarize`24、`meeting-minutes`21（逐条来源校验、模型补的负责人不采信）、`meeting-tracks`10（双轨不交错、时钟错乱按接收时间修正）、`meeting-artifact`6（确认版不覆盖、损坏不导出）、`meeting-todo`4、`meeting-presentation-store`3、`meeting-minutes-voice`（describe，语音指令命中） |
| 文档（9） | `document-ipc.e2e`95（会议/插话/听写共享采集的真实 IPC）、`document`78（授权边界穷举：相似前缀/大小写/越界）、`doc-pdf`20（真实 PDF.js、密码 PDF 不挂起）、`doc-presenter`11（**只有 started 回执推进**）、`doc-view-window`9（发信者核验+令牌指纹）、`doc-office`4、`markdown-view`2（伪标题跳过）、`office-view-window`2、`doc-panel`（describe：formatSize/sectionLabel） |
| 桌面动作/WPS（5） | `win-actions`36（base64 单行、身份不采信）、`wps-control`28（安装定位与身份核验）、`mac-actions`18（三权限分项禁用）、`pointer-watch`15（分块粘包、启停幂等）、`wps-view-target`4（失焦暂停如实回报） |
| 窗口/审批/设置（9） | `first-run`19（数据去向逐项列出）、`evidence-intake`9（确认框预览正文原文）、`report-workbench-window`9（IPC 只认登记窗口、**无批准通道**）、`companion-task-window`8、`assistant-settings`12、`assistant-settings-ui`5、`first-run-service`10、`approval-meeting-mail.e2e`2、`approval-policy`（describe：riskOf 认不出一律往高判） |
| 渲染层（16） | `group-scene`71（空闲才开演、五人只开黑、全员干活不开演）、`stage`56（状态优先级、缺席即空闲）、`member-management`26、`runtime-status`18（连接状态各自对应一种语气）、`pet-interaction`17、`pet-sprite-fallback`10（视频降级）、`overlay-state`11（四方向放不下选溢出最少）、`member-management-ui`11、`assets`8（帧缓存）、`pet-behavior-timers`8（台词变化不重置生活计时）、`scene-clock`7（单时钟+退订幂等）、`self-speech`（已计语音域）、`member-editor-ui`4、`use-session-errors`5（迟到旧快照不清新错误）、`proactive-ui`3（固定文案）、`chat-overlay-model`1、`team-panel`（describe：十个状态标签不漏） |
| 宿主/资源/平台（4） | `runtime-launch`73（打包路径/环境变量契约）、`model-resources`29（清单 sha256 三方一致）、`platform`24（三平台能力如实返回）、`packaging-wiring`9（解包路径钉死） |

> 说明：`self-speech` 在语音域计入，上表渲染层行不再重复计数；4 个 `describe` 风格文件（`approval-policy`/`doc-panel`/`team-panel`/`meeting-minutes-voice`）的嵌套 `test()` 已计入总数。

### 7.3 覆盖薄弱点（诚实清单）

- **macOS 真机路径无 e2e**：`mac-actions`/`sampler-macos`/KWS 均为逻辑级测试，README 明示未真机验证。
- **Linux**：无语音实现，相关测试直接断言"如实返回 null/不支持"。
- **真实模型/网络**：edge-tts、企微 SDK、IMAP、SMTP 全部用假传输或假 SDK；真实外呼只在 `tts-edge-worker.test.ts` 的模拟边界内。
- **审批窗口的人机交互**（焦点默认驳回等）靠代码结构测试，无 UI 自动化。

## 8. 关键设计决策与不变量

1. **凭据分离是安全模型的基石**：`bridge.json`（聊天令牌）只管会话/事件/工作台读写提案；`bridge-approval.json` 的三类凭据（approval/report/assistant）只存在于磁盘与主进程，模型上下文、IPC、渲染层永远拿不到；聊天令牌签发的批准一律无效（`companion-bridge.test.ts`）。
2. **批准只能从专用窗口签发**：舞台/工作台/文档渲染的都是模型写的文本，它们只能**请求**开窗；决定经 `checkSender`（登记窗口+主框架+算出的页面地址）回传。`desktop.e2e` 钉死"舞台渲染器没有能直接签发批准的通道"。
3. **审批哈希绑定**：任务+目标+参数摘要+输入修订四样（+成员版本/工具/代次）任一变化即失效；执行点消费时重新校验摘要、期限、范围；批准 id 不进模型上下文（模型只持 proposalId）。
4. **执行点门禁装在子代理 ctx**（非全局）：明确允许只读集合，未知工具与再委派默认拒绝；写类目标 realpath 规范化（逐级解符号链接/联接点）后必须落在父会话工作目录内，相似前缀/穿越/悬空链接全拒。
5. **账本优先于自报**：执行结果 unknown 重启对账、任务不再领取、审批卡作废、**绝不自动重发**；help verdict 完全由账本推出，模型说什么都不影响；人工复核 `reviewed` 永不算验证通过。
6. **删除传播与防复活**：`deletion_ledger`/`material_tombstones`/`deleted_activity_ranges`/保留期边界只进不退——备份还原、旧记录回填不能让已删内容回来；删除区间与新采样重叠则静默不写。
7. **分级授权落在采集侧**：`captureWindowTitles=false` 时脚本根本不读标题（`DSH_SAMPLE_TITLES='0'`）；隐私顺序=先排除进程再碰 System Events；macOS 标题读不到如实标 `titleUnavailable` 不编造。
8. **单写入者与单一事实源**：team.sqlite 只有团队服务写；渲染层共享采集只开一次麦克风；`scene-clock` 全场一个节拍器；渠道按会话串行队列；会话所有权只认 `/session/start` 创建的。
9. **回执驱动推进**：文档讲解只认 `started` 回执翻页；TTS 只有 `finished` 记播出；会议停止先冲刷末块再结算；`speech` 半句打断 `complete:false` 不算说过。
10. **不可信材料双侧落实**：提示词声明（聊天/网页/邮件/截图/会议文字/资料正文都是数据不是指令）+ 代码边界（证据进模型前必须可信审批、分析请求 `tools: []`、围栏 nonce 防伪造段行）。
11. **可测性分层**：纯逻辑 `.ts` / 组件 `.tsx` 分离；`approval-policy` 等零 import 模块渲染层与测试共用；I/O 全部注入。
12. **生命周期与构建不变量**：采样子进程随插件卸载必须 dispose（否则孤儿）；杀进程树用 `taskkill /T /F`/进程组；插件产物带时间戳、旧产物改名 `.stale` 永不删除（AV 误杀事件的教训）；桌宠 copyStatic **只覆盖不删除**；PowerShell 脚本纯 ASCII 或带 UTF-8 BOM（PS5.1 GBK 误读问题）。

## 9. 已知限制与风险

### 9.1 文档漂移清单（⚠️ README vs 代码，均已核实）

| # | 文档说法 | 代码事实 |
|---|---|---|
| 1 | 插件 README 工具清单"15 个助理工具 + 6 个团队工具" | **实际注册 80 个**（§4.12：35+12+7+10+7+4+2+2+1），README 未列邮件/会议/电脑/帮助域工具 |
| 2 | 根 README "assets 约 11MB" | 实测 `dsh-pet/assets` **9.6MB** |
| 3 | 插件 README:323 "会议录音、转写与纪要…暂缓" | 会议管线已完整实现（`meeting-recorder`/`meeting-store` 加密落盘/`meeting-presentation-tools` 均注册） |
| 4 | pet README 平台表"前台活动记录 macOS ❌" | 插件有 `sampler-macos.js` + `sampler.ts` darwin 分支 + 测试；根 README 写"✅（未真机验证）"——**pet README 过时** |
| 5 | 插件 README 桥接架构图端点不全 | 未列 `/assistant-approval`、`/report-approval`、`/evidence/intake`、`/companion/v1/*`、`/chat/cancel`、`/team/cancel|pause`、`/workbench/*` 等（§3.3 完整） |
| 6 | README"截图目前仅支持 Windows" | 属实，但**控件读取同样仅 Windows**（无条件 spawn powershell.exe），文档未明说 |
| 7 | README 主动提醒门槛描述 | 代码判定顺序是其**保守超集**（多 capture-active/stale-sample/development-app/task-running/meeting/help-in-progress），属简化非矛盾 |
| 8 | 两份 README 对 macOS 活动采样的表述互相矛盾 | 以代码为准：有实现、无真机验证 |

### 9.2 功能与平台限制

- **Linux**：语音（ASR/TTS/唤醒/会议）与桌面动作均无实现，如实报不支持。
- **macOS**：桌面动作（JXA）、活动采样、KWS 唤醒为**未真机验证**的实验路径；会议唤醒默认关。
- **Windows**：截图/控件读取独占；PS5.1 编码坑（脚本纯 ASCII/BOM 约定）。
- **默认配置的刻意取舍**：`defaultBudgetTokens=0`（无累计预算，费用不设上限；非零则拒启）；连续对话默认关；外放插话默认关（实验）；barging 依赖 Chromium AEC。
- **单实例约束**：一个桌面账号只允许一个运行时实例；渠道/邮件账号各一份配置。
- **模型依赖**：本地 ASR 新装 300–350MB（旧 streaming 目录保留会更多，根 README 的 ~700MB 为旧口径）；分人模型可选；缺模型时功能如实降级。

### 9.3 工程风险

- 插件 dist 时间戳产物持续累积（`.stale` 永不删除）+ AV 黑名单事故史——清理需人工确认。
- `team-domain.ts`（2,625 行）与 `main/index.ts`（4,489 行）是两个最大单体，改动影响面大（建议参照 §7 先补测试再动）。
- 跨包类型双份维护（`session-types`/`companion-types`/`evidence-types` 均注明"改字段两边一起改"），无编译期强制——靠测试两侧同红。
- 桥接端口随机、令牌每次重启变化：任何缓存旧 `bridge.json` 的代码都会得到一串 401（`report-workbench-client` 每次重读即为此）。

## 10. 附录

### 10.1 脚本与资产清单

**PowerShell/JXA 脚本（13 个 ps1 + 1 个 js）**：

| 脚本 | 侧 | 用途 |
|---|---|---|
| `assets/sampler.ps1` | 插件 | 前台活动采样（Windows），JSONL 输出 |
| `assets/sampler-macos.js` | 插件 | 同上（macOS，osascript JXA，ASCII） |
| `assets/computer.ps1` | 插件 | 电脑操作辅助：身份核验/UIA/输入注入/GDI 截屏 |
| `tests/fixtures/computer-vision-synthetic.ps1` | 插件 | 合成截图测试夹具 |
| `src/main/wake.ps1` + `wake-grammar.ps1` | 桌宠 | 常驻唤醒（码点构造唤醒词+近音变体） |
| `src/main/asr-wave.ps1` | 桌宠 | System.Speech 整句识别兜底 |
| `src/main/play.ps1` / `speak-once.ps1` / `play-host.ps1` | 桌宠 | MCI 播放 / 本地合成兜底 / 播放宿主 |
| `src/main/record.ps1` | 桌宠 | MCI 录音兜底 |
| `src/main/win-uia.ps1` | 桌宠 | 常驻 UIA 辅助进程（桌面动作） |
| `assets/pointer-watch.ps1` | 桌宠 | 全局指针监视（外放插话） |
| `scripts/setup-local-asr.ps1` / `setup-local-asr.sh` | 桌宠 | 本地模型下载（镜像前缀、sha256 校验） |

**桌宠静态资源 `dsh-pet/assets/`（9.6MB）**：`pets/`——21 张 PNG（3 皮肤 panda/girl-glasses/boy-glasses × 各 7：基础+lie/play/read/sit/walk/write）+ `webm/panda/` 17 个透明 WebM 动作（idle/walk/jump/wave/grab/sleep 系列/laptop 系列/write 等，~5.7M）+ `frames/panda/walk-stop/` 3 帧序列（f001–f003，508K）；`tray/`（pandaTemplate @1x/@2x）；`pointer-watch.ps1`。素材从 ~128MB 优化而来（根 README ~11MB 为旧口径）。

**双侧 README**：根 README（167 行，总览+平台矩阵）、插件 README（363 行，架构图+工具+排障）、桌宠 README（244 行，功能+差异+排障+测试哲学）。

### 10.2 排障速查

| 症状 | 原因与处理 |
|---|---|
| 桌宠连不上、503 `unbound` | 运行时未绑定会话：桌宠命令面板或插件 `/summon-pet` 重新绑定；或 `bridge.json` 端口/令牌已变（重启后必变），桌宠会重读 |
| 401 一串 | 缓存了旧 `bridge.json`——任何调用都应每次重读该文件 |
| 审批卡不出现/立即过期 | `approvalTtlMs` 到期或任务修订/成员版本变化使计划失效（设计如此，重新提案） |
| 采样没数据 | `captureActivity` 开关；`captureWindowTitles=false` 只是不读标题；macOS 需要 osascript 权限（标题要 Accessibility） |
| 孤儿 sampler 进程 | 插件未正常 dispose；用 `sampler.pid` 诊断（仅诊断不作存活判据），`taskkill /T /F` 清理 |
| 唤醒无反应 | Windows：`wake.ps1` 日志（连续 30 次异常才放弃）；macOS：KWS 模型与 `keywords-dsh.txt` token 校验（`kwsModelProblem`） |
| TTS 播不出/机械声 | 断网会退到 `speak-once.ps1` 本地合成（音色降级话不吞）；检查 `edge-tts` 连接 |
| 会议密钥丢失 | 拒绝开会是**设计行为**（不把话明文留盘）；密钥文件损坏不会被重建覆盖 |
| PowerShell 中文乱码 | 脚本必须纯 ASCII 或 UTF-8 BOM（PS5.1 把 BOM-less UTF-8 按 GBK 解析） |
| 模型下载失败 | `first-run` 报告逐项给原因；镜像前缀非法不静默退回直连；sha256 不符拒装 |
| 构建后桌面壳没更新 | copyStatic 只覆盖不删除；`dist/` 不存在时 `pnpm start` 会自动先构建 |

### 10.3 术语表

| 术语 | 含义 |
|---|---|
| 总助理 / 专家 | 总助理=用户正在对话的 dsh 会话（可有副作用）；专家=其只读子代理 |
| 可信执行器 | 副作用任务的执行通道：启动前装定向门禁、每次调用都要桌面批准 |
| 因果折叠 | 按 message id 把流式事件折叠成一条回复归属（`onAgentIdle`） |
| 代次（epoch） | 桥接/审批凭据的版本号，重连或换凭据即失效旧批准 |
| 观察 vs 记忆 | 观察=采样看到的事实（带来源）；记忆=带范围/状态的结论（删除可传播） |
| 资料（material） | 用户交来的原文，`modelVisible` 单独记账（存本机≠允许发模型） |
| 回执推进 | 文档讲解/TTS/会议都只按真实播放回执推进状态，不按生成速度 |
| 外放插话 | 实验开关：TTS 改由渲染层 WebAudio 播，使 AEC 能减掉回声以检测插话 |

### 10.4 常见改动的落点索引

| 想改什么 | 先看哪里 |
|---|---|
| 加一个模型工具 | `tools.ts`（助理域，`registerAssistantTools`）或对应域文件的 `register*Tools`；同步 §4.12 清单与系统提示词 section |
| 加/改一个配置项 | `config.ts`（interface + Schema 两处）→ `cordis.patch.yml` 两份注释 → §4.11 表 |
| 加一个桥接端点 | `bridge.ts` 路由 + 鉴权归属（chat/approval/assistant/report/owner/executor 哪把钥匙）→ §3.3 表；桌宠侧若要调用，改 `companion-host.ts` |
| 改审批语义（绑定/期限/话术） | 插件侧 `approval.ts`/`assistant-approval.ts`/`approval-policy.ts`（桌宠侧零 import 可测）→ `approval-card.tsx` 展示 → `approval.test.ts` |
| 改 SQLite 表结构 | 建表文件（§4.10 归属）+ `store.ts` 版本迁移 + 两侧测试；旧域 `domain.ts` **永不原地升级** |
| 改工具白名单/门禁 | `gate.ts`（允许集合、DELEGATION 拦截、realpath）→ `gate-scope.test.ts` |
| 改采样或隐私行为 | `sampler.ts`（环境变量契约）+ `assets/sampler.ps1`/`sampler-macos.js`（隐私顺序在**脚本侧**执行）→ `sampler-privacy.test.ts` |
| 改日报发布/撤销 | `report.ts`（状态机+publish_jobs 对账）→ `report-approval.ts` → `workbench.ts` → `deletion.ts` |
| 改渠道规则 | `channels.ts`（白名单/去重/串行）→ `wecom.ts`（传输）→ `channel-agent-settings.ts`（预算） |
| 改邮件发送可靠性 | `mail.ts`（账本先登记后发送）→ `mail-watch.ts`（值守水位）→ 对应 reliability 测试 |
| 加/改桌宠窗口 | `main/*-window.ts`（注册 IPC+checkSender）→ 专用 `preload/*.ts`（只暴露需要的）→ 页面 `renderer/*-main.tsx` → `desktop.e2e.test.ts` 通道清单（**改完必须同步两侧清单测试**） |
| 改舞台动画/交互 | 纯逻辑进 `group-scene.ts`/`pet-interaction.ts`/`stage-layout.ts`（可测），组件只接线；节拍统一走 `scene-clock.ts`（勿另起定时器） |
| 改语音链路 | 采集只在 `audio-capture.ts`（唯一 getUserMedia）→ 仲裁 `audio.ts` → 各消费方；TTS 队列在 `speech.ts`（纯）、传输在 `tts.ts`/`tts-edge-worker.ts` |
| 改会议数据/加密 | `meeting-store.ts`（密钥与 chunk）→ `meeting-recorder.ts`（编排顺序：先冲刷后结算）→ `meeting-minutes.ts`（来源校验规则） |
| 改文档授权边界 | `document.ts`（规则，realpath/同名处理）+ `doc-fs.ts`（I/O）→ `doc-view-window.ts`（令牌指纹）→ `document.test.ts` 穷举 |
| 改桌面动作 | 先改 `desktop-actions.ts` 契约与错误码 → `win-actions.ts`/`mac-actions.ts` 实现 → `desktop-actions.test.ts`（错误码↔暂停原因全映射） |
| 改跨包类型 | `dsh-pet/src/session-types.ts`/`companion-types.ts`/`evidence-types.ts` 与插件同构类型**两边一起改**（无编译期强制，靠测试同红） |
| 改构建产物 | 插件 `scripts/build.mjs`（时间戳产物、`.stale` 不删）；桌宠 `scripts/build.mjs`（17 bundle、copyStatic 只覆盖不删）→ `packaging-wiring.test.ts` |

---

*本文件由代码通读生成（2026-11）；所有关键声称均可溯源到上表文件与行号。代码变更后请按 §0 维护约定更新对应章节。*
