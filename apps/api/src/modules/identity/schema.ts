import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  subject: text('subject').notNull().unique(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  roles: text('roles').array().notNull().default([]),
  divisions: text('divisions').array().notNull().default([]),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});
