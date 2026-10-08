# Hive：自研的 Mac 原生多 Agent 开发平台（总体规划 v2）

> 本文档**取代** `HIVE_MINI_PLAN.md`，并吸收 `HIVE_SPEC.md` 与 `HIVE_TART.md` 中仍然适用的部分。
> 参考对象：<https://github.com/AlexZihaoXu/agent-swarm-ng>（以下简称 ASNG，MIT 协议）。**我们自己写，不 fork**：只参考它的产品形态、数据模型和设计取舍，需要时阅读它的代码来理解做法，再按自己的架构重写。
> 标有 **【需验证】** 的是写作时无法确认的事实，实现前先查官方文档或在 Mac mini 上实测。

---

## 范围调整（最新，优先于下文）

**本版先不做 Xcode，只做一个能在 Mac 上跑的多 Agent 平台。** 下文凡涉及 Xcode、模拟器的内容，整体延后到最后的「Apple 工具包」阶段；平台本身要从第一天起就把它设计成"可插拔"，以后接入时不用改核心。

### 先做什么

- 创建、编辑、分配 Agent；私聊、群聊、Agent 之间私聊与交接。
- Pi 作为运行框架；模型先用 OpenRouter，以后可切本地 Qwen。
- **通用工作站**：Mac 上的独立用户和目录，Agent 在里面读写文件、开终端、用 git、跑测试，不依赖 Xcode。
- 任务看板与分配、lead / reviewer 流程、PR 自动化。
- 桌面与浏览器控制（核心稳定之后）。
- 多用户（仪表盘账号）。
- 前端参考 ASNG：深色、药丸导航、会话列表、群聊、Agent 设置、工作站网格、仪表盘、手机 PWA。

### 延后做什么

- Xcode 构建与测试、Simulator 操作、`.pi-build.sh` 相关的一切；真机、签名、发布。
- Tart 虚拟机、Linux 桌面。

### 为什么这个顺序

1. 平台最大的不确定性（Pi SDK 的用法、多 Agent 调度、聊天体验、权限模型）与 Xcode 无关，应该先解决。
2. 没有 Xcode，16GB 的 Mac mini 不再是瓶颈：hived 加十几个 Pi 会话占用很小，主要限制变成模型的并发与费用。
3. 平台做完就已经有用：可以让 Agent 写和测任何普通代码仓库、做调研、操作网页。
4. Xcode 之后作为"工具包"插进来，不影响平台。

### 工具包（Toolpack）机制——为了以后接 Xcode，核心里要先留好

一个工具包是一个自包含的模块，核心通过统一接口加载：

```ts
interface Toolpack {
  id: string;                         // "core.workstation" | "apple.xcode" | "desktop" | "browser"
  tools(ctx: AgentContext): ToolDefinition[];   // 该 Agent 被授权时才返回
  leases?: LeaseKind[];               // 它引入的稀缺资源，如 "xcode-build" | "simulator"
  healthcheck(): Promise<HealthReport>;        // 例如检查 Xcode 是否已安装
  guidance?: string;                  // 附加到系统提示词的使用说明（保持稳定以利缓存）
}
```

- 授权按工具包和工具两级勾选；工具包不满足前置条件时在 UI 里显示"不可用"，而不是报错。
- 租约（构建槽、模拟器、桌面）是通用机制，工具包只是注册新的租约类型。
- `apple.xcode` 工具包将来包含原文第 5、6.5 节的 Xcode 与模拟器工具。

### 调整后的阶段总览

| 阶段 | 内容 | 规模 |
|---|---|---|
| P0 | 可行性验证：Pi SDK、macOS 用户工作站执行、桌面截图点击（不含 Xcode） | S |
| P1 | 平台骨架、登录、模型端点、Agent 创建、私聊、前端外壳 | M |
| P2 | 通用工作站：文件、终端、git、Git Relay、通用租约；单 Agent 完成真实编码任务 | M |
| P3 | 群聊、Agent 间私聊、提及唤醒、并发调度、活动检查器 | M |
| P4 | 任务看板、lead / reviewer、交接、PR 自动化 | M |
| P5 | 桌面与浏览器控制 | M |
| P6 | 多用户、审计、PWA 与推送、记忆整理、心跳、Linear | M |
| P7 | 本地 Qwen | S |
| P8 | Apple 工具包：Xcode 构建与测试、模拟器 | L |

详细的阶段内容与验收标准见下文第 12 节（已按此版本改写）。

---

## 0. 需求与假设

### 0.1 你的需求（按你最近一次的描述整理）

1. 多 Agent 协作：可以**创建 Agent、分配 Agent**，**单聊也可以群聊**，Agent 之间可以互相沟通、交接。
2. 用 **Pi** 作为 Agent 的运行框架。
3. **Xcode 开发**：改代码、编译、测试、开模拟器、看界面。（**已延后**，见「范围调整」）
4. Agent 可以**操控桌面**（截图、点击、键盘），可以**开模拟器**。
5. 可以**创建多个用户**。
6. 前端形态类似 ASNG：深色界面、顶部导航、聊天列表加会话、群聊、Agent 设置、"电脑"网格、仪表盘、手机可用。
7. 运行在 **Mac mini**（目前 16GB M4）上，模型先用 **OpenRouter**，以后可换本地 Qwen。

### 0.2 我的假设（请纠正）

