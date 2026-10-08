# Hive

A Mac-native multi-agent workspace, built in phases from [`HIVE_PLAN.md`](HIVE_PLAN.md).

- **P1**: platform skeleton, admin login, model endpoints, agents, and private chat ([plan](docs/P1_IMPLEMENTATION_PLAN.md), [acceptance](docs/P1_ACCEPTANCE.md)).
- **P2**: workstations as separate macOS users, `core.workstation` tools, the Git Relay and PRs, leases, and the coding eval ([plan](docs/P2_IMPLEMENTATION_PLAN.md), [decision](docs/decisions/0004-workstation-macos-user.md)).

## Layout

```text
apps/hived       Bun + Fastify backend: auth, endpoints, agents, chat, runs, Pi runtime, WebSocket
apps/web         React + Vite + Tailwind UI (Chat, Agents, Settings)
packages/core    Shared TypeBox contracts, server events, Drizzle schema
packages/tools   Toolpack interface, registry, core.communication and core.workstation tools
packages/priv-helper  hive-exec: runs one sandboxed operation as a workstation user
evals            hive-sandbox fixture (8 seeded bugs) and the coding eval runner
e2e              Playwright flow against a fake OpenAI-compatible model
```

## Run

```sh
zsh scripts/bootstrap.sh          # pinned Bun 1.3.0 in .tmp/, deps, UI build
bun apps/hived/src/main.ts        # http://127.0.0.1:4318
```

### Workstations (one-time admin step)

Workstations live on the ownership-enabled APFS volume `/Volumes/HiveWS` (see decision 0004). Run this once, and again whenever you add workstations or change `packages/priv-helper`:

```sh
sudo zsh scripts/setup-workstations.sh 2      # creates ws-1, ws-2; --update-exec, --uninstall also available
bun scripts/check-workstations.ts             # verifies isolation, network, git and tmux as the real users
```

hived keeps its data in `/Volumes/HiveWS/hived` by default and refuses to start if that volume is missing or mounted without ownership.

On first visit, create the admin account. Then add a model endpoint in Settings (OpenRouter or any OpenAI-compatible URL), create an agent, and message it from Chat.

| Variable | Default | Meaning |
|---|---|---|
| `HIVE_PORT` | `4318` | HTTP port |
| `HIVE_HOST` | `127.0.0.1` | Bind address; anything else also needs `HIVE_ALLOW_NON_LOOPBACK=1` |
| `HIVE_DATA_DIR` | `/Volumes/HiveWS/hived` | SQLite DB, `master.key`, Pi scratch dir (mode 0700) |
| `HIVE_HEAVY_SLOTS` | `2` | Commands (`ws_bash`) that may run at once across all workstations |
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

## Coding eval

```sh
HIVE_PASSWORD=... bun evals/runner/run.ts --url http://127.0.0.1:4318 --endpoint OpenRouter \
  --model qwen/qwen3.8-omni-flash --workstation ws-1 --runs 3 --budget 5 --cleanup
```

Each attempt uses a fresh agent to fix one seeded bug in `Zaaacqwq/hive-sandbox`, push and open a PR. The runner then clones the branch itself, reruns the target test, checks that `test/` was not edited, and writes a report to `evals/reports/`.

## Test

```sh
bun run test            # unit + integration (Pi runs against a local fake model)
bun run test:coverage
bun run typecheck
BUN_BIN=$(which bun) bun run test:e2e   # Playwright, uses installed Google Chrome
```
