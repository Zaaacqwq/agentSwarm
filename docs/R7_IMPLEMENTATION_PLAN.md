# R7 实施方案：内置看板，替换 Linear（2026-10-18 已确认）

> 依据：`PLAN.md` 第 14 节，R5 的 Linear 集成（`docs/R5_IMPLEMENTATION_PLAN.md`），agent-swarm-ng 的 tickets（`docs/tickets.md`，2026-10-17 加入），以及现在面板上的 Missions 页。
> 你同意了第 9 节的全部推荐（"按推荐"）。

## 0. 为什么做，做完是什么样

R5 让你在 Linear 里发任务。用下来，问题有三个：
- 任务在 Linear，过程在面板，要两边对照；
- Linear 的 Agent API 还是开发者预览版；令牌每 24 小时刷新一次，还得为它开一个对公网的入口（Tailscale Funnel）；
- 面板经 tailnet 已经能在手机上用，Linear 只剩"发任务、收提醒"两件事。

本阶段做完后：
- **面板里有一个看板**：Backlog、待办、进行中、等你处理、完成。在手机上也好用，可以像 App 一样装到主屏幕。
- **发任务就是新建一张 ticket**：写一句话，选项目和类型，可以附上手机截图（比如 bug 的样子）。放进"待办"就会按优先级排队开工。
- **一张 ticket 就是一个完整的记录**：
  - 你的原话和附图；
  - 和 lead 的对话、批准方案；
  - 阶段进度、实时动态、截图；
  - 文档、PR，以及把 PR 拉到本机的命令；
  - 用时、费用、复盘。
- **需要你的时候 Discord 会提醒**，消息里带 ticket 的链接，点开就是面板（tailnet 地址）。
- **Linear 集成删掉**，Funnel 的公网入口关掉。agentSwarm 不再有对公网开放的端口。

## 1. 验收（真实环境）

1. 你用手机打开面板（tailnet 地址，装到主屏幕），新建 3 张 ticket：
   - Fridgy 的一个改动，附一张截图；
   - betterUWWorks 的一个 bug；
   - 一个沙盒实验。

   它们先放在 Backlog。
2. 你把它们拖进（手机上点选）"待办"。三件事按优先级开工，超过同时进行上限的排队等待，卡片上显示排在第几。
3. 你在手机上：
   - 回答 lead 的问题、批准方案；
   - 在 ticket 页看实时动态和 QA 截图；
   - 在 GitHub 上合并 PR。

   PR 合并后，ticket 自动进入"完成"。
4. 每次需要你处理（提问、批准方案、PR 已开好）以及任务完成、失败时，Discord 都会提醒，带 ticket 链接。
5. 沙盒实验结束后，你在 ticket 上点"立项"：agentSwarm 新建私有仓库、登记项目，再开一张功能 ticket 接着做。
6. Linear 的代码和设置已删除，Funnel 已关闭，`:8443` 从外网访问不到。R5 时 Linear 里未完成的 ticket 已导入看板。

## 2. Ticket 和 mission 的关系

- **ticket 是你写的任务**，mission 是 agentSwarm 怎么做它。一张 ticket 开工时生成一个 mission，二者一一对应。之后追加的要求，在同一张 ticket 里继续对话。
- **编号**按项目加前缀，例如 `FRI-12`、`BUW-3`。前缀在项目设置里改，默认取项目名。沙盒实验用 `SBX`，想法用 `IDEA`。
- **状态**分两类：
  - 你管的：Backlog（还没打算做）、待办（排队开工）、取消；
  - 跟着 mission 走的：

| 状态 | 什么时候 |
|---|---|
| Backlog | 新建时默认；Agent 记下的后续事项也在这里 |
| 待办 | 你放进来的；按优先级、再按先后排队，有空位就开工 |
| 进行中 | mission 在跑 |
| 等你处理 | lead 在问你、方案等你批准、PR 等你合并 |
| 完成 | mission 结束（PR 合并、调研结论、实验结果） |
| 取消 | 你取消的，或在 mission 进行中停止的 |

