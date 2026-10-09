# P4 实施方案：任务、分配与评审（已确认，2026-10-09）

基于 P3（PR #3）。对应 `HIVE_PLAN.md` 第 8 节与第 12 节 P4，并包含从 P3 推迟过来的「频道文件」。

**要做的**：任务实体与看板、`task_*` 工具、lead / dev / reviewer 角色模板、交接模板、PR 自动化与状态回写、任务频道、频道文件。

**不做**：Linear 同步（P6）、桌面与浏览器（P5）、Xcode（P8）、打断当前回合的判断（后期）。

## 0. 已确认的设计决定

1. **先批准、再指派**：Agent 创建的任务进入 `backlog`，等你在看板上点「批准」或拖到 `todo` 之后，lead 才能指派。你自己创建的任务直接进 `todo`。
2. **默认不设费用上限**：仍然记录每个任务花了多少，显示在看板和详情里。上限是可选字段，默认留空；你给某个任务填了上限，超出时该任务会被标为 `blocked` 并 @你。
3. **验收模型**：lead、dev、reviewer 全部用 `qwen/qwen3.8-omni-flash`。
4. **其余按默认**：
   - 只有人能合并 PR；
   - 每 2 分钟用 `gh` 轮询一次 PR 状态；
   - 附件单个不超过 10 MB，类型限白名单。

## 1. 任务模型

- **状态**：`backlog → todo → in_progress → in_review → done`，另有 `blocked`。状态变化由服务端控制。
- **字段**：
  - 编号 `T-<n>`（组织内递增）、标题、描述、验收标准（列表）；
  - 负责人（一个 Agent）、reviewer（一个 Agent，可选）、依赖（其他任务）；
  - 仓库、分支、worktree、PR 链接与状态、已花费、可选的费用上限（默认为空）；
  - 创建者、任务频道。
- **分支归任务，不归 Agent**：`hive/t<n>/<slug>`。交接时接手方在自己的工作站检出同一分支继续做，不需要改名。Git Relay 的放行规则相应改为「当前负责人才能推这个任务的分支」。没绑任务的分支（`hive/<agent>/<slug>`）仍按 P2 规则走。
- **依赖**：依赖还没 `done` 时，任务不能进入 `in_progress`。dev 调用 `task_start` 时会被拒绝，并告诉它是哪些任务挡着。
- **每个任务一个任务频道**：
  - 频道类型 `task`。成员是你、负责人、reviewer 和创建它的 lead，增删人随任务变化。
  - 讨论、交接、评审结论都在这里，界面上和群聊一样。
  - 唤醒规则沿用群聊：被 @ 才会唤醒。另外，指派、交接、打回会以系统消息的形式唤醒对应的人。

## 2. 工具（`core.tasks`）

| 工具 | 谁用 | 说明 |
|---|---|---|
| `task_list(status?, mine?)`、`task_get(id)` | 所有 | 只读。`task_get` 返回描述、验收标准、依赖、分支、PR、交接记录、费用 |
| `task_create(title, description, acceptance[], depends_on?, repo?)` | lead | 新任务进 `backlog`，等待人批准 |
| `task_assign(id, agent, reviewer?)` | lead | 只能指派状态为 `todo` 的任务。会唤醒负责人 |
| `task_start(id)` | dev（负责人） | 检查依赖 → 建立或恢复该任务的 worktree，并设为当前 worktree → 状态改为 `in_progress` |
| `task_update(id, status?, note?)` | 负责人 / lead | 只允许合理的状态转移。例如 dev 不能直接把任务标成 `done` |
| `task_comment(id, body)` | 所有 | 发到任务频道 |
| `task_handoff(id, to_agent, notes)` | 负责人 / lead | 先校验交接模板的六个小节，再把当前进度作为 WIP 推上去（经 Relay），然后改派并唤醒接手方 |
| `task_review(id, decision, notes)` | reviewer | 通过：@你「可以合并」。打回：状态回到 `in_progress` 并 @负责人 |
| `pr_view(id)` | reviewer / dev | 通过 `gh` 读取 PR 的文件列表、diff（截断）和检查状态 |
| `pr_comment(id, body)` | reviewer | 经 Relay 在 PR 上评论 |
| `attach_file(channel_id, path)` | 有工作站的 Agent | 把 worktree 里的文件附加到频道 |

- `pr_create` 在任务分支上调用时，会自动把 PR 绑到该任务，状态改为 `in_review`，并在任务频道 @reviewer。
- **交接模板**：六个小节都必须写，缺一个就拒绝，并告诉 Agent 缺了哪个。
  - 背景
  - 已完成
  - 未完成与下一步
  - 分支与状态
  - 如何验证
  - 注意事项

## 3. 角色模板

创建 Agent 时可以选一个模板，模板会预填工具授权和一段说明。之后仍然可以逐项修改。

