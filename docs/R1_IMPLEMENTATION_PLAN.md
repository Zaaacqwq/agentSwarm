# R1 实施方案：骨架（已确认，2026-10-16）

> 依据：`PLAN.md` 第 14 节 R1，以及 `docs/R0_FINDINGS.md`。
> 第 10 节的决定已全部按建议确认。

## 0. 目标与验收

**目标**：搭起之后所有阶段都要用的底座。具体是：守护进程、数据库、登录、面板外壳、模型端点、原生 Agent 循环、8 个工作站用户组成的池子、在工作站里执行操作的小程序和沙箱，以及 Relay。

**验收**（真实环境，模型用 qwen3.8-omni-flash）：
1. 你在面板上登录，配置 OpenRouter 端点，添加一个 GitHub 测试仓库。
2. 给一个 Agent 下达任务："修一个 bug 并补测试"。Agent 被分配到 `ws-1`，在自己的 worktree 里读写代码、跑测试、提交，经 Relay 把 `swarm/<项目>/<任务>` 分支推到 GitHub。
3. 面板上能实时看到它的每一步：工具调用、输出、费用。
4. 隔离检查全部通过：
   - Agent 读不到你的家目录、其他工作站、swarmd 的数据目录；
   - 推送 `main` 被拒绝；
   - 含密钥的提交被拒绝。
5. `main` 上已开启 GitHub 分支保护；agentSwarm 使用的令牌无法绕过它。

**不在 R1 做**：子 Agent、流水线、Discord、CLI worker、浏览器、模拟器、桌面。这些都留在后续阶段，但 R1 的数据模型和接口要给它们留好位置。

---

## 1. 目录结构

npm workspaces（Node 24 自带，不引入新工具）。守护进程利用 Node 24 直接运行 TypeScript 的能力，不需要编译步骤（R0 已验证）。类型检查用 `tsc --noEmit`。

```
package.json                     workspaces、脚本（dev / test / typecheck / e2e）
tsconfig.base.json               strict、erasableSyntaxOnly（Node 只能去掉类型标注，不支持 enum 等）
packages/
  contracts/                     TypeBox 写的 API 和事件结构，前后端共用
  ws-exec/                       在工作站用户身份下执行操作的小程序（移植自 priv-helper）
    src/main.ts                  入口：从系统用户库取身份，读一条 JSON 请求，返回一条 JSON 结果
    src/ops/{fs,exec,git}.ts     文件读写编辑搜索、跑命令、git（clone / status / commit / 推到 inbox）
    src/sandbox.ts               seatbelt 配置
    src/paths.ts                 路径解析，防止越出工作目录（含符号链接）
apps/
  swarmd/
    src/main.ts                  启动：环境检查 → 数据库 → 服务 → HTTP
    src/config.ts
    src/db/{client.ts,schema.ts} drizzle + better-sqlite3；migrations/ 下是迁移文件
    src/auth/                    首次设置、登录、会话、限流
    src/crypto/secret-box.ts     master.key + AES-GCM，加密存储密钥
    src/endpoints/               模型端点（OpenRouter；OpenAI 兼容的留好接口）
    src/models/                  Pi 的模型集合、动态列表刷新、费用计算
    src/agents/
      runtime.ts                 Pi Agent 循环：会话持久化、恢复、取消、超时
      tools/                     工作站工具（第 4 节）
      agent-service.ts           创建 Agent、下达任务、状态机
    src/workstations/
      pool.ts                    用户池：租用、归还、健康检查
      exec-client.ts             调用 sudo -n -H -u ws-N ws-exec
    src/projects/                项目 = GitHub 仓库 + 本地镜像
    src/relay/                   推送校验、密钥扫描、推到 GitHub（移植自 git-relay）
    src/events/                  事件总线 → 数据库和 WebSocket
    src/http/                    Fastify 路由、WebSocket
  web/                           React + Vite 面板
scripts/
  setup.sh                       一次性安装脚本，需要 sudo，由你运行（第 6 节）
  check.ts                       不需要 sudo 的隔离和环境检查
docs/
  R1_IMPLEMENTATION_PLAN.md / R1_ACCEPTANCE.md
```

---

## 2. 数据库（SQLite，WAL 模式）

R1 建的表（为后续阶段预留的字段写在括号里）：

