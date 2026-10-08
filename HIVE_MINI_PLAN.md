# Hive-Mini：在 16GB Mac mini 上跑的 Agent Swarm（MVP 规划）

> 前置文档：`HIVE_SPEC.md`（完整愿景）、`HIVE_TART.md`（Tart 变体）。本文档是**第一版可落地的缩减方案**：
> 先在一台 16GB M4 Mac mini 上、用 OpenRouter 的 API 代替本地 Qwen，把"多 Agent + 独立工作区 + Xcode 闭环 + 聊天与任务"跑通。
> 标有 **【需验证】** 的是写作时无法确认的事实，实现前先查文档或在 mini 上实测。

---

## 1. 范围

### 1.1 这一版要做到

1. 多个 Agent 并发工作，每个任务一个 git worktree、一条分支、一个 PR。
2. 每个 Agent 有独立工作区、独立 DerivedData、独立 Simulator。
3. Agent 能完成 改代码 → 编译 → 跑测试 → 在 Simulator 里看 UI → 修改 的闭环。
4. 你可以和任意 Agent 私聊、建群聊；Agent 之间可以 @、交接任务。
5. 模型走 OpenRouter，随时可以换成本地 Qwen（只改网关后端）。

### 1.2 这一版**不**做

- 不用 Tart（16GB 放不下 Xcode 加 VM，先原生跑）。
- 不做"看屏幕点鼠标"的 Operator（放到后期，M5）。
- 不接 Linear（先用本地任务库，接口预留）。
- 不动真机：不用 `devicectl`，不碰你的 iPhone。
- 不做签名、发布、App Store 相关的任何操作。

### 1.3 DoFocus 的现状（已查看仓库）

| 事实 | 对设计的影响 |
|---|---|
| iOS 应用，`DoFocus.xcodeproj`，scheme 为 `DoFocus`，iOS 部署目标 26.4，无 workspace | 单一工程，命令固定 |
| 另有 `DoFocusMonitor`、`DoFocusWidgets` 等 target | 构建会比较重，要限制并行度 |
| `DoFocusTests/` 下有约 60 个测试文件，**包含大量快照测试**（`*SnapshotTests`） | 快照对设备型号和系统版本敏感，**所有 Agent 必须固定使用同一种模拟器型号和 runtime**，否则大量误报 |
| `.pi-build.sh` 已在用：写死了模拟器 UDID，DerivedData 共享，还会安装到你的真机 | **Swarm 不能直接用它**；`hive-xcode` 要自己管理模拟器和 DerivedData，且禁止真机安装 |
| 屏蔽功能的 entitlements 默认关闭，模拟器构建可以不签名 | 构建时用 `CODE_SIGNING_ALLOWED=NO`，不需要任何证书 |
| `doFocus.md`、`Docs/Todo List.md` 已有产品说明 | 可以作为 Lead 拆任务的素材 |

---

## 2. 16GB 的资源预算（估算，M0 要实测）

| 项目 | 内存 |
|---|---|
| macOS（无浏览器、无多余应用） | ~4–5 GB |
| 一次 `xcodebuild`（限制 `-jobs`） | ~4–7 GB |
| 每台启动中的 Simulator | ~1.5–2.5 GB |
| 每个 Agent 进程（Node） | ~0.3–0.5 GB |
| Hive 守护进程 + 网关 | ~0.3 GB |

**结论与硬规则：**

1. **最多 2 个 Agent 同时"活跃"，但同一时间只允许 1 个 `xcodebuild`**（全局构建信号量）。
2. Simulator 按需启动、闲置 5 分钟自动关闭；同时启动的不超过 2 台。
3. Agent 大部分时间在等模型响应，真正占内存的是"构建"和"模拟器"，所以把它们做成**被租用的资源**，不是每个 Agent 常驻一份。
4. 构建参数：`-jobs 4`（具体数值 M0 调）；每个 Agent 独立 DerivedData，任务结束清理。
5. 磁盘：Xcode + runtime + 缓存很容易超过 100GB，**M0 先检查剩余空间**。
6. 内存压力监控：守护进程每 10 秒读 `memory_pressure` / swap，进入 warn 级别时暂停发新的构建，并在聊天里通知你。

---

## 3. 总体架构

