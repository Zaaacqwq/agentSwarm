# R0 实测记录（2026-10-16）

环境：Mac mini M4，16 GB，macOS 27，Xcode 27.0（27A266a），模拟器运行时 iOS 17.5 / 18.6 / 26.4 / 27.0。
实测脚本在 `r0/` 下。

| 项目 | 结论 | 状态 |
|---|---|---|
| 模拟器：构建、运行、截图（你的账号） | 可行 | 完成 |
| 模拟器：读界面、点击、输入（你的账号） | 可行，但点击必须用 AXe 的 `physical` 方式 | 完成 |
| 识图定位（qwen3.8-omni-flash） | 大号元素基本可用；小图标偏弱；延迟偶有尖峰 | 完成 |
| Claude Code 无头运行（你的账号） | 可行 | 完成 |
| Codex 无头运行（你的账号，外层套沙箱） | 可行，但必须关掉 Codex 自带的沙箱 | 完成 |
| Node 24 + Pi 循环 | 可行 | 完成 |
| 模拟器在独立用户（`ws-probe`，无图形会话）下运行 | **可行**：建设备、启动、截图、读界面、点击，Xcode 构建并安装 App | 完成 |
| Claude Code / Codex 在独立用户下用订阅额度 | 可行 | 完成 |
| Discord 机器人 | 可行：发消息、建线程、按钮、斜杠命令、收回复 | 完成 |

---

## 1. 模拟器（以你的账号运行）

工具：`mobilebuildmcp` 2.7.1（npx 运行）、`axe` 1.8.0、`xcrun simctl`。

| 操作 | 结果 | 耗时 |
|---|---|---|
| 生成 iOS 工程（`project-scaffolding scaffold-ios`） | 成功 | 1.4 s |
| 构建、安装并启动（`simulator build-and-run`，含冷启动模拟器） | 成功 | 38 s |
| 截图（`simctl io screenshot`，1206×2622） | 成功 | 2.2 s |
| 读界面结构（`axe describe-ui`） | 成功，元素带标签和位置 | 约 1 s |
| 读界面结构（`mobilebuildmcp ui-automation snapshot-ui`） | 冷启动超时；热启动成功，输出带元素编号，很适合直接交给 Agent | 失败 12.5 s / 成功 6.5 s |
| 按标签或坐标点击（AXe 默认方式） | **报告成功，但界面没变化** | — |
| 按标签或坐标点击（`--tap-style physical`） | 成功，页面正常跳转 | 约 4 s |
| 按编号点击（`mobilebuildmcp ui-automation tap`） | **报告成功，但界面没变化**（它底层调用 AXe 的默认方式） | — |
| 输入文字（`axe type`） | 成功（先用坐标点中输入框） | — |

- 默认点击无效的问题在 iOS 26.4 和 27.0 上都会出现，原因是和 Xcode 27 不兼容，与 iOS 版本无关。
- **结论**：读界面和截图可以用 MobileBuildMCP 或 AXe；点击和手势直接调用 AXe 并加上 `--tap-style physical`。之后再跟进上游是否修复。
- 按标签点击搜索框没能让它获得焦点（iOS 27 的悬浮搜索栏）；改用坐标点击就正常了。所以工具要同时支持按元素点击和按坐标点击。
- 构建过程中系统可用内存还剩约 40%。

## 2. 识图定位（`r0/vision-probe.mjs`）

方法：把截图缩到 603 像素宽交给模型，问"要点某个元素该点哪里"，让它用 0–1000 的比例坐标回答；用 AXe 读到的元素位置作为标准答案，判断落点是否在元素范围内。

| 页面 | 命中 | 说明 |
|---|---|---|
| 设置首页 | 9/12 | 2 个是格式偏差（漏了引号、改用 `point_2d`），按它给的坐标算其实都点中了；1 个（StandBy）恰好被底部悬浮搜索栏挡住 |
| General 页 | 7/8 | 唯一没点中的是左上角的小返回按钮，模型指到了页面标题上 |

- 每次请求约 $0.0001–0.0002，通常 2.5–6 秒。
- **延迟偶尔有尖峰**：一次 30 秒，另一轮里出现过 148 秒和 333 秒。必须设置超时和重试，实测脚本现在用 60 秒超时。
- **结论**：
  - 有界面结构时，优先用结构里的元素位置，识图作为辅助和验证；
  - 没有界面结构时（游戏、自绘界面），识图对大号元素可用，小图标需要配合局部放大；
  - 解析模型的回答要兼容多种坐标格式。

