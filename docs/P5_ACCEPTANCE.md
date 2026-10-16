# P5 验收记录（2026-10-16）

| 验收项（plan 第 12 节） | 结果 | 依据 |
|---|---|---|
| operator 在网页后台完成低风险任务，附截图汇报 | 通过 | Operator 在 the-internet.herokuapp.com 用页面上公开的演示账号登录，进入 Secure Area，截图并发回频道 |
| 触发危险操作时正确请求审批 | 通过 | 往密码框输入前发起了 `browser_site` 审批（the-internet.herokuapp.com），批准后才继续 |
| 同时另一个 dev 的终端任务不受影响 | 通过 | Dev 在 `ws-2` 上检出 `hive-sandbox` 并跑 `bun test`，与 Operator 同时进行，两个回合都成功 |

## 真实模型验收（qwen3.8-omni-flash）

脚本 `evals/runner/p5-acceptance.ts`，总用时 36 秒，花费 $0.0062（Operator $0.0040，Dev $0.0022）。

1. 在 `ws-1` 上新建 Operator，在 `ws-2` 上新建 Dev，两边同时开始。
2. Operator 打开登录页，读到页面上印着的演示账号，往密码框输入前调用审批。脚本代替人批准，范围是该站点、有时间窗。
3. Operator 登录后到达 `/secure`，用 `browser_screenshot`（`post_to`）把截图发进频道，并汇报页面内容。脚本核对：到达 Secure Area，截图 1 张、发出 1 张，只请求过这一次审批。
4. Dev 报告 `bun test` 为 0 通过、8 失败。`hive-sandbox` 是评测夹具，每个模块故意埋了一个 bug，本地跑结果相同，所以这是如实汇报，不是环境问题。

验收的运行方式：
- 原来的管理员密码文件已不在 scratchpad 中，hived 也没有重置密码的入口。为了不改真实数据库里的登录凭据，验收用的是 `hive.db` 的副本：在副本里设了新密码，在 4320 端口起了一个 hived。验收期间停掉了空闲的 4319。
- 跑完后：删除了副本和临时密码，删掉了 `ws-2` 上的验收 worktree，重置了 Operator 的浏览器配置文件。`hive-sandbox` 远端只有 `main`，没有打开的 PR。
- 4319 已用新代码在真实数据上重新启动。

## 本机桌面实测

- Hive Desktop 以 LaunchAgent 运行，socket 位于 `~/Library/Application Support/Hive/desktop.sock`。
- 屏幕录制已授权，截图返回 1280×720 的 JPEG，带网格。
- 没有获批会话时，`click` 和 `ui` 都返回 `denied`。
- **辅助功能尚未授权**。因此点击 TextEdit 和读取辅助功能树的实测还没做，会控制你的真实屏幕，等你授权并在界面上亲自批准会话后再做。这一部分已由协议测试覆盖：用模拟 socket 测试会话到期、停止锁存、过期会话令牌。

## 测试

- `bun run test`：133 项通过。覆盖：
  - URL 和地址拦截：IPv4、IPv6 各种内嵌形式，包括带方括号的写法；
  - 伪造或过期的审批；WebSocket 拦截；写操作只在审批过的站点上放行；
  - Agent 的沙箱读不到浏览器状态目录；并发首次调用只启动一个浏览器；
  - 审批的生命周期、频率限制、拒绝后的冷却期；
  - 桌面停止锁存；过期的 disarm；截图池上限；
  - 只把最新 2 张图放进上下文；模型目录查询失败时的缓存；
  - hive-exec 从系统用户库取用户，不读 `$HOME` 和 `$USER`。
- `bun run test:e2e`：5 项通过，其中 P5 新增 1 项。覆盖：
  - 用 Operator 模板创建 Agent，浏览器资料面板显示"未使用"；
  - `ask_human` 的提问卡片在聊天里批准；从顶部横幅拒绝时，聊天里的卡片同步更新；
  - This Mac 页面在没装助手时给出安装提示。
  - 活动检查器里的截图缩略图没有 E2E 覆盖，只有路由和权限的集成测试。
