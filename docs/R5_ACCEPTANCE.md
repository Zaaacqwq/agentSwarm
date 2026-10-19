# R5 验收记录（2026-10-17）

| 验收项（R5 方案第 1 节） | 结果 | 依据 |
|---|---|---|
| 1. 在 Linear 里安装应用；10 秒内收到事件并回应，签名校验通过 | 通过 | 应用以 `actor=app` 装进 zaaac 工作区，Linear 里的用户名是 agentSwarm。webhook 经 Tailscale Funnel 进来（`:8443/linear/webhook`，只开放这一个路径）：<br>· 不带签名的 POST 返回 401，其他路径返回 404；<br>· 三张 ticket 交出后，每张都在几秒内收到第一条回复 |
| 2. 至少两个真实项目登记好，各对应一个 Linear 项目 | 通过 | Fridgy（iOS）和 betterUWWorks（Web）从"选择 GitHub 仓库"下拉框登记，对应同名 Linear 项目，`main` 受保护。另建了 Sandbox 和 Ideas 两个 Linear 项目，分别用于实验和想法 |
| 3. 同时交出 3 张 ticket，并行进行 | 部分通过 | 三张同时开始：<br>· ZAA-5（Fridgy，功能，完整流程）：完成；<br>· ZAA-6（betterUWWorks）：内容其实是 bug，但没打 bug 标签，所以按功能流程走，调研阶段失败，见问题 1；<br>· ZAA-7（Sandbox，实验）：完成。<br>**偏差：** 快速 bug 流程没有在真实环境里走过，只有集成测试 |
| 4. 不在 Mac mini 前也能完成 | 通过 | ZAA-5 的方案用 Linear 里的"批准"按钮批准。你在 GitHub 上合并了 Fridgy PR [#1](https://github.com/Zaaacqwq/Fridgy/pull/1)（01:32），swarmd 约 1.5 分钟后发现并把任务收尾 |
| 5. ticket 里留下完整记录；合并后自动 Done；提交和 PR 带 ticket 编号 | 通过 | ZAA-5 的 ticket 里有：<br>· 阶段清单，包括 5 个工作包；<br>· research、decisions、plan、acceptance 四份文档和 PR 的链接；<br>· 最终答复，带用时、费用和复盘。<br>合并后 ticket 变成 Done。PR 标题和 8 个提交都以 `ZAA-5:` 开头，PR 正文带 `Fixes ZAA-5`。ZAA-7 的结果（`results.md`）随最终答复发出 |
| 6. 在 Linear 里点"停止"，几秒内停下并说明停在哪一步 | 未在真实环境验证 | 集成测试覆盖了这一项（`linear-flow.test.ts`）。真实验收中没有点停止 |
| 7. 想法类 ticket 只做调研和讨论；说"立项"后新建私有仓库并进入方案阶段 | 未在真实环境验证 | 调研类流程、立项（建私有仓库、推送、登记项目、建 Linear 项目、开始功能任务）、立项中途失败后继续，都由集成测试覆盖。建仓库用的是 `POST /user/repos`。真实验收中没有交想法类 ticket |

## 三张 ticket

| | ZAA-5 Fridgy 配菜选项 | ZAA-6 betterUWWorks 自动 fetch | ZAA-7 CSV 解析库对比 |
|---|---|---|---|
| 类型 | 功能 | 功能（内容是 bug） | 实验（只在本机的项目） |
| 结果 | PR #1 合并，ticket Done | 调研阶段 lead 失败，已搁置 | 完成，结果写进 ticket |
| 总用时 | 192 分钟，大部分时间在等你批准和合并 | 搁置时已过 207 分钟 | 3 分钟 |
| 运行数 | 8 个：lead、2 个 researcher、2 个 dev、reviewer、QA 等 | 3 个 | 1 个 |
| 费用 | $0.54 | $0.99 | $0.025 |
| 改动 | +188/−4 | — | 没有推送（本机项目） |

## 验收中加做的（你提出的）

1. **面板经 Tailscale 访问**：`https://mac-mini.tail8abe68.ts.net:8444`，只在你的 tailnet 里，没有开 Funnel。
   - swarmd 以 `SWARM_DASHBOARD_URL` 和 `SWARM_EXTRA_HOSTS` 启动，ticket 里的面板链接指向这个地址。
   - 实测：页面 200，未登录的 API 返回 401，tailnet 地址的请求通过来源检查，别的来源返回 403。
   - 你原来 443 端口上的 serve 没动。
2. **整棵树的实时动态**：任务页按时间显示所有 Agent 的发言、工具调用（卡片）、推送和问题。每个 Agent 有自己的颜色标签，可以只看一个 Agent；往上翻时不再自动跟到最新。参考了 agent-swarm-ng。
3. **ticket 里的关键动作**：开始、完成、失败、评审通过或打回、开出 PR、合并，都作为 action 发到 ticket 里。

## 实测和验收中发现的问题

1. **ZAA-6 的 lead 被模型提供方拒答。** 错误是 Alibaba 的 `data_inspection_failed`（内容审核）。在这之前一个 researcher 跑满 30 分钟时限，花了 $0.73。换模型重试和 researcher 上限记入 PLAN.md 第 17 节，之后再做。
2. **沙箱里的 `xcodebuild` 加载不了 Swift 宏插件**（SwiftUIMacros），Agent 编译不了 SwiftUI 项目。ZAA-5 的改动是 Swift 代码，只能靠评审和你自己试。归入 R6，作为模拟器验收的前提先解决。
3. **装好的 ws-exec 是旧版**，端口禁止名单看起来不生效。你重新运行 `--update-exec` 后正常。
4. **DNS 在沙箱里失效。** 原因是我禁止了 `/var/run` 下所有的 Unix socket，域名解析要用其中的 mDNSResponder。
   - 修复（`7881daa`）：只禁止 `/tmp`、`/var/run/docker.sock` 和 `/Users` 下的 socket，并加了带变异检查的 DNS 测试。
   - 你重新运行 `--update-exec` 后核对过：名单里的端口连不上，GitHub 和 npm 都返回 200。
5. **PR 合并前没法在手机上试。** 以前你在 Xcode 里跑模拟器、装到手机上试过才合并，现在只能先合并。Xcode Cloud 的 PR TestFlight 包和"PR 消息附上拉到本机的命令"记入 PLAN.md 第 17 节。

## 测试

- `npm test`：**93 项全部通过**（R4 结束时 82 项）。新增的有：
  - Linear 流程 5 项（假 Linear，用法同假 Discord）：
    - webhook 只收签名正确、未过期的投递，每个只处理一次；
    - bug ticket：只听你的，在 ticket 里批准方案，ticket 跟着任务到 Done；
    - 超过同时进行上限的 ticket 按优先级排队，停止能取消任务或移出队列；
    - 沙盒实验在本机仓库里跑，结果写回 ticket，"立项"后变成项目；
    - Linear 出故障时事件重试、早到的回复等待、消息和最终答复重发。
  - 项目档案和本地文件：路径规则；Agent 能读到文件，但文件本身和其中的值都推不出去。
  - ws-exec：放置文件不跟随符号链接、端口禁止名单、Unix socket、DNS。
- E2E（Playwright）：**4 项全部通过**，新增 Linear 设置页和实时动态。1440 和 375 宽度都没有溢出。

## 代码审查

| | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| code-reviewer | 0 | 5 | 8 | 9 |
| security-reviewer | 0 | 3 | 5 | 12 |

HIGH 全部修复（`de1bbc1`）：
- 不知道作者的回复一律忽略；
- 项目文件路径逐段检查，写入时不跟随符号链接；
- webhook 按 Linear 签过名的内容去重，只存本工作区的 Agent 会话事件；
- Relay 拒绝包含本地文件中的值的推送；
- 发送失败不会让任务变成孤儿，事件最多重试 10 次，消息按顺序送达，最终答复重试直到送达；
- 调研和实验任务保留根分支；
- 立项可以中途继续。

MEDIUM 大部分一并修复，例如：
- 批准按钮写明批准的是哪一版方案；
- 含糊的回复当作修改意见；
- OAuth 回调只显示固定文字；
- 本地文件总共不超过 1 MB；
- CLI reviewer 超时不推送。

## 剩余问题

- **快速 bug 流程、停止和立项没有在真实环境走过**，见上表。
- **ZAA-6 仍占着一个进行中的名额**，需要时停掉。
- **ticket 里的旧面板链接**还指向 `127.0.0.1:4318`。已结束的 ticket 不会再同步，新 ticket 会用 tailnet 地址。
- 从 R4 带下来的问题仍然存在：
  - 没开 PR 的树不会被清理；
  - Codex 的轮数没有意义；
  - 手机端导航被截断。