| 表 | 用途 |
|---|---|
| `users`、`login_sessions` | 面板账号（R1 只有一个管理员）、会话（只存令牌的哈希） |
| `audit_log` | 登录、配置变更、推送等审计记录 |
| `endpoints` | 模型端点：类型、地址、加密后的 API key |
| `github_credentials` | agentSwarm 使用的 GitHub 令牌（加密），记录它能访问哪些仓库 |
| `projects` | 项目：GitHub 仓库、默认分支、本地镜像路径（R3 加流水线阶段，R3 加 Discord 频道） |
| `workstations` | `ws-1`…`ws-8`：状态、健康检查结果、当前租用者 |
| `agents` | 角色、模型、运行时（R1 只有 `native`）、所属项目（`parent_id`、`depth`、`budget_usd` 为 R2 预留） |
| `runs` | 每次执行：状态、开始和结束时间、token、费用、结果 |
| `run_events` | 只追加的事件流：消息、工具调用开始和结束、输出摘要、错误；面板和回放都从这里读 |
| `agent_sessions` | Pi 会话的消息记录（JSON），用于恢复和继续对话 |
| `worktrees` | 工作站、分支、路径、所属 Agent |
| `git_pushes` | 每次推送：分支、提交、检查结果、被拒原因 |

- 迁移用 drizzle-kit 生成 SQL，启动时自动执行；执行迁移前先备份数据库。
- 有界面需要分页的地方都加 LIMIT；`run_events` 按 run 和时间建索引。

---

## 3. 工作站与沙箱

**存储**（R0 发现启动盘只剩 6.4 GB）：重新在外置盘的 APFS 容器里建 **SwarmWS 卷**，并开启所有权（沿用决定 0004）。

```
/Volumes/SwarmWS/                 root 0755，Owners: Enabled
  swarmd/                         zaaac 0700：数据库、master.key、日志
  mirrors/<项目>.git              zaaac 0750，组 swarm-ws 可读：GitHub 仓库的本地镜像
  inbox/<ws-N>.git               ws-N 0700：工作站推送的落点
  ws/<ws-N>/                     ws-N 0700：这个工作站的全部数据
    worktrees/<项目>/<分支>/
    cache/                       npm 缓存、DerivedData（R5）、模拟器设备（R5，用 simctl --set 指到这里）
```

- `ws-N` 的家目录仍在 `/Users`，但只放很小的配置文件。大文件一律通过环境变量指到 `ws/<ws-N>/cache`，例如 `npm_config_cache`、`XDG_CACHE_HOME`。
- **用户**：`ws-1`…`ws-8`，隐藏用户，主组是专属的 `swarm-ws`（不进 `staff`），登录 shell 是 `/usr/bin/false`。
- **ws-exec**：
  - 由 root 安装到 `/usr/local/libexec/agentswarm/`，内容是一个 Node 运行时、打包成单个文件的程序，以及一个启动脚本。
  - Node 运行时用 nodejs.org 官方发布的 24.x 包（下载后校验 SHA256 和签名），**不用 Homebrew 的**：R0 发现 Homebrew 的 node 依赖共享库，而且有的目录其他用户读不到。
  - 启动脚本用 `env -i` 清空环境变量，防止 `NODE_OPTIONS` 之类被注入。
  - sudoers 只允许你的账号以 `ws-N` 的身份运行这一个启动脚本。
  - 身份一律从系统用户库取（P5 的教训：Bun 和 sudo 会把 `$HOME` 带错）。
- **seatbelt 配置**（移植自旧版，按新目录调整）：
  - 拒绝：整个 `/Volumes`、所有用户的家目录、swarmd 数据目录、其他工作站；
  - 放行：自己的 `ws/<ws-N>`、自己的 inbox、只读的 mirrors、自己的家目录；
  - 网络放行（沿用决定 0004）。
- **租用**：一个 Agent 执行期间独占一个 `ws-N`，结束后归还；空闲的 `ws-N` 用完时，新任务排队等待。
- **并发槽**：普通 6、重任务 2（R1 先实现普通槽，重任务槽和桌面槽留接口）。

---

## 4. Agent 运行时

- 用 Pi（`@earendil-works/pi-ai` 和 `pi-agent-core` 1.3.0）在 swarmd 进程里运行。OpenRouter 模型从动态列表获取。
- **R1 的工具**都通过 ws-exec 在租用的 `ws-N` 沙箱里执行：

