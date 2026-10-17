ALTER TABLE `linear_events` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `linear_sessions` ADD `final_sent_at` integer;