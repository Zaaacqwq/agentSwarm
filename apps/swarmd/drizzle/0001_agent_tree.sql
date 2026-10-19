DROP INDEX `runs_branch_uq`;--> statement-breakpoint
ALTER TABLE `runs` ADD `tree_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `budget_usd` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `kind` text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `review_of` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `review` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `merged_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `waiting_for` text;--> statement-breakpoint
CREATE INDEX `runs_branch_idx` ON `runs` (`project_id`,`branch`);--> statement-breakpoint
CREATE INDEX `runs_tree_idx` ON `runs` (`tree_id`);--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `ephemeral` integer DEFAULT false NOT NULL;