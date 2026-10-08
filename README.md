# Hive

A Mac-native multi-agent workspace, built in phases from [`HIVE_PLAN.md`](HIVE_PLAN.md). This branch implements **P1**: the platform skeleton, admin login, model endpoints, agent creation, and private chat with agents. The P1 scope is in [`docs/P1_IMPLEMENTATION_PLAN.md`](docs/P1_IMPLEMENTATION_PLAN.md).

## Layout

```text
apps/hived       Bun + Fastify backend: auth, endpoints, agents, chat, runs, Pi runtime, WebSocket
apps/web         React + Vite + Tailwind UI (Chat, Agents, Settings)
packages/core    Shared TypeBox contracts, server events, Drizzle schema
packages/tools   Toolpack interface, registry, core.communication tools
e2e              Playwright flow against a fake OpenAI-compatible model
```

## Run

```sh
zsh scripts/bootstrap.sh          # pinned Bun 1.3.0 in .tmp/, deps, UI build
bun apps/hived/src/main.ts        # http://127.0.0.1:4318
```

On first visit, create the admin account. Then add a model endpoint in Settings (OpenRouter or any OpenAI-compatible URL), create an agent, and message it from Chat.

| Variable | Default | Meaning |
|---|---|---|
| `HIVE_PORT` | `4318` | HTTP port |
| `HIVE_HOST` | `127.0.0.1` | Bind address; anything else also needs `HIVE_ALLOW_NON_LOOPBACK=1` |
| `HIVE_DATA_DIR` | `.hive-data/` | SQLite DB, `master.key`, Pi scratch dir (mode 0700) |
| `HIVE_MAX_CONCURRENT_RUNS` | `3` | Global cap on agent turns running at once |
| `HIVE_SECURE_COOKIES` | unset | Set to `1` when served over HTTPS |
| `HIVE_ALLOWED_HOSTS` | unset | Extra comma-separated Host names to accept (e.g. a Tailscale name) |

For UI development, run hived and then `bun run dev:web` (Vite on :5173, which proxies `/api` to hived).

## How it behaves

- Agents have no tools until you grant them. Grants are checked again at execution time, so a revoke applies mid-run.
- Model output is private. Only the `send_message` tool posts to chat. Everything else shows up in the agent's activity inspector.
- One turn per agent at a time. Messages that arrive while the agent is busy are delivered together at the next turn boundary.
- Runs belong to hived. Refreshing the browser does not cancel them. After a hived restart, mid-flight turns are marked interrupted (not replayed), and queued turns resume.
- Pi sessions are checkpointed in SQLite after each successful turn and rebuilt with `SessionManager.inMemory`. Hive never reads `~/.pi`.
- Endpoint keys are AES-GCM encrypted with `master.key`. The API never returns them, and they are redacted from run errors and activity.
- Every `/api` request, including the WebSocket upgrade, must come from an allowed Host (loopback, plus `HIVE_ALLOWED_HOSTS`) with a matching Origin.
- Known limit for P6: each agent keeps one Pi session across all its DMs. That is fine with a single admin, but per-user isolation will need per-channel sessions.

## Test

```sh
bun run test            # unit + integration (Pi runs against a local fake model)
bun run test:coverage
bun run typecheck
BUN_BIN=$(which bun) bun run test:e2e   # Playwright, uses installed Google Chrome
```
