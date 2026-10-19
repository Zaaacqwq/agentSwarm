# R1 验收记录（2026-10-16）

R1 阶段把项目名从 Hive 改成了 **agentSwarm**：守护进程叫 swarmd，卷叫 SwarmWS，用户组叫 `swarm-ws`，Agent 的分支叫 `swarm/<项目>/…`。已安装的系统用 `scripts/migrate-from-hive.sh` 迁移到了新名字。

| 验收项（R1 方案第 0 节） | 结果 | 依据 |
|---|---|---|
| 在面板上登录、配置 OpenRouter、添加 GitHub 测试仓库 | 通过 | 真机：首次设置、端点、令牌和项目 `Zaaacqwq/agentswarm-playground` 都配好了，镜像已克隆。E2E 在面板上把同样的流程点了一遍 |
| Agent 在 `ws-1` 的沙箱里修 bug、跑测试、提交，经 Relay 推送分支 | 通过 | 见下面的真实模型验收 |
| 面板上实时看到每一步 | 通过 | 运行详情页通过 WebSocket 实时更新时间线（工具调用、输出、Relay、费用），E2E 覆盖 |
| 隔离：读不到你的家目录、其他工作站、swarmd 数据；推 `main` 被拒；含密钥的提交被拒 | 通过 | `npm run check` 23/23 通过（真实的 sudo 加 ws-launch）。集成测试覆盖：推 `main` 被拒、含密钥的提交被拒、越界访问被拒 |
| `main` 有 GitHub 分支保护，agentSwarm 的令牌绕不过去 | 通过 | 保护规则：必须经过 PR、对管理员同样生效、禁止强推和删除。swarmd 启动时会检查，系统检查显示 "Default branches are protected" |

## 真实模型验收

脚本是 `scripts/acceptance-r1.ts`，模型用 qwen3.8-omni-flash（OpenRouter）。

- 任务："`test/median.test.js` 失败了，修源码（不改测试），跑测试，提交，推送，报告。"
- 结果：成功，共 12 轮，用时 51 秒，花费 **$0.0048**（输入 36k token，输出 2.1k token）。
- 过程：`ws_list` → `git_status` → `ws_read`×3 → `ws_bash`（先跑测试看基线）→ `ws_edit` → `ws_read` → `ws_bash`×4 → `git_commit` → `git_push` → `report`。
- Agent 找到了两个缺陷：排序没有用数值比较；偶数长度时没有取中间两个数的平均。它只改了 `src/median.js`，并在报告里说明：另外 3 个模块的测试原本就失败，不属于这次任务。
- Relay 检查通过，分支 `swarm/agentswarm-playground/fix-median-132912` 已推到 GitHub，内容就是正确的实现。`main` 没有被改动。

## 隔离检查（`npm run check`，真机，23/23 通过）

- 工作站的命令以 `ws-1` 身份运行，主组是 `swarm-ws`，不在 `staff` 组里。
- **跑在工作站自己的后台会话里**（`Background 503`），不是你的图形会话。见下面"开发中发现并修复的问题"里的第一条。
- 读不到：你的家目录、`/Volumes/Data`、swarmd 数据、`ws-2` 的工作站和 inbox。
- 命令的环境变量里没有任何密钥；PATH 上用的是 agentSwarm 自己装的 Node 24.22.0；可以联网。
- 连不上 swarmd 的 API；读不到剪贴板；控制不了 Finder。
- 路径越界被拒。

## 测试

- `npm test`：31 项全部通过。覆盖：
  - ws-exec：路径越界和符号链接逃逸、真实 seatbelt 下的读写和隔离、剪贴板和截屏被拒、超时连同子进程一起结束、git 的克隆、提交、推到 inbox；
  - swarmd：认证、CSRF、Host 白名单、密钥加密存储、项目镜像和分支保护；
  - 完整的运行流程：修 bug 加推送、越界被拒、密钥被拒（包括"先加后删"的提交历史）、改 `.github/` 被拒、取消、轮数上限、模型重试、追加消息、重启后恢复；
  - 本地重置密码。
- `npm run e2e`：1 项通过（Playwright + Chrome）。从首次设置开始，依次配置端点、令牌、项目，建 Agent，下达任务，看实时时间线，最后看到报告和推送。截图有 1440 和 375 两个宽度。
- `npm run typecheck`：通过（TypeScript 7）。