- "多个用户"我理解为两层，**都要，但优先级不同**：
  - **macOS 用户（核心）**：每个工作站是 Mac 上一个独立的系统用户，有自己的主目录、DerivedData、模拟器设备，用来隔离 Agent。
  - **仪表盘账号（后期）**：多个真人登录这个平台，各看各的 Agent 和数据。从第一天就在数据模型里预留 `owner`，界面和权限放在后期。
- Apple 账号、证书、签名、上架：**不交给 Agent**。Agent 只做模拟器构建（`CODE_SIGNING_ALLOWED=NO`），不碰真机。
- 起步在一台 Mac mini 上完成；以后加 Mac Studio（本地 Qwen）或第二台 Mac 时，架构不用推翻。

### 0.3 不做（至少 v1 不做）

- 不 fork ASNG，不依赖 Docker/Linux。
- 不做 Tart 虚拟机（16GB 放不下），作为以后的可选工作站类型预留。
- 不做真机安装、签名、发布、App Store 提交。
- 不做 Discord、WhatsApp 等外部渠道（预留渠道抽象）。

---

## 1. 从 ASNG 学到的设计（要借鉴的）

我读了它的 README、愿景、开发文档、`AGENTS.md`，并看了它的截图。值得借鉴的做法：

| 设计 | 内容 | 我们怎么用 |
|---|---|---|
| **Agent 与渠道、电脑分离** | Agent 有持续的身份和记忆；聊天只是它的沟通渠道；电脑是可分配的资源 | 我们同样：Agent、Channel、Workstation 三个独立概念 |
| **没有隐含的主机访问** | Pi 用 `noTools: 'all'`，再通过 `customTools` 显式授予能力；工具在**执行处**检查权限 | 同样做。Pi 内置的 bash/read/write 全部关闭，只给我们自己实现的、有作用域的工具 |
| **发布边界** | Agent 的思考和直接输出是内部的，只有调用 `send_message` 才会进入聊天 | 同样做，避免模型的原始输出漏进聊天 |
| **后台运行，不依赖浏览器** | 刷新页面只是重新观察，不会取消正在跑的 Agent | 同样：Run 属于后端，前端只是订阅 |
| **每个 Agent 同一时间只有一个活跃回合** | 新消息在回合边界送达；有短暂的防抖和"要不要打断"的判断 | 先做简单版：排队、回合边界送达；打断判断后做 |
| **会话持久化与压缩** | Pi 会话检查点存进数据库，重启后恢复；上下文接近上限时压缩 | 同样做 |
| **"任何人可读，一个人可写"** | 电脑的读取（截图、看终端）不干扰持有者；写操作要先领取 | 桌面和工作站写操作采用同样的租约语义 |
| **工具声明 r / w / rw / claim** | 每个工具在定义时声明权限类别 | 同样做，便于审计和 UI 展示 |
| **操作活动单独存储** | 工具调用、截图等"活动"与聊天消息分开存，截图只存在有容量上限的磁盘池里 | 同样做，数据库里只存路径和元数据 |
| **长期记忆** | 索引、有出处的类型化记忆、"睡眠"时整理 | v1 先做简单文件式记忆，睡眠整理放后期 |
| **审计、用量、仪表盘** | 每次模型调用都计量；登录与关键操作留审计 | 同样做，分阶段 |

**不借鉴的**：Docker/Sysbox/LXCFS/出口过滤（我们不用容器）、Selkies 桌面串流、Discord、组织/用户的完整权限矩阵（后期再做）、它的全部 Kibo UI 依赖。

**建议实现者先读的 ASNG 文件**（只作理解设计用，勿整段复制）：

- 产品与规则：`docs/vision.md`、`AGENTS.md`、`docs/agent-communication.md`、`docs/chat-and-groups.md`、`docs/agent-computer-use.md`、`docs/agent-memory.md`、`docs/message-interruption.md`、`docs/agent-todos.md`
- Pi SDK 用法：`backend/src/chat-runtime.ts`（`createAgentSession`、`noTools`、`customTools`、`SessionManager`）、`chat-runner.ts`、`agent-runs.ts`、`agent-session-store.ts`、`agent-work-queue.ts`
- 工具定义范例：`backend/src/dm-tools.ts`、`group-tools.ts`、`chat-history-tools.ts`、`backend/src/computer-use/tools.ts`、`terminal-tools.ts`
- 前端结构：`frontend/src/components/chat-panel.tsx`、`group-conversation.tsx`、`agent-panel.tsx`、`computers-panel.tsx`、`agent-activity-panel.tsx`、`portal.tsx`

---

## 2. 总体架构

