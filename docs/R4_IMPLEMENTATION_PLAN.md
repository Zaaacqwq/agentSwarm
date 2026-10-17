# R4 实施方案：CLI worker（2026-10-17 已确认）

> 依据 `PLAN.md` 第 7 节和第 14 节（R4）、`docs/R0_FINDINGS.md` 第 3、4、7 节，以及 R1–R3 的现有实现。
> 你同意了第 8 节的全部推荐（"按建议，开始 R4"）。
> 标 **【需验证】** 的内容在实现第一步用真实 CLI 实测后再定，结果见第 9 节。

## 0. 目标与验收

**目标：** 子 Agent 除了现在的原生循环（Pi + OpenRouter），还可以用 **Claude Code** 或 **Codex** 来做。它们在同一套沙箱里运行，消耗的是你的订阅额度；其余流程不变：分支、评审、合并、PR、清理。

**验收**（真实环境，`agentswarm-playground` 仓库）：
1. **接入。** 你在面板设置里填入 Claude Code 的长期令牌，并在面板上为 `ws-1`、`ws-2` 完成 Codex 登录。每个运行时都有"测试"按钮，在工作站上实际跑一次，结果显示在面板上。
2. **同一个工作包，三种运行时。** 工作包是"给 csv2md 加 `--align` 选项（逐列指定左、中、右对齐），带测试"。从面板发起 3 棵任务树，每棵由原生 lead 派一个 dev 子 Agent，运行时分别是 native、claude_code、codex。三个都要：
   - 提交代码，由 swarmd 推送；
   - 经原生 reviewer 评审；
   - 合回各自的集成分支，并开出 PR。

   至少有一个 CLI 子 Agent 被打回过一次：lead 用 `message_agent` 把意见发给它，它**接着原来的会话**修改，然后重新评审。
3. **合并与清理。** 你挑一个 PR 合并，关掉另外两个。三棵树的 worktree 和分支全部清理干净。
4. **面板。** 能实时看到 CLI 子 Agent 的过程（执行的命令、改动的文件、它说的话）。树上每个节点标出运行时；显示按 API 价格折算的费用、Claude 的额度用量，以及 Codex 的 token 用量。
5. **停止。** 取消一个运行中的 CLI 子 Agent 后，几秒内进程全部结束，工作站释放，`ps` 查不到残留。
6. **隔离。** 让一个 Claude Code 子 Agent 和一个 Codex 子 Agent 分别尝试做以下事情，全部失败：
   - 读你的家目录；
   - 读其他工作站的目录；
   - 读 swarmd 的数据目录；
   - 连 swarmd 的端口；
   - 在 shell 里打印出自己的登录凭据（Claude Code 用真实令牌检查：`env`、`~/.claude` 下的文件里都不应该出现令牌）。
7. **对比。** 验收文档里列出三种运行时在同一个工作包上的表现：用时、轮数、费用或额度、评审结论、测试结果。

不在 R4 范围内：
- 让 CLI 当 lead、reviewer、researcher 或 QA（只做 dev 子 Agent）；
- 把 agentSwarm 的工具（派生、提问等）通过 MCP 交给 CLI 使用；
- 直连 Anthropic 或 OpenAI 的 API 端点。原生循环现在已经可以通过 OpenRouter 使用 Claude 和 GPT 模型，需要时再加。

---

## 1. 运行时怎么选

- `spawn_agent` 新增参数 `runtime`，取值 `native`（默认）、`claude_code`、`codex`。
- 工具说明里会写出当前能用的运行时和额度情况，例如 "claude_code：5 小时窗口已用 38%"。lead 的提示词建议：难、改动面大的工作包交给 CLI，简单的用 native。
- 面板设置里每个运行时可以单独开关。关掉的运行时不会出现在工具说明里；如果 lead 还是指定了它，`spawn_agent` 会报错并说明原因，让 lead 改用别的运行时。
- 子 Agent 的运行时记在它的 agent 记录上（`agents.runtime`，现有字段，现在只有 `native`）。

## 2. 在工作站上运行 CLI

### 2.1 新的 ws-exec 操作

现在 ws-exec 的每个请求都只返回一次结果，而 CLI 一跑就是十几分钟，中间要持续汇报事件。

- **`cli.run`**：
  - 请求内容：`{scope, runtime, prompt, resume?, model?, maxTurns, timeoutMs, credential?}`。
  - ws-exec 运行期间不断在标准输出写事件行 `{"event": …}`，最后写一行结果。
  - 命令行**由 ws-exec 按固定模板拼出**，请求只能填上面这些字段，不能塞入任意参数。