## 代码审查

code-reviewer 报了 0 个 CRITICAL、4 个 HIGH、7 个 MEDIUM、9 个 LOW。

4 个 HIGH 都已修复：
1. 点"检查工作站"会释放正在运行的任务占用的工作站。现在只在启动时重置。
2. 取消或结束后，Agent 用 `setsid` 之类方式留下的后台进程会活下来。现在新增 `reap` 操作：运行结束、取消、swarmd 启动时，结束该工作站用户的全部进程。命令超时后最多再等 0.5 秒。
3. 跨站 WebSocket 劫持和 DNS 重绑定。现在所有 `/api` 请求（包括 WebSocket 握手）都只接受白名单里的 Host 和同源的 Origin。
4. 追加消息时，时长、轮数、费用上限按整个生命周期计算。现在按每次执行计算。

MEDIUM 已修复的：
- 逐个提交扫描密钥，包括提交说明；
- 禁止改动 `.github/`，单次推送的新对象上限 50 MB；
- 每个工作站只能读自己项目的镜像；
- 启动过程中收到的消息先缓存再送达；
- clone 可以重复执行，并且先确认模型可用再 clone；
- 沙箱禁止连接 swarmd 的端口；
- 登录限流只统计失败次数。

LOW 已修复的：
- 审计日志不再记录失败登录的原始用户名；
- 分支名后缀加长到 6 位；
- 模型重试之间加等待；
- 断线重连后重新拉取数据；
- 工作站不可用时，追加的消息直接报错，不再无限排队。

## 开发中发现并修复的问题

- **工作站继承了你的图形会话**：真机检查发现，`sudo -u ws-N` 启动的命令仍然挂在你的 Aqua 会话下，能读你的剪贴板，`osascript` 也能运行。
  - 现在改为由 root 安装的 `ws-launch` 用 `launchctl asuser` 把命令放进该工作站自己的会话；
  - sudoers 只允许 `ws-launch` 配上 `ws-1`…`ws-8` 这 8 个确切的参数；
  - 沙箱另外禁止剪贴板和窗口服务，作为第二道防线。
- **`kill(-1)` 会连调用者一起杀掉**：macOS 上 `kill(-1)` 也会杀死调用它的进程，所以 reap 回报不了结果。现在改为列出该用户的进程逐个结束，跳过自己。**这个修复需要你运行一次 `sudo zsh scripts/setup.sh --update-exec` 才会装上**；在那之前，swarmd 日志里会出现 "reap failed"，但清理本身是生效的。
- **Homebrew 连带升级**：安装 `node@24` 时，Homebrew 升级了共享的 simdjson，导致已有的 `node` 和 `node@22` 无法启动，已升级修复。教训已经写进安装脚本：工作站使用 nodejs.org 的官方 Node，并校验 SHA256。

## 与方案不同之处

- 改名，见开头。
- 工作站命令经 `ws-launch` 以 root 进入工作站的会话，而不是直接 `sudo -u`。原因见上面。
- 测试用的假模型用的是 Pi 自带的 faux provider，而不是自己写的 HTTP 假服务器。

## 剩余风险（留到后续）

- **文件读写操作不在 seatbelt 里**：`fs.read`、`fs.write` 等直接以 `ws-N` 身份运行，检查和使用之间存在符号链接竞争的可能。第一道防线（独立用户）仍然有效，**前提是你的家目录不再是 `755`**（系统检查目前提示了这一项）。
- **从 inbox 取代码时读的是 Agent 能改的仓库配置**：审查没有找到能执行代码的路径，以后改成从 swarmd 自己的副本取。
- **运行事件里的工具输出是明文存储的**：例如 Agent 读了 `.env` 文件，内容会进数据库。以后加脱敏。
- **OpenAI 兼容端点的模型费用按 0 计算**：对这类模型，费用上限不起作用，只有轮数和时长上限在保护。
- **GitHub 令牌**：没有设过期时间，并且授权范围里还包括 agentSwarm 源码仓库。建议重建一个 90 天过期、只授权 playground 的令牌。
- **`sandbox-exec` 已被 Apple 标为弃用**：每次系统升级后跑一遍 `npm run check`。