```
┌────────────────────────────── Mac mini（macOS）───────────────────────────────┐
│                                                                                │
│  浏览器 / 手机 PWA（经 Tailscale）                                              │
│        │ HTTPS + WebSocket                                                     │
│  ┌─────▼──────────────────────────── hived（Bun，单进程）───────────────────┐ │
│  │  HTTP API · WebSocket 事件总线 · 鉴权                                      │ │
│  │  Agent Manager：Pi 会话（每 Agent 一个）· 工作队列 · 回合调度               │ │
│  │  Chat：频道、消息、提及、附件         Tasks：看板、分配、交接               │ │
│  │  Workstation Manager：租约（构建 / 模拟器 / 桌面）· 内存压力保护            │ │
│  │  Model Gateway（内置）：OpenRouter / OpenAI 兼容端点 · 用量计量 · 预算       │ │
│  │  Git Relay：持有 GitHub token，Agent 无法接触                              │ │
│  │  SQLite（bun:sqlite）· 文件存储 · 审计                                     │ │
│  └───────┬────────────────────────────────────────────────────────────────────┘ │
│          │ 经特权助手 hive-exec，以工作站用户身份执行                            │
│   ┌──────▼────────┐  ┌───────────────┐  ┌───────────────┐                        │
│   │ 工作站 ws-1    │  │ 工作站 ws-2    │  │ 桌面工作站     │  ← 各自一个 macOS 用户  │
│   │ worktrees      │  │ worktrees      │  │ 控制台会话     │                        │
│   │ DerivedData    │  │ DerivedData    │  │ screencapture  │                        │
│   │ 模拟器设备     │  │ 模拟器设备     │  │ cliclick       │                        │
│   │ tmux 终端      │  │ tmux 终端      │  │ 辅助功能权限   │                        │
│   └───────────────┘  └───────────────┘  └───────────────┘                        │
│                  共享：Xcode、Simulator runtime、git 镜像（只读）                  │
└──────────────────────────────────────────────────────────────────────────────────┘
          │ OpenRouter（以后：本地 Qwen）            │ GitHub（由 Git Relay 推送）
```

### 2.1 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 运行时与语言 | **Bun + TypeScript** | Pi SDK 是 TS；ASNG 同栈，便于对照阅读；前后端共享类型 |
| 后端框架 | Fastify + TypeBox（生成 OpenAPI 与前端类型） | 与 ASNG 一致，便于参考 |
| 数据库 | **SQLite（bun:sqlite）+ Drizzle**，WAL 模式 | 比 Prisma 轻，更适合 16GB 机器；单后端进程足够 |
| Agent 运行 | **Pi SDK，在 hived 进程内**，每个 Agent 一个会话 | 与 ASNG 相同；工具由我们实现并带权限检查；不为每个 Agent 起子进程，省内存 |
| 实时通信 | 单条 WebSocket，类型化事件（消息、输入状态、运行状态、活动、租约） | 前端简单 |
| 前端 | React + Vite + Tailwind + shadcn/ui + TanStack Query + React Router，深色主题优先，PWA | 与 ASNG 同形态 |
| 终端 | tmux 会话 + xterm.js 前端查看 | 与 ASNG 一致，且程序在断开后继续运行 |
| 隔离 | 专用 macOS 用户（工作站）+ 作用域受限的工具 | 不用容器，贴合 Xcode |
| 凭据 | OpenRouter key 与 GitHub token 只在 hived；工作站用户拿不到 | Agent 不可见 |

### 2.2 为什么 Pi 放在 hived 进程内，而不是工作站里

Pi 本身只负责"模型加工具循环"。**真正执行命令的是我们的工具**，它们通过特权助手在对应工作站用户下执行。这样：

- 凭据和模型调用始终在 hived，工作站用户拿不到；
- 会话持久化、预算、审计都集中在一处；
- 一个进程管理所有 Agent，内存占用低；
- 以后工作站换成别的类型（Tart 虚拟机、另一台 Mac），只需要换工具的执行后端。

Pi SDK 的具体 API（`createAgentSession`、`defineTool`、`SessionManager` 等）以 ASNG 锁定的版本（`@earendil-works/pi-coding-agent` 与 `pi-ai` 0.85.1）为起点，**【需验证】** 当前版本是否一致。

---

## 3. 核心概念与数据模型

所有实体带 `owner_user_id`（默认 1）和 `org_id`（默认 1），为以后的多用户预留。

| 实体 | 说明 |
|---|---|
| **User** | 仪表盘账号（角色：admin / member）。v1 只有 Admin |
| **Endpoint** | 模型连接：OpenRouter、OpenAI 兼容端点（以后本地 Qwen）。key 加密存储 |
| **Agent** | 名字、头像（程序生成）、角色说明、系统提示词、模型（endpoint + model + thinking）、工具授权、绑定的工作站、预算、状态 |
| **Channel** | `dm`（人与 Agent）、`agent_dm`（Agent 之间，人可只读查看）、`group`（成员含人和多个 Agent）、`task`（任务专属讨论串，可选） |
| **Message** | 作者（user / agent / system）、正文（Markdown）、回复引用、提及、附件、反应 |
| **Attachment** | 截图、日志、文件，存文件系统，库里存元数据和访问权限（跟随频道授权） |
| **Task** | 标题、描述、验收标准、状态、负责人（Agent）、依赖、仓库、分支、worktree、PR 链接、工作站 |
| **Workstation** | 一个 macOS 用户加工作目录；类型 `macos-user`（默认）、`local-dir`（回退）、`console`（带桌面）；资源上限；分配给哪些 Agent |
| **Lease** | 对稀缺资源的租用：`build`（全局构建槽）、`simulator`（模拟器设备）、`desktop`（桌面控制权）、`workstation-write` |
| **Run** | 一次 Agent 回合：触发来源、起止、token、费用、结果 |
| **ActivityEvent** | Run 内的事件：思考摘要、工具调用、工具结果摘要、截图引用（独立于聊天，分页读取） |
| **Memory** | Agent 的记忆条目和索引（v1：每个 Agent 一个目录的 Markdown 文件） |
| **Approval** | 需要人确认的动作及其结果 |
| **UsageRecord** | 每次模型调用的 token 和费用 |
| **AuditLog** | 登录、创建/删除 Agent 与工作站、授权变更、审批结果 |