- **`cli.login`、`cli.status`**：只用于 Codex，发起设备码登录、查询登录状态（第 3 节）。
- **swarmd 一侧**：`WorkstationBackend` 新增 `stream()`，按行读取事件。取消时沿用现在的做法，发 SIGTERM 杀掉整个进程组。sudoers 规则和 `ws-launch` 都不用改。

### 2.2 命令

| | Claude Code | Codex |
|---|---|---|
| 程序 | `/usr/local/libexec/agentswarm/cli/claude`（固定版本，第 2.4 节） | `/usr/local/libexec/agentswarm/cli/codex` |
| 无头运行 | `-p --output-format stream-json --verbose` | `exec --json` |
| 权限 | `--permission-mode bypassPermissions`。安全靠外层沙箱：独立用户加 seatbelt | `--dangerously-bypass-approvals-and-sandbox`。R0 发现它自带的沙箱套在 seatbelt 里会失效 |
| 关掉的工具 | `WebFetch`、`WebSearch`；不加载 MCP（`--strict-mcp-config`）；不加载用户级设置和 hooks | 网页搜索关掉（`-c` 配置） |
| 上限 | `--max-turns`，再加时间上限 | 没有回合上限参数：靠时间上限，外加动作条数上限（命令和文件改动，每个允许的回合 3 条） |
| 结构化结果 | `--json-schema`：要求最后交回 `{summary, tests, unfinished}` | `--output-schema`：同样的结构 |
| 继续会话 | `--resume <session_id>` | `exec resume <thread_id>` |

- **环境变量**：沿用现在的最小环境（`HOME` 和 `TMPDIR` 是这个 worktree 自己的），再加上：
  - `DISABLE_AUTOUPDATER=1`；
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；
  - ~~`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`~~：实测改用更好的办法，见第 9 节第 1 条。
- **会话文件**：放在 worktree 自己的 `HOME` 下。worktree 一直留在原来那个工作站上，后续消息也会回到那里，所以"接着原来的会话"能用。万一会话文件丢了，就新开一个会话，把任务说明、最新消息和 `git log` 一起交给它。

### 2.3 结束之后

CLI 自己不能推送，它没有 GitHub 凭据。进程结束后，swarmd 依次：
1. 运行 `git.status`。有没提交的改动就替它提交一次，提交信息注明"CLI 留下的未提交改动"。
2. 经 Relay 推送，和原生子 Agent 的 `git_push` 走同一条路：扫描密钥、拒绝改 `.github/`、限制改动量。
3. 用结构化结果生成子 Agent 的报告，交给父 Agent。拿不到结构化结果时，用 CLI 最后一段话作为摘要。

之后的评审、合并、PR、清理全部沿用 R2 和 R3 的流程，不做任何改动。

### 2.4 安装

`ws-N` 用户读不到你家目录里的 `claude`（`~/.local/share/claude`）。所以由 `scripts/setup.sh`（你用 sudo 运行）把**固定版本**装到 `/usr/local/libexec/agentswarm/cli/`：
- Claude Code 2.1.302：单个原生程序；
- Codex 0.163.0：npm 包里自带的 `aarch64-apple-darwin` 原生程序。

安装后，脚本会以 `ws-1` 的身份运行一次 `--version` 确认能用。升级就是改版本号重新运行脚本。swarmd 启动时会检查版本；如果和测试过的版本不一致，面板上给出警告，因为 CLI 的事件格式可能已经变了。

## 3. 凭据

| | Claude Code | Codex |
|---|---|---|
| 来源 | 你运行 `claude setup-token` 生成长期令牌，粘贴到面板设置里 | 面板上点"登录 ws-1"：swarmd 在 `ws-1` 下运行 `codex login --device-auth`，把网址和验证码显示在面板上，你在浏览器里确认 |
| 保存 | 加密存进 swarmd 数据库，和 Discord 令牌一样 | 每个工作站各自的 `CODEX_HOME`（`/Volumes/SwarmWS/ws/ws-N/.codex`）。不复制你的 `auth.json`，以免共用刷新令牌、互相挤下线（R0 的发现） |
| 交给 CLI | 放进 ws-exec 请求，经标准输入传入，再经文件描述符 3 交给 Claude Code。不出现在环境变量、命令行参数和日志里 | 每次运行拿到一份登录信息的**副本**，放在它自己的空间里（`CODEX_HOME` 指向那里），工作站上的原件它读不到。运行结束后，如果 Codex 轮换了刷新令牌，而且还是同一个账号，副本才写回原件；换成别的账号的不收。运行之间互相看不到对方的会话记录，也没法给别的运行留配置，另外加上 `--ignore-user-config` 和 `--ignore-rules` |
| 可用范围 | 所有工作站 | 只在已登录的工作站上运行。调度时 Codex 子 Agent 只排到这些工作站 |