| 工具 | 说明 |
|---|---|
| `ws_list` / `ws_read` / `ws_grep` | 列目录、读文件（带行号和分页）、搜索 |
| `ws_write` / `ws_edit` | 写文件、精确替换 |
| `ws_bash` | 跑命令，带超时和输出长度上限；环境里没有 agentSwarm 的任何密钥 |
| `git_status` / `git_commit` | 查看状态、提交 |
| `git_push` | 推到 inbox，再由 Relay 校验后推到 GitHub |
| `report` | 交回结构化结果（做了什么、分支、测试结果、未完成事项），作为本次执行的结束 |

- 每个工具调用都写入 `run_events`，并实时推送到面板。
- 保护机制：
  - 每次执行有最大轮数、总时长和费用上限；
  - 模型请求设超时并重试（R0 实测出现过几分钟的延迟尖峰）；
  - 取消执行会立即停止循环，并终止 ws-exec 里正在运行的命令。
- 模型请求失败、工作站执行失败、Relay 拒绝推送，这些都作为工具结果如实返回给模型，同时完整记录在事件里。

---

## 5. Relay

沿用旧版流程，移植并简化：

```
worktree ──git push──► inbox/<ws-N>.git ──swarmd fetch──► mirrors/<项目>.git ──校验──► GitHub
```

- **校验**：
  - 分支必须是 `swarm/<项目>/…`，并且属于发起推送的 Agent；
  - 拒绝 `main` 和其他受保护的分支，拒绝强推；
  - 提交数、文件数、改动行数有上限；
  - 新增内容做密钥扫描（移植 `secret-scan.ts`）。
- **推到 GitHub**：只有 swarmd 持有令牌，通过 `GIT_ASKPASS` 临时提供，令牌不进入命令行参数，也不进入工作站。
- **`main` 分支保护**：安装时用 GitHub API 开启（必须经过 PR、需要批准、禁止强推）；swarmd 启动时检查保护是否仍然生效，失效则在面板上报警。

---

## 6. 安装脚本 `scripts/setup.sh`（需要 sudo，由你运行）

1. 检查：
   - macOS 版本；
   - 外置盘是否已挂载；
   - 启动盘剩余空间（低于 10 GB 时警告）；
   - 家目录权限（`755` 时警告，并提示 `chmod 750`）；
   - 是否有对外可读的私钥文件（只警告，不修改）。
2. 建 SwarmWS 卷（已存在就跳过），开启所有权并重新挂载，然后验证所有权确实生效、挂载参数里没有 `noowners`。
3. 建用户组 `swarm-ws` 和用户 `ws-1`…`ws-8`，以及各自的目录。
4. 安装 Node 运行时（官方包，校验签名）、ws-exec 和启动脚本；写入 sudoers 并用 `visudo -c` 校验。
5. 自检：以每个 `ws-N` 的身份运行一次 ws-exec，检查隔离是否生效。
6. `--uninstall`：删除以上全部内容。`--update-exec`：只更新 ws-exec。

**Homebrew 目录权限**：`ws-N` 用不了顶层目录是 `700` 的那 35 个 Homebrew 包。安装脚本只报告受影响的工具，并给出修复命令，不自动修改。

---

## 7. 面板（React + Vite）

R1 只做基础页面，视觉方向确定后再细化（R3 会做 Agent 树和流水线视图）：
- 首次设置和登录；
- 端点：OpenRouter key（只写入，不回显）、测试连接、模型列表；
- 项目：添加 GitHub 仓库、镜像状态、`main` 保护状态；
- 工作站：8 个 `ws-N` 的状态、当前租用者、健康检查；
- Agent：新建、下达任务、实时活动流（工具调用、输出、费用）、执行历史；
- 一页"系统检查"，展示 `scripts/check.ts` 的结果。

---

## 8. 从旧代码移植（来自已关闭的 PR #2–#5，逐个审阅后移植）