---

## 4. Agent 运行时

### 4.1 回合生命周期

```
触发（人的消息 / 被 @ / 被分配任务 / 定时器 / 租约到手 / 审批返回）
  → 入工作队列（每 Agent 一条，同时只有一个活跃回合）
  → 组装输入（稳定的系统提示词 + 记忆摘要 + 触发内容，含来源频道 ID）
  → Pi 会话执行：模型 ↔ 工具循环
       - 事件流写入 ActivityEvent，并通过 WebSocket 推给前端
       - 只有 send_message 才产生聊天消息
  → 回合结束：保存会话检查点，更新状态，必要时压缩上下文
```

### 4.2 触发与防刷屏

- 私聊的消息、群里被 @、被分配任务、被交接，才会唤醒 Agent。群里没被 @ 的消息只作为上下文，不触发。
- Agent 之间同一会话连续往返超过 6 次，自动暂停并通知人。
- 每 Agent 每小时消息数上限；提示词禁止无实质内容的确认消息。
- 新消息在 Agent 忙时进入队列，在**回合边界**送达（v1）；"是否打断当前回合"的判断（参考 ASNG 的 `message-interruption.md`）放在后期。

### 4.3 预算与保护

- 每个 Run 与每个任务：最大轮数、token、费用、时长，超限暂停并 @人。
- 循环检测：同一命令连续失败 5 次、同一文件被反复改回，暂停求助。
- OpenRouter key 在其后台设额度上限；hived 内置请求并发上限和 429 退避。
- 模型按 Agent 单独配置；固定服务商并记录实际服务商，便于对比评测。【需验证 OpenRouter 的服务商路由参数】

### 4.4 会话与记忆

- Pi 会话检查点存 SQLite，hived 重启后恢复；运行中被打断的流不自动重放。
- 上下文使用率超过阈值（如 70%）时，让 Agent 写状态摘要后压缩或开新会话。
- 记忆 v1：`agents/<id>/MEMORY.md`（短索引）加 `notes/`，由 `memory_*` 工具读写；"睡眠整理"、出处标注、提醒线索放到后期。
- 项目级知识放在目标仓库的 `AGENTS.md`，所有 Agent 共享（DoFocus 需要先补一份）。

---

## 5. 工具目录（显式授权，Pi 内置工具全部关闭）

每个 Agent 在设置页勾选授权组；工具在执行处二次检查。类别：**r** 只读、**w** 写、**claim** 需要先领取租约。

| 授权组 | 工具 | 类别 | 说明 |
|---|---|---|---|
| **沟通**（基线） | `send_message`、`read_channel`、`search_messages`、`react`、`attach_file` | r/w | 只能操作自己所在的频道；历史按块分页返回，不倾倒整份记录 |
| **同事** | `agent_directory`、`message_agent`（私聊另一个 Agent）、`create_group`（需审批） | r/w | 只能联系已建立连接或同组织的 Agent |
| **任务** | `task_list`、`task_get`、`task_create`、`task_assign`、`task_update`、`task_handoff`、`task_comment` | r/w | `create/assign` 一般只给 lead；`handoff` 校验固定模板 |
| **记忆** | `memory_read`、`memory_write`、`memory_search` | r/w | 限自己的目录 |
| **时间** | `timer_set`、`reminder_set`、`current_time` | w | 持久化，重启后仍然有效 |
| **工作站·文件** | `ws_read`、`ws_write`、`ws_edit`、`ws_list`、`ws_grep` | r / claim | 作用域限当前任务的 worktree 和自己的目录，越界直接拒绝 |
| **工作站·终端** | `ws_bash`（同步，带超时）、`term_create`、`term_send`、`term_read`、`term_kill` | claim | tmux 会话；输出截断并写文件 |
| **Xcode**（延后到 P8） | `xcode_info`、`xcode_build`、`xcode_test`、`xcode_run` | claim | 经全局构建槽排队；输出只留错误和失败用例 |
| **模拟器**（延后到 P8） | `sim_screenshot`、`sim_ui_tree`、`sim_tap`、`sim_type`、`sim_swipe`、`sim_logs`、`sim_reset` | r / claim | 只能操作本任务租到的设备 |
| **Git** | `git_status`、`git_commit`、`git_push`（经 Relay）、`pr_create`、`pr_comment` | w | 只能推 `hive/*` 分支，禁止 force |
| **桌面** | `desktop_screenshot`、`desktop_click`、`desktop_type`、`desktop_key`、`desktop_scroll`、`desktop_acquire/release` | r / claim | 单一控制台会话，领取后才能输入 |
| **浏览器**（后期） | `browser_open`、`browser_snapshot`、`browser_click`、`browser_fill` | claim | Playwright 读页面结构，不靠像素 |
| **审批** | `ask_human` | — | 阻塞式提问，用于危险操作 |

工具输出原则：默认约 2k token 以内，详情写文件并返回路径；截图只在被明确请求时作为图片返回，且缩放到固定尺寸以控制 token。

---

## 6. 工作站（Mac 原生）

### 6.1 定义

**工作站 = 一个 macOS 用户 + 一套目录 + 一组租约。** Agent 通过"绑定"获得工作站，同一个工作站可以被多个 Agent 读取，写操作需要领取。

