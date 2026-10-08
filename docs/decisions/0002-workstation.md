# P0：macOS 用户工作站（进行中，2026-10-08）

## 已验证

- 本机有 git 2.53.0、tmux 3.7c。把工作目录显式传给 `tmux new-session -c` 后，终端可从指定 worktree 启动。
- `local-dir` 的 `0700` 目录只限制其他用户。同一用户下启动的终端仍可读取同一用户在目录外的 `0600` 凭据文件。实验只执行 `test -r`，没有打开凭据内容。
- 因此，如果 `hived` 和 `ws_bash` 同属 `zaaac` 或同一个 `hive` 用户，目录作用域检查不能约束任意 shell 命令。`local-dir` 只能作为受限工具的工作目录组织方式，不能作为带终端能力的凭据隔离边界。

## 待验证

已创建标准测试用户 `ws-hive-p0`（UID 502，家目录 `/Users/ws-hive-p0`，模式 `0700`）。在管理员授权下切换执行身份得到 UID 502；该用户没有 `AuthenticationAuthority` 记录。以该用户运行的 git 在启动盘家目录内成功初始化仓库。tmux 能启动短命会话，但结束后服务器自动退出，长时间存活与重连仍需验证。`dscl -authonly ws-hive-p0 ''` 返回成功，但实际用空密码 `su` 登录失败；前者不能作为空密码可登录的证据。

外置盘 `/Volumes/Data` 的 `diskutil info` 显示 **`Owners: Disabled`**。Apple 说明此模式把盘上文件视为当前访问者所有，因此目前不能把该盘上的 `0700` 目录当成不同 macOS 用户之间的隔离边界。测试用户从管理员授权助手中写外置盘还收到 `Operation not permitted`；这也可能涉及该助手自己的访问限制，不能仅凭这一错误判断普通工作站进程是否能访问外置盘。

经用户批准，曾临时执行 `diskutil enableOwnership /Volumes/Data`。`diskutil info` 随后显示 `Owners: Enabled`，现有代码仍可由 `zaaac` 读写。但在同一次脚本里，`sudo -H -u ws-hive-p0 test -r` 对 `zaaac` 拥有、模式 `0600` 的外置盘探针文件仍返回可读，隔离验收失败。脚本在失败处理时使用了 zsh 只读变量 `status`，导致自动回滚没有执行；这是脚本缺陷。用户随后手动运行 `sudo diskutil disableOwnership /Volumes/Data`，再次核对 `diskutil info` 为 **`Owners: Disabled`**、挂载参数为 `noowners`，已恢复原设置。此次 `Owners: Enabled` 的查询结果不能证明已挂载文件系统即时按所有权执行；需在受控环境下重新验证，不应重复运行该失败脚本。

还需在常规工作站进程（非授权助手的子进程）下验证外置盘访问、git、tmux 持久运行、私有目录不可读，以及重启后的执行方式。当前没有免密码 sudo；后续管理员操作需一次性、范围受限，并确保失败时回滚逻辑先经过检查。

## 暂定决策

默认工作站类型倾向 `macos-user`，但在外置盘 ownership 问题解决并实测前不能定案。工作树按磁盘规则放外置盘，小型用户家目录留在启动盘；P8 的 DerivedData 留在启动盘 scratch 并在任务结束后清理。不得因为系统用户实验失败，就把带任意终端能力的 Agent 降级到同 UID 的 `local-dir`，否则违反计划要求的凭据隔离。

曾在外置盘上创建 128 MiB 的临时 APFS sparsebundle，尝试以 `-owners on` 挂载；`hdiutil attach` 返回 `Permission denied`，未挂载。下一步倾向为工作站使用独立的、启用 ownership 的外置 APFS 卷，并在该卷上完成跨用户实测；现有 `/Volumes/Data` 保持原设置。参考：[Apple 对“忽略此卷宗所有权”的说明](https://support.apple.com/en-ca/guide/mac-help/mchlp1204/mac)。