- `bun scripts/check-workstations.ts`：重新运行 `--update-exec` 后 24/24 通过。
  - 包括：Chrome 以 `ws-1` 身份运行；能打开 IPv6 网站并读取页面结构；拒绝本机地址；Agent 的 shell 读不到浏览器状态。
  - 第一次只有 22/24，原因是 IPv6 地址判定问题（见下文）。
  - 另外 example.com 改版后正文里没有了 "Example Domain"，所以 snapshot 检查改为核对正文内容和元素编号。
  - `ws-2` 补测：sudo 时保留调用者的 HOME，仍然能打开 example.com。
- 真实数据库：迁移前已备份为 `hive-backup-p4-202610091352.db`，0005 已在 HiveWS 上执行。

## 开发中发现并修复的问题

- **Bun 1.3.0 启动崩溃**：Bun 在 socket 的 close 回调之后才真正关闭文件描述符，紧接着的 `Bun.spawn` 会复用这个编号，然后被迟到的关闭操作关掉。现在 socket 调用要等关闭完成、再过一个宏任务才返回。
- **浏览器无法以 `ws-N` 启动**：Bun 的 `os.userInfo()` 读的是 `$HOME` 和 `$USER`，而 macOS 的 sudo 会保留调用者的 HOME。安装脚本自检时，浏览器拿到的是你的家目录，Chrome 因此退出。hive-exec 改为用 `id -P` 按 uid 查用户；sudo 调用也加上了 `-H`。hived 本身调用时环境里没有 HOME，不受影响。
- **IPv6 网站全部被关掉**：Chrome 报告的服务器地址写成 `[2606:…]` 这种带方括号的形式，判定函数解析失败后按拒绝处理。已修复并补了测试。
- **代码审查**：0 个 CRITICAL、3 个 HIGH，都已修复：
  - Agent 的 shell 能伪造审批、读浏览器 cookie。现在浏览器状态放在 `/Volumes/HiveWS/browser/<ws-user>`，Agent 沙箱拒绝访问这个目录；浏览器 daemon 有自己的沙箱配置；审批改为带到期时间的 `{host, until}`。
  - 你按停止后，Agent 能借旧审批重新拿到桌面。现在助手会锁存"已被用户停止"，直到 hived 撤销所有桌面审批并确认后才能重新启用；会话令牌也不能再重复使用。
  - 内网拦截能被绕过（SSRF）。现在会检查响应的实际服务器地址；WebSocket 只允许连到审批过的公网主机；禁用了 Service Worker；补上了 NAT64、6to4、198.18/15 等地址段。
- **代码审查的 MEDIUM 和 LOW** 大部分已修复：
  - 写操作要求目标站点和发起页面所在站点都经过审批；
  - 每个 Agent 的浏览器请求排队执行，启动时加锁；
  - 桌面禁区扩大到脚本工具、启动器、"强制退出"等快捷键，以及指向本机地址的浏览器页面；
  - 截图路由只对管理员开放；
  - 审批每小时最多 20 次请求，被拒绝后 10 分钟内不再重复询问；
  - Swift 助手并发处理连接，会改变状态的命令串行执行。

## 与计划不同之处

- 截图单独建了 `screenshots` 表，没有用 `attachments.source`。截图不属于任何频道，套用附件的绑定规则不合适。发到频道里的截图仍然是普通附件。
- 桌面助手的 socket 放在 `~/Library/Application Support/Hive/`，不在 hived 的数据目录里。`/Volumes/HiveWS` 是外置卷，要访问它还得额外申请 macOS 的"可移除宗卷"权限。
- Chrome 自带的沙箱已关闭，因为它不能嵌套在 `sandbox-exec` 里面。隔离改由 `ws-N` 用户身份加上 daemon 的 seatbelt 配置来保证。

## 剩余风险

- 只读浏览仍可以通过 GET 请求把数据带出去（例如把内容拼进 URL 访问）。写操作和表单提交需要审批，GET 不需要。
- 同一个 `ws-N` 用户下的进程理论上可以互相检查，例如调试 Chrome。现在靠 Agent 沙箱挡住了浏览器状态目录，但两者没有做到 uid 级别的隔离。
- DNS rebinding 只是部分缓解：有 30 秒的判定缓存，加上对响应服务器地址的事后检查。

## 待你操作

1. 在 系统设置 → 隐私与安全性 → 辅助功能 中打开 Hive Desktop，然后运行 `zsh scripts/install-desktop-helper.sh`。之后可以做桌面实测：截图、读取 TextEdit 的辅助功能树、点击。
