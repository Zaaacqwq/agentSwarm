ALTER TABLE `missions` ADD `options` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `options` text DEFAULT '{}' NOT NULL;