# R0 实测记录（2026-10-16，进行中）

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
| 模拟器在 `ws-N` 用户下运行 | — | 待做：需要你创建测试用户 |
| Claude Code / Codex 在 `ws-N` 用户下用订阅额度 | — | 待做：需要你创建测试用户并登录 |
| Discord 机器人 | — | 待做：需要你创建机器人 |

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

## 待做（需要你配合）

1. **测试用户**：创建一个临时用户 `ws-probe`，用来测试在没有图形会话的独立用户下：
   - 模拟器能否启动、截图、点击；
   - Claude Code 和 Codex 能否用你的订阅额度运行。
2. **Discord 机器人**：测试收发消息、线程和按钮。
