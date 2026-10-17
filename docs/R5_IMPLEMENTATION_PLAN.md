# R5 实施方案：用 Linear 管理多个项目（草案，待你确认）

> 依据：你 2026-10-17 提出的工作流需求（见第 0 节），`PLAN.md`，以及 R1–R4 的现有实现。
> 阶段顺序调整：本阶段插在原 R5（眼睛和手）之前，原 R5–R7 顺延为 R6–R8。确认后同步更新 `PLAN.md` 第 14 节。
> 标 **【需验证】** 的内容，在实现第一步实测后再定。

## 0. 你现在的问题，以及本阶段怎么解决

你现在的做法：开好几个终端，每个终端跑一个 Claude Code，轮流回复它们改东西。项目有 betterUWWorks、Cents、DoFocus、Fridgy、vibeIsland、agentSwarm。

| 你的问题 | 本阶段的做法 |
|---|---|
| 1. 慢：同一时间只能改一个项目的一个 bug | 每件事是一张 Linear ticket。你把多张 ticket 交给 agentSwarm，它们**同时**进行，各有一组 Agent 和自己的工作站 |
| 2. 没有记录，改完不知道何时改的，无法回溯 | ticket 就是记录：对话、阶段进度、调研、方案和验收文档的链接、PR、完成时间、费用。提交和 PR 也带上 ticket 编号，从代码能查回 ticket |
| 3. 多个终端很乱 | 只有一个地方：Linear 的看板和收件箱。要看细节就打开面板 |
| 4. 离开这台 Mac mini 就没法让 Agent 干活 | 在手机或任何电脑上用 Linear 建 ticket、回答问题、批准方案；GitHub 上合并 PR |
| 5. 想试新东西，要自己搭环境、开新的 Claude Code | 有一个专门的"沙盒"项目：一张 ticket 就是一次实验，agentSwarm 自动准备一个干净的仓库和工作站，结果写回 ticket |
| 6. 一切都在一个终端里做，上下文混乱；方案、评审、调研都要你想起来才做 | 每张 ticket 按类型走固定流程（第 3 节），调研、方案、评审、测试都是流程里的固定环节，由不同的 Agent 在各自的上下文里完成 |

**像公司一样运转：**
- 你是老板：提需求、做决定（批准方案、合并 PR）；
- 每张 ticket 有一个负责人（lead），由它组建小组：researcher、architect、developer（原生 / Claude Code / Codex）、reviewer、QA；
- 多张 ticket 同时开工，进度都在 Linear 里。

本阶段要做的是**入口、排队、记录和多项目**。
- "员工"的长期记忆和经验库、营销角色放在 R7；
- 让 QA 在模拟器里点 App 放在 R6（你的 4 个 Apple 项目到那时验证会更完整）。

## 1. 验收（真实环境）

1. 你在 Linear 里安装 agentSwarm 应用（浏览器里点一次授权）。swarmd 能在 10 秒内收到 Linear 发来的事件并回应，签名校验通过。
2. 你的项目在面板里登记好，每个 Linear 项目对应一个仓库。至少登记两个真实项目，具体哪两个由你在第 9 节选（推荐 Fridgy 和 betterUWWorks）。
3. 你**同时**交出 3 张 ticket，三件事并行进行：
   - 项目 A 的一个小 bug（快速流程）；
   - 项目 B 的一个小功能（完整流程：调研 → 讨论 → 方案 → 你批准 → 开发 → 评审 → 验证 → PR）；
   - 沙盒里的一个实验。
4. **不在 Mac mini 前也能完成**：用手机上的 Linear 回答 lead 的问题、批准方案；用手机上的 GitHub 合并 PR。
5. 每张 ticket 最后都能看到：
   - 阶段清单（ticket 里的进度条）；
   - 调研、方案、验收文档的链接，以及 PR 链接；
   - 开始和结束时间、费用，以及复盘。

   合并后 ticket 自动变成 Done。提交和 PR 里带着 ticket 编号。
6. 在 Linear 里点"停止"，对应的任务在几秒内停下，并在 ticket 里说明停在了哪一步。
7. 一个"想法"类 ticket（还没有仓库）只做调研和讨论，结论写回 ticket。你说"立项"后，agentSwarm 新建私有仓库，登记项目，再进入方案阶段。新建仓库所需的 GitHub 权限见第 6 节【需验证】。

