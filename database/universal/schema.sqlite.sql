-- ==============================================================================
-- UNIVERSAL DATABASE SCHEMA: SQLITE 3 / TURSO (EDGE REPLICATED SQLITE)
-- ==============================================================================

PRAGMA foreign_keys = ON;

-- 1. ORGANIZATIONS (TENANTS)
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    max_api_keys INTEGER NOT NULL DEFAULT 3,
    max_storage_bytes INTEGER,
    max_pending_tickets INTEGER,
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations (slug);

-- 2. USERS (RBAC & MEMBERSHIP)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'editor',
    can_upload INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- 3. API KEYS (SCOPED ACCESS TOKENS)
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    can_upload INTEGER NOT NULL DEFAULT 1,
    can_read INTEGER NOT NULL DEFAULT 1,
    can_delete INTEGER NOT NULL DEFAULT 0,
    can_manage_keys INTEGER NOT NULL DEFAULT 0,
    rate_limit_per_minute INTEGER,
    rate_limit_per_second INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

-- 4. FILES (3NF CANONICAL METADATA)
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    extension TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256_hash TEXT NOT NULL,
    sha256_verified INTEGER DEFAULT 0,
    resource_type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    s3_pending_key TEXT NOT NULL,
    s3_processed_key TEXT,
    s3_upload_id TEXT,
    cloudfront_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending_upload',
    scan_status TEXT DEFAULT 'not_scanned',
    error_message TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_ticket_id ON files (ticket_id);
CREATE INDEX IF NOT EXISTS idx_files_org_id ON files (org_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files (user_id);
CREATE INDEX IF NOT EXISTS idx_files_status ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files (sha256_hash);

-- 5. SERVICE LOGS (AUDIT & SECURITY LOGS)
CREATE TABLE IF NOT EXISTS service_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT,
    user_id TEXT,
    ticket_id TEXT,
    file_id TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    http_method TEXT,
    ip_address TEXT DEFAULT '127.0.0.1',
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_service_logs_created_at ON service_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_logs_org_id ON service_logs (org_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_ticket_id ON service_logs (ticket_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_file_id ON service_logs (file_id);

-- 6. RATE LIMIT BUCKETS (SLIDING WINDOW)
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL DEFAULT (datetime('now')),
    last_request_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_request ON rate_limit_buckets (last_request_at);

-- 7. WEBHOOK DELIVERIES (PERSISTENT RETRY QUEUE)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
    locked_until TEXT,
    last_status_code INTEGER,
    last_error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org_id ON webhook_deliveries (org_id);
