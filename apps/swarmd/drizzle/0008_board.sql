CREATE TABLE `ticket_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`name` text NOT NULL,
	`file` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_attachments_ticket_idx` ON `ticket_attachments` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`,`id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`number` integer NOT NULL,
	`space` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`kind` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`position` real NOT NULL,
	`mission_id` text,
	`created_by` text NOT NULL,
	`from_ticket_id` text,
	`commit_attachments` integer DEFAULT true NOT NULL,
	`external` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_key_uq` ON `tickets` (`prefix`,`number`);--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_mission_uq` ON `tickets` (`mission_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `ticket_prefix` text;