```
┌──────────────────────────── Mac mini（用户 hive，无显示器可远程）────────────────────────────┐
│                                                                                              │
│   你 ── hive CLI / TUI（M3 起加 Web UI，经 Tailscale 手机可用）                                │
│            │                                                                                 │
│   ┌────────▼──────────────────────────── hived（守护进程）──────────────────────────────┐    │
│   │  Task Store(SQLite) · Chat Bus · Scheduler · Run Manager · Leases · Approvals        │    │
│   └───┬───────────────┬──────────────────────┬─────────────────────┬─────────────────────┘    │
│       │ spawn          │ 租约                 │ 请求模型             │ 推送                      │
│       ▼                ▼                      ▼                     ▼                          │
│   Agent 进程 ×N     资源池                 LLM Gateway           Git Relay                     │
│   (pi 或内置循环)    ├ build 信号量(1)       (保管 OpenRouter key)  (保管 GitHub token)          │
│   cwd=自己的worktree ├ Simulator 池(2)       预算/并发/日志                                     │
│       │             └ worktree 目录                  │                   │                     │
│       └─ 调用 CLI：hive-xcode · hive-chat · hive-task · git                                    │
└───────────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                         ▼                    ▼
                                                                    OpenRouter            GitHub
                                                                 （以后换本地 Qwen）
```

### 3.1 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（Node） | pi 是 TS，Gateway/CLI/Web 可同一套代码 |
| 存储 | SQLite（单文件） | 零运维，足够 |
| Agent 运行器 | **适配器接口**：优先 pi，备选自带的最小循环 | pi 的编程接口、是否支持自定义 OpenAI 兼容端点、是否有非交互模式，我没法核实【需验证】；用适配器避免被卡住 |
| 工具形态 | 全部是 **CLI**（Agent 通过 bash 调用） | 与运行器无关，输出可控，便于单独测试 |
| 模型入口 | 所有 Agent 只连本机 **LLM Gateway** | OpenRouter key 不进 Agent 进程；统一预算与日志；以后换本地 Qwen 只改一处 |
| 隔离 | 专用 macOS 用户 `hive` + 目录隔离 | 16GB 不上 VM；无 Apple ID、无证书、无 GitHub 凭据 |
| 凭据 | GitHub token 在 Git Relay；OpenRouter key 在 Gateway | Agent 进程环境里没有长期密钥 |

### 3.2 仓库布局（`agentSwarm`，不放进 DoFocus）

```
agentSwarm/
├─ apps/
│  ├─ hived/            # 守护进程：任务、聊天、调度、租约、Run 管理
│  ├─ gateway/          # LLM Gateway
│  └─ web/              # M4 再做
├─ packages/
│  ├─ core/             # 类型、DB schema（drizzle）
│  ├─ runner/           # Agent 运行器适配器（pi / builtin）
│  ├─ cli-xcode/        # hive-xcode
│  ├─ cli-chat/         # hive-chat
│  ├─ cli-task/         # hive-task
│  └─ cli/              # hive（给你用的总入口 + TUI）
├─ config/
│  ├─ hive.yaml
│  ├─ agents/*.yaml
│  └─ prompts/*.md
├─ evals/               # 预埋 bug 任务集与评分脚本
└─ ops/launchd/
```

> 仓库已创建：`https://github.com/Zaaacqwq/agentSwarm`。M0 的机器基线记录在 `BASELINE.md`。

---

## 4. LLM Gateway（走 OpenRouter）

### 4.1 职责

1. 对 Agent 暴露 OpenAI 兼容的 `/v1/chat/completions`（含流式、tool calling）。
2. 转发到 OpenRouter，注入 `Authorization`，Agent 不持有 key。
3. **限流**：全局并发上限（默认 4）、单 Agent 并发 1、遇到 429 自动指数退避。
4. **预算**：按 Agent / 任务累计 token 和费用（读响应里的 usage），超过任务上限直接返回错误并通知守护进程暂停该 Agent。
5. **日志**：每次请求记录 模型、服务商、prompt/completion token、延迟、首 token 时间、费用，写入 SQLite。
6. **服务商固定**：请求里指定 OpenRouter 的服务商路由偏好，关闭自动回退，并把实际服务商记入日志，保证评测结果可比。【需验证参数名与行为】
7. **模型按角色配置**：`lead` 可以用更强的模型，`dev` 用目标模型（Qwen 3.8 Flash Next，具体 slug 到 OpenRouter 模型列表确认）。
8. 预留：`backend: openrouter | local`，切到本地 Qwen 只改配置。

### 4.2 安全与成本

