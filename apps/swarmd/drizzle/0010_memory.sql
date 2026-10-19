CREATE TABLE `handbook_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`change` text NOT NULL,
	`why` text NOT NULL,
	`author` text NOT NULL,
	`source` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `handbook_proposals_status_idx` ON `handbook_proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `handbook_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `handbook_versions_idx` ON `handbook_versions` (`role`,`id`);--> statement-breakpoint
CREATE TABLE `handbooks` (
	`role` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lesson_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lesson_id` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lesson_versions_idx` ON `lesson_versions` (`lesson_id`,`id`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`role` text,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`source` text,
	`pinned` integer DEFAULT false NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lessons_scope_idx` ON `lessons` (`scope`,`project_id`,`role`);