CREATE TABLE `linear_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `linear_events_pending_idx` ON `linear_events` (`processed_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `linear_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`issue_key` text NOT NULL,
	`issue_url` text NOT NULL,
	`title` text NOT NULL,
	`priority` integer NOT NULL,
	`status` text NOT NULL,
	`mission_id` text,
	`request` text NOT NULL,
	`plan_digest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `linear_sessions_status_idx` ON `linear_sessions` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `linear_sessions_mission_idx` ON `linear_sessions` (`mission_id`);--> statement-breakpoint
CREATE TABLE `project_files` (
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`content_sealed` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `path`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mission_messages` ADD `linear_delivered_at` integer;--> statement-breakpoint
ALTER TABLE `missions` ADD `kind` text DEFAULT 'feature' NOT NULL;--> statement-breakpoint
ALTER TABLE `missions` ADD `origin` text DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `kind` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `profile` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `linear_project_id` text;