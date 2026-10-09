# P5 实施方案：桌面与浏览器（已确认，2026-10-09）

本阶段基于 P4（PR #4），对应 `HIVE_PLAN.md` 第 7 节和第 12 节的 P5，内容如下：

- `browser` 和 `desktop` 两个工具包；
- 审批机制（`ask_human`，以及危险操作的审批卡片）；
- 截图缩放和图片池；
- 前端的桌面标签和审批界面；
- 从 P4 推迟过来的二进制文件附件。

不做：Xcode 与模拟器（P8）、实时屏幕串流（VNC），以及多用户（P6）。

## 0. 已确认的设计决定

1. **控制你的桌面，但必须经你批准。** macOS 只能截取和操作当前在屏幕前登录的用户（zaaac）的图形会话。
   - Agent 只能在你批准的「控制会话」期间截图和点击，会话默认 15 分钟，到期自动收回。
   - 系统设置、钥匙串访问、终端、密码管理器和 Hive 自己的界面，任何时候都不允许操作。
   - 界面上实时显示屏幕画面，并提供停止按钮。
2. **浏览器以工作站用户身份运行。** 每个 Agent 的浏览器是一个无头 Chrome，跑在它所绑定的 `ws-n` 用户下，和 dev 一样隔离：读不到你的文件，也碰不到你自己的 Chrome 数据。这需要你再执行一次 `sudo zsh scripts/setup-workstations.sh --update-exec`。
3. **审批按会话计算。** 批准一次，在约定时间内都有效。例如：
   - 「控制桌面 15 分钟」；
   - 「在 example.com 上提交表单 30 分钟」。

## 1. 审批（通用）

- **`ask_human(question, options?, kind?)`**：在当前频道发出一张审批卡片（带按钮），工具调用一直阻塞，直到你回复、超时或回合被停止。卡片同时出现在 Dashboard 顶部。
- **危险操作**不由 Agent 自己判断，由服务端强制要求审批：
  - 开始一个桌面控制会话；
  - 在浏览器里提交表单或填写密码框；
  - 访问某个站点的写操作。
- **审批记录**：存审批人、结论、有效期，全部写入审计日志。
- **复用 plan 第 10 节中已有的审批项**：force push、更新快照基准，以及删除工作区以外的文件。目前这些操作对 Agent 根本不开放，不需要额外处理。

## 2. 浏览器工具包（`browser`）

| 工具 | 类别 | 说明 |
|---|---|---|
| `browser_open(url)` | claim | 打开页面。只允许 http(s)；本机和内网地址会被拒绝 |
| `browser_snapshot()` | r | 返回页面的无障碍树（文字 + 元素编号），优先用它，不靠截图 |
| `browser_click(ref)`、`browser_type(ref, text)`、`browser_select(ref, value)` | claim | 用快照里的元素编号操作页面 |
| `browser_screenshot(full?)` | r | 截图，缩放到 1280 宽后作为图片返回给模型，同时存进图片池 |
| `browser_back()`、`browser_tabs()` | r / claim | 后退、列出标签页 |

- 浏览器跑在 Agent 绑定的工作站用户下：hive-exec 在工作站目录里启动一个无头 Chrome 守护进程，hived 通过 hive-exec 向它转发命令。Chrome 用 `--remote-debugging-pipe` 通信，不开放调试端口，其他用户无法连接。
- 每个 Agent 有独立的浏览器资料目录，放在它的工作站目录里。资料在多次回合之间保留（例如登录状态），人可以在界面上清空。
- **默认只读**。遇到「提交表单、填写密码框、新站点上的写操作」时，需要一个对应站点的有效审批，否则工具返回「需要审批」，并提示 Agent 调用 `ask_human`。
- 不处理下载和文件选择框，也不使用你的 Cookie 或已保存的密码。

## 3. 桌面工具包（`desktop`）

