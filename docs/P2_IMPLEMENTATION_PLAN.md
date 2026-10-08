# P2 实施方案：通用工作站与编码闭环（待确认）

本阶段基于 P1（PR #1）。工作站放在外置盘的专用卷 `/Volumes/HiveWS` 上，决策见 `docs/decisions/0004-workstation-macos-user.md`。

**交付内容：**
- 工作站：独立的 macOS 用户。
- `core.workstation` 工具包：文件、终端、git。
- Git Relay，可推分支并开 PR。
- 通用租约机制和内存压力保护。
- Workstations 页面。
- 评测夹具和第一版评测集。

**不做**：Xcode、模拟器、桌面、群聊、任务看板（P3 以后）。

## 0. 需要你执行或确认的事

1. **一次性管理员操作。** 由你执行 `sudo zsh scripts/setup-workstations.sh 2`，它会：
   - 创建组 `hive-ws` 和用户 `ws-1`、`ws-2`：标准账户，不在登录界面显示，不能用密码登录，主组是 `hive-ws`。
   - 建立 `/Volumes/HiveWS/ws/ws-n`（属主为该工作站用户，0700）和 `/Volumes/HiveWS/hived`（属主 zaaac，0700）。
   - 安装 `/usr/local/libexec/hive/hive-exec`，属主 root:wheel，权限 0755。
   - 写入 `/etc/sudoers.d/hive`，内容为 `zaaac ALL=(%hive-ws) NOPASSWD: /usr/local/libexec/hive/hive-exec`。写入前先用 `visudo -c` 校验。

   脚本带 `--uninstall` 选项。以后要加工作站，就再跑一次脚本。
2. **清理 P0 测试用户 `ws-hive-p0`。** 用同一个脚本的 `--remove-p0` 选项。
3. **评测仓库。** 验收要推分支、开 PR，需要一个 GitHub 仓库 `Zaaacqwq/hive-sandbox`（建议设为 private）。由我用你现在的 `gh` 登录来创建，还是你自己建？
4. **评测费用。** 8 题 × 3 次，用 `qwen/qwen3.8-omni-flash` 粗估不到 $1；换更强的模型会贵几倍。建议整轮设上限 $5。
5. **hived 数据目录。** 默认改到 `/Volumes/HiveWS/hived`。启动时检查该卷为 `Owners: Enabled` 且没有以 `noowners` 挂载，不满足就拒绝启动。P1 的 `.hive-data/` 里还没有正式数据，直接弃用。

## 1. 文件结构

```text
packages/priv-helper/            # hive-exec：Bun 编译成单个可执行文件，属主 root
  src/main.ts                    # 从 stdin 读 JSON 请求，按 op 分发；不接受拼接好的 shell 字符串
  src/ops/{fs,bash,tmux,git}.ts  # 所有路径先 realpath，必须落在工作站根目录内
  src/sandbox.ts                 # 生成 sandbox-exec 配置：拒绝 /Volumes/Data、其他家目录、hived 数据目录、其他工作站
  test/                          # 路径越界、符号链接逃逸、超时、输出截断
apps/hived/src/
  workstations/                  # WorkstationBackend 接口
                                 #   macos-user 实现：sudo -n -u ws-n hive-exec
                                 #   local-fake 实现：仅用于测试
                                 #   以及工作站服务和路由
  leases/                        # 通用租约，到期自动回收：
                                 #   workstation-write（同一时刻一个写入者）
                                 #   heavy-task（全局槽位）
  repos/                         # 仓库登记、本机 bare 镜像（对 hive-ws 组只读）、worktree 生命周期
  git-relay/                     # 校验后推送到 GitHub，并通过 gh 创建 PR
  host/                          # 采样 memory_pressure、swap、磁盘；到 warn 级别就暂停派发新的重任务
packages/tools/src/workstation/  # core.workstation 工具包
apps/web/src/pages/workstations/ # 工作站网格卡片、终端查看（xterm.js）、文件浏览、租约、主机状态横幅
evals/hive-sandbox/              # TypeScript 示例项目，预埋 8 个问题，每题有对应的 bun test
evals/runner/                    # 每题跑 N 次，输出成功率、耗时、轮数、token、费用报告
scripts/setup-workstations.sh    # 一次性管理员脚本（见 0.1）
```

## 2. 工具包 `core.workstation`

| 工具 | 类别 | 说明 |
|---|---|---|
| `ws_list`、`ws_read`、`ws_grep` | r | 只能访问当前 worktree；输出会截断，完整内容写到文件并返回路径 |
| `ws_write`、`ws_edit` | claim | 需要持有该工作站的 `workstation-write` 租约；第一次写入时自动领取 |
| `ws_bash` | claim | 同步执行，超时默认 120s、最长 600s；输出只保留尾部；允许联网 |
| `term_create` / `term_send` / `term_read` / `term_kill` | claim | 每个工作站用户一个 tmux 服务；断开后会话继续运行 |
| `git_status`、`git_commit` | w | 在 worktree 内执行 |
| `git_push` | w | 走 Git Relay：分支名必须是 `hive/<agent>/<slug>`，禁止 force，限制大小，并做简单的密钥扫描 |
| `pr_create` | w | Relay 用 `gh` 创建 PR；合并只能由人来做 |

工具执行时会再检查一遍授权、工作站绑定和租约。`hive-exec` 的每个 op 还会校验路径和超时，这是第三道检查。

## 3. 数据库变更（新迁移 0001）

- `workstations`：`id, org_id, owner_user_id, name, kind('macos-user'|'local-fake'), os_user, root_path, network_allowed(默认 1), status, created_at, updated_at`
- `agent_workstations`：`agent_id, workstation_id`。多对多。绑定后即可读，写入还需要租约。
- `repositories`：`id, org_id, name, github_full_name, default_branch, mirror_path, created_at`
- `worktrees`：`id, workstation_id, repository_id, agent_id, path, branch, created_at, removed_at`
- `leases`：`id, kind, resource_id, holder_agent_id, run_id, acquired_at, expires_at, released_at`。用部分唯一索引保证同一 `kind + resource_id` 只有一条未释放的租约。
- `git_pushes`：`id, worktree_id, agent_id, branch, head_sha, status('accepted'|'rejected'|'pushed'|'failed'), reason, pr_url, created_at`。用于审计，只记字段，不记密钥。

## 4. 测试计划

1. **单元测试**（不依赖 macOS 用户，CI 可跑）：
   - 租约：互斥、过期回收、Run 结束时自动释放。
   - Relay 校验：分支名、非快进推送、大小、密钥模式。
   - 工具授权和租约检查。
   - 在 `local-fake` 后端上跑通完整的编码流程。
2. **hive-exec 测试**：`../`、绝对路径、指向根目录外的符号链接、超长输出、超时、非法 op 都要被拒绝。
3. **本机集成测试**（在 mini 上运行，用开关控制）：
   - 以 `ws-1` 身份执行时，读不到 `/Users/zaaac` 下的文件、`/Volumes/HiveWS/hived`、`/Volumes/Data`、`ws-2` 的工作站目录。
   - 能联网。
   - hived 重启后 tmux 会话仍在。
4. **E2E**：Workstations 页面能显示工作站、终端输出和租约状态。
5. **验收**（计划第 12 节）：在聊天里对 dev Agent 说「`hive-sandbox` 里这个测试失败了，修好它」。它要在无人干预下完成：读代码 → 修改 → 跑测试 → 推分支 → 开 PR。8 题各跑 3 次，出一份报告。
