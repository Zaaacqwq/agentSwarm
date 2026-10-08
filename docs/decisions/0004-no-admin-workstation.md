# 0004 — No administrator password workstation mode

Date: 2026-10-08

The owner asked for unattended delivery without entering a macOS administrator password. The earlier P0 experiment did not establish a safe cross-user ownership boundary on `/Volumes/Data`; macOS user creation and TCC grants would require interactive system authorization.

Hive therefore runs as the current user. Workspace files and model sessions stay on `/Volumes/Data`. `ws_bash` runs through macOS `sandbox-exec` with an empty environment, a workspace-specific read/write rule, no network permission, and explicit denials for `/Users`, other `/Volumes` paths, and Hive's data directory. Path-based file tools also resolve symlinks before access. Write-capable workspace tools serialize per workspace in the server process.

This mode was tested with a real Pi coding task: the agent read a failing fixture, changed one source file, and passed its tests. Separate probes confirmed denied access to the personal GitHub credential file, Hive's access token, a neighboring repository, and the local HTTP service. The test fixture was reset after the run.

This is not equivalent to a separately administered macOS user or VM. In particular, an allowed workspace may itself contain secrets, and shell subprocess lifecycle management is limited. Only assign repositories that the agent may read and edit. GitHub pushes go through the host-side Relay, which pins the repository at workspace creation and checks task assignment and branch naming.

The desktop toolpack, macOS user provisioning, and Xcode simulator toolpack remain outside this no-admin delivery. They require separate feasibility checks and, for TCC and user provisioning, interactive system authorization.
