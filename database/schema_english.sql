-- ==============================================================================
-- CLOUDINARY CLONE: STANDARDIZED ENGLISH RELATIONAL SCHEMA (3NF / PURE SQL)
-- Database: Supabase / PostgreSQL
-- Tables: organizations, users, files, service_logs
-- ==============================================================================

-- 1. ENUM Types
DO $$ BEGIN
    CREATE TYPE file_status AS ENUM (
        'pending_upload',               -- Ticket issued, awaiting direct S3 upload
        'uploaded_pending_processing',  -- In S3 landing zone, waiting for worker/Lambda
        'processing',                   -- Worker optimizing/transforming asset
        'completed',                    -- Processed and moved to permanent destination
        'failed',                       -- Upload or processing failed
        'security_rejected'             -- GuardDuty/Antivirus detected threat
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Organizations Table (Tenants)
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,          -- e.g. 'organization_1', 'organization_2'
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Users Table (RBAC & Multi-Tenant Membership)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
    can_upload BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Files Table (Normalized 3NF - Pure SQL, Zero JSON Blobs)
CREATE TABLE IF NOT EXISTS public.files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,                         -- e.g. 'image/png', 'application/pdf'
    size_bytes BIGINT NOT NULL,                      -- Original file size in bytes
    final_size_bytes BIGINT,                         -- Post-optimization size
    sha256_hash VARCHAR(64) NOT NULL,               -- Native SHA-256 integrity hash
    resource_type TEXT NOT NULL CHECK (resource_type IN ('images', 'documents', 'videos')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    s3_pending_key TEXT NOT NULL,                    -- pending/{user_id}/{filename}
    s3_processed_key TEXT,                           -- organizations/{slug}/{type}/{visibility}/{ticket_id}-{filename}
    cloudfront_url TEXT,                             -- CDN delivery URL
    status file_status NOT NULL DEFAULT 'pending_upload',
    scan_status VARCHAR(20) DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING', 'CLEAN', 'THREAT_DETECTED', 'NOT_APPLICABLE')),
    threat_detected BOOLEAN DEFAULT false,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 5. Service Logs Table (Audit & Security Events)
CREATE TABLE IF NOT EXISTS public.service_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ticket_id UUID,
    action TEXT NOT NULL,                            -- e.g. 'TICKET_ISSUED', 'CROSS_ORG_DENIED', 'S3_UPLOAD_CONFIRMED'
    status TEXT NOT NULL,                            -- e.g. 'ALLOWED', 'DENIED_CROSS_ORG', 'DENIED_NO_PERMISSION'
    file_name TEXT,
    ip_address TEXT DEFAULT '127.0.0.1',
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 6. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_files_user_id ON public.files (user_id);
CREATE INDEX IF NOT EXISTS idx_files_org_id ON public.files (org_id);
CREATE INDEX IF NOT EXISTS idx_files_ticket_id ON public.files (ticket_id);
CREATE INDEX IF NOT EXISTS idx_files_sha256_hash ON public.files (sha256_hash);
CREATE INDEX IF NOT EXISTS idx_files_status ON public.files (status);
CREATE INDEX IF NOT EXISTS idx_users_org_id ON public.users (org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_service_logs_org_id ON public.service_logs (org_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_user_id ON public.service_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_created_at ON public.service_logs (created_at DESC);

-- 7. Auto-update Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_files_updated_at ON public.files;
CREATE TRIGGER trigger_files_updated_at
BEFORE UPDATE ON public.files
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- SEED DATA (Organizations & Users)
-- Consistent UUIDs matching test environment
-- ==============================================================================

-- Organizations
INSERT INTO public.organizations (id, name, slug, description)
VALUES 
    ('11111111-1111-1111-1111-111111111111', 'Organization 1', 'organization_1', 'Enterprise Account Alpha'),
    ('22222222-2222-2222-2222-222222222222', 'Organization 2', 'organization_2', 'Enterprise Account Beta')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;

-- Organization 1 Users (10 Members)
INSERT INTO public.users (id, org_id, name, email, role, can_upload)
VALUES
    ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Carlos Mendoza', 'carlos.mendoza@org1.com', 'admin', true),
    ('a1111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Ana Beltran', 'ana.beltran@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Roberto Morales', 'roberto.morales@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Lucia Vega', 'lucia.vega@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Diego Solis', 'diego.solis@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Elena Castillo', 'elena.castillo@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'Javier Ramos', 'javier.ramos@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'Sofia Pineda', 'sofia.pineda@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'Fernando Ortiz', 'fernando.ortiz@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'Valeria Ruiz (No Permission)', 'valeria.ruiz@org1.com', 'viewer', false)
ON CONFLICT (id) DO UPDATE SET can_upload = EXCLUDED.can_upload, role = EXCLUDED.role;

-- Organization 2 Users (5 Members)
INSERT INTO public.users (id, org_id, name, email, role, can_upload)
VALUES
    ('b2222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Mateo Delgado', 'mateo.delgado@org2.com', 'admin', true),
    ('b2222222-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Camila Herrera', 'camila.herrera@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'Andres Navarro', 'andres.navarro@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Paula Cardenas', 'paula.cardenas@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'Gabriel Fuentes (No Permission)', 'gabriel.fuentes@org2.com', 'viewer', false)
ON CONFLICT (id) DO UPDATE SET can_upload = EXCLUDED.can_upload, role = EXCLUDED.role;