| 模板 | 预填授权 | 默认说明（摘要） |
|---|---|---|
| lead | 沟通、同事、任务（创建 / 指派 / 交接 / 评论） | 只拆解、指派、跟进、汇报，不写代码。拆完后在群里列出方案并 @人 确认 |
| dev | 沟通、同事、任务（读 / start / update / 评论 / 交接）、工作站 | 用 `task_start` 开工，跑测试后推送并 `pr_create`。卡住时及时说明 |
| reviewer | 沟通、同事、任务（读 / 评论 / review）、`pr_view` / `pr_comment` | 对照验收标准审查，不写代码 |
| operator | 沟通（P5 再加桌面和浏览器） | 默认不启用 |

工具权限按工具逐个授权，所以「dev 只能更新自己的任务」这类限制，放在工具执行时检查：调用者是否为负责人，或者是 lead。

## 4. PR 自动化与状态回写

- 每 2 分钟用 `gh pr view` 查一次处于 `in_review` 状态的任务的 PR：
  - **已合并** → 任务 `done`，清理 worktree，在任务频道发通知；
  - **被关闭但没合并** → 任务回到 `in_progress`，并 @负责人；
  - **CI 检查失败** → 在任务频道 @负责人。
- **费用**：任务频道里的消息唤醒的回合，费用都计入这个任务。默认没有上限；只有你给任务设了上限，超出后才会把它标为 `blocked` 并 @人，在你提高上限或改派之前不再唤醒负责人。

## 5. 频道文件（从 P3 推迟）

- 存放在 `/Volumes/HiveWS/hived/files/<sha256>`，同样内容只存一份。
- 校验：单个文件 ≤ 10 MB；MIME 类型限白名单；文件名会规范化；下载时强制 `Content-Disposition: attachment`。不渲染 HTML 或 SVG。
- 上传方式：
  - 人在输入框旁点上传按钮，附件跟消息一起发；
  - Agent 用 `attach_file` 从自己的 worktree 读取文件，经 hive-exec 读出，大小同样限制。
- 频道有「文件」抽屉。图片显示缩略图，文本可以预览。
- 权限跟频道走：能读这个频道，才能下载它的文件。

## 6. 数据库变更（迁移 0003）

- `tasks`：`id, org_id, number, title, description, acceptance (json), status, assignee_agent_id, reviewer_agent_id, created_by_kind, created_by_id, repository_id, branch, channel_id, pr_url, pr_state, budget_usd, spent_usd, approved_at, created_at, updated_at`
- `task_dependencies`：`task_id, depends_on_task_id`
- `task_events`：状态变更、指派、交接（含交接说明）、评审结论，作为任务的完整历史。
- `attachments`：`id, channel_id, message_id, uploader_kind, uploader_id, filename, mime, size, sha256, created_at`
- `channels.kind` 增加 `task`。需要重建表，沿用 0002 那套已经验证过的做法：在迁移事务之外关闭外键。
- `runs` 增加 `task_id`，用于把费用计入任务。

## 7. 前端

- **Tasks 页（看板）**：
  - 六列，可以拖拽改变状态，按服务端规则校验；
  - 卡片显示编号、标题、负责人头像、PR 状态、已花费（设了上限时也显示上限）、依赖标记；
  - `backlog` 列里由 Agent 提议的任务带「批准」按钮。
- **任务详情抽屉**：
  - 描述和验收标准（可编辑）、依赖；
  - 负责人和 reviewer（可改派）、费用上限；
  - 嵌入的任务频道对话；
  - 交接和评审时间线；
  - PR 链接与状态。
- **新建任务表单**：人也能直接建任务。人建的任务直接进 `todo`。
- **Agent 编辑页**：新增角色模板选择。
- **聊天**：输入框可以带附件，频道有文件抽屉。
- **⌘K 搜索**：增加任务结果。

## 8. 测试计划

1. **单元测试**：
   - 状态机：合法 / 非法的转移，以及谁可以做哪种转移；
   - 依赖阻挡；交接模板校验；
   - 费用计入，以及设了上限时的超限阻断；
   - 编号递增；PR 状态映射；
   - 附件的类型、大小、文件名和去重。
2. **权限测试**：
   - dev 不能指派、不能把任务标为 `done`；
   - 非负责人不能 `task_start`，也不能推送任务分支；
   - reviewer 不能写 worktree；
   - 下载附件需要频道读权限。
3. **集成测试**（ScriptedRuntime + 本地工作站后端）完整走一遍：
   lead 拆成 3 个任务 → 人批准 → 指派给两个 dev → 并行 start / 改代码 / push / PR → reviewer 打回一次后通过 → 模拟 PR 合并 → 任务 `done`、worktree 被清理。
   中途做一次交接：dev-1 推送 WIP，dev-2 在自己的工作站检出同一分支并完成。
4. **E2E**：
   - 看板拖拽和批准；
   - 任务详情和任务频道；
   - 上传并下载附件；
   - 选择角色模板建 Agent。
5. **验收**（plan 第 12 节，真实模型）：
   - 在 hive-sandbox 里提出一个含 3 个小功能的需求给 lead；
   - lead 拆解后，你（脚本扮演）批准；
   - 2 个 dev 在 `ws-1`、`ws-2` 上并行完成并开 PR，reviewer 评审；
   - 中途把一个任务从 dev-1 交接给 dev-2，dev-2 接着完成；
   - 最后关闭所有 PR。
