CREATE TABLE `agent_workstations` (
	`agent_id` text NOT NULL,
	`workstation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `workstation_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `git_pushes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text,
	`status` text NOT NULL,
	`reason` text,
	`pr_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `git_pushes_agent_idx` ON `git_pushes` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`holder_agent_id` text NOT NULL,
	`run_id` text,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`released_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leases_live_uq` ON `leases` (`kind`,`resource_id`) WHERE released_at is null;--> statement-breakpoint
CREATE INDEX `leases_run_idx` ON `leases` (`run_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`github_full_name` text NOT NULL,
	`remote_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`mirror_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_org_name_uq` ON `repositories` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_mirror_uq` ON `repositories` (`mirror_name`);--> statement-breakpoint
CREATE TABLE `workstations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`os_user` text NOT NULL,
	`network_allowed` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workstations_kind_ck" CHECK("workstations"."kind" in ('macos-user','local-fake'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workstations_os_user_uq` ON `workstations` (`os_user`);--> statement-breakpoint
CREATE UNIQUE INDEX `workstations_org_name_uq` ON `workstations` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worktrees_agent_idx` ON `worktrees` (`agent_id`,`last_used_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_live_scope_uq` ON `worktrees` (`workstation_id`,`scope`) WHERE removed_at is null;