```
/Users/ws-<name>/hive/
├─ worktrees/<repo>/<task-id>/
├─ derived/<task-id>/
├─ artifacts/<task-id>/          # 截图、日志、xcresult 摘要
└─ agents/<agent-id>/            # 记忆、笔记、草稿
```

### 6.2 类型与回退

| 类型 | 说明 | 何时用 |
|---|---|---|
| `macos-user`（默认） | 独立 macOS 用户，真正的隔离 | 模拟器可在该用户下正常工作时 |
| `local-dir` | 同一个 `hive` 用户，仅目录隔离 | 如果 P0 实测发现多用户下模拟器有问题，先用它 |
| `console` | 控制台登录的那个用户，唯一能被截屏和点击的桌面 | 桌面控制 |
| `tart-vm`（以后） | Tart 虚拟机 | 内存更大的机器上，需要更强隔离时 |

### 6.3 创建与执行

- 创建用户：`sysadminctl -addUser ...`（需要管理员权限）。**只由一个小型特权助手 `hive-priv` 完成，不让 hived 以 root 运行**。
- 执行命令：hived 通过 `sudo -n -u ws-<name> hive-exec ...` 调用助手；`sudoers` 里只放行这一个助手和这一类目标用户。助手负责：设置环境、限制工作目录、超时、输出截断。
- 终端：每个工作站用户一个 tmux 服务，会话在 Agent 断开后继续运行；hived 读取输出并推给前端的 xterm.js。
- 【需验证】在非控制台用户下：`simctl boot`、`simctl io screenshot`、`xcodebuild test`、AXe 是否都能正常工作（用户的 launchd GUI 域是否存在）。这是 P0 必测项，决定默认类型。
- Xcode 与 Simulator runtime 是系统级共享的；用户各自拥有 `~/Library/Developer`（DerivedData、模拟器设备、缓存）。每个新用户首次要做一次初始化（`xcodebuild -runFirstLaunch` 属系统级，已完成则无需重复）。【需验证】

### 6.4 资源租约与 16GB 的硬规则（构建槽和模拟器两项随 Apple 工具包延后）

| 资源 | 规则 |
|---|---|
| 构建槽 | **全局只允许 1 个 `xcodebuild`** 同时运行（M0 实测后可提到 2）；其余排队，聊天里显示排队位置 |
| 模拟器 | 同时启动的不超过 2 台；闲置 5 分钟自动关闭；设备型号与 runtime **固定**，保证快照测试稳定 |
| 活跃 Agent | 同时活跃的回合不超过 2–3 个（大部分时间在等模型和构建，不占内存） |
| 桌面 | 一个控制台会话，同一时刻一个持有者，超时自动释放 |
| 内存压力 | hived 每 10 秒读取 `memory_pressure` 与 swap；进入 warn 级别就暂停发新构建，并在界面显示横幅 |
| 磁盘 | 监控剩余空间；任务结束清理 DerivedData；定期清理旧 worktree |

### 6.5 Xcode 与模拟器工具的实现要点（针对 DoFocus，延后到 P8）

- 固定命令：`xcodebuild -project DoFocus.xcodeproj -scheme DoFocus -destination "id=<UDID>" -derivedDataPath <dd> -jobs N CODE_SIGNING_ALLOWED=NO`。
- 默认只跑相关测试（`-only-testing`）；全量测试只在提交前跑一次并带超时。
- 测试结果用 `-resultBundlePath` 加 `xcresulttool` 解析，只返回失败用例、断言和相关日志片段。
- DoFocus 有大量快照测试：所有 Agent 必须使用同一型号和 runtime 的模拟器；**不得自行更新快照基准**，需审批。
- 模拟器界面：`simctl` 加 AXe（或 idb）读界面结构、按标签点击；截图通过 `simctl io screenshot`。【需验证 AXe 当前命令集】
- 禁止项：不提供任何真机、`devicectl`、签名、证书相关的工具。仓库里的 `.pi-build.sh` 写死了模拟器 UDID 并会装到真机，**仅供你个人使用，Agent 不得运行**。

### 6.6 Git 与 PR

- hived 维护本机 bare 镜像，Agent 的 `origin` 指向镜像；`git_push` 经 Relay 检查（分支必须是 `hive/<agent>/<task>-<slug>`、禁止 force、大小上限、简单密钥扫描）后才推到 GitHub。
- PR 由 Relay 用 GitHub token 创建和更新；合并只由人（或人授权的 lead）完成。
- GitHub token 使用 fine-grained PAT，只授予目标仓库的 contents 和 pull requests 权限；`main` 开启分支保护。

---

## 7. 桌面控制

### 7.1 现实约束

- macOS 上只有**控制台登录用户的图形会话**能被 `screencapture` 截取、被 `cliclick` 操作。其他用户的后台会话不行。【需验证】
- 所以桌面控制是**一个共享资源**：对应 `console` 工作站，同一时刻只给一个 Agent 写，其他 Agent 可以只读看截图（"一人写、多人读"）。
- 大多数 iOS 测试**不需要桌面**：用 `simctl` 加 AXe 在后台完成。桌面主要用于 Xcode 界面、系统弹窗、macOS App、网页后台（App Store Connect 等）。
- Mac mini 无显示器时，图形会话和截图可能异常，可能需要 HDMI 假负载。【P0 实测】

### 7.2 实现

