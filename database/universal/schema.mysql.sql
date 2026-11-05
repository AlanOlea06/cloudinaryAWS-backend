-- ==============================================================================
-- UNIVERSAL DATABASE SCHEMA: MYSQL 8+ / MARIADB / PLANETSCALE / AWS RDS MYSQL
-- ==============================================================================

-- 1. ORGANIZATIONS (TENANTS)
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(191) NOT NULL UNIQUE,
    description TEXT,
    max_api_keys INT NOT NULL DEFAULT 3,
    max_storage_bytes BIGINT,
    max_pending_tickets INT,
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_organizations_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. USERS (RBAC & MEMBERSHIP)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    org_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(191) NOT NULL UNIQUE,
    role VARCHAR(20) NOT NULL DEFAULT 'editor',
    can_upload BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_users_org_id (org_id),
    INDEX idx_users_email (email),
    CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. API KEYS (SCOPED ACCESS TOKENS)
CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(36) PRIMARY KEY,
    org_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NULL,
    key_hash VARCHAR(191) NOT NULL,
    key_prefix VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    can_upload BOOLEAN NOT NULL DEFAULT TRUE,
    can_read BOOLEAN NOT NULL DEFAULT TRUE,
    can_delete BOOLEAN NOT NULL DEFAULT FALSE,
    can_manage_keys BOOLEAN NOT NULL DEFAULT FALSE,
    rate_limit_per_minute INT NULL,
    rate_limit_per_second INT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_api_keys_hash (key_hash),
    INDEX idx_api_keys_org_id (org_id),
    INDEX idx_api_keys_user_id (user_id),
    CONSTRAINT fk_keys_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT fk_keys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. FILES (3NF CANONICAL METADATA)
CREATE TABLE IF NOT EXISTS files (
    id VARCHAR(36) PRIMARY KEY,
    ticket_id VARCHAR(36) NOT NULL UNIQUE,
    org_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    extension VARCHAR(20) NOT NULL DEFAULT '',
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    sha256_verified BOOLEAN DEFAULT FALSE,
    resource_type VARCHAR(50) NOT NULL,
    visibility VARCHAR(20) NOT NULL DEFAULT 'private',
    s3_pending_key VARCHAR(500) NOT NULL,
    s3_processed_key VARCHAR(500) NULL,
    s3_upload_id VARCHAR(255) NULL,
    cloudfront_url VARCHAR(500) NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_upload',
    scan_status VARCHAR(20) DEFAULT 'not_scanned',
    error_message TEXT NULL,
    completed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_files_ticket_id (ticket_id),
    INDEX idx_files_org_id (org_id),
    INDEX idx_files_user_id (user_id),
    INDEX idx_files_status (status),
    INDEX idx_files_sha256 (sha256_hash),
    CONSTRAINT fk_files_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT fk_files_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. SERVICE LOGS (AUDIT & SECURITY LOGS)
CREATE TABLE IF NOT EXISTS service_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    org_id VARCHAR(36) NULL,
    user_id VARCHAR(36) NULL,
    ticket_id VARCHAR(36) NULL,
    file_id VARCHAR(36) NULL,
    action VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    http_method VARCHAR(10) NULL,
    ip_address VARCHAR(45) DEFAULT '127.0.0.1',
    message TEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_service_logs_created_at (created_at DESC),
    INDEX idx_service_logs_org_id (org_id),
    INDEX idx_service_logs_ticket_id (ticket_id),
    INDEX idx_service_logs_file_id (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. RATE LIMIT BUCKETS (SLIDING WINDOW)
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    `key` VARCHAR(191) PRIMARY KEY,
    count INT NOT NULL DEFAULT 1,
    window_start DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_request_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_rate_limit_buckets_last_request (last_request_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. WEBHOOK DELIVERIES (PERSISTENT RETRY QUEUE)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id VARCHAR(36) PRIMARY KEY,
    org_id VARCHAR(36) NOT NULL,
    file_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_retry_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    locked_until DATETIME(6) NULL,
    last_status_code INT NULL,
    last_error TEXT NULL,
    delivered_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_webhook_deliveries_pending (status, next_retry_at),
    INDEX idx_webhook_deliveries_org_id (org_id),
    CONSTRAINT fk_webhooks_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
