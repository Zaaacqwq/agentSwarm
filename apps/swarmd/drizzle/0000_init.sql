CREATE TABLE `agent_sessions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`model_id` text NOT NULL,
	`instructions` text NOT NULL,
	`runtime` text NOT NULL,
	`parent_id` text,
	`depth` integer NOT NULL,
	`budget_usd` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_project_idx` ON `agents` (`project_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_time_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_sealed` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `git_pushes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text,
	`status` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `git_pushes_project_idx` ON `git_pushes` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `github_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`token_sealed` text NOT NULL,
	`login` text,
	`expires_at` integer,
	`checked_at` integer,
	`error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_sessions_token_uq` ON `login_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_sessions_user_idx` ON `login_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`github_repo` text NOT NULL,
	`remote_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`mirror_path` text NOT NULL,
	`protected_at` integer,
	`last_fetched_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uq` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_uq` ON `projects` (`github_repo`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`branch` text NOT NULL,
	`worktree_scope` text NOT NULL,
	`workstation_id` text,
	`status` text NOT NULL,
	`pending_message` text,
	`report` text,
	`error` text,
	`turns` integer NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`limits` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_agent_idx` ON `runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_branch_uq` ON `runs` (`project_id`,`branch`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `workstations` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`last_check_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