- 在 OpenRouter 后台给这把 key **设置额度上限**。
- Gateway 只监听 `127.0.0.1`。
- 每任务默认上限：轮数 150、token 3M、费用 $X（你定）；超限即暂停并 @你。
- 循环检测：同一命令连续失败 5 次、同一文件被反复改回，自动暂停。
- 隐私：私有代码会发给第三方服务商，先在 OpenRouter 设置里筛选"不保留/不训练"的服务商。

---

## 5. Agent、任务与聊天

### 5.1 角色（MVP）

| ID | 角色 | 职责 | 备注 |
|---|---|---|---|
| `lead` | 拆解与调度 | 把你的高层需求拆成任务（含验收标准、依赖），指派 | M2 前由你手动建任务，M3 再让 lead 自动拆 |
| `dev-1`, `dev-2` | iOS 开发 | 实现任务，自己编译、测试、在模拟器验证，提 PR | 同一个 Agent 既写又测，省交接 |
| `reviewer` | 审 PR | 只读 diff 和测试结果，在 PR 上评论 | 纯 LLM 调用，不占构建与模拟器 |

QA 常驻 Agent 先不要，后面需要再加。

Agent 定义沿用 `HIVE_SPEC.md` 第 3 节的 YAML 格式（名字、角色、system prompt、模型、工具白名单、预算）。

### 5.2 运行方式

- Agent 是数据库里长期存在的"身份"；**进程按需启动**。
- 触发条件：私聊收到消息、群聊中被 @、被分配任务、收到交接、等待的审批返回。
- 一个 Agent 同时只处理一个任务（串行）；会话（pi session 或消息历史）持久化到 `/Volumes/Data/Dev/hive/agents/<id>/sessions/`。
- 上下文接近上限时：让 Agent 先写一份状态摘要，再开新会话继续。
- Memory：`/Volumes/Data/Dev/hive/agents/<id>/MEMORY.md`；项目共享知识放在 DoFocus 仓库的 `AGENTS.md`（需要你先写一份，见 8.3）。

### 5.3 任务

沿用 `HIVE_SPEC.md` 第 5 节的任务模型和工作流，MVP 简化为：

```
状态: todo → in_progress → in_review → done | blocked
```

- 调度：`todo` 且依赖满足 → 找空闲的 dev → 分配；全部忙则排队。
- 提交：`hive-task submit` 推分支（经 Git Relay）、创建 PR、状态改 `in_review`、@reviewer。
- 交接：`hive-task handoff <id> --to dev-2 --note-file ...`，说明必须含固定字段（背景 / 已完成 / 下一步 / 分支状态 / 如何验证 / 注意事项）。交接靠推送 WIP 分支，不拷贝 worktree。

### 5.4 聊天

- 数据模型：`channels(dm|group)`、`messages`、`threads`、`mentions`、附件（截图、日志文件路径）。
- Agent 用 `hive-chat send|read|attach|ask`。`ask` 是阻塞式审批（例如"允许 force push 吗"），你在聊天里回答。
- 防止无限对话：没被 @ 的群消息只当上下文，不触发；Agent→Agent 在同一 thread 连续往返超过 6 次自动停下并 @你；禁止发"收到""好的"这类无实质内容的消息（写进 system prompt）。
- 界面：M3 先做 **TUI**（终端里的频道列表加消息流加输入框，可 ssh 进去用）；M4 再做 Web UI。

---

## 6. 工作区与 Xcode 工具

### 6.1 目录

```
/Volumes/Data/Dev/hive/
├─ repos/dofocus.git             # bare mirror，Git Relay 维护
├─ worktrees/dofocus/<task-id>/  # 每任务一个 worktree
├─ artifacts/<task-id>/          # 截图、日志、xcresult 摘要
└─ agents/<agent-id>/            # memory、sessions

/Users/hive/.cache/xcode-builds/hive-<task-id>/  # 每任务独立 DerivedData，任务结束后清理
```

分支名：`hive/<agent-id>/<task-id>-<slug>`。

### 6.2 `hive-xcode`（最重要的一个工具）

在 worktree 内执行，自动推断任务、DerivedData 和租到的 Simulator。

```bash
hive-xcode info                             # scheme、可用 runtime、已租 Simulator
hive-xcode build                            # 等价 xcodebuild build，经全局构建信号量排队
hive-xcode test [--only DoFocusTests/XxxTests[/method]]
hive-xcode run                              # 构建 + 安装 + 在租到的 Simulator 启动
hive-xcode sim screenshot [--out f.png]
hive-xcode sim ui-tree                      # 精简的界面结构（每行一个元素）
hive-xcode sim tap --label "…" | --id … | --xy x,y
hive-xcode sim type --text "…"
hive-xcode sim logs [--since 60s] [--grep DoFocus]
hive-xcode sim reset
```

