# P0：Pi SDK 可行性（2026-10-08）

## 结论

当前机器上的 `@earendil-works/pi-coding-agent` 0.87.1 能通过 OpenRouter 运行自定义工具，保存并恢复会话，也能并发运行独立会话。P1 可以以此版本做适配层的起点，但必须显式列出允许的工具名。

## 实验

- 使用本机 Pi 凭据存储中已配置的 OpenRouter 连接，以及 `qwen/qwen3.8-omni-flash`。密钥没有复制到仓库或实验目录。
- 自定义 `p0_echo` 工具由 TypeBox 定义参数。首次对话调用一次，返回 `cedar42`；保存 JSONL 会话，销毁会话对象，重开后询问先前的词，正确返回 `cedar42`。
- 再同时启动两个内存会话，分别调用工具并返回 `alpha73` 与 `beta84`，没有交叉污染。三次工具调用都成功。首次对话加恢复约 6.3 秒，并发两轮约 2.2 秒（单次样本）。
- `noTools: "all"` 加 `customTools`、但不指定 `tools` 时，`getActiveToolNames()` 返回空数组。加 `tools: ["p0_echo"]` 后只启用该工具。这与参考仓库在所读提交中使用的 `noTools: 'all'` 加 `customTools` 写法不同，适配时不能直接照搬。

## P1 约束

通过一个自己的 `AgentRuntime` 接口封装 Pi。每次创建会话传入明确的工具名允许列表，在工具执行处再次校验 Agent、频道和工作站权限；会话恢复用 `SessionManager.open()`，不能只替换内存消息数组。三个成功调用只证明基本可行，压力、失败恢复和长时间运行仍需 P1 验证。

参考：本机安装包 `docs/sdk.md`、`dist/core/sdk.d.ts`；[ASNG 的 chat-runtime.ts](https://github.com/AlexZihaoXu/agent-swarm-ng/blob/23a1bad3291dd36dcf6fcbfc291d3e92b8420d7c/backend/src/chat-runtime.ts)。