- 工具：`screencapture`（固定缩放尺寸，如 1280×800，控制 token）、`cliclick`（点击、输入、按键）。
- 权限：**屏幕录制**和**辅助功能**这两项 TCC 权限只能由人在系统设置里授予一次，授予对象是一个固定的助手二进制（`hive-desktop`）。首次启动时 UI 引导用户完成。
- 优先用结构而不是像素：能用 AXe / Accessibility API 读元素就不靠截图加坐标；网页用 Playwright 的页面快照。
- 模型要能看图并点准坐标：P0 用你选的模型实测；不行时再考虑单独的视觉模型。
- 查看：v1 用定时截图（缩略图 2 秒一次，仅在卡片可见时请求）；以后需要实时再接 macOS 屏幕共享（VNC）加网页端查看。

---

## 8. 任务、分配与协作流程

这是 ASNG 没有而你需要的部分：**任务层**。

### 8.1 状态

`backlog → todo → in_progress → in_review → done`，另有 `blocked`。每个任务可选地绑定一个任务频道，用于讨论。

### 8.2 流程

```
你（私聊或群聊）：给 DoFocus 增加 X、Y、Z
  → lead 拆解：task_create ×3（含验收标准、依赖），在群里列出方案并 @你确认
  → 你确认后，lead 用 task_assign 指派给 dev-1 / dev-2（或你在看板上手动指派）
  → dev：start（建 worktree、租模拟器）→ 实现 → xcode_build / xcode_test → 在模拟器里验证 → git_push → pr_create → 状态 in_review，@reviewer
  → reviewer：读 diff 和测试结果，在 PR 和频道里评论；通过则 @你；不通过则 @dev 打回
  → 你：合并 PR；任务 done；worktree 清理
```

### 8.3 角色（初始模板，可自定义）

| 角色 | 默认授权 | 说明 |
|---|---|---|
| lead | 沟通、同事、任务、记忆 | 不写代码，只拆解、分配、跟进、汇报 |
| dev | 沟通、同事、任务（只读加更新自己的）、工作站、Xcode、模拟器、Git、记忆 | 写、测、验证一体 |
| reviewer | 沟通、同事、任务、工作站（只读）、Git（只读加 PR 评论） | 不占构建槽 |
| operator | 沟通、桌面、浏览器 | 需要桌面时才启用，默认关闭 |

### 8.4 交接

`task_handoff` 的说明必须包含：背景、已完成、未完成与下一步、分支与状态（是否已推送、能否编译）、如何验证、注意事项。迁移靠推送 WIP 分支，接收方在自己的 worktree 里继续，不拷贝目录。

### 8.5 看板与外部系统

- v1：本地看板。
- 后期：Linear 双向同步（`TaskProvider` 接口，无公网时轮询）。

---

## 9. 前端规划（参考 ASNG 的截图）

### 9.1 总体样式

- **深色主题为主**，圆角卡片，顶部居中的**药丸形导航条**：Chat · Agents · Tasks · Workstations · Dashboard · Settings。
- 左上角工作区（组织）切换器；右上角 **Portal 搜索**（Ctrl/⌘+K），搜索 Agent、频道、任务、工作站、文件。
- 技术：React + Vite + Tailwind + shadcn/ui；图表用 Recharts；终端用 xterm.js；Markdown 用 react-markdown 加代码高亮；PWA（只缓存静态资源，不缓存 API，更新前提示）。
- 响应式：手机上底部浮动标签栏，列表与对话分屏切换。
- Agent 头像：用确定性算法生成的圆润"小方块表情"SVG（根据名字和颜色种子），带状态点（在线 / 工作中 / 等待 / 出错）。

### 9.2 页面

| 页面 | 内容 |
|---|---|
| **Chat** | 左栏：搜索框、新建群聊按钮、会话列表（头像、最后一条消息、时间、状态点）。右侧对话：作者分组、Markdown、代码块、表格、图片附件、回复引用、反应；顶部显示成员；底部是 "X is working…" 提示和输入框（附件、发送 / 停止）。群聊有成员编辑和文件抽屉 |
| **Agents** | 列表加创建。单个 Agent 的设置：身份与头像、指令、模型（端点、模型、思考强度）、工具授权勾选、绑定工作站、预算、记忆查看与编辑、**活动检查器**（按回合展开的工具调用、结果摘要、截图、token、费用） |
| **Tasks** | 看板（列：todo / in_progress / in_review / done / blocked），拖拽改状态；卡片显示负责人头像、PR 状态、预算；详情抽屉含描述、验收标准、依赖、交接记录、关联频道 |
| **Workstations** | 网格卡片（对应 ASNG 的 Computers）：名称、类型、占用者、**实时预览**（最近一张桌面截图或终端尾部）、CPU 与内存环形图、租约状态；详情页分标签：**终端**（xterm.js）、**模拟器**（设备列表加最新截图）、**桌面**（控制台截图加领取按钮）、**文件**、**租约** |
| **Dashboard** | 主机内存压力与 swap、CPU、磁盘；构建队列；模拟器占用；各 Agent 的活跃时长、token 和费用；Run 列表 |
| **Settings** | 模型端点、GitHub、工作站管理、安全（登录、地址限制）、用户（后期）、审计日志、通知 |

### 9.3 交互细节