## 3. Claude Code 无头运行

命令：`claude -p … --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "Read,Edit" --max-turns 6`。

- 修一个小 bug 用了 13 秒、3 轮。默认模型是 `claude-opus-5-5`，可以用 `--model` 指定更省额度的模型。
- 事件流：`system:init`（模型、工具、权限模式）、`assistant`、`user`（工具结果）、`result`（结果、`total_cost_usd`、轮数、耗时）。
- **`rate_limit_event` 里有订阅额度**：5 小时窗口和 7 天窗口的已用比例和重置时间（实测时分别是 38% 和 15%）。Hive 可以据此决定是否把任务派给 Claude Code。
- `total_cost_usd`（$0.59）是按 API 价格折算的数值，订阅不另外收费，只能用来估算。
- 运行时会执行 `~/.claude` 里的用户 hooks；到了 `ws-N` 用户下就没有这些 hooks。

## 4. Codex 无头运行

命令：`codex exec --json --ephemeral -C <dir> …`。

- 修一个小 bug 用了 17 秒。事件流：`thread.started`、`turn.started`、`item.*`（`command_execution`、`file_change`、`agent_message`）、`turn.completed`（只有 token 用量，没有费用）。
- **嵌套沙箱**：
  - 在 `sandbox-exec` 里面再用 Codex 自带的沙箱（`-s workspace-write`）会完全失效：读不了文件，也跑不了命令。
  - 改用 `--dangerously-bypass-approvals-and-sandbox` 之后正常，10 秒完成。
- **结论**：Hive 里的 Codex 必须关掉它自带的沙箱，安全完全依赖外层的 Hive 沙箱（独立的 `ws-N` 用户加 seatbelt）。Claude Code 默认没有自己的沙箱，所以不受这个影响。

## 5. Node 24 + Pi（`r0/pi-loop/`）

- `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core` 1.3.0，运行在 Node 24.22.0 上。
- 接口和旧版 Pi 不同：
  - 模型通过 `createModels()` 加 provider 创建；
  - OpenRouter 的模型列表是动态的，要先 `refresh()`。刷新后能直接找到 `qwen/qwen3.8-omni-flash`（支持图片输入，100 万上下文），不需要 P5 时自己写的模型目录查询。
- 修 bug 任务通过（读文件 → 写文件 → 读文件确认），用时 8.5 秒。
- 工具直接返回图片后，模型能正确说出页面标题和列表内容，用时 4.9 秒。
- 两个任务合计 $0.0007。

## 6. 安装过程中的发现

- **Homebrew 连带升级的风险**：安装 `node@24` 时，Homebrew 把共享依赖 simdjson 升到了新版本，导致已有的 `node`（26.0）和 `node@22` 无法启动，需要分别升级到 26.12.0 和 22.23.3 才恢复。之后用 `brew linkage --test` 检查了其他依赖这些库的程序，都正常。
  - 教训：Hive 的安装脚本不要随手用 Homebrew 安装共享依赖；必须安装时，装完要检查其他程序的链接是否完好。
- **AXe 的 Homebrew 配方**要求 Command Line Tools，而 CLT 还不支持 macOS 27。改用官方发布的通用二进制包：有 Developer ID 签名并经过 Apple 公证，安装在 `~/.local/opt/axe`。

---

## 7. 独立用户 `ws-probe`（模拟 `ws-N`：隐藏用户，没有图形会话）

测试用户由 `r0/probe-user.sh` 创建，你的账号可以免密码以它的身份运行命令（`sudo -n -u ws-probe -H`）。

| 操作 | 结果 |
|---|---|
| `simctl list` | 能看到系统装的全部运行时；有自己独立的一套设备，和你的互不干扰 |
| 新建 iOS 27 设备并启动 | 成功，约 1 秒返回，`bootstatus` 显示启动完成 |
| 打开"设置"、截图 | 成功（新设备第一次启动时截到白屏，几秒后正常） |
| AXe 读界面 | 第一次"创建自动化会话超时"，重试成功 |
| AXe 点击（physical） | 成功，页面正常跳到 General |
| `xcodebuild` 构建示例 App（DerivedData 放在它自己的家目录） | 成功，29 秒 |
| 安装并启动自己构建的 App，读到界面上的 "Hello, World!" | 成功 |

**结论**：模拟器不需要你的登录会话，每个 `ws-N` 用户都可以有自己的模拟器，互不干扰。HIVE_PLAN 第 9 节里"不行就在你的会话里跑代理"的备选方案用不上了。