## 2. Linear 的组织方式

- **一个工作区，一个团队**（例如 `ZAC`）。每个产品是一个 Linear **项目**：Cents、DoFocus、Fridgy、vibeIsland、betterUWWorks、agentSwarm。另外有两个特殊项目：
  - **想法**：还没有仓库的点子；
  - **沙盒**：一次性的实验。
- 在面板里把每个 Linear 项目对应到一个 agentSwarm 项目（一个 GitHub 仓库），"沙盒"对应本机的临时仓库。对应关系在面板里设置，不靠名字去猜。
- **agentSwarm 是 Linear 里的一个 Agent 应用**，用 Linear 的 Agent 接口（目前还是开发者预览版）。
  - 你把 ticket **交给** agentSwarm（Linear 里的 Delegate），或在 ticket 里 @agentSwarm，就开工。
  - ticket 的负责人仍然是你，agentSwarm 只是被委派的执行者。
  - 不交出去的 ticket 就留在待办池里，想多少写多少。
- **ticket 的类型**用标签表示，决定走哪套流程（第 3 节）：`feature`、`bug`、`research`、`experiment`。没打标签时，由 lead 判断后在 ticket 里说明。
- **优先级**沿用 Linear 的设置。排队时先做 Urgent 和 High。

## 3. 流程：每类 ticket 固定走哪几步

| 类型 | 阶段 | 关口 |
|---|---|---|
| feature（新功能） | 收集 → 调研 → 讨论 → 方案 →【你批准】→ 开发 → 评审 → 验证 → PR →【你合并】→ 复盘 | 方案、合并 |
| bug | 收集 → 复现（写一个会失败的测试）→ 方案（简短）→【你批准，可设为免批准】→ 修复 → 评审 → 验证 → PR →【你合并】 | 合并（方案可选） |
| research（调研） | 收集 → 调研 → 讨论 → 结论写回 ticket | 无（不改代码） |
| experiment（沙盒实验） | 收集 → 动手做 → 结果和产物写回 ticket | 无（不开 PR；想保留时你说"立项"） |
| 想法 → 立项 | 走 research 流程；你说"立项"后，新建仓库，再走 feature 流程 | 立项、方案、合并 |

- "bug 免批准"可以按项目设置。推荐默认要批准，以后再放开。
- 评审和 QA 是流程里固定的 Agent，不靠谁"想起来"才做。R4 验收发现原生 reviewer 会漏掉问题，所以本阶段允许评审改用 Claude Code 或 Codex（第 9 节第 6 条）。

## 4. 在 Linear 里怎么对话

Linear 的 Agent 接口把一次委派当作一个**会话**：Agent 在 ticket 里发出"思考 / 动作 / 提问 / 回复 / 出错"几类消息，你的每次回复会推送给 Agent。各种操作对应如下：

| agentSwarm 里的动作 | Linear 里的样子 |
|---|---|
| 开工、进入新阶段 | 一条 thought（"进入调研：派了 2 个 researcher"） |
| 派生、评审、合并、开 PR | action（例如 "spawn_agent · csv-parser-dev"、"open_pull_request · #12"） |
| lead 问你问题 | elicitation。有备选答案时显示成按钮（`select` 信号），你也可以直接打字回答 |
| 方案关口 | elicitation，带"批准 / 要修改"两个按钮，附 plan.md 链接 |
| 阶段和工作包的进度 | 会话的 plan 清单：每个阶段、每个工作包一项，状态有待做 / 进行中 / 完成 / 取消 |
| 文档、PR、面板链接 | 会话的 externalUrls：research.md、plan.md、acceptance.md、PR、面板里的任务树 |
| 完成、复盘 | response |
| 你点"停止" | 收到 `stop` 信号，立刻取消整棵 Agent 树，然后回一条 response 说明停在哪里 |

**ticket 状态自动跟着变：** 开工时变为 In Progress，开出 PR 时变为 In Review，合并后变为 Done，PR 被关闭或你点停止时变为 Canceled。

