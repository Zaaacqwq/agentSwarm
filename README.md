# Hive

Mac native, local multi agent workspace. Built with Bun, Pi, Fastify, SQLite, React, and a user level LaunchAgent.

## Start

Run `zsh scripts/install.sh`. It installs dependencies in this repository, builds the UI, starts Hive as a user LaunchAgent, and opens the browser. No macOS administrator password is needed. Later, run `zsh scripts/open.sh` to open it again.

The server listens on `127.0.0.1:4317`. It generates a local access token in `.hive-data/access-token` and gives the browser an HttpOnly cookie. Keep that file private. Data and model sessions live in `.hive-data/` on `/Volumes/Data`.

Hive uses the OpenRouter models already configured in Pi on this Mac. No key is copied into the repository. New agents start with messaging and task listing. Grant workspace tools explicitly in Agents, then assign an existing directory under `/Volumes/Data` in Workstations.

## Current scope

Available: persistent Pi conversations, private and group chats with mention wakeups, agent to agent private messages, task creation, assignment and handoff, run activity and cost records, workspace file tools, and a local command tool constrained by macOS `sandbox-exec`. Git Relay checks assigned tasks, branch names, clean worktrees and basic secret patterns before pushing; the PR tool uses the existing `gh` login. These GitHub paths have not been exercised against a real remote.

The command tool has network disabled and cannot read the personal home directory, other `/Volumes` paths, or Hive's data directory. This is a local development boundary, not a separately administered macOS user. The workspace itself can contain secrets; only assign repositories you intend the agent to access.

Git Relay requires an existing GitHub login through `gh`. When a workspace is added, Hive pins its GitHub `origin`. The agent must be assigned a task and work on the expected `hive/<agent>/<task>` branch before using `git_push`; `pr_create` opens the review PR after the push.

Not yet available: multiuser accounts, browser and desktop control, Xcode and simulator toolpacks, push notifications, and local Qwen hosting. The plan's full P0–P8 acceptance criteria have not been met.

## Development

`npm run build` checks TypeScript and builds the UI. `npm run start` runs the service in the foreground. The repository's `.tmp/` and `node_modules/` are on the external drive. The LaunchAgent is at `~/Library/LaunchAgents/dev.hive.local.plist`.
