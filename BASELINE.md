# M0 基线：Mac mini（2026-10-08）

## 环境

| 项目 | 观测结果 |
|---|---|
| 机器 | Mac16,10，16 GiB 内存 |
| Xcode | 27.0 (27A266a) |
| Node | 22.22.2 |
| 已有工具 | `gh` 2.89.0、`pi`、Tailscale CLI |
| 尚未找到 | `xcbeautify`、AXe CLI |
| 启动盘可用空间（测试前） | 约 26 GiB |
| `/Volumes/Data` 可用空间 | 约 195 GiB |
| 专用 `hive` 用户 | 尚未创建 |
| Docker | 测试前正常退出，测试结束后恢复；`buw-postgres` 已重新运行 |
| DeviceBoard | 测试前停止，当前保持停止 |

DoFocus 工作树在 `/Volumes/Data/Code/DoFocus`，测试前 `main` 分支干净。以下命令没有调用 `.pi-build.sh`，没有访问真机，且都指定 `CODE_SIGNING_ALLOWED=NO`。所有 DerivedData、日志、截图和 `.xcresult` 都写入启动盘的专用 scratch 目录，并在检查后清理。

## 模拟器

已创建两台 iPhone 17 Pro / iOS 26.4 模拟器：

| 名称 | UDID |
|---|---|
| `hive-sim-1` | `275E6F59-C8A8-4C2A-9553-1F9A6DD145F2` |
| `hive-sim-2` | `5B6CD47B-CA13-449D-9EFA-2863F5A0DE97` |

`hive-sim-1` 启动成功，并截得 1206×2622 PNG。`simctl io screenshot` 直接写 `/Volumes/Data` 报 `Operation not permitted`；写启动盘 scratch 成功。因此 `hive-xcode` 应先写启动盘，再按需复制到外置盘。测试后已关闭并擦除 `hive-sim-1`；其设备目录由约 2.3 GiB 降到 17 MiB。

## 构建与测试

统一参数：`-project DoFocus.xcodeproj -scheme DoFocus -configuration Debug -destination 'platform=iOS Simulator,id=<hive-sim-1>' -derivedDataPath <scratch> -jobs 4 CODE_SIGNING_ALLOWED=NO`。

| 检查 | 结果 |
|---|---|
| 冷构建 `build` | 成功，约 22 秒；scratch 峰值约 291 MiB |
| 定向测试 `-only-testing:DoFocusTests/SketchGeometryTests` | 6/6 通过 |
| 全量 `test -parallel-testing-enabled NO` | 测试框架报告 528/528 通过、80 个 suite，测试执行约 100 秒 |
| 全量命令退出 | **异常**：测试结果输出后约 3 分钟 `xcodebuild` 仍未退出；在总耗时 372 秒时发送 SIGTERM，退出码 143；scratch 约 528 MiB，已清理 |

全量测试通过不等于 `xcodebuild` 命令可靠完成。M0 完成前需要查明结束阶段卡住的原因，并再次验证命令能自行退出。测试日志中有 SwiftUI 运行时警告（重复 `ForEach` ID、appearance transition 不平衡），但没有测试失败。

## 资源观测

Docker 退出后，空闲内存比例约 54%–55%；全量测试期间约 35%–37%，测试结束后约 59%。Swap 已用量由测试前约 1.8 GiB 上升到约 2.65 GiB。这些是单次观测，尚不足以确定两个 Agent 的并发上限。启动盘测试结束后约剩 25 GiB。

## M0 待完成

1. 查明并复测全量 `xcodebuild test` 结束阶段卡住的问题。
2. 测增量构建，以及不同 `-jobs` 值的耗时和峰值内存。
3. 验证快照测试重复运行的稳定性。
4. 创建专用 `hive` 用户，确认外置盘权限、SSH/Tailscale 和无显示器运行条件。
5. 安装并验证 `xcbeautify` 与 AXe（或选定替代方案）。

在这些数据完成前，暂定最多一台启动中的模拟器、一次构建；不启动双 Agent 并发。
