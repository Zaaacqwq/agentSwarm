# P1 验收记录（2026-10-08）

| 验收项 | 结果 | 依据 |
|---|---|---|
| 界面创建 Agent、选 OpenRouter 模型并私聊 | 通过 | Playwright `e2e/p1-flow.spec.ts`（假模型）；真实 OpenRouter 冒烟见下 |
| 刷新页面不丢状态、不取消运行 | 通过 | E2E 刷新后历史仍在；Run 属于 hived，与浏览器连接无关 |
| 重启 hived 后会话可继续 | 通过 | 冒烟：重启后 Ada 正确答出重启前记住的 `cedar42`；单测覆盖中断与排队恢复 |
| 看到本次 token 与费用 | 通过 | 冒烟：Ada 3795/258 token，$0.000691；Bob 1709/145 token，$0.000324 |
| 两个 Agent 分别私聊互不干扰 | 通过 | 冒烟与 E2E：两个 DM 内容和会话没有串线 |

## 真实 OpenRouter 冒烟（只跑一次）

- 模型 `qwen/qwen3.8-omni-flash`（Pi 目录内有价格，费用按目录价计算），thinking `low`。
- Key 取自本机 Pi 的 OpenRouter 凭据（经用户同意），通过 API 写入临时数据目录（加密存储）；结束后已删除该目录。检查确认明文 key 未出现在任何数据文件或日志中。
- 回复延迟 1–4 秒；每次回复都经由 `send_message`；所有 Run 均为 `succeeded`。
- 第一次运行时脚本在 Agent 发完消息、尚未结束回合时就重启了 hived，回合被标为 `interrupted`，但部分会话已保存，重启后仍记得上下文。修正脚本（等 Agent 空闲后再重启）后重跑，结果如上表。

## 测试

- `bun run test`：51 项通过，行覆盖率约 98%（`bun run test:coverage`）。
- `bun run test:e2e`：2 项通过（桌面 1440 宽，以及 375 宽下无横向溢出）。
- 代码审查发现的 1 个 HIGH 与 2 个 MEDIUM 已修复，并补了回归测试（见提交 `205bf17`）。
