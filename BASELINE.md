# Hive P0 基线（2026-10-08）

本文件按新版 `HIVE_PLAN.md` 的 P0 范围记录。Xcode 与模拟器已延后到 P8。

| 项目 | 状态 |
|---|---|
| 主机 | Mac16,10，16 GiB 内存；工作目录位于 `/Volumes/Data` |
| Pi SDK | 0.87.1；OpenRouter 自定义工具、会话恢复、双会话并发实验通过；见 `docs/decisions/0001-pi-sdk.md` |
| Bun | 尚未安装；P1 开始前安装并锁定版本 |
| macOS 工作站 | 已创建 `ws-hive-p0` 并验证身份切换及启动盘 git；`local-dir` 不能隔离凭据；临时启用外置盘 ownership 后隔离探针失败，已恢复 `Owners: Disabled`；默认类型尚未定案，见 `docs/decisions/0002-workstation.md` |
| 桌面控制（可选） | 截图失败，`cliclick` 未安装；见 `docs/decisions/0003-desktop-optional.md` |
| 启动盘剩余空间 | 约 25 GiB；构建与模块缓存需留在启动盘并及时清理 |
| 外置盘剩余空间 | 约 195 GiB；代码、工作树和可保留产物放在此盘 |

P0 尚未通过验收：需确定外置盘的隔离方案，完成独立用户工作站实验，并形成默认工作站类型决策。桌面控制可按计划推迟到 P5 前。P1 方案已获用户有条件确认，待 P0 通过后实施。
