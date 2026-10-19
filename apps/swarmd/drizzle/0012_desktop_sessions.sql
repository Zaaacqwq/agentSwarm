CREATE TABLE `desktop_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent` text NOT NULL,
	`purpose` text NOT NULL,
	`minutes` integer NOT NULL,
	`status` text NOT NULL,
	`until` integer,
	`end_reason` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `desktop_sessions_status_idx` ON `desktop_sessions` (`status`,`created_at`);