实现要点：

- 固定命令：`xcodebuild -project DoFocus.xcodeproj -scheme DoFocus -destination "id=<UDID>" -derivedDataPath <derived> -jobs N CODE_SIGNING_ALLOWED=NO`。
- 输出压缩：只返回 结果、错误数、前 N 条错误（文件:行号加代码片段）；完整日志写到 `artifacts/` 并返回路径。每个命令默认输出不超过约 2k token。
- 测试：用 `-resultBundlePath` 加 `xcresulttool` 解析，只返回失败用例和断言信息。**默认只跑与改动相关的测试**（`--only`）；全量测试只在提交前跑一次，并限制超时。
- **模拟器固定**：创建 `hive-sim-1`、`hive-sim-2`，型号和 runtime 与快照测试期望一致（现有脚本里是 iPhone 17 Pro，iOS 26.4；以快照基准为准，M0 确认）。Agent 无权选择别的设备。
- Simulator 界面操作：`simctl` 加 AXe（读界面结构、按 label 点击）；AXe 的命令集与安装方式【需验证】，备选 idb。
- 截图只在需要时才让模型看，不自动塞进上下文。`simctl io screenshot` 的输出先写入启动盘任务 scratch，再按需搬到 `/Volumes/Data/Dev/hive/artifacts/`；CoreSimulatorService 可能无法直接写外置盘。
- **禁止项**：`hive-xcode` 不提供任何真机相关命令；白名单之外的 `xcodebuild` / `devicectl` 调用由运行器层拦截。

### 6.3 `hive-task start/finish`

`start`：`git fetch` → `git worktree add` → 在启动盘创建 DerivedData 目录 → 租 Simulator（必要时启动）→ 记录。
`finish`：释放租约、关闭空闲 Simulator、清理该任务的 DerivedData；PR 合并后删除 worktree。删除前必须确认绝对路径及目标内容。

### 6.4 Git Relay

- Agent 的 `origin` 指向本机 bare mirror；GitHub token 只在 Git Relay。
- 推送前检查：分支必须是 `hive/*`、禁止 force、大小上限、简单的密钥扫描。
- Relay 负责 push 到 GitHub 并用 `gh`（或 API）创建 / 更新 PR；合并只由你完成。
- GitHub 侧：fine-grained token 只授予 DoFocus 仓库的 contents 和 pull requests 权限；`main` 开 branch protection。

---

## 7. 阶段计划与验收

### M0：Mac mini 基线（半天到一天，不写业务代码）

1. 新建专用用户 `hive`；关闭睡眠（`caffeinate` / `pmset`），开启 SSH，装 Tailscale；记录是否接显示器（无显示器时测试 Simulator 启动与 `simctl io screenshot`，必要时加 HDMI 假负载）。【需验证】
2. 装 Xcode、命令行工具、Simulator runtime、Node、`gh`、xcbeautify、AXe。
3. clone DoFocus，创建 `hive-sim-1/2`，记录：冷编译时间、增量编译时间、`-jobs` 取不同值时的峰值内存、运行一个 `--only` 测试的耗时、跑完整测试套件的耗时和内存、**快照测试在固定设备上是否稳定通过**。
4. 记录空闲时的内存、磁盘剩余。

**产出**：`BASELINE.md`，确定 `-jobs` 数、最大 Simulator 数、是否真能同时 2 个 Agent。

### M1：单 Agent 闭环 + 评测集

1. `hive-xcode` 全部命令；`hive-task start/finish`（任务先放 JSON 文件）。
2. Gateway 最小版（转发 OpenRouter、记录日志、任务级预算）。
3. 运行器适配器：先接 pi（若不行用内置循环）。
4. `evals/`：8 个预埋问题（文案错误、逻辑 bug、编译错误、缺失测试、小功能、界面错位等），每个是一个补丁加验收脚本。

**验收**：8 个评测任务各跑 3 次，输出成功率、耗时、轮数、token 与费用、失败原因分类。这份报告同时回答"这个模型适不适合你的任务"和"买 Studio 是否值得"。

### M2：守护进程、2 个 Agent 并发

