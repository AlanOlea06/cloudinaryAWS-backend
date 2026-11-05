import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ==============================================================================
// 1. ORGANIZATIONS (TENANTS)
// ==============================================================================
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    max_api_keys: integer('max_api_keys').notNull().default(3),
    max_storage_bytes: bigint('max_storage_bytes', { mode: 'number' }),
    max_pending_tickets: integer('max_pending_tickets'),
    webhook_url: text('webhook_url'),
    webhook_secret: text('webhook_secret'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: index('idx_organizations_slug').on(table.slug),
  })
);

// ==============================================================================
// 2. USERS (MEMBERSHIP & RBAC)
// ==============================================================================
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    role: text('role').notNull().default('editor'),
    can_upload: boolean('can_upload').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdIdx: index('idx_users_org_id').on(table.org_id),
    emailIdx: index('idx_users_email').on(table.email),
  })
);

// ==============================================================================
// 3. API KEYS (SCOPED KEYS)
// ==============================================================================
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hashed_key: text('hashed_key').notNull(),
    can_read: boolean('can_read').notNull().default(true),
    can_upload: boolean('can_upload').notNull().default(true),
    can_delete: boolean('can_delete').notNull().default(false),
    can_manage_keys: boolean('can_manage_keys').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashedKeyIdx: index('idx_api_keys_hash').on(table.hashed_key),
    orgIdIdx: index('idx_api_keys_org_id').on(table.org_id),
    userIdIdx: index('idx_api_keys_user_id').on(table.user_id),
  })
);

// ==============================================================================
// 4. FILES (CANONICAL METADATA 3NF)
// ==============================================================================
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticket_id: uuid('ticket_id').notNull().unique().defaultRandom(),
    org_id: uuid('org_id')
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    original_name: text('original_name').notNull(),
    extension: varchar('extension', { length: 20 }),
    mime_type: text('mime_type').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256_hash: varchar('sha256_hash', { length: 64 }),
    sha256_verified: boolean('sha256_verified').default(false),
    resource_type: text('resource_type'),
    visibility: text('visibility').default('private'),
    s3_pending_key: text('s3_pending_key').notNull(),
    s3_processed_key: text('s3_processed_key'),
    s3_upload_id: text('s3_upload_id'),
    cloudfront_url: text('cloudfront_url'),
    status: text('status').notNull().default('pending_upload'),
    scan_status: varchar('scan_status', { length: 20 }).default('not_scanned'),
    threat_detected: boolean('threat_detected').default(false),
    retry_count: integer('retry_count').default(0),
    error_message: text('error_message'),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ticketIdx: index('idx_files_ticket_id').on(table.ticket_id),
    orgIdIdx: index('idx_files_org_id').on(table.org_id),
    userIdIdx: index('idx_files_user_id').on(table.user_id),
    statusIdx: index('idx_files_status').on(table.status),
    sha256Idx: index('idx_files_sha256').on(table.sha256_hash),
  })
);

// ==============================================================================
// 5. SERVICE LOGS (AUDIT & SECURITY TRAIL)
// ==============================================================================
export const serviceLogs = pgTable(
  'service_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ticket_id: uuid('ticket_id'),
    file_id: uuid('file_id'),
    action: text('action').notNull(),
    status: text('status').notNull(),
    http_method: text('http_method'),
    ip_address: text('ip_address').default('127.0.0.1'),
    message: text('message'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdIdx: index('idx_service_logs_org_id').on(table.org_id),
    userIdIdx: index('idx_service_logs_user_id').on(table.user_id),
    ticketIdIdx: index('idx_service_logs_ticket_id').on(table.ticket_id),
    fileIdIdx: index('idx_service_logs_file_id').on(table.file_id),
    createdAtIdx: index('idx_service_logs_created_at').on(table.created_at),
  })
);

// ==============================================================================
// 6. RATE LIMIT BUCKETS (SHARED STATE)
// ==============================================================================
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(1),
    window_start: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
    last_request_at: timestamp('last_request_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lastReqIdx: index('idx_rate_limit_buckets_last_request').on(table.last_request_at),
  })
);

// ==============================================================================
// 7. WEBHOOK DELIVERIES (PERSISTENT RETRY QUEUE)
// ==============================================================================
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    file_id: uuid('file_id').notNull(),
    event_type: text('event_type').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(5),
    next_retry_at: timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
    locked_until: timestamp('locked_until', { withTimezone: true }),
    last_status_code: integer('last_status_code'),
    last_error: text('last_error'),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusNextRetryIdx: index('idx_webhook_deliveries_status_retry').on(
      table.status,
      table.next_retry_at
    ),
    orgIdIdx: index('idx_webhook_deliveries_org_id').on(table.org_id),
  })
);

// ==============================================================================
// RELATIONS
// ==============================================================================
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  files: many(files),
  apiKeys: many(apiKeys),
  serviceLogs: many(serviceLogs),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.org_id],
    references: [organizations.id],
  }),
  files: many(files),
  apiKeys: many(apiKeys),
}));

export const filesRelations = relations(files, ({ one }) => ({
  organization: one(organizations, {
    fields: [files.org_id],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [files.user_id],
    references: [users.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.org_id],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [apiKeys.user_id],
    references: [users.id],
  }),
}));
