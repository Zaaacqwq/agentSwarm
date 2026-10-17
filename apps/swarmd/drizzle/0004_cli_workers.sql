ALTER TABLE `runs` ADD `cli_session` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `estimated_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workstations` ADD `codex_login_at` integer;