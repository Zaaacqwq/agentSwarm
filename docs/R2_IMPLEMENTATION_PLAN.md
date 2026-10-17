# R2 实施方案：子 Agent 与分支树（草案，待你确认）

> 依据：`PLAN.md` 第 5、6 节和第 14 节 R2，以及 R1 的实现。
> 第 9 节列出需要你确认的决定。

## 0. 目标与验收

**目标**：Agent 可以派生子 Agent。每个子 Agent 有自己的上下文、工作站和分支；完成后交回结构化结果；结果经过评审后合回父分支。最后由根 Agent 开一个到 `main` 的 PR，由你来合并。

**验收**（真实环境，模型用 qwen3.8-omni-flash，仓库用 `agentswarm-playground`）：
1. 给 lead 一个包含 3 个小功能的需求，例如新增 `sum`、`range` 和字符串工具（`capitalize` 加 `titleCase`）。
2. lead 派生 3 个 dev 子 Agent 并行开发；其中做字符串工具的 dev 再派生一个孙 Agent 去做 `titleCase`。
3. 每个子结果都先由 reviewer 子 Agent 评审，通过后合回父分支；被打回的由父 Agent 处理。
4. 全部合回 lead 的集成分支后，lead 开出到 `main` 的 PR，`npm test` 全部通过。
5. 面板上能看到整棵 Agent 树，以及每个节点的状态、费用和分支。
6. 层数、并发、预算的上限都有效；取消 lead 会连带取消整棵树。

---

## 1. 分支命名（和 PLAN.md 第 6 节不同，原因如下）

git 不允许同时存在 `swarm/p/feat` 和 `swarm/p/feat/login` 两个分支：前者是文件，后者需要同名目录。已经实测确认。所以改成**每棵树一个目录，所有节点放在同一层，用 `--` 表示层级**：

```
swarm/<项目>/<树>/root              ← 根（lead），集成分支，开 PR 到 main
swarm/<项目>/<树>/sum               ← 子
swarm/<项目>/<树>/strings           ← 子
swarm/<项目>/<树>/strings--title    ← 孙（strings 派生的）
```

- `<树>` 是根任务标题的缩写加 6 位随机数，例如 `utils-3fa21c`。
- 父子关系以数据库为准，分支名只用于人工阅读。
- R1 里不派生子 Agent 的单个任务，仍然用 `swarm/<项目>/<任务>` 两级的写法。两种写法都要满足同一个分支规则。

## 2. 数据模型（迁移 0001）

`runs` 表新增字段：

| 字段 | 说明 |
|---|---|
| `parent_run_id` | 父运行；根为空 |
| `tree_id` | 整棵树共用的编号，用于整树查询、取消和计数 |
| `depth` | 根是 0 |
| `base_branch` | 从哪个分支切出（根从默认分支切，子从父分支切） |
| `budget_usd` | 本节点自己的预算（派生时从父节点的剩余预算里划出） |
| `kind` | `task` 或 `review` |
| `review_of` | 评审运行所评审的那个运行 |
| `review` | 评审结论：`{approved, comments}` |
| `merged_at` | 什么时候合回了父分支 |
| `pr_url` | 根运行开出的 PR |
| `status` | 新增 `waiting`：在等子 Agent，不占工作站 |

`agents` 表新增 `ephemeral`：子 Agent 是一次性的，不出现在 Agent 列表里，只出现在树里。

## 3. 子 Agent 的工具

| 工具 | 谁能用 | 作用 |
|---|---|---|
| `spawn_agent({name, role, brief, budget_usd?, model?})` | 未到最大层数的 task 运行 | 派生子 Agent，立即返回它的编号和分支。`brief` 必须完整，子 Agent 看不到父 Agent 的上下文 |
| `wait_agents({ids?})` | 同上 | **结束本次执行并让出工作站**，进入 `waiting`。等指定的（默认全部未完成的）子 Agent 完成后，自动在原工作站恢复，并把子 Agent 的结果作为一条消息送进来 |
| `message_agent({id, text})` | 父 Agent | 给运行中的子 Agent 补充信息 |
| `cancel_agent({id})` | 父 Agent | 取消子 Agent 及其所有后代 |
| `review_agent({id})` | 父 Agent | 为已完成的子 Agent 派生一个 reviewer，然后同样进入等待 |
| `merge_agent({id})` | 父 Agent | 评审通过后，把子分支合并进自己的 worktree（在自己的沙箱里执行 `git merge --no-ff`）。有冲突就中止合并并列出冲突文件，由父 Agent 自己解决或再派一个子 Agent。合并成功后照常 `git_push` |
| `open_pull_request({title, body})` | 只有根运行 | 开一个从根分支到 `main` 的 PR。不提供合并工具 |
| `review_verdict({approved, comments})` | 只有 reviewer | 给出结论并结束评审 |

reviewer 的工具是只读的：`ws_list`、`ws_read`、`ws_grep`、`ws_bash`（跑测试用）和 `review_verdict`。它不能提交，也不能推送。它会得到 `git diff <父分支>...<子分支>` 的内容。

