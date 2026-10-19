CREATE TABLE `ticket_files` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`name` text NOT NULL,
	`file` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_files_ticket_idx` ON `ticket_files` (`ticket_id`);--> statement-breakpoint
ALTER TABLE `missions` ADD `options` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `options` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `blocked_by` text DEFAULT '[]' NOT NULL;