**风险**（写进验收文档）：CLI 进程本身必须拿到凭据。一个被网页内容诱导的 CLI，理论上可以想办法把凭据读出来再发出去。应对措施：
- 关掉 CLI 的网页工具；
- Claude 令牌只有推理权限，并通过文件描述符 3 交给 Claude Code，根本不进环境变量，shell 命令看不到它（第 9 节第 1 条）；
- Relay 的密钥扫描增加 JWT 格式（Codex 的访问令牌是这种格式）。这只能防止意外提交，挡不住有意外传：网络是开放的，编码一下就能绕过；
- 两种凭据都能随时作废：面板上可以替换 Claude 令牌，也可以注销某个工作站的 Codex 登录。

R0 时有一段 Claude 令牌显示在了对话里。**R4 用的令牌请重新生成。**

## 4. 费用、额度与上限

- **钱的预算。** 订阅运行**不计入**任务的美元预算，因为订阅本身不按次收费。但两者的数据都会记录下来：
  - Claude 报告的 `total_cost_usd`，记为"按 API 价格折算"；
  - Codex 的 token 用量。
- **额度。**
  - Claude Code 的事件里有 `rate_limit_event`，包含 5 小时和 7 天两个窗口的已用比例和重置时间。swarmd 保存最新的一份，显示在面板上。
  - 某个窗口超过设定的阈值（默认 5 小时 80%、7 天 90%）时，`spawn_agent` 拒绝新的 Claude Code 子 Agent，并告诉 lead 什么时候重置。已经在跑的不受影响。
  - Codex 的 `exec --json` 不带额度信息（第 9 节第 3 条），所以只记录 token 用量，不做额度检查。
- **并发。** 每种 CLI 运行时同时最多 2 个，可以在设置里调。超出的排队等待，不报错。你的订阅额度是共用的，这也是 `PLAN.md` 风险表里"订阅版 CLI 不能大量并发"那一条的应对。
- **回合和时间上限**：和原生子 Agent 一样，每次执行 80 回合、30 分钟。

## 5. 面板与 Discord

- **任务树。** 每个节点显示运行时标记。CLI 节点的费用显示为"≈$x（订阅）"。
- **运行时间线。** 把 CLI 的事件换成现有的事件类型：
  - Claude 的 `assistant` 文字，以及 Codex 的 `agent_message`，对应"助手发言"；
  - Claude 的 `tool_use` 和 `tool_result`，以及 Codex 的 `command_execution` 和 `file_change`，对应"工具开始"和"工具结束"；
  - `result` 和 `turn.completed`，对应轮数和费用。

  因此现有的时间线组件不用改。认不出的事件会被跳过，原始内容保留在运行记录里，方便排查。
- **设置页新增"CLI worker"一栏：**
  - Claude 令牌、开关、版本、最近的额度；
  - Codex 每个工作站的登录状态，以及"登录"和"注销"按钮；
  - 并发上限和额度阈值；
  - "测试"按钮。
- **Discord**：`/status` 加上 Claude 额度一行，其他不变。

## 6. 数据

迁移 0004 只新增字段，不改已有字段：
- `runs.cli_session`：Claude 的 session id 或 Codex 的 thread id；
- `runs.estimated_usd`：按 API 价格折算的费用；
- `workstations.codex_login_at`；
- `settings` 新增：Claude 令牌（加密）、每个运行时的开关、并发上限、额度阈值、最近一次额度快照。

`agents.runtime` 的取值扩展为 `native`、`claude_code`、`codex`。SQLite 里它本来就是文本，只改类型定义。

## 7. 测试

- **单元测试：**
  - 两种事件流的解析：用实测录下的真实事件做样本，包括不认识的事件、被截断的行、出错时的事件；
  - 结构化结果的解析和兜底；
  - 额度阈值；
  - 拼命令行时请求字段的校验：不能借字段塞入额外参数；
  - 新的 JWT 密钥扫描规则。
- **集成测试**：用假的 `claude` 和 `codex` 程序，它们按脚本回放录下的事件、改文件、提交。覆盖：
  - 派生 CLI 子 Agent → 推送 → 评审被打回 → `message_agent` 接着原会话修改 → 合并；
  - 会话文件丢失时新开会话；
  - 超时和取消时进程组全部结束；
  - 额度超阈值时拒绝派生；
  - 并发上限排队；
  - Codex 只排到已登录的工作站；
  - 凭据不出现在事件、日志和报告里。
- **E2E**：在面板设置里填令牌、看到模拟的 Codex 登录码；在任务树里看到运行时标记和 CLI 事件。
- **真实验收**：第 0 节，结果写进 `docs/R4_ACCEPTANCE.md`。
- **代码审查**：用 code-reviewer agent 审查，HIGH 及以上全部修复。因为涉及凭据，再加一轮 security-reviewer。

