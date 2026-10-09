CREATE TABLE `chains` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`origin_kind` text NOT NULL,
	`origin_message_id` integer,
	`budget` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`paused_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chains_origin_ck" CHECK("chains"."origin_kind" in ('user','agent'))
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_id` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `actor_kind`, `actor_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reactions_message_idx` ON `reactions` (`message_id`);--> statement-breakpoint
CREATE TABLE `__new_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`dm_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channels_kind_ck" CHECK("kind" in ('dm','group','agent_dm'))
);
--> statement-breakpoint
INSERT INTO `__new_channels`("id", "org_id", "owner_user_id", "kind", "title", "dm_key", "created_at") SELECT "id", "org_id", "owner_user_id", "kind", NULL, "dm_key", "created_at" FROM `channels`;--> statement-breakpoint
DROP TABLE `channels`;--> statement-breakpoint
ALTER TABLE `__new_channels` RENAME TO `channels`;--> statement-breakpoint
CREATE UNIQUE INDEX `channels_dm_key_uq` ON `channels` (`dm_key`);--> statement-breakpoint
ALTER TABLE `messages` ADD `author_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_id` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `chain_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `mentions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_chain_idx` ON `messages` (`chain_id`);--> statement-breakpoint
CREATE INDEX `messages_author_idx` ON `messages` (`author_kind`,`author_id`,`created_at`);--> statement-breakpoint
UPDATE `messages` SET `author_name` = COALESCE((SELECT `username` FROM `users` WHERE `users`.`id` = `messages`.`author_id`), (SELECT `name` FROM `agents` WHERE `agents`.`id` = `messages`.`author_id`), 'system') WHERE `author_name` = '';--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(`body`, content='messages', content_rowid='id', tokenize='trigram');--> statement-breakpoint
INSERT INTO `messages_fts`(`rowid`, `body`) SELECT `id`, `body` FROM `messages`;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN INSERT INTO `messages_fts`(`rowid`, `body`) VALUES (new.`id`, new.`body`); END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body`) VALUES ('delete', old.`id`, old.`body`); END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE OF `body` ON `messages` BEGIN INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body`) VALUES ('delete', old.`id`, old.`body`); INSERT INTO `messages_fts`(`rowid`, `body`) VALUES (new.`id`, new.`body`); END;
