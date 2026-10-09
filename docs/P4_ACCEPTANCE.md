# P4 验收记录（2026-10-09）

| 验收项（plan 第 12 节） | 结果 | 依据 |
|---|---|---|
| lead 拆解含 3 个子功能的需求，你确认后再指派 | 通过 | lead 建了 3 个任务，都停在 backlog，批准后才能指派。批准之前 lead 尝试指派，被拒绝 |
| 2 个 dev 并行完成并提 PR | 通过 | DevA（`ws-1`）和 DevB（`ws-2`）同时开发，开出 PR #28–30 |
| reviewer 评审 | 通过 | T-1 先被要求修改，dev 修改后重新提交评审并获批；T-2、T-3 一次通过；每个 PR 上都有 reviewer 的评论 |
| 中途把任务从一个 dev 交接给另一个 dev，对方接着完成 | 通过 | 见下面的专项交接验收 |

## 真实模型验收（qwen3.8-omni-flash，lead / dev / reviewer 都用它）

**主流程**（脚本 `evals/runner/p4-acceptance.ts`，花费 $0.195）：
1. 向 lead 提出 clamp、capitalize、sum 三个小功能。lead 拆成 T-1 到 T-3，都带验收标准。
2. 脚本代替你批准后，lead 把 T-1、T-3 指派给 DevA，T-2 指派给 DevB，reviewer 都是 Rev。
3. 两个 dev 分别在自己的工作站执行 `task_start`、写代码、跑测试、推送、`pr_create`。任务自动进入 in_review，同时唤醒 reviewer。
4. reviewer 用 `pr_view` 读 diff、在 PR 上评论，再用 `task_review` 给出结论。T-1 被打回一次，修改后通过。
5. T-2 的交接在 DevB 已开出 PR 之后才发生，没能验证「中途」交接，所以另外做了一次专项验收。

**专项交接**（脚本 `evals/runner/p4-handoff.ts`，花费 $0.017）：
- 任务 T-4 有两部分：`mean` 和 `median`。指示 HandB 只做第一部分，然后交接给 HandA。
- HandB 写完 `mean`，用六个小节的说明交接，WIP 经 Relay 推送到 `hive/t4/stats-helpers-i14`。
- HandA 在另一台工作站执行 `task_start`，检出同一个分支，补上 `median`，开出 PR #31。
- 评测脚本自己克隆该分支核对：两个函数都在，`bun test test/stats.test.ts` 通过。
- 任务历史：created → started → handoff → started → pr_opened。

两个脚本开的 PR 都已关闭，分支也已删除。`hive-sandbox` 没有遗留的 PR 或 `hive/*` 分支。

## 测试

- `bun run test`：115 项通过。覆盖：
  - 状态机；交接模板校验；依赖阻挡与解除后唤醒；
  - 预算记账与超限阻断；
  - lead / dev / reviewer 的权限边界；
  - 完整的任务流程：批准、并行、评审、依赖、交接、合并、关闭；
  - 附件：类型嗅探、大小上限、绑定规则、下载头、跨用户访问；
  - 迁移不丢数据；代码审查后的回归测试。
- `bun run test:e2e`：4 项通过。覆盖：
  - 用角色模板建 lead；lead 提议的任务在看板上被批准；
  - 新建任务、任务抽屉；
  - 上传和下载附件；
  - 在看板上拖拽改变状态。
- 真实数据库：迁移前备份了 `hive.db`，0003 和 0004 已在 HiveWS 上应用。

## 开发中发现并修复的问题

- 交接模板校验把只有标题、内容为空的小节也算作通过。已修复，并补了测试。
- 一个任务完成后，依赖它的任务不会被唤醒。已补上「依赖解除后唤醒负责人」。
- reviewer 打回、dev 修改后，没有人通知 reviewer 重新评审。已补上通知。
- 代码审查发现 3 个 HIGH，均已修复并补了回归测试：
  - 交接可以绕过状态机，让 backlog 或 done 的任务重新活过来；
  - 名叫「T5」之类的 Agent 的分支会和任务分支撞名，从而绕过 Relay 的负责人检查；
  - 被预算阻断的任务，Agent 可以自己解除。
- 代码审查的 MEDIUM / LOW 也都已修复：
  - 交接时 WIP 推送失败会被吞掉；任务改名后会用新分支名；
  - 成本没有记到回合实际开始的任务上；
  - `update` 在失败前就已写入部分数据；
  - 任务抽屉保存时会覆盖其他人刚做的修改；
  - 上传没有配额，也不清理未用的上传；
  - 任何 Agent 都能用 `pr_view` 看任意任务的 PR；
  - PR 轮询可能同时跑两次；
  - 删除任务后编号会被复用（新增迁移 0004：每个组织一个计数器）；
  - 删除任务没有清理频道，也没有通知前端；
  - 非法的 `X-Filename` 请求头会导致 500；文件写入不是原子的；
  - 手动标记为 done 时会删掉还没推送的 worktree。

## 未覆盖 / 留到后续

- Agent 用 `attach_file` 只能附加文本文件。附加二进制文件（例如截图）需要更新 hive-exec，放到 P5 一起做。
- PR 状态靠每 2 分钟轮询一次。没有公网，所以不使用 webhook。
- 合并只能由人来做，没有提供给 Agent 的合并工具。
