# 0004 — 默认工作站类型：外置盘专用卷上的独立 macOS 用户（2026-10-08）

## 决定

P2 的默认工作站类型为 `macos-user`。每个工作站对应一个独立的 macOS 用户（`ws-<n>`）。各工作站的 worktree 和 hived 的数据目录都放在外置盘的专用 APFS 卷 **`/Volumes/HiveWS`** 上，这个卷开启了所有权。工作站用户的家目录很小，仍留在启动盘 `/Users`。`ws_bash` **一律允许联网**（用户决定）。

## 依据

- `/Volumes/Data` 显示 `Owners: Disabled`，挂载参数是 `noowners`。P0 实测其他用户能读到 0600 文件，所以它不能作为隔离边界。我们不改动这个卷。
- 在同一 APFS 容器（`disk7`）里新建了卷 `HiveWS`，和 `Data` 共享约 194 GiB 的空闲空间。在这个卷上执行 `enableOwnership` 并重新挂载后，状态为 `Owners: Enabled`，挂载参数里已没有 `noowners`。探针结果 7/7 通过（`scripts/p0-hivews-volume-probe.sh`）：
  - 工作站用户读不到、列不出、写不进 zaaac 的 0700/0600 目录和文件；
  - zaaac 读不到工作站用户的 0600 文件；
  - 工作站用户能在自己的目录里写文件、执行 `git init`。
- P0 里对 `/Volumes/Data` 执行 `enableOwnership` 后隔离仍然失败，原因很可能是没有重新挂载，旧挂载还带着 `noowners`。本次脚本显式重新挂载后隔离生效。没有再在 `Data` 上复验。
- 启动盘只剩约 24 GiB，不适合放 worktree。
- 同一 UID 下的 `local-dir` 无法隔离凭据，不采用。

## 待验证

- 重启后 `diskutil info /Volumes/HiveWS | grep Owners` 仍应为 `Enabled`，挂载参数里仍不应有 `noowners`。hived 启动时也会检查这两点，不满足就拒绝启动工作站。

## 带来的约束

1. **hived 数据目录**：放在 `/Volumes/HiveWS/hived`，属主 zaaac，权限 0700。不再放在 `/Volumes/Data`，否则 `master.key` 和数据库对所有工作站用户都可读。
2. **工作站目录**：`/Volumes/HiveWS/ws/<ws-user>/`，属主为对应的工作站用户，权限 0700。`/Volumes/HiveWS` 和 `/Volumes/HiveWS/ws` 由 root 拥有，权限 0755。
3. **主组改为 `hive-ws`**：新建工作站用户默认的主组是 `staff`。而 `/Users/zaaac` 是 `drwxr-xr-x`，前两层有约 200 个所有人可读的文件。所以工作站用户的主组改成专属组 `hive-ws`，不进 `staff`。
4. **纵深防御**：独立 UID 之外，`hive-exec` 还用 `sandbox-exec` 包住每条命令，拒绝访问：
   - `/Volumes/Data`（该卷没有所有权保护）；
   - 其他用户的家目录；
   - hived 数据目录；
   - 其他工作站的目录。

   网络按上面的决定放行。
5. **hived 不以 root 运行**：管理员权限只出现在一次性脚本 `scripts/setup-workstations.sh` 里，由用户本人执行。

## 已接受的风险

- 允许联网意味着 Agent 能把工作目录里的内容发到外部。只给它分配允许它读写的仓库。
- `sandbox-exec` 已被 Apple 标为弃用，但在本机可用。它只是第二道防线，第一道是独立 UID 加上 HiveWS 的所有权。
- 外置盘没挂载时（例如拔盘），hived 无法启动。这是有意的：宁可停，也不退回到不安全的位置。
