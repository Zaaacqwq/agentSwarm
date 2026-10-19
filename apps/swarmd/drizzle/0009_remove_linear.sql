DROP TABLE `linear_events`;--> statement-breakpoint
DROP TABLE `linear_sessions`;--> statement-breakpoint
ALTER TABLE `mission_messages` DROP COLUMN `linear_delivered_at`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `linear_project_id`;--> statement-breakpoint
-- The Linear connection: its client secret, webhook secret and OAuth tokens (sealed) go with it.
DELETE FROM `settings` WHERE `id` = 'linear';