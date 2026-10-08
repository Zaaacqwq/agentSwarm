# 0004 — 默认工作站类型：启动盘上的独立 macOS 用户（2026-10-08）

## 决定

P2 的默认工作站类型为 `macos-user`。每个工作站对应一个独立的 macOS 用户（`ws-<n>`），用户家目录和 worktree 都放在**启动盘**上。`ws_bash` **一律允许联网**（用户决定）。

## 依据

- `/Volumes/Data` 显示 `Owners: Disabled`，P0 实测其他用户能读到 0600 的探针文件，所以外置盘不能作为跨用户隔离的边界，工作站文件不放在外置盘上。
- 启动盘剩余约 24 GiB，放小到中等仓库的 worktree 够用，但需要清理策略和磁盘监控。
- 同一 UID 的 `local-dir` 隔离不了凭据，不采用。

## 带来的约束

1. **hived 数据目录迁到启动盘**：`~/Library/Application Support/Hive`（0700）。如果继续放在 `/Volumes/Data`，`master.key` 和数据库对所有工作站用户可读。
2. **工作站用户不进 `staff` 组**：macOS 新用户默认主组是 `staff`（GID 20），而 `/Users/zaaac` 是 `drwxr-xr-x`，家目录前两层有约 200 个其他人可读的文件。所以主组改成专用的 `hive-ws` 组。
3. **纵深防御**：除用户隔离外，`hive-exec` 用 `sandbox-exec` 包住每条命令，拒绝访问 `/Volumes`（整盘没有 ownership 保护）、其他用户的家目录和 hived 数据目录。网络按上面的决定放行。
4. **hived 不以 root 运行**：管理员权限只在一次性脚本 `scripts/setup-workstations.sh` 里用，由用户本人执行。脚本负责：
   - 创建用户和组；
   - 安装 root 拥有的 `hive-exec`；
   - 写入 `sudoers.d/hive`，只允许以 `hive-ws` 组成员的身份运行 `hive-exec`。

## 已接受的风险

- 允许联网意味着 Agent 能把工作目录里的内容发到外部，所以只给它分配允许读写的仓库。
- `sandbox-exec` 已被 Apple 标为弃用，但在本机可用。它只是第二道防线，第一道是独立 UID。
