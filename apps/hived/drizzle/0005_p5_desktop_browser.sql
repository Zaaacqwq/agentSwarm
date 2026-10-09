CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`channel_id` text,
	`message_id` integer,
	`kind` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`question` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`duration_ms` integer,
	`decided_by` text,
	`decided_at` integer,
	`timeout_at` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_kind_ck" CHECK(`kind` in ('question','desktop','browser_site')),
	CONSTRAINT "approvals_status_ck" CHECK(`status` in ('pending','approved','denied','expired','cancelled','revoked'))
);
--> statement-breakpoint
CREATE INDEX `approvals_agent_idx` ON `approvals` (`agent_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `approvals_org_status_idx` ON `approvals` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `approvals_channel_idx` ON `approvals` (`channel_id`);--> statement-breakpoint
CREATE TABLE `browser_profiles` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`source` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `screenshots_agent_idx` ON `screenshots` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `screenshots_created_idx` ON `screenshots` (`created_at`);