- **`hive-desktop` 助手**：一个固定路径、ad-hoc 签名的 Swift 程序，以 LaunchAgent 的形式运行在你的图形会话里，通过 hived 数据目录下的 Unix socket（0600）提供服务。
- **TCC 权限**：屏幕录制和辅助功能只授予这个助手，由你在系统设置里手动打开一次，界面会给出引导。注意：助手每次重新编译都要重新授权（ad-hoc 签名的特性），所以它的代码会尽量保持稳定。
- **工具**：

  | 工具 | 类别 | 说明 |
  |---|---|---|
  | `desktop_screenshot(display?)` | r | 缩放到 1280 宽，带坐标网格提示 |
  | `desktop_click(x, y, button?)`、`desktop_type(text)`、`desktop_key(combo)`、`desktop_scroll(dx, dy)` | claim | 用 CGEvent 实现，不依赖 cliclick |
  | `desktop_ui(app?)` | r | 读取前台应用的辅助功能树，优先按元素操作，不靠像素 |
  | `desktop_acquire` / `desktop_release` | claim | 申请或释放桌面控制会话 |

- **租约**：同一时刻只有一个 Agent 持有桌面。持有需要一个有效的审批会话，到期自动释放。
- **禁区**：系统设置、钥匙串访问、终端、密码管理器，以及 hived 自己的界面。点击或输入落在这些应用上时直接拒绝，前台应用由助手判断。

## 4. 图片池与附件

- 截图存进 `hived/files`，复用 P4 的内容寻址存储。活动检查器里能看到每一张截图，总量有上限（默认 2 GB，超出后先删最旧的）。
- 返回给模型的图片固定为 1280 宽的 JPEG，以控制 token 用量。
- **二进制附件**：hive-exec 增加 `fs.readBinary`，让 `attach_file` 也能附加图片和 PDF。这需要你执行一次 `--update-exec`。

## 5. 数据库变更（迁移 0005）

- `approvals`：`id, org_id, agent_id, run_id, channel_id, message_id, kind, scope, question, options (json), status, decided_by, decided_at, expires_at, created_at`
- `browser_profiles`：`agent_id, path, created_at, last_used_at`
- `leases.kind` 增加 `desktop`。这一列没有 CHECK 约束，所以不需要重建表。
- `attachments` 增加 `source`，取值为 `upload` 或 `screenshot`。

## 6. 前端

- **审批卡片**：在聊天里显示问题、按钮（批准 / 拒绝 / 选项）和倒计时，Dashboard 顶部显示待处理的审批。
- **Workstations → Desktop 标签**：
  - 当前截图（可见时每 2 秒刷新一次）；
  - 持有者、会话剩余时间、立即收回按钮；
  - 未授权时显示 TCC 授权引导。
- **Agent 页**：可以查看和清空该 Agent 的浏览器资料，并显示它的站点审批。

## 7. 测试计划

1. **单元测试**：
   - URL 过滤（scheme、本机、内网、DNS 解析后的地址）；
   - 审批的有效期和作用域匹配；
   - 桌面禁区判断；截图缩放；图片池清理。
2. **浏览器集成测试**：本地起一个测试网站（含表单和登录页），覆盖打开、快照、点击、输入、截图。
   - 没有审批时提交表单会被拒绝；
   - 拿到审批后可以提交；
   - 访问 file:// 和 127.0.0.1 会被拒绝。
3. **桌面测试**：
   - 助手协议用模拟的 socket 测试；
   - 在本机实测截图、点击 TextEdit、读取辅助功能树（需要你先完成 TCC 授权）；
   - 确认会话到期后操作被拒绝，禁区应用无法操作。
4. **E2E**：审批卡片的批准和拒绝、Desktop 标签、Agent 浏览器截图出现在活动检查器里。
5. **验收**（plan 第 12 节）：
   - 一个 operator Agent 在一个网页后台完成只读或低风险的任务，并附截图汇报；
   - 触发危险操作时，正确请求审批；
   - 同时另一个 dev 在工作站上跑终端任务，不受影响。
