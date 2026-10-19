CREATE TABLE `mission_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mission_id` text NOT NULL,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`discord_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mission_messages_idx` ON `mission_messages` (`mission_id`,`id`);--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`intent` text NOT NULL,
	`stage` text NOT NULL,
	`fast` integer NOT NULL,
	`lead_agent_id` text NOT NULL,
	`root_run_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`docs_path` text NOT NULL,
	`pending_stage` text,
	`stage_summary` text,
	`retro` text,
	`docs` text NOT NULL,
	`discord_thread_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `missions_project_idx` ON `missions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `missions_stage_idx` ON `missions` (`stage`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`secret_sealed` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `mission_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_state` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `cleaned_at` integer;--> statement-breakpoint
CREATE INDEX `runs_mission_idx` ON `runs` (`mission_id`);