- 全局一条 WebSocket 订阅：消息、输入状态、Run 状态、活动、租约、告警；刷新页面后按快照重连，不重跑 Agent。
- 内存压力、磁盘将满、构建排队等以顶部横幅显示。
- 审批（`ask_human`）以带按钮的消息出现在私聊和仪表盘顶部。
- 无障碍与一致性：可点击元素用指针光标；重要切换有过渡动画并尊重"减少动效"。

---

## 10. 安全

- 仪表盘必须登录（v1 单个 Admin，首次访问设置密码），默认拒绝；只监听本机和 Tailscale 地址，不暴露公网；会话令牌只存哈希。
- Agent **没有任何隐含权限**：所有能力通过显式授权，且在执行处检查；工具可见不等于可用。
- 工作站用户无法读取 hived 的数据目录、其他工作站、你的个人用户目录。
- 凭据只在 hived：OpenRouter key、GitHub token、将来的 Linear key。
- 审批覆盖：force push、推非 `hive/*` 分支、更新快照基准、删除工作区外文件、桌面上的危险操作。
- 审计日志：登录、增删 Agent 与工作站、授权变更、审批结果；只记字段名，不记密钥。
- 私有代码会发往 OpenRouter 的服务商：先在 OpenRouter 设置里限定"不保留数据"的服务商。

---

## 11. 仓库结构

```
hive/
├─ apps/
│  ├─ hived/               # 后端：API、WebSocket、Agent 运行、工作站、Relay
│  └─ web/                 # 前端
├─ packages/
│  ├─ core/                # 共享类型、事件定义、DB schema（Drizzle）
│  ├─ tools/               # Pi 自定义工具（沟通、任务、工作站、Xcode、模拟器、桌面…）
│  └─ priv-helper/         # hive-priv / hive-exec 特权助手（Swift 或 Bun 编译）
├─ evals/                  # 预埋 bug 的评测任务集与评分脚本
├─ docs/                   # 设计文档、决策记录（decisions/）、AGENTS.md 模板
├─ scripts/                # 安装、launchd、备份
└─ ops/launchd/
```

> 新仓库需要你来建，或明确授权我创建（我这个会话目前只有 DoFocus 的 GitHub 访问权限）。

---

## 12. 阶段计划与验收（范围调整后）

每个阶段结束都必须能演示，达不到验收标准不进入下一阶段。规模：S 约几天，M 约一到两周，L 约两周以上（以一人加 AI 辅助的节奏粗估，仅供排序，不是承诺）。

**评测夹具**：建一个小型的、与 Apple 无关的示例仓库 `hive-sandbox`（例如带单元测试的 TypeScript 项目），预埋若干问题，用来评测 Agent 的编码能力；另设几个"协作场景"（群里讨论、拆任务、交接）评测模型在多 Agent 协作上的表现。这些评测在更换模型（OpenRouter 的不同模型、以后的本地 Qwen）时重复使用。

### P0：可行性验证（S，不写产品代码）

在 Mac mini 上做三个小实验，每个出一页结论记入 `docs/decisions/`：

1. **Pi SDK**：用 OpenRouter 的模型，`noTools: 'all'` 加一个自定义工具，完成一次对话；会话保存后重启并恢复；多个会话并发运行；记录 tool calling 的稳定性。
2. **macOS 用户工作站**：创建新用户；以该用户执行命令、开 tmux、用 git；限制工作目录；验证它读不到其他用户的目录。结论决定默认工作站类型（`macos-user` 或 `local-dir`）。
3. **桌面控制**（可选，可推迟到 P5 前）：`screencapture` / `cliclick` 能否在控制台会话工作；TCC 授权流程；无显示器时的表现。

**产出**：`BASELINE.md` 与默认工作站类型的决策。

### P1：平台骨架与单聊（M）

- monorepo、Bun + Fastify、SQLite + Drizzle、TypeBox → OpenAPI → 前端类型、登录（Admin）。
- 模型端点（OpenRouter 加 OpenAI 兼容）、Agent 创建与编辑、头像生成。
- Agent Manager：Pi 会话、工作队列、`send_message`、会话持久化、用量计量、Toolpack 加载框架。
- 前端：深色主题外壳、Chat（私聊）、Agents、Settings、输入中状态、活动检查器基础版。

**验收**：在界面里创建 Agent，选 OpenRouter 的模型，私聊它；刷新页面不丢状态、不取消运行；重启 hived 后会话可继续；能看到本次的 token 和费用；创建第二个 Agent 并分别私聊，互不干扰。

### P2：通用工作站与编码闭环（M）

- 特权助手、工作站管理器、`macos-user` / `local-dir` 工作站、通用租约（重任务槽、写入领取）、内存压力保护。
- `core.workstation` 工具包：文件、终端（tmux）、grep、git；Git Relay 与 PR 创建。
- 前端：Workstations 页（网格、终端查看、文件、租约）。
- 评测夹具与第一版评测集（8 个编码问题）。

**验收**：在聊天里对一个 dev Agent 说"`hive-sandbox` 里这个测试失败了，修好它"，它在无人干预下：读代码 → 修改 → 运行测试 → 推送分支 → 创建 PR；8 题各跑 3 次，输出成功率、耗时、轮数、token 和费用报告。

### P3：多 Agent 与群聊（M）

- 群聊、Agent 间私聊、提及唤醒、防刷屏规则、回复与反应、成员管理、频道文件。
- 调度器：多 Agent 并发回合、资源排队、可见的排队与等待状态。
- 前端：群聊界面、Agent 间会话（只读查看）、活动检查器完善、Portal 搜索。

