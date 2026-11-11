CREATE TABLE `calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`event_id` text,
	`title` text,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `calls_application` ON `calls` (`application_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `calls_event` ON `calls` (`event_id`);