实现顺序：
1. 先用真实的 `claude` 和 `codex` 在 `ws-1` 下录事件样本，验证所有【需验证】项；
2. 实现 ws-exec 的 `cli.*` 操作和 `stream()`；
3. 运行时接入 RunService；
4. 凭据和额度；
5. 面板；
6. 测试和验收。

## 8. 需要你决定的

1. **CLI 做什么。** 只做 dev 子 Agent，由 lead 按工作包选运行时；评审仍由原生 reviewer 做，这样不同的模型可以互相检查。（推荐）
2. **费用。** 订阅运行不计入美元预算，只显示折算费用；对 Claude Code 用额度阈值把关（5 小时 80%、7 天 90%）。（推荐）
3. **并发。** 每种 CLI 同时最多 2 个。（推荐）
4. **Claude 凭据。** 用 `claude setup-token` 生成的长期令牌，加密存在 swarmd 里。你需要重新生成一个。（推荐）
5. **Codex 登录。** 在面板上逐个工作站登录，先登 `ws-1` 和 `ws-2`，以后需要再加。另一个办法是用 OpenAI API key，但那样走的是 API 计费，不是订阅。（推荐：逐个工作站登录）
6. **CLI 的网页工具。** 关掉。dev 子 Agent 不需要上网查资料，调研由 researcher 负责。（推荐）
7. **版本。** 把 Claude Code 2.1.302 和 Codex 0.163.0 固定装到 `/usr/local/libexec/agentswarm/cli/`，升级时重新运行安装脚本。（推荐）

## 9. 实测结果（2026-10-17，实现第一步）

以你的账号和 `ws-8` 实际运行 Claude Code 2.1.302 和 Codex 0.163.0，修同一个小 bug，录下事件样本（已去掉本机路径，放在 `apps/swarmd/test/fixtures/cli/`）：

1. **Claude 令牌的传法。** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` 会把权限模式强制改回 default，必须另外列出允许的工具。实测发现更好的办法：`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`。以 `ws-8` 身份通过 fd 3 传入一个假令牌，Claude Code 读到并用它请求，得到 401 "OAuth access token is invalid"，说明这条路生效。令牌因此**不进入任何环境变量**，CLI 执行的 shell 命令看不到它。
2. **锁定的参数可用。**
   - `--tools` 和 `--allowedTools` 只放 `Bash,Read,Edit,Write,Glob,Grep`，没有网页工具和子 agent 工具；
   - `--setting-sources ""` 不加载任何设置和 hooks，`--strict-mcp-config` 不加载 MCP；
   - `--json-schema` 交回 `{summary, tests, unfinished}`；
   - `--resume` 能接着原会话，session id 不变；
   - 提示词从标准输入传入可用。
3. **Codex。**
   - `exec --json` 的事件里没有额度信息，只有 `turn.completed` 的 token 用量；
   - `--output-schema` 交回同样的结构；
   - `exec resume <thread_id> … -` 能接着原会话，提示词从标准输入读入；
   - `-c web_search="disabled"` 在 `--strict-config` 下被接受，写错的配置项会直接报错。
4. **安装来源。** 两个程序都带厂商签名（`codesign --verify --strict` 通过）。安装脚本从你本机已装的固定版本复制，并核对签名和版本号。

## 10. 代码审查后的调整

code-reviewer 和 security-reviewer 共报 0 个 CRITICAL、4 个 HIGH。HIGH 全部修复，并加了回归测试：
1. **运行中的 CLI 收到消息。** 原来要等它结束、父 Agent 已经拿到"完成"之后，才作为新任务重新开始。现在同一次执行会接着处理，父 Agent 只在全部做完后收到一次结果。
2. **没有会话的后续消息。** 原来 CLI 只收到"Continue."这类最新消息，看不到任务本身。现在会连同任务说明一起交给它。
3. **共享的 Codex 目录。** 原来每个 Codex 运行都能读写工作站上的同一个 `.codex`：可以给后来的运行留配置，也能读别的运行的会话记录。现在改成每次运行用一份副本，见第 3 节。
4. **登录链接。** 面板只显示 OpenAI 自己的登录页面链接（`auth.openai.com`、`chatgpt.com`），其他网址一律不显示。

安装脚本另外改为：
- 核对固定的 SHA-256，以及厂商的 Developer ID（Anthropic `Q6L2SF6YDW`、OpenAI `2DC432GLL2`）；
- 校验的是复制出来的那份文件，不以 root 身份运行你账号下的任何程序。

其他 MEDIUM 和 LOW 的处理见验收文档。
