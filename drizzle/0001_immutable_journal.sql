CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Journal events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Journal events are immutable'); END;
--> statement-breakpoint
CREATE INDEX events_kind_seq ON events(kind, seq);
--> statement-breakpoint
CREATE INDEX events_created_at ON events(created_at);