**Discord 改为只发通知：** 有事需要你时（提问、待批准、PR 已开），发一条带 ticket 链接的提醒。对话不再在 Discord thread 里进行，以免两边各说一半。原有的 Discord 发起方式（`/idea`）仍然保留，可以选择关掉（第 9 节第 2 条）。

## 5. 怎么收到 Linear 的事件：远程访问

- Linear 用 webhook 推送事件，要求 **5 秒内回应、10 秒内发出第一条消息**，所以 swarmd 必须有一个公网能访问的 HTTPS 地址。
- **做法：** 用你已经装好的 Tailscale 的 **Funnel**，只公开一个路径。
  - swarmd 另开一个只监听本机的端口（例如 `127.0.0.1:4319`），上面**只有** `POST /linear/webhook` 这一个接口。
  - Funnel 只把这个端口暴露出去。面板和其他接口仍然只在本机 `4318`，公网访问不到。
  - 每个请求都校验 Linear 的签名（webhook 密钥）和时间戳，签名不对的直接丢弃。
  - 收到事件后先存进数据库再回 200，然后在后台处理，不会超过 5 秒。
- **备选：** Cloudflare Tunnel（`cloudflared` 也已安装，但需要一个托管在 Cloudflare 的域名）。
- **面板的远程访问（可选）：** 通过 Tailscale 只在你自己的 tailnet 内访问，不用 Funnel 对公网开放。这样你在外面用手机也能看任务树。

## 6. 项目接入

**登记：**
- 面板里一次性登记你的 6 个仓库，每个仓库对应一个 Linear 项目。
- Agent 永远基于 GitHub 上的 `main` 工作，**不碰你本机的 `/Volumes/Data/Code/…` 目录**。你在本机未提交的改动，Agent 看不到；它的改动以 PR 的形式回来，合并后你在本机 `git pull` 拉下来。

**项目档案**（每个项目一份，可选，lead 和子 Agent 都会看到）：
- 平台（iOS / macOS / Web / Node）；
- 安装依赖、构建、测试用的命令；
- 哪些测试本来就是坏的；
- 不能碰的东西，例如"betterUWWorks 是线上服务，不部署，只开 PR"。

**本地配置文件：** Cents 的 `Local.xcconfig`、DoFocus 的 `Secrets.plist`、Fridgy 的 `Config.local.xcconfig` 和 `Secret.plist`、betterUWWorks 的 `.env`，这些不在 Git 里，没有它们就构建不起来。
- 你在面板里按项目上传这些文件，加密保存。clone 时写进 worktree，并加进该 worktree 的 git 排除列表，不会被提交。
- Relay 另外检查：任何推送包含这些路径都会被拒绝。
- **风险：** Agent（包括可以联网的 CLI）能读到这些文件里的密钥。**请尽量给开发或测试用的密钥，不要给正式环境的。** 不上传也行，Agent 会在报告里说明"缺配置，没法构建"。

**本机的其他服务：**
- betterUWWorks 线上服务就跑在这台 Mac mini 上，现在的沙箱只挡住了 swarmd 的端口。
- 本阶段增加一份"禁止访问的本机端口"名单，例如线上服务和数据库的端口，在面板里设置，写进沙箱配置。

**Apple 平台的项目：**
- 本阶段 Agent 能用 `xcodebuild` 构建和跑单元测试；R0 已经验证工作站用户可以使用模拟器。
- 在模拟器里点界面、截图验收在 R6。
- 签名、上架这类需要你证书的操作不交给 Agent。

**立项时新建仓库：**
- 需要能建私有仓库的 GitHub 权限。
- 现在用的细粒度令牌能不能建仓库，资料说法不一，【需验证】。实现第一步会实际调用接口，看 GitHub 返回的所需权限。
- 不行的话有两个办法：你新建一个只用于建仓库的令牌；或者立项时由你手动建一个空仓库，agentSwarm 接着往下做。

## 7. 沙盒实验

- 一张沙盒 ticket 对应 agentSwarm 在本机新建的一个**只在本机的仓库**（不推到 GitHub）。
  - Agent 在工作站里正常干活，Relay 只把提交收进本机仓库，不推送。
  - 结果写回 ticket：说明、关键输出、截图，以及面板里查看文件的链接。