| 旧文件 | 用途 | 处理 |
|---|---|---|
| `packages/priv-helper/src/sandbox.ts` | seatbelt 配置 | 按新目录调整 |
| `packages/priv-helper/src/paths.ts` | 路径解析，防越界和符号链接逃逸 | 基本照搬 |
| `packages/priv-helper/src/passwd.ts` | 从系统用户库取身份 | 照搬 |
| `packages/priv-helper/src/ops/{fs,exec,git}.ts` | 工作站里的文件、命令和 git 操作 | Bun 的 API 改成 Node 的 |
| `apps/swarmd/src/git-relay/{relay,secret-scan}.ts` | Relay 和密钥扫描 | 去掉任务相关的逻辑，改用新的分支命名 |
| `apps/swarmd/src/auth/*`、`crypto/*` | 登录、会话、加密 | 把 `Bun.password` 换成 Node 的 `crypto.scrypt` 或 argon2 |
| `scripts/setup-workstations.sh`、`check-workstations.ts` | 安装和检查 | 按第 3 节和第 6 节重写，参考旧版的检查项 |

不移植：聊天、任务看板、审批、浏览器、桌面（后续阶段按新设计重做）。

---

## 9. 测试计划

- **单元测试**（Node 自带的 `node:test`）：
  - 路径越界和符号链接逃逸；
  - seatbelt 配置生成；
  - 分支命名和归属；
  - 密钥扫描；
  - 加密往返；
  - 会话过期；
  - 费用计算；
  - 工具参数校验。
- **集成测试**：swarmd 的 API，搭配一个假的模型服务器（按脚本回放工具调用）和一个本地后端（不用 sudo，在临时目录里模拟工作站），覆盖：
  - 登录；
  - 端点；
  - 项目；
  - 下达任务 → 工具调用 → 提交 → Relay 推到本地的"假 GitHub"裸仓库；
  - 取消执行；
  - 超时。
- **E2E**（Playwright）：首次设置 → 配置端点 → 添加项目 → 新建 Agent → 下达任务 → 活动流显示工具调用。用假的模型服务器。
- **真机检查**：`scripts/check.ts` 用真实的 sudo 和 ws-exec 逐项检查隔离：
  - 读你的家目录、读其他工作站、读 swarmd 数据、读 `/Volumes/Data`，都应失败；
  - 在自己的 worktree 里写文件、提交，都应成功；
  - 推 `main`，应被拒绝。
- **真实模型验收**：第 0 节的场景，用 qwen3.8-omni-flash 跑一遍，结果写入 `docs/R1_ACCEPTANCE.md`。
- **代码审查**：用 code-reviewer agent 审查；HIGH 及以上的问题必须修复。

---

## 10. 已确认的决定（全部按建议）

1. **工程工具**：npm workspaces，加 Node 24 直接运行 TypeScript（守护进程不编译）。备选是 pnpm 加编译。
2. **数据库**：better-sqlite3 加 drizzle（R0 验证过 Node 24 有预编译包）。Node 自带的 `node:sqlite` 也能用，但 drizzle 不支持它。
3. **HTTP 框架**：Fastify 5，实时事件走 WebSocket。
4. **重建 SwarmWS 卷**：在外置盘上新建卷并开启所有权，需要你运行安装脚本。
5. **工作站用的 Node**：用 nodejs.org 的官方包装进 `/usr/local/libexec/agentswarm`，不依赖 Homebrew。
6. **GitHub 令牌**：R1 用细粒度 PAT，只授权测试仓库的 Contents、Pull requests、Administration（开启分支保护需要）三项读写权限，由你在 GitHub 上创建。以后需要时再换成 GitHub App。
7. **测试仓库**：新建一个私有仓库 `Zaaacqwq/agentswarm-playground`，里面放几个带 bug 的小模块用于验收。由我创建，需要你同意。
8. **密码哈希**：用 Node 自带的 `crypto.scrypt`，不引入原生依赖。备选是 argon2，需要额外的原生包。

## 11. 风险

| 风险 | 应对 |
|---|---|
| 启动盘只剩 6.4 GB | 所有大文件放在 SwarmWS；安装脚本低于 10 GB 时警告；建议你清理启动盘 |
| Node 直接运行 TypeScript 不支持 enum、namespace 等语法 | 打开 `erasableSyntaxOnly`，由类型检查拦住 |
| Homebrew 包权限导致 `ws-N` 用不了部分工具 | 安装脚本报告受影响的工具；`ws-N` 依赖的核心工具（node、git）都用系统自带或 agentSwarm 自己安装的版本 |
| `sandbox-exec` 已被 Apple 标为弃用 | 它是第二道防线，第一道是独立用户加 SwarmWS 卷的所有权；每次系统升级后都跑一遍 `check.ts` |
| 细粒度 PAT 会过期 | swarmd 启动时检查令牌的有效期，快过期时在面板上提醒 |