- **类型**：功能、bug（快速流程）、调研、实验，沿用 R5 的流程。
- **项目**：实验 ticket 用"沙盒"，开工时新建一个只在本机的仓库；想法 ticket 用"想法"，只做调研，不需要仓库。都和 R5 一样。
- **同时进行上限**、优先级排队、停止、立项：从 R5 的 Linear 代码里搬过来，不再依赖 Linear。

## 3. 面板

### 3.1 看板页（新的首页入口"Tickets"）
- **看板视图**：五列，取消的默认不显示。卡片上显示：
  - 编号、标题、项目、类型、优先级；
  - 阶段进度；
  - "工作中"标记，以及有几个 Agent 在干活；
  - 等你处理的事（问题、批准、合并）；
  - 费用。
- **列表视图**：按状态分组；手机上默认是这个。
- **改状态**：电脑上可以拖动；手机上点卡片的菜单改，或长按拖动。拖动用 dnd-kit（版本固定），它支持触屏和键盘。
- **搜索和筛选**：按项目、类型、优先级、状态；条件保存在网址里，刷新或分享链接后不丢。
- **新建 ticket**：标题和描述（Markdown）、项目、类型、优先级，可选附图。手机上可以直接拍照或选相册里的图片。

### 3.2 Ticket 页
- 用现在的 Mission 页扩展：
  - 上方是你的原话和附图；
  - 中间是对话、批准、PR 就绪的提示，PR 就绪时附上 `cd <仓库> && gh pr checkout <编号>`（PLAN.md 第 17 节记下的事项）；
  - 再往下是实时动态和截图墙；
  - 侧栏是状态、优先级、项目、编号、费用、链接。
- 在 Backlog 和待办状态时，可以编辑标题、描述、附图；开工后这些就固定了，只能通过对话补充。
- 实验和想法类 ticket 完成后显示"立项"按钮。

### 3.3 手机
- **装到主屏幕**：加上 Web App Manifest 和图标，从 iPhone 主屏幕打开是全屏的。
- **按手机宽度检查**：看板、ticket 页、对话输入框、批准按钮都在 375 宽度下检查，不出现横向滚动；按钮够大，好点。

## 4. 提醒

- **Discord**：沿用现在的机器人和频道。每张 ticket 的提醒都带编号、标题和面板链接（`SWARM_DASHBOARD_URL`，即 tailnet 地址）：
  - lead 提问；
  - 方案等批准；
  - PR 已开好；
  - 完成；
  - 失败。
- **网页推送**（可选，见第 9 节第 2 条）：iPhone 上装到主屏幕的网页 App 可以收系统推送，需要 HTTPS（tailnet 地址有）和 Service Worker。

## 5. 附图

- **限制**：每张 ticket 最多 6 张，每张不超过 10 MB；接受 JPEG、PNG、HEIC。HEIC 由 swarmd 用 sips 转成 JPEG，最长边缩到 1600。存在 swarmd 的数据目录里，面板要登录才能看。
- **开工时交给 lead**：图片作为 lead 第一条消息里的图片（R6 已经能处理图片），同时提交到 `docs/agentswarm/<任务>/request/` 下。这样 dev 和 QA 也看得到，PR 里也保留着。
- 截图里可能有个人信息。提交进仓库这一步可以在 ticket 上关掉。

## 6. Agent 和 ticket

- **记下后续事项**：lead 有一个工具 `file_ticket`，把工作中发现的、不在本次范围内的事记成 Backlog ticket，标明"由某个 Agent 记录"、来自哪张 ticket。它不能开工，也不能改其他 ticket。是否放进待办由你决定（第 9 节第 3 条）。
- **ticket 内容是你的原话**，在提示词里照常当作要求；Agent 记下的 ticket，如果之后被你放进待办，它的内容也算作你认可的要求。

