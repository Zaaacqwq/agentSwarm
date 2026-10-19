# R3 implementation plan: the pipeline and Discord (confirmed 2026-10-17)

> Based on `PLAN.md` sections 4, 10 and 14 (R3), and on R1 and R2 as built.
> You accepted every recommendation in section 9 ("按建议，开始 R3").

## 0. Goal and acceptance

**Goal:** you say one sentence in Discord, and agentSwarm takes it to a pull request on `main`: it asks you what it needs to know, researches, discusses with you, writes a plan, waits for your approval, builds it with a tree of agents, verifies it, and opens the PR. You merge it on GitHub; agentSwarm notices, writes a short retrospective and cleans up after itself.

**Acceptance** (real environment, qwen3.8-omni-flash, the `agentswarm-playground` repository):
1. In Discord you run `/idea` with a small web tool, for example "a page where I paste CSV and get a Markdown table".
2. The lead opens a thread for it and asks you at most three clarifying questions; you answer in the thread.
3. Researchers produce `research.md` (findings with source links); the lead discusses the direction with you in the thread.
4. An architect writes `plan.md` with work packages and acceptance criteria. The lead posts a summary with **Approve** / **Request changes** buttons. Nothing is built before you approve.
5. After approval, the lead builds it with a tree of sub-agents (R2), then a QA agent runs everything and writes `acceptance.md`.
6. The PR to `main` contains the code, tests, `research.md`, `decisions.md`, `plan.md` and `acceptance.md`. Its link is posted in the thread.
7. You merge it on GitHub. Within a few minutes agentSwarm posts a retrospective and deletes the mission's worktrees and `swarm/…` branches.
8. The dashboard shows the mission's stage, its gates, its documents, its agent tree and its cost, and you can do everything there that you can do in Discord.

Out of scope for R3: marketing, the team experience library and role playbooks (R6), CLI workers (R4), browser and simulator (R5).

---

## 1. Missions

A **mission** is one idea pursued in one project (repository). It is new; R1/R2 runs and trees stay as they are and become the building blocks of a mission.

| Field | Meaning |
|---|---|
| `intent` | Your original words, plus every later clarification, stored verbatim and never edited |
| `stage` | See section 2 |
| `lead_agent_id` | The lead that runs every stage (a standing agent, created per mission from a lead template) |
| `tree_id` | The R2 tree of the build stage |
| `branch` | The mission's integration branch (the build tree's root branch) |
| `docs_path` | `docs/agentswarm/<mission-slug>/` in the repository |
| `budget_usd`, `cost_usd` | Whole-mission budget and spend (all stages) |
| `pr_url`, `pr_state` | The pull request and what GitHub last said about it |
| `discord_thread_id` | Where the conversation lives |
| `fast` | Skip research and discussion (small changes) |

## 2. Stages and gates (a state machine in code; agents cannot skip a gate)

```
intake → research → discussion → planning → [Gate A: you approve] → building → verifying → [Gate B: you merge] → retro → done
   (fast track: intake → planning)                     ↑ request changes → back to planning
any stage → cancelled (you say stop, or the PR is closed)
```

| Stage | Who | What happens | Ends when |
|---|---|---|---|
| intake | lead | Stores your words; asks up to 3 questions in the thread | The lead calls `stage_done`, or you answer and say go |
| research | lead + researcher sub-agents | Parallel research (alternatives, how others do it, reusable libraries, risks) | `research.md` committed and summarised in the thread |
| discussion | lead and you | Back and forth in the thread; decisions recorded | You say go (or press a button), and `decisions.md` is committed |
| planning | lead + architect sub-agent | Scope, design, work packages with acceptance criteria and dependencies, risks, budget | `plan.md` committed; the lead calls `request_approval` |
| Gate A | **you** | Approve, or request changes with a comment | Your button or dashboard action |
| building | lead + its tree | Work packages to sub-agents; review and merge (R2) | All packages merged and pushed |
| verifying | QA sub-agent | Runs every test, checks the plan's acceptance criteria one by one | `acceptance.md` committed; the lead opens the PR |
| Gate B | **you** | Merge (or close) the PR on GitHub | swarmd sees it merged (or closed) |
| retro | lead | A short retrospective: what went well, what cost the most, what to change | Posted in the thread and kept with the mission. It is not committed, because the PR is already merged. |

How a stage runs: each stage is one root run of the mission's lead (with stage-specific instructions and tools). When it succeeds, swarmd moves the mission to the next stage. A stage's documents are committed to the mission branch, so they end up in the PR.

New tools for the lead: `ask_user` (posts a question in the thread and waits for your answer, like `wait_agents`), `stage_done({summary})`, `request_approval({summary})` (only in planning; moves to Gate A), and `web_fetch` / `web_search` for researchers (section 5).

## 3. Discord