- 你在 ticket 里说"立项"时，新建 GitHub 仓库，把实验的历史推上去，登记项目，后面走 feature 流程。
- ticket 结束（Done 或 Canceled）7 天后自动清理；时间可以设置。
- 实验也要遵守费用上限，默认每张 ticket $1，可以在 ticket 里调整。

## 8. 记录与回溯

- **ticket**：完整的对话、阶段清单、文档和 PR 链接、开始和结束时间、费用（原生的实际花费，以及 CLI 按 API 价格折算的数字）、复盘。
- **仓库**：
  - 调研、决策、方案、验收文档照旧提交在 `docs/agentswarm/<任务>/`；
  - 分支名带 ticket 编号，例如 `swarm/fridgy/ZAC-42-…`；
  - 提交信息和 PR 标题以编号开头，PR 正文写 `Fixes ZAC-42`。如果你装了 Linear 的 GitHub 集成，PR 会自动挂到 ticket 上。
- **面板**：保留每个运行的完整过程，在 ticket 里有链接。
- 项目级的"本周做了什么"汇总（Linear 的项目更新）放到以后再做。

## 9. 需要你决定的

1. **对话放在哪里。** ticket 的会话里（推荐，见第 4 节）；或者仍然放在 Discord thread，ticket 只用来开工和记录。
2. **Discord 的角色。** 只发提醒（推荐），保留 `/idea` 作为备用入口；或者完全停用。
3. **公网入口。** Tailscale Funnel，只公开 webhook 这一个路径（推荐）；或者 Cloudflare Tunnel。
4. **验收用哪两个真实项目。** 推荐 Fridgy（iOS，最近在活跃开发）和 betterUWWorks（Web，验证"不碰线上服务"）。验收会在这两个仓库开出真实的 PR，由你合并或关闭。
5. **本地配置文件。** 上传开发用的密钥（推荐，前提是你能提供开发用的值）；或者不上传，Agent 只做不需要它们的事。
6. **评审的运行时。** 每个项目可以设置 reviewer 用 native、Claude Code 或 Codex。推荐 Apple 项目用 Claude Code 评审：R4 里它最严格。
7. **同时进行的 ticket 数。** 推荐 3 张，超出的按优先级排队。受工作站数量（8 个）和 CLI 并发上限限制。
8. **bug 是否免批准方案。** 推荐默认需要批准，用一段时间后再按项目放开。

## 10. 实现顺序和测试

1. **实测：**
   - 建一个 Linear 应用，用 `actor=app` 安装；
   - 用 Funnel 收 webhook，测出签名、10 秒期限、`select` 和 `stop` 信号的实际效果；
   - 测出 GitHub 建仓库需要的权限。
2. **Linear 客户端（GraphQL）和 webhook 接收：**
   - 单独的监听端口，签名校验，先存库再回应；
   - 事件可重复投递（同一个事件处理两次不出错）。
3. **ticket 和任务的对应：**
   - 事件进来，变成任务，带上类型和优先级；
   - 任务的状态和消息变成 Linear 的消息、清单和链接；
   - 你的回复、关口操作、停止，变成对任务的操作；
   - 同步 ticket 状态；
   - 排队。
4. 项目档案、本地配置文件、本机端口禁止名单、分支和提交带 ticket 编号。
5. 沙盒项目（只在本机的仓库）和立项流程。
6. 评审可以用 CLI 运行时，结论按固定格式交回（同意与否、意见）。
7. **面板：**
   - 设置页：Linear 连接状态、项目对应关系、项目档案、配置文件上传、端口名单；
   - 任务页：链接到 ticket。
8. **测试：**
   - 假的 Linear：本地 GraphQL 加 webhook 签名器，用法和现在的假 Discord 一样；
   - 单元测试：签名、重复事件、消息格式；
   - 集成测试：从 ticket 到 PR 到 Done；回答问题、批准、停止；沙盒；立项；
   - E2E：设置页；
   - 真实验收：第 1 节；
   - code-reviewer 和 security-reviewer 审查，因为新增了公网入口和存放密钥的功能。

不在本阶段：
- Linear 子 ticket（工作包只在会话清单里显示）；
- 双向同步你对 ticket 的编辑（只在开工和你回复时读取 ticket 内容）；
- 项目周报；
- 部署。
