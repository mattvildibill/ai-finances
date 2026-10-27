import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const events = sqliteTable('events', {
 seq: integer('seq').primaryKey({autoIncrement:true}),
 id: text('id').notNull(),
 kind: text('kind').notNull(),
 created_at: text('created_at').notNull(),
 actor: text('actor').notNull(),
 payload: text('payload').notNull(),
 digest: text('digest').notNull(),
}, t=>[uniqueIndex('events_id_unique').on(t.id),uniqueIndex('events_single_inception').on(t.kind).where(sql`${t.kind} = 'experiment_opened'`)]);
export const locks = sqliteTable('locks', {name:text('name').primaryKey(), token:text('token').notNull(), expires_at:text('expires_at').notNull()});