- swarmd gets a Discord gateway client (discord.js). It starts only when a bot token is configured; nothing else depends on it.
- **Layout:** one channel you choose (for example `#agentswarm`); each mission is a **thread** in it. Threads need only the permissions the R0 probe already had (send messages, create public threads, read history), so no Manage Channels.
- **Who is obeyed:** only your Discord user id (`769549199007416320`). Anyone else's messages are ignored, and never reach an agent.
- **Commands:**
  - `/idea text:<idea> project:<repo> [fast:true] [budget:<usd>]` starts a mission and its thread;
  - `/status` lists missions and stages;
  - `/stop` cancels the mission of the thread it is used in (with a confirm button);
  - `/budget usd:<amount>` changes the mission budget.
- **In a mission thread:** your messages go to the lead (as a message to its current run, or queued for the next stage). The lead's replies, stage summaries, questions and the PR link are posted back. Long text is split; code and file contents are not posted, only links to the files on GitHub and the dashboard.
- **Gate A** is a message with the plan summary, a link to `plan.md` and two buttons: **Approve** and **Request changes** (opens a text box for your comment).
- The dashboard and Discord show the same mission; acting in one updates the other.

## 4. PR tracking and cleanup (left over from R2)

- swarmd polls every open mission PR every 2 minutes (GitHub API; no webhooks, since there is no public endpoint).
- **Merged:** the mission moves to retro, then done. **Closed without merging:** the mission is cancelled.
- **Cleanup, after merged or closed:** delete the mission's worktrees on every workstation (ws-exec `git.remove`), delete every `swarm/<project>/<tree>/…` branch on GitHub and in the mirror, and reap the workstations. Sessions, events and the database history stay.
- The same cleanup runs for R2 trees started from the dashboard without a mission, once their PR is merged or closed.

## 5. Research access to the web

Researchers need to read the web; agents in R1/R2 only have their workstation.

- `web_fetch({url})`: fetched **by swarmd**, not the workstation. Only `https` URLs on public addresses (the SSRF checks from the old P5 browser work: block private, loopback, link-local and similar ranges, re-check after redirects), size and time limits, HTML turned into text. The result is marked as untrusted data.
- `web_search({query})`: through OpenRouter's web search plugin (Exa engine) on the same OpenRouter key and the agent's own model. Checked 2026-10-17: Exa costs $0.007 per search (up to 10 results); a real search with qwen3.8-omni-flash cost $0.008 in total, returned 6 results with excerpts, and took about 25 s. The cost is charged to the agent's run.
- Only researchers and the lead in the research stage get these two tools.

## 6. Dashboard

- **Missions** page: list with stage, cost and PR state; a new-mission form (same fields as `/idea`).
- **Mission** page:
  - a stage stepper with the two gates (Approve / Request changes buttons at Gate A);
  - the intent, and links to each document on GitHub;
  - the conversation (the same messages as the Discord thread, with a reply box);
  - the agent tree of the build stage (R2 component) and the total cost.
- **Settings:** the Discord bot token (stored encrypted), the channel, your user id; a "send test message" button.

## 7. Data

New tables (one migration, additive):
- `missions` (section 1).
- `mission_messages`: the conversation (from you, from the lead, system notes), with the Discord message id.
- `settings`: the Discord token (sealed), channel id, owner id.

`runs` gains `mission_id` and `stage`.

## 8. Testing

- **Unit:** the stage machine (every legal and illegal transition, the gates, the fast track, cancel), message routing (owner only, thread to mission), PR state handling, URL safety checks for `web_fetch`, Discord message splitting.
- **Integration** (scripted models, local "GitHub", a fake Discord gateway that records sends and injects messages and button presses):
  - a whole mission from `/idea` to merged and cleaned up;
  - Gate A cannot be passed by an agent (a scripted lead calling `stage_done` in planning does not start building);
  - request changes sends the mission back to planning with your comment;
  - messages from other Discord users are ignored;
  - a closed PR cancels the mission and cleans up;
  - cleanup removes worktrees and branches and nothing else.
- **E2E:** start a mission from the dashboard, answer a question, approve the plan, see the tree, see the PR link (scripted models).
- **Real acceptance:** section 0, in your Discord, with you answering and approving; results in `docs/R3_ACCEPTANCE.md`.
- **Code review** with the code-reviewer agent; HIGH and above fixed.

## 9. Decisions for you

1. **Missions.** An idea is a mission inside a project (repository), run by its own lead through the stages above. (Recommended.)
2. **Discord layout.** One channel, one thread per mission (no extra bot permissions). The alternative is a channel per mission, which needs Manage Channels and clutters the server faster. (Recommended: threads.)
3. **Bot.** A new Discord application just for agentSwarm, rather than the ZacAgent bot your discordAgent project uses (both would answer the same messages). (Recommended: new bot; I'll give you the steps.)
4. **Research tools.** `web_fetch` done by swarmd with SSRF checks, plus `web_search` via OpenRouter's web plugin. (Recommended; pricing to verify.)
5. **Gates.** Exactly two hard gates: approve the plan, merge the PR. Everything else, including research and discussion, can be skipped with the fast track. (Recommended.)
6. **Cleanup.** After the PR is merged or closed, delete the mission's worktrees and all its `swarm/…` branches (including the integration branch). (Recommended.)
7. **Deferred.** Marketing, the experience library and role playbooks stay in R6; R3 only keeps a short retrospective for each mission. (Recommended.)
