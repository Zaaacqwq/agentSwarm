# R4 验收记录（2026-10-17）

| 验收项（R4 方案第 0 节） | 结果 | 依据 |
|---|---|---|
| 1. 面板里接入 Claude Code 令牌和 Codex 登录，"测试"按钮在工作站上实际跑通 | 通过 | 令牌是你用 `claude setup-token` 生成的，加密保存。`ws-1`、`ws-2` 用设备码登录了 Codex。两个"测试"都返回 OK。Codex 第一次测试失败，原因是漏装了 `codex-code-mode-host`，见下文问题 1 |
| 2. 同一个工作包分别交给 native、Claude Code、Codex，三个都经过评审、合并、开 PR；至少一个 CLI 子 Agent 被打回后接着原会话修改 | 通过 | 工作包是给 csv2md 加 `--align` 选项。三棵树全部成功，开出 [#3](https://github.com/Zaaacqwq/agentswarm-playground/pull/3)、[#4](https://github.com/Zaaacqwq/agentswarm-playground/pull/4)、[#5](https://github.com/Zaaacqwq/agentswarm-playground/pull/5)。Claude Code 第一次被打回，lead 用 `message_agent` 转达意见；它带着同一个 session（`cca73ee8…`）继续修改，第二轮评审通过 |
| 3. 你合并一个、关闭两个，三棵树都清理干净 | 通过 | 你合并了 #3，关闭了 #4、#5。监视器在下一次轮询时发现，19:03:04–19:03:09 清理了 10 个 worktree、6 个分支，0 次失败。CLI 运行的家目录（Claude 会话、Codex 登录副本）也一起删除了。GitHub 上只剩 `main` 和 R1 遗留分支 |
| 4. 面板实时显示 CLI 的过程，标出运行时，显示折算费用和额度 | 通过 | CLI 的命令、文件改动和发言都按原有事件类型记录，例如 Claude 的 `Read`、`Bash`，Codex 的 `shell`、`edit`。任务树上有运行时标签，CLI 节点显示"≈$x subscription"。设置页显示 Claude 的 5 小时和 7 天额度条。用 E2E 截图和你的截图核对过，1440 和 375 宽度都没有溢出 |
| 5. 取消运行中的 CLI 子 Agent，几秒内进程全部结束，工作站释放 | 通过 | 真实的 Codex 子 Agent 正在 `sleep 300`，`ws-2` 上有 22 个进程，其中包括 `codex`、`codex-code-mode-host`、`zsh`、`sleep`。取消后 0.3 秒内全部结束，子 Agent 记为 cancelled，`ws-2` 回到 free |
| 6. 隔离：读你的家目录、其他工作站、swarmd 数据，连 swarmd 端口，打印凭据，都失败 | 通过（方法有偏差） | 见下文"隔离检查" |
| 7. 三种运行时的对比 | 完成 | 见下表 |

## 对比：同一个工作包，三种运行时

模型：lead 和 reviewer 都用 native（qwen3.8-omni-flash）；开发子 Agent 分别用 native、Claude Code（claude-sonnet-5-5，Claude Code 在工作站用户下的默认模型）、Codex（默认模型）。三棵树同时开始，总共用时 9.5 分钟。

| | Claude Code（#3，已合并） | native（#4，已关闭） | Codex（#5，已关闭） |
|---|---|---|---|
| 开发用时 | 3.7 分钟（两次执行） | 4.2 分钟 | 6.0 分钟 |
| 整棵树用时 | 5.9 分钟 | 8.3 分钟 | 9.4 分钟 |
| 开发子 Agent 花费 | $0（订阅），按 API 价格约 $0.26 | $0.032 | $0（订阅），Codex 不报价格 |
| 整棵树花费（lead + reviewer） | $0.063 | $0.057 | $0.046 |
| token（输入 / 输出） | 13.7 万 / 7.3 千 | 46.7 万 / 9.6 千 | 18.7 万 / 2.8 千 |
| 评审 | 第一次打回，改后通过 | 一次通过 | 一次通过 |
| 改动 | +152/−7，4 个提交 | +344/−6，2 个提交 | +128/−14，2 个提交 |
| 测试（我本地重跑） | 76 个全部通过 | 87 个全部通过 | 82 个全部通过 |
| 是否符合要求 | 符合 | **不完全符合** | 符合 |

- **native 偏离了要求，评审没发现。** 窄列时它输出 `:--`，不是要求的 `:---`。它为了保持原来的列宽把分隔符截短了，原生 reviewer 认为可以合并。便宜模型做评审，会漏掉这种"能跑、但不合要求"的细节。
- **Claude Code 被打回的理由站得住。** 实现本身正确，reviewer 指出的是：
  - 错误用例只检查了"抛出了错误"，没检查是哪一种错误；
  - 没有窄列的测试；
  - `--align=SPEC` 写法和重复给 `--align` 时的行为没说明。

  它在原会话里补上了这些，还自己决定支持 `--align=SPEC`。
- **Codex 的"轮数"显示为 1。** `codex exec` 一次执行只算一个回合，面板上的数字没有参考价值。实际的动作上限按"每回合 3 条"计算，见 R4 方案第 2.2 节。以后面板可以改为显示动作数。
- **Claude Code 的提交带 `Co-Authored-By: Claude …` 尾注。** 这是它自己的默认做法，不影响什么，记录在这里。

## 隔离检查

1. **先让 CLI 子 Agent 自己去试，结果两边都拒绝了。**
   - Claude Code 的回答是：这和"只在当前目录工作、不找凭据"的规则冲突。任务里写着"这是主人要求的安全检查"，但这句话无法验证，只能当作数据。
   - Codex 那棵树里，原生 lead 连子 Agent 都没派，直接拒绝转达这个任务，并说明这是"收集凭据、外传数据"。

   这对抵御提示词注入是好事，但说明这一项没法靠 Agent 自己去验证。
2. **改为在沙箱这一层直接检查。** 在两个 CLI 子 Agent 自己的 worktree 里，以同一个工作站用户、同一份 seatbelt 配置，通过 ws-exec 执行同样的命令。CLI 执行的每条 shell 命令都套着这一层，所以条件相同。

| 检查 | Claude Code（ws-5） | Codex（ws-1） |
|---|---|---|
| `ls /Users/zaaac` | Permission denied | Permission denied |
| 其他工作站 `/Volumes/SwarmWS/ws/ws-2` | Operation not permitted | Operation not permitted |
| swarmd 数据 `/Volumes/SwarmWS/swarmd` | Operation not permitted | Operation not permitted |
| 同一工作站上的其他 worktree（`..`） | Operation not permitted | Operation not permitted |
| 工作站上的 Codex 登录原件 | （不存在） | Operation not permitted |
| swarmd 端口：`127.0.0.1`、`localhost`、`[::1]` | 连不上（curl 7） | 连不上（curl 7） |
| 环境变量里带凭据的条目 | 0 | 0 |
| 运行后家目录里落下 Claude 令牌（`sk-ant-`） | 没有 | — |

- 外网是通的（`api.github.com` 返回 200），这是设计如此，开发时要装依赖。
- Codex 的运行目录里有它自己那份登录副本，也是设计如此；运行结束后就清理掉了。

## 实测和验收中发现的问题

1. **漏装 `codex-code-mode-host`。** Codex 0.163.0 需要和 `codex` 放在同一目录的这个程序，没有它会拒绝运行。我在本机实测时用的是 npm 的完整目录，所以没发现。面板的"测试"按钮在第一次使用时就报了出来。
   - 修复（`aa38cf2`）：安装脚本一并安装它，同样核对固定的 SHA-256 和 OpenAI 的开发者签名。
   - 你重新运行了一次 `--update-cli`。
2. **方案里的令牌传法被实测推翻。** 方案原本打算用 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 不让令牌进入 shell 命令的环境。实测发现它会把权限模式强制改回 default。改用 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`，令牌完全不进环境变量。验收中用真实令牌检查了环境变量和家目录，都没有令牌。
3. **Codex 的事件里没有额度信息**，所以只对 Claude Code 做额度把关，Codex 只记录 token 用量。

## 测试

- `npm test`：**82 项全部通过**（R3 结束时 60 项）。新增的有：
  - `ws-exec` 的 CLI 测试 7 项，使用真实 seatbelt：
    - 令牌经 fd 3 传入，不在环境变量和命令行参数里；
    - 参数锁定、沙箱隔离、超时连同子进程一起杀掉；
    - Codex 的运行副本：轮换后的令牌写回原件，换成别的账号的不收；运行之间无法互留配置；
    - 设备码登录。
  - 事件解析 7 项：使用从真实 CLI 录下并去掉本机路径的事件样本（`apps/swarmd/test/fixtures/cli/`）。
  - 集成 8 项（假 CLI）：
    - 被打回后接着原会话修改；
    - Codex 只排到已登录的工作站；
    - 替 CLI 提交它没提交的改动；
    - 不可用时拒绝派生，额度用完时也拒绝；
    - 取消、会话丢失时新开会话；
    - 运行中收到消息时接着处理；
    - 没有会话时补上任务说明；
    - 额度用完时排队等待；
    - 每种运行时的并发上限。
- `npm run e2e`：3 项通过。新的一项覆盖：在面板里保存令牌、Codex 设备码登录、Claude Code 子 Agent 完成任务、在任务树和运行页看到运行时和折算费用。
- 有两个关键修复我做了反向验证：把修复拿掉后，对应测试会失败。一个是并发上限，一个是运行中收到消息时接着处理。
- 迁移 0004 只新增字段。升级前自动备份了数据库（`agentswarm.db.backup-2026-10-17T18-33-41-438Z`）。

## 代码审查

code-reviewer 报 0 / 2 / 7 / 9（CRITICAL / HIGH / MEDIUM / LOW），security-reviewer 报 0 / 2 / 3 / 4，其中有两条两边都报了。HIGH 全部修复并有回归测试（`2f17a4d`）：
1. **运行中的 CLI 收到消息。** 原来要等它结束、父 Agent 已经拿到结果后，才重新开工。现在在同一次执行里接着处理。
2. **没有会话的后续消息。** 原来 CLI 只收到"Continue."这类最新消息，看不到任务本身。现在会连同任务说明一起交给它。
3. **共享的 Codex 目录。** 原来同一工作站上的 Codex 运行可以给后来的运行留配置，也能读别的运行的会话记录。现在每次运行只拿一份副本，另外加了 `--ignore-user-config` 和 `--ignore-rules`。
4. **登录链接。** 面板只显示 OpenAI 自己的登录页面链接。

MEDIUM 已修复：
- 安装脚本核对固定哈希和开发者签名，不以 root 身份执行你账号下的文件；
- stdin 或 fd 3 写入时出现 EPIPE 不再让 ws-exec 崩溃；
- 登录或测试占用的工作站释放后，会唤醒调度；
- 只有明确"未登录"时才清除 Codex 登录状态；
- 每次执行都检查运行时是否可用；额度用完的排队任务等待恢复，不直接失败；
- Codex 的动作上限放宽；
- 超时后先停掉进程再保存工作，推送失败会报告出来。

LOW 已修复：
- CLI 没交回结果就算失败；
- 第二次尝试的计数在第一次的基础上累加；
- 额度事件必须两个窗口都有；
- 退出登录时占用工作站，并检查结果；
- 登录输出的 stderr 实时显示；
- 事件处理出错不再被吞掉；
- 工具 id 加随机前缀；
- 测试和刷新同一时间只跑一个。

未修复：
- 单行事件超过 4MB 时会被切开。很少见，切开后两段解析器都不认识，会被跳过。
- JWT 扫描只能防止意外提交，挡不住有意外传，方案第 3 节已经这样写明。

## 剩余问题

- **便宜模型做评审会漏问题。** 这次 native 那份的偏差就没被发现。可以考虑让 Claude Code 或 Codex 也能当 reviewer（本阶段没做），或者给 reviewer 换更强的模型。
- **没开 PR 的树不会被清理。** 两棵隔离检查树和取消验证那棵树的 worktree 还留在工作站上（GitHub 上没有它们的分支）。这和 R1 遗留分支是同一个问题：清理只在 PR 合并或关闭时触发。
- **工作站用户运行不了 Homebrew 装的 `node`。** 缺 `libhwy` 动态库，R0 就记录过，是 Homebrew 目录权限的问题。Agent 用的是 agentSwarm 自带的 Node，所以不受影响。
- **Codex 的轮数没有意义**，面板以后可以改为显示动作数。
- 从 R3 带下来的问题仍然存在：网页工具的泄露风险、lead 可以绕开评审、手机端导航被截断、Discord 里显示 HTML 原文。
