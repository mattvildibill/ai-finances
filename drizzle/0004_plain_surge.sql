CREATE TABLE `display_cache` (
	`name` text PRIMARY KEY NOT NULL,
	`payload` text,
	`token` text,
	`next_fetch_at` integer NOT NULL,
	`error` text
);