**结果约定**：子 Agent 的 `report` 增加 `recommendations` 字段。swarmd 会自动附上分支、提交列表和改动统计。父 Agent 只拿到这份结果，看不到子 Agent 的完整对话；完整对话在面板上看。

## 4. 等待与调度（为什么等待时要让出工作站）

如果父 Agent 一边等子 Agent，一边占着工作站，8 个工作站很快会被"等待中的父节点"占满，子 Agent 就永远排不上，形成死锁。所以：
- `wait_agents` 会结束父 Agent 当前这次执行，把状态改成 `waiting`，并释放工作站。父 Agent 的 worktree 留在原工作站上，不会删除。
- 等到它在等的子 Agent 全部进入终态（成功、失败或取消），swarmd 把这些结果合成一条消息，让父 Agent 回到原工作站继续运行（和 R1 里追加消息的机制相同）。
- 并发上限只计算正在运行的节点，`waiting` 的不算。

## 5. 上限（写在代码里，可以配置）

| 上限 | 默认值 | 超出时 |
|---|---|---|
| 层数 | 根加 3 层（depth ≤ 3） | 最深一层的节点拿不到派生工具 |
| 每棵树同时存在的未结束节点 | 12 | `spawn_agent` 返回错误，说明原因 |
| 全局同时运行 | 6（R1 已有） | 排队 |
| 根预算 | $2，创建任务时可以改 | 派生时从父节点的剩余预算里划出；子节点用完自己的预算后，作为失败结束并报告给父节点 |
| 单个节点的轮数和时长 | 40 轮、30 分钟（R1 已有） | 和 R1 相同 |

整棵树的总花费 = 所有节点的花费之和，在面板上显示。

## 6. 推送、评审与合并的流程

```
子 Agent：写代码 → 提交 → git_push（Relay 检查，推到 GitHub，不开 PR）→ report
父 Agent：review_agent → 等待 → 恢复，看结论
          通过 → merge_agent（在自己的 worktree 里合并）→ git_push
          打回 → message_agent 让子 Agent 修改（子 Agent 作为追加消息继续），或者自己修
根 Agent：全部合并后 → open_pull_request → 你在 GitHub 上合并
```

- Relay 判断"有没有新内容"时，改为和本节点的 `base_branch` 比较，不再和默认分支比较。
- 子 Agent 从父分支切出。如果父分支还没推送过，就从父节点的 `base_branch` 切出。
- 子分支在 GitHub 上可见，但不开 PR。全程只有根分支到 `main` 这一个 PR。

## 7. 面板

- 运行详情页增加**树**：每个节点显示名字、角色、状态（包括 waiting）、费用、分支、评审结论和是否已合并。点击节点进入它的时间线。
- 根运行显示整棵树的总花费，以及 PR 链接。
- Agent 列表只显示常驻 Agent（`ephemeral = false`）。
- "取消"按钮在根上会取消整棵树。

## 8. 测试计划

- **单元测试**：
  - 分支命名（层级编码、长度、碰撞）；
  - 预算划分；
  - 层数和每棵树的数量上限；
  - 等待集合的完成判断；
  - 把子结果组合成消息。
- **集成测试**：Pi 假模型的回复按"哪个 Agent 在请求"分别编排，不依赖调度顺序。覆盖：
  - lead 派生 2 个子 Agent → 等待 → 恢复 → 评审 → 合并 → 开 PR，用本地仓库模拟 GitHub 并接收 PR；
  - 孙 Agent；
  - 合并冲突，冲突文件交回父 Agent；
  - reviewer 打回；
  - 子 Agent 预算用尽；
  - 层数上限，最深一层拿不到派生工具；
  - 取消根节点会取消整棵树，并清理各节点的进程；
  - 8 个工作站被等待中的父节点"占满"时不会死锁（等待中的节点不占工作站）。
- **E2E**：运行页显示树、节点状态随事件更新、点击节点进入它的时间线。
- **真实模型验收**：第 0 节的场景。另外记录整棵树的总花费、用时和每个节点的轮数，写进 `docs/R2_ACCEPTANCE.md`。
- **代码审查**：用 code-reviewer agent 审查，HIGH 及以上必须修复。

## 9. 需要你确认的决定

1. **分支命名**：用 `swarm/<项目>/<树>/<节点>`，用 `--` 表示层级（第 1 节），以绕开 git 的限制。
2. **等待时让出工作站**：父 Agent 等待时释放工作站，结果出来后回到原工作站继续（第 4 节），以避免死锁。代价是父 Agent 每等一次，就结束一次执行再重新开始。
3. **评审**：用独立的 reviewer 子 Agent，工具只读，可以跑测试；只有评审通过才能合并；合并在父 Agent 自己的沙箱里执行。
4. **GitHub 上只开一个 PR**：子分支推到 GitHub 方便你查看，但不开 PR，只有根分支开 PR 到 `main`。
5. **默认上限**：层数 3、每棵树 12 个未结束节点、根预算 $2、全局并发 6。
6. **子 Agent 的模型**：默认沿用父 Agent 的端点和模型，`spawn_agent` 可以指定同一端点下的其他模型。
