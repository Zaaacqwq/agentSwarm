# P2 验收记录（2026-10-08）

| 验收项 | 结果 | 依据 |
|---|---|---|
| 工作站为独立 macOS 用户，彼此隔离 | 通过 | `scripts/check-workstations.ts` 在真实用户下 18/18 通过 |
| `core.workstation` 工具包：文件、终端、git | 通过 | 单元与集成测试；真实运行中 Agent 使用了 checkout、read、edit、bash、commit、push、pr_create |
| Git Relay 与 PR | 通过 | 25 次真实推送，全部经 inbox、镜像、校验后推到 GitHub 并开了 PR；拒绝路径（密钥、改写历史、无变更）有测试覆盖 |
| 租约与内存压力保护 | 通过 | 单元测试；真实运行时 UI 显示写租约持有者和到期时间，Run 结束后自动释放 |
| Workstations 页面 | 通过 | 实际数据截图：工作站卡片、写租约、worktree、文件浏览、主机状态 |
| 评测：8 题 × 3 次 | **24/24 通过** | `evals/reports/2026-10-08T21-04-20-917Z.md` |

## 隔离检查（真实用户，18/18）

- `hive-exec` 以 `ws-1`、`ws-2` 身份运行，拒绝其他用户。命令以 `ws-1` 身份执行，所属组为 `hive-ws`，不在 `staff` 组。
- 以 `ws-1` 身份读取以下位置均被拒绝：
  - 管理员家目录；
  - `/Volumes/Data`；
  - `/Volumes/HiveWS/hived`；
  - `ws-2` 的工作站目录和 inbox。
- 网络可用；bun 可用（1.4.2）；路径穿越被拒绝。
- git 流程跑通：从镜像克隆，推送到 inbox，hived 能读取 inbox。
- tmux 终端可用，且终端内的 shell 同样受沙箱限制。

## 评测（真实 OpenRouter）

- 模型 `qwen/qwen3.8-omni-flash`，thinking `low`，工作站 `ws-1`，费用上限 $5。
- **结果：24/24（100%）**
  - 总费用 $0.149，平均每次 72 秒、约 16 次工具调用；
  - 共 607,524 个输入 token、81,652 个输出 token。
- 判定成功的条件：评测器自行克隆推送的分支，确认目标测试通过、`test/` 未被修改，并且 PR 已创建。
- 每次评测结束后关闭对应 PR 并删除分支。目前 `hive-sandbox` 没有遗留的 PR 或 `hive/*` 分支。

## 评测期间发现并修复的问题

- **删除 Agent 后 worktree 残留在磁盘上。**
  - 评测每次结束都会删除 Agent，worktree 目录却没有一起删掉。
  - 冒烟测试和 `median #1` 恰好用了同一个 Agent 名，`median #1` 检出时撞上了残留目录。这次它用了 215 秒、35 次工具调用，是所有尝试里最慢的一次。
  - 已修复：删除 Agent 时一并删除它的 worktree，hived 启动时也会清理残留目录。重启后清掉了 24 个。
- **git 拒绝访问属于其他用户的仓库。**
  - 工作站用户要从 zaaac 拥有的镜像克隆，hived 要从工作站用户拥有的 inbox 拉取，两边都会被 git 的 safe.directory 检查拦下。
  - 已修复：通过受保护的环境变量配置，只把这两个目录加入信任。
- **`git init --shared` 会拒绝非快进推送。**
  - inbox 因此拦下了改写历史的推送，Agent 看不到 Relay 给出的「禁止 force push」说明。
  - 已修复：inbox 不再拒绝这类推送，统一交给 Relay 校验并给出说明。

## 未覆盖 / 留到后续

- 只测了一个工作站上的单个 Agent。多个 Agent 并发写入同一工作站的情况由测试覆盖，没有做真实压力测试。
- 免费版 GitHub 的私有仓库不能开分支保护，所以只能推 `hive/*` 分支、禁止 force push 这两条规则依赖 Git Relay 来保证。