- **Claude Code**：
  - 令牌通过标准输入交给 `ws-probe` 下的进程，存进环境变量 `CLAUDE_CODE_OAUTH_TOKEN`，不出现在命令行参数里（其他用户能通过 `ps` 看到命令行参数）。
  - 修 bug 用了 6 秒；`apiKeySource: none`，说明走的是订阅。
  - 这个用户下的默认模型是 `claude-sonnet-5-5`（你的账号下是 opus，因为你有自己的设置）。
  - 和你共用同一份额度，`rate_limit_event` 里的已用比例是同一个。
- **Codex**：
  - `ws-probe` 用 `codex login --device-auth` 单独登录。不复制你的 `auth.json`，以免两边共用刷新令牌、互相挤下线。
  - 套上外层 seatbelt 并关掉它自带的沙箱后，修 bug 用了 19 秒。
  - 外层配置拒绝了它读取 `~/client_private.key` 的尝试（Operation not permitted），说明外层隔离有效。

## 8. Discord（`r0/discord-probe/`，discord.js 14.27.0）

- 机器人 `ZacAgent#7026` 登录用时不到 1 秒，所在服务器 `ZacBot`。
- 在 #general 发出带"批准 / 要修改"按钮的消息用了 328 ms；建线程并在线程里发消息成功。
- 注册服务器内的斜杠命令 `/hive` 成功。
- 收到了你的回复、按钮点击（"批准"）和 `/hive`，回复和按钮更新都正常。
- 你的 Discord 账号 ID：`769549199007416320`，Hive 用它做指令白名单。
- 没测到：在线程里收消息（这次的回复发在了频道里），只是收消息的位置不同，代码相同。
- 机器人现在没有 Manage Channels 权限。Hive 要为每个项目建频道，正式接入时需要补上这个权限。
- 仅作提示的回复要用 `flags: MessageFlags.Ephemeral`，旧的 `ephemeral: true` 写法已经弃用。

## 9. 环境里原有的问题（对 R1 有影响）

1. **家目录对所有用户开放**：`/Users/zaaac` 的权限是 `755`，任何本机用户都能列出里面的文件；`~/client_private.key` 是 `644`，`ws-probe` 能直接读取。
   - Hive 的 seatbelt 会拒绝访问 `/Users/*`，但操作系统这一层也应该收紧（`chmod 750 ~`，私钥改成 `600`）。
   - R1 的安装脚本要检查这一项并给出提示。
2. **Homebrew 包的权限**：151 个包里有 35 个的顶层目录是 `700`，其他用户用不了。例如 `/opt/homebrew/bin/node`（26.12）在 `ws-probe` 下因为读不到 highway 库而启动失败。
   - 里面的文件本身是可读的，只需把顶层目录改成 Homebrew 的标准权限 `755`。
   - R1 的安装脚本要检查 `ws-N` 用到的工具能否运行。
3. **Homebrew 连带升级**：见第 6 节。

## 对 HIVE_PLAN 的影响

| 方案里的内容 | 调整 |
|---|---|
| 第 9 节：模拟器 | 确认可以在 `ws-N` 下运行，不需要你会话里的代理；读界面用 MobileBuildMCP 或 AXe，点击直接调用 AXe 并加 `--tap-style physical` |
| 第 9 节：识图 | 有界面结构时以结构为主；请求加超时和重试；兼容多种坐标格式；小图标需要局部放大 |
| 第 7 节：CLI worker | Claude Code 通过标准输入拿令牌；Codex 每个 `ws-N` 用户单独登录，并关掉它自带的沙箱；从 `rate_limit_event` 读额度来安排任务 |
| 第 7 节：原生循环 | 用 `@earendil-works/pi-ai` 和 `pi-agent-core` 1.3.0；OpenRouter 模型从动态列表获取 |
| 第 10 节：Discord | 方案可行；正式接入时给机器人加 Manage Channels 权限 |
| 第 8 节：安装脚本 | 增加环境检查：家目录权限、`ws-N` 能否运行 Homebrew 工具；不随手用 Homebrew 安装共享依赖 |

## 收尾

- 测试用的模拟器、App 和 `/tmp` 下的目录都已删除。
- 测试用户 `ws-probe` 还在，由你决定何时用 `sudo zsh r0/probe-user.sh --remove` 删除（R1 会另外创建正式的 `ws-1`…`ws-8`）。
- `/hive` 斜杠命令还注册在 ZacBot 服务器里，R3 正式接入时会重新注册。
- 实测中 Claude 令牌约 18 个字符的尾段显示在了对话里，建议作废后重新生成。
