# P1 实施方案（用户已确认，待 P0 通过）

本阶段只交付可登录的单用户平台、两个独立 Agent 的私聊，以及可恢复的 Pi 会话。工作站与 Git Relay 留到 P2；群聊、任务、桌面、Xcode 均不进入 P1。

## 文件结构

```text
apps/
  hived/src/
    server.ts                 # Fastify 入口、HTTP/WebSocket、生命周期
    auth/                     # 首次 Admin 设置、密码、会话 cookie
    db/                       # SQLite 连接、迁移、仓储
    endpoints/                # 模型端点、密钥加密与调用计量
    agents/                   # Pi 适配器、每 Agent 队列、检查点、运行事件
    chat/                     # 私聊、消息、send_message 发布边界
    toolpacks/                # 加载器和执行时权限检查
  web/src/
    app/                      # 路由、深色布局、导航、API/WebSocket 客户端
    pages/                    # Chat、Agents、Settings
    components/               # 对话、Agent 表单、活动检查器、头像
packages/
  core/src/                   # 共享 TypeBox 契约、事件、Drizzle schema
  tools/src/                  # Toolpack 接口、core.communication 工具包
apps/hived/drizzle/           # 可审查的 SQL 迁移
tests/                        # API、权限、Pi 适配器与重启集成测试
```

根目录使用 Bun workspace，并锁定 Pi SDK 0.87.1。Fastify 路由用 TypeBox 契约生成 OpenAPI；前端 API 类型由同一契约生成，避免手写两套类型。后端与前端各有独立构建命令。

## 数据库与密钥

- SQLite WAL；首次迁移建 `organizations`、`users`、`login_sessions`、`endpoints`、`agents`、`agent_tool_grants`、`channels`、`channel_members`、`messages`、`runs`、`activity_events`、`usage_records`、`agent_sessions`、`audit_logs`。租约和工作站表留到 P2。
- 单 Admin 与单默认组织先建在首次设置流程中；业务表均带 `org_id`、`owner_user_id`。`channels.kind` 在 P1 只允许 `dm`，为 P3 预留其他类型。
- Admin 密码存强哈希；浏览器会话使用 HttpOnly、SameSite cookie，数据库只存令牌哈希。首次设置接口仅在没有 Admin 时开放，随后关闭。
- OpenRouter key 从 Settings 输入，经本机 hived 加密后入库；主密钥单独放在 hived 私有目录（`0700` 目录、`0600` 文件）。不会把现有个人 Pi 凭据复制进仓库或工作站。
- Pi 检查点在每次回合稳定结束后写 `agent_sessions`；重启从保存的条目重建 `SessionManager`。模型原始输出只写活动记录，不自动写聊天。只有 `send_message` 工具能发布 Agent 消息。

## 运行与权限

- 每个 Agent 一条串行队列；浏览器刷新仅重新订阅状态，不取消后端 Run。先做回合边界送达，不做中途打断。
- 使用 `noTools: "all"`、`customTools` 和显式 `tools: [...]` 允许列表。工具执行时再次检查 Agent、频道成员、授权项；P0 已证实只传 `noTools` 会连自定义工具一起关掉。
- Toolpack 接口包含 `id`、`tools(ctx)`、`leases?`、`healthcheck()`、`guidance?`。P1 只加载 `core.communication`；保留租约类型接口但不实现工作站租约。
- API 默认只监听 `127.0.0.1`。本阶段前端通过同源路径访问，WebSocket 重连时先取快照再订阅增量。

## 验证计划

1. 迁移测试：空库启动、重复启动、约束与索引；事务失败不产生半条消息。
2. 安全测试：首次 Admin 设置只允许一次；未登录请求拒绝；会话令牌只存哈希；端点密钥不出现在 API、日志或活动记录；未经授权的工具即使被直接调用也拒绝。
3. 聊天测试：人的私聊触发对应 Agent；模型直接文本不发布；`send_message` 才发布且只能写所属频道；两个 Agent 的消息与会话不串线。
4. 生命周期测试：刷新页面时 Run 继续；重启 hived 后恢复聊天和 Pi 上下文；忙碌时消息在回合边界排队；模型失败后 Run 状态可恢复。
5. 实机演示：在 UI 创建两个 Agent、分别私聊，查看 token/费用与活动；刷新及重启后继续对话。使用真实 OpenRouter 的冒烟测试只跑一次，其余测试用可控模型替身。

P1 完成后按上述验收演示，再提交下一阶段方案。