## 7. 删除 Linear

- **代码**：`apps/swarmd/src/linear/` 和 webhook 监听（4319 端口），设置页里的 Linear 一节，测试里的假 Linear。
- **数据库**：迁移里删除 `linear_events`、`linear_sessions` 和 `projects.linear_project_id`。以前从 Linear 来的 mission 保留，来源仍显示为 Linear。
- **导入**（第 9 节第 4 条）：删除之前，把 Linear 里各项目未完成的 issue 一次性导入成 Backlog ticket，带上原编号和链接。正在进行的 ZAA-6 先停掉，再作为 Backlog 导入。
- **Funnel 和 Linear 应用**：
  - 我关掉 Funnel：`tailscale funnel --https=8443 off`；
  - 你在 Linear 的设置里卸载 agentSwarm 应用；
  - 我删掉存着的 Linear 令牌和密钥。
- **防火墙**：4319 端口不再存在，从固定禁止的端口里去掉。

## 8. 实现顺序和测试

1. **数据**：
   - 表 `tickets`：编号、项目、标题、描述、类型、优先级、状态、排序位置、mission、来源（你或某个 Agent）、时间戳；
   - 表 `ticket_events`：状态变化和编辑记录；
   - 表 `ticket_attachments`；
   - 项目加 `ticket_prefix`。
2. **TicketService**：新建、编辑、改状态、排序、取消；排队和开工（同时进行上限，从 Linear bridge 搬过来）；状态跟着 mission 变化；立项（从 Linear bridge 搬到 mission 这一层）。
3. **附图**：上传、转换、交给 lead、提交进仓库。
4. **HTTP 接口和实时消息**：ticket 的增删改查、附图、改状态和排序；`tickets_updated` 推送。
5. **面板**：看板和列表、新建、ticket 页、手机界面、Manifest。
6. **提醒**：Discord 消息带 ticket 链接；可选的网页推送。
7. **`file_ticket` 工具。**
8. **导入 Linear**，然后删除 Linear，关闭 Funnel。
9. **测试**：
   - 单元测试：状态的规则（哪些由你改，哪些跟着 mission）、排队顺序、编号、附图校验；
   - 集成测试：
     - 从 ticket 到 mission，到 PR 合并，再到完成；
     - 等你处理、取消、停止；
     - 立项；
     - 附图交给 lead；
     - Agent 记下的 ticket 不会自己开工；
   - E2E：
     - 新建 ticket（带附图）、拖进待办、回答和批准、完成；
     - 375 和 1440 宽度截图，浅色和深色；
   - 真实验收：第 1 节；
   - code-reviewer 和 security-reviewer 审查（新增了文件上传）。

不在本阶段：
- 子任务、ticket 之间的关联、截止日期（agent-swarm-ng 有，你需要时再加）；
- 多用户；
- Xcode Cloud（PLAN.md 第 17 节）。

## 9. 需要你决定的

1. **一张 ticket 对应一个 mission，追加要求在同一张 ticket 里对话。**（推荐）另一种是每次追加都开新 mission，记录会分散。
2. **手机提醒先用 Discord，网页推送以后再说。**（推荐）Discord 现在就能用。网页推送要你把面板装到主屏幕并允许通知，工作量不小，可以放到本阶段之后。
3. **lead 可以把发现的后续事项记进 Backlog（`file_ticket`），但只有你能把它放进待办。**（推荐）
4. **删除前，把 Linear 里未完成的 issue 一次性导入看板。**（推荐）不导入的话，Linear 里的东西就留在 Linear。
5. **附图默认提交进项目仓库**（`docs/agentswarm/<任务>/request/`），可以在 ticket 上关掉。（推荐）好处是 dev 和 QA 都看得到，PR 里也保留着；坏处是截图里如果有个人信息，会进入 Git 历史。