1. `hived`：SQLite 任务库、调度器、Run 管理、构建信号量、Simulator 租约、内存压力保护。
2. Git Relay；`hive-task submit` 自动提 PR。
3. 2 个 dev 并发。

**验收**：同时下发 2 个独立任务，两个 Agent 并行产出 2 个 PR；构建被正确串行化、Simulator 不冲突；内存不进入严重换页；中途手动杀掉一个 Agent 进程，守护进程能恢复并继续。

### M3：聊天、交接、reviewer

1. Chat Bus、`hive-chat`、TUI、@ 唤醒、thread、审批、防循环规则。
2. reviewer 流程；任务交接；`lead` 自动拆任务（由你确认后生效）。

**验收**：在群聊 `#dofocus` 里 @lead 提一个包含 3 个子任务的需求，lead 拆解并经你确认，dev-1/dev-2 并行完成，reviewer 评审；中途把一个任务从 dev-1 交接给 dev-2，后者能接着完成；你私聊 dev-1 询问进度，得到准确回答且不阻塞其他工作。

### M4：Web UI 与远程访问

Web UI（频道、私聊、任务看板、Agent 实时活动、成本与资源面板），通过 Tailscale 在手机上使用。

### M5：Operator 与 Tart（可选）

`hive-browser`（Playwright）；视 mini 内存决定是否上 Tart VM（需要更大内存的机器）。

### M6：换成本地 Qwen

Mac Studio 到位后，Gateway 切到 `backend: local`；重跑 M1 的评测集，与 OpenRouter 的结果对比。

---

## 8. 风险与待办

### 8.1 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 16GB 内存紧张 | 换页导致构建和 Simulator 卡死 | 全局构建信号量、Simulator 按需启停、内存压力保护、M0 实测后再定并发 |
| 快照测试因设备不一致产生大量误报 | Agent 被误导去"修"测试 | 固定模拟器型号和 runtime；默认不让 Agent 更新快照基准，需审批 |
| 模型质量不够 | 成功率低、费用高 | M1 评测集尽早暴露；`lead` 和 `reviewer` 可用更强的模型 |
| OpenRouter 服务商差异和限流 | 结果不稳定 | 固定服务商、记录实际服务商、429 退避 |
| 费用失控 | 钱 | OpenRouter 额度上限 + 任务级预算 + 循环检测 |
| pi 的接口不满足需求 | 阻塞 | 适配器 + 内置最小循环兜底 |
| 无显示器的 mini 上 GUI 相关功能异常 | Simulator 截图、点击失败 | M0 实测；HDMI 假负载 |
| Agent 误操作 | 损坏仓库或环境 | 专用用户、worktree 隔离、分支保护、无真机、无签名、工具白名单 |
| 版本漂移（Xcode、runtime 升级） | 快照全挂 | 固定 Xcode 版本，升级后先跑 M0 的基线 |

### 8.2 需要你确认的决定

1. ~~新仓库放在哪个 GitHub 账号下~~：已创建 `Zaaacqwq/agentSwarm`。
2. 每个任务的费用上限（建议先设 $2–5）。
3. OpenRouter 上目标模型的确切 slug，以及能否固定服务商。
4. mini 是否接显示器。

### 8.3 建议先在 DoFocus 里补的东西

1. `AGENTS.md`：构建命令、测试命令、目录结构、编码规范、**不要碰的文件**（entitlements、StoreKit 配置、签名相关）、快照测试的使用规则。
2. 把 `.pi-build.sh` 里写死的 UDID 和真机安装部分，保持仅供你个人使用，并在 `AGENTS.md` 里明确"Agent 不得运行"。
3. 在 CI 或本地确认 `xcodebuild test` 在固定模拟器上能稳定全绿，作为 Agent 判断"我有没有改坏东西"的基准。

---

## 9. 实现者须知

1. 严格按阶段推进，M0 的数据没出来之前不要写调度器。
2. 所有 CLI 输出要短，详细内容写文件返回路径。
3. system prompt 保持稳定，动态内容放在消息末尾，便于以后本地前缀缓存。
4. macOS 专有部分（`hive-xcode`、租约、内存监控）只能在 mini 上验证；与平台无关的部分（Gateway、任务库、聊天、调度器）要有单元测试，可以在任何系统上跑。
5. 遇到【需验证】的内容，把结论写进 `docs/decisions/`。
6. 每个阶段结束时按验收标准给出可复现的输出（命令输出、报告、PR 链接）。
