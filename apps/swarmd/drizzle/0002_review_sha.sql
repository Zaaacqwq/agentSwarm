ALTER TABLE `runs` ADD `review_sha` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_task_branch_uq` ON `runs` (`project_id`,`branch`) WHERE kind = 'task';