**验收**：在群里让两个 dev Agent 各自完成一个独立小任务，期间你私聊第三个 Agent 不被阻塞；两个 Agent 能互相讨论并给出结论；Agent 之间的往返超过上限时自动暂停并通知你。

### P4：任务、分配与评审（M）

- 任务实体与看板、`task_*` 工具、lead / reviewer 角色模板、交接模板、PR 自动化与状态回写、任务频道。
- 前端：Tasks 看板和详情。

**验收**：对 lead 提出含 3 个子功能的需求，lead 拆解、你确认后，2 个 dev 并行完成并提 PR，reviewer 评审；中途手动把一个任务从 dev-1 交接给 dev-2，对方能接着完成。

### P5：桌面与浏览器（M）

- `desktop` 与 `browser` 工具包：控制台工作站、桌面工具与租约、TCC 授权引导、截图缩放与图片池、Playwright 浏览器工具。
- 前端：桌面标签（截图、领取、释放）、危险操作审批。

**验收**：operator 在一个网页后台完成一个只读或低风险任务并带截图汇报；触发危险操作时正确请求审批；同时另一个 dev 的终端任务不受影响。

### P6：多用户与完善（M）

- 仪表盘账号与权限（admin / member，每人只看自己的 Agent、频道、工作站）、组织、审计日志与访问日志、已知地址与锁定。
- 用量与成本仪表盘完整版、Web Push、PWA 安装、记忆的"睡眠整理"、心跳、todo 续跑、Linear 同步。

**验收**：创建第二个用户，其 Agent 和聊天对第一个用户不可见；手机上安装 PWA 并收到 Agent 的推送。

### P7：本地模型（S）

Mac Studio 到位后，新增本地 OpenAI 兼容端点，把部分 Agent 切过去，用评测集对比 OpenRouter；根据实测调整并发和上下文策略。

### P8：Apple 工具包（L，最后做）

按本文第 5、6.4、6.5 节实现 `apple.xcode` 工具包：构建槽、模拟器池、Xcode 与模拟器工具、DoFocus 的评测集与 `AGENTS.md`。内存需求届时以 Mac 的实际配置为准。

**验收**：对一个 dev Agent 说"设置页某按钮文案错了，修一下"，它在无人干预下完成 定位 → 修改 → 编译 → 模拟器确认 → 推送 → PR。

---

## 13. 风险与待确认

### 13.1 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 16GB 内存紧张 | 换页导致构建和模拟器卡死 | 构建槽加模拟器上限加内存压力保护；P0 实测后再定并发；必要时升级到 32GB 以上 |
| 非控制台 macOS 用户下模拟器或 AXe 不可用 | 多用户隔离方案不成立 | P0 实测；回退到 `local-dir`；以后用 Tart 或第二台 Mac |
| TCC 权限与无显示器 | 桌面控制不稳定 | P0 实测；HDMI 假负载；先靠 AXe / Playwright |
| Pi SDK 接口变化或不满足需求 | 阻塞 | 锁定版本；封装一层 `AgentRuntime` 接口，必要时换自写的循环 |
| 模型质量不够（Qwen 类） | 成功率低、费用高 | P2 评测集尽早暴露；lead / reviewer 用更强模型；记录服务商 |
| 特权助手的安全 | 提权漏洞 | 极小的接口、固定目标用户模式、不接受任意命令拼接、审计日志、代码审查 |
| 快照测试误报 | Agent 被误导去改基准 | 固定设备；更新基准需审批 |
| 范围过大 | 做不完 | 严格按阶段；每阶段可用；P2 是第一个"真正有价值"的节点 |

### 13.2 需要你确认

1. "多个用户"的理解是否正确（macOS 用户隔离 + 以后的仪表盘账号）？
2. 新仓库 `hive` 放在哪个 GitHub 账号下？是否授权我创建？
3. 每个任务的费用上限（建议先 $2–5）。
4. mini 是否接显示器？
5. 内存：16GB 能做 P0 到 P2 的验证；之后要不要升级到 32GB 以上，取决于 P0 的实测。

---

## 14. 给实现者的提示（可原样交给 Claude Code / Codex）

> 你要实现 `HIVE_PLAN.md`。
> 1. 先只做 P0，产出 `BASELINE.md` 与决策记录，然后停下来等我确认。
> 2. 每个阶段开始前，先列出该阶段的文件结构、数据库变更和测试计划给我确认；完成后按验收标准演示（命令输出、截图、PR 链接）。
> 3. 标 **【需验证】** 的事项，先查官方文档或实测，把结论写进 `docs/decisions/`。
> 4. 阅读 ASNG（`AlexZihaoXu/agent-swarm-ng`）来理解设计，但**不要复制整段代码**；用我们自己的结构重写。
> 5. 平台无关的部分（聊天、任务、调度、工具的权限检查）必须有单元测试；macOS 专有部分（特权助手、工作站、Xcode、桌面）写成可替换的接口，并在 mini 上做集成验证。
> 6. 所有工具输出要短；系统提示词保持稳定，动态内容放在消息末尾；Agent 没有任何默认权限。
> 7. 不要实现规格以外的功能；认为规格有问题时，提出来讨论，而不是自行修改设计。
> 8. **本版不要实现 Xcode、模拟器相关的任何东西**（P8 才做），但必须按「范围调整」一节实现 Toolpack 接口，保证以后能无痛接入。
