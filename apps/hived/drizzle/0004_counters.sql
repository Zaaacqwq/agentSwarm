CREATE TABLE `org_counters` (
	`org_id` text PRIMARY KEY NOT NULL,
	`next_task_number` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
