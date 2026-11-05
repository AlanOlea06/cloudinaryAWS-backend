-- ==============================================================================
-- UNIVERSAL DATABASE SCHEMA: POSTGRESQL (AWS RDS / NEON / SUPABASE / DOCKER)
-- ==============================================================================

-- 1. ORGANIZATIONS (TENANTS)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    max_api_keys INTEGER NOT NULL DEFAULT 3,
    max_storage_bytes BIGINT,
    max_pending_tickets INTEGER,
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations (slug);

-- 2. USERS (RBAC & MEMBERSHIP)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
    can_upload BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- 3. API KEYS (SCOPED ACCESS TOKENS)
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    can_upload BOOLEAN NOT NULL DEFAULT true,
    can_read BOOLEAN NOT NULL DEFAULT true,
    can_delete BOOLEAN NOT NULL DEFAULT false,
    can_manage_keys BOOLEAN NOT NULL DEFAULT false,
    rate_limit_per_minute INTEGER,
    rate_limit_per_second INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

-- 4. FILES (3NF CANONICAL METADATA)
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    extension VARCHAR(20) NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    sha256_verified BOOLEAN DEFAULT false,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('images', 'documents', 'videos', 'raw')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    s3_pending_key TEXT NOT NULL,
    s3_processed_key TEXT,
    s3_upload_id TEXT,
    cloudfront_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending_upload',
    scan_status VARCHAR(20) DEFAULT 'not_scanned',
    error_message TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_files_ticket_id ON files (ticket_id);
CREATE INDEX IF NOT EXISTS idx_files_org_id ON files (org_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files (user_id);
CREATE INDEX IF NOT EXISTS idx_files_status ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files (sha256_hash);

-- 5. SERVICE LOGS (AUDIT & SECURITY LOGS)
CREATE TABLE IF NOT EXISTS service_logs (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ticket_id UUID,
    file_id UUID,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    http_method TEXT,
    ip_address TEXT DEFAULT '127.0.0.1',
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_service_logs_created_at ON service_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_logs_org_id ON service_logs (org_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_ticket_id ON service_logs (ticket_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_file_id ON service_logs (file_id);

-- 6. RATE LIMIT BUCKETS (SLIDING WINDOW)
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_request_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_request ON rate_limit_buckets (last_request_at);

-- 7. WEBHOOK DELIVERIES (PERSISTENT RETRY QUEUE)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    last_status_code INTEGER,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org_id ON webhook_deliveries (org_id);
