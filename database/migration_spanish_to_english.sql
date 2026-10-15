-- ==============================================================================
-- MIGRATION SCRIPT: SPANISH TO STANDARDIZED ENGLISH (ROBUST & SAFE)
-- Fixes constraint violations by dropping old Spanish checks before updating values
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- STEP 1: Rename Tables (if not already renamed)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizaciones') THEN
        ALTER TABLE public.organizaciones RENAME TO organizations;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
        ALTER TABLE public.usuarios RENAME TO users;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'archivos') THEN
        ALTER TABLE public.archivos RENAME TO files;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'logs_servicio') THEN
        ALTER TABLE public.logs_servicio RENAME TO service_logs;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 2: Drop Old Spanish Check Constraints (To avoid Error 23514)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    -- Drop old constraints on files or archivos if present
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'files') THEN
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS archivos_visibilidad_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS archivos_tipo_recurso_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS archivos_estado_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_visibilidad_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_tipo_recurso_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_estado_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_visibility_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_resource_type_check;
        ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_status_check;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'archivos') THEN
        ALTER TABLE public.archivos DROP CONSTRAINT IF EXISTS archivos_visibilidad_check;
        ALTER TABLE public.archivos DROP CONSTRAINT IF EXISTS archivos_tipo_recurso_check;
        ALTER TABLE public.archivos DROP CONSTRAINT IF EXISTS archivos_estado_check;
    END IF;

    -- Drop old constraints on users or usuarios
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
        ALTER TABLE public.users DROP CONSTRAINT IF EXISTS usuarios_rol_check;
        ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_rol_check;
        ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
        ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
    END IF;
EXCEPTION
    WHEN undefined_table THEN null;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 3: Rename Columns in 'organizations'
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'nombre') THEN
        ALTER TABLE public.organizations RENAME COLUMN nombre TO name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'descripcion') THEN
        ALTER TABLE public.organizations RENAME COLUMN descripcion TO description;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 4: Rename Columns in 'users'
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'nombre') THEN
        ALTER TABLE public.users RENAME COLUMN nombre TO name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'rol') THEN
        ALTER TABLE public.users RENAME COLUMN rol TO role;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'puede_subir') THEN
        ALTER TABLE public.users RENAME COLUMN puede_subir TO can_upload;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 5: Rename Columns in 'files'
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    -- Drop obsolete redundant columns
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'user_name') THEN
        ALTER TABLE public.files DROP COLUMN user_name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'metadata') THEN
        ALTER TABLE public.files DROP COLUMN metadata;
    END IF;

    -- Rename columns
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'nombre_original') THEN
        ALTER TABLE public.files RENAME COLUMN nombre_original TO original_name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'formato') THEN
        ALTER TABLE public.files RENAME COLUMN formato TO mime_type;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'tamano_bytes') THEN
        ALTER TABLE public.files RENAME COLUMN tamano_bytes TO size_bytes;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'tamano_final_bytes') THEN
        ALTER TABLE public.files DROP COLUMN tamano_final_bytes;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'final_size_bytes') THEN
        ALTER TABLE public.files DROP COLUMN final_size_bytes;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'hash_sha256') THEN
        ALTER TABLE public.files RENAME COLUMN hash_sha256 TO sha256_hash;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'tipo_recurso') THEN
        ALTER TABLE public.files RENAME COLUMN tipo_recurso TO resource_type;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'visibilidad') THEN
        ALTER TABLE public.files RENAME COLUMN visibilidad TO visibility;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 's3_key_pendiente') THEN
        ALTER TABLE public.files RENAME COLUMN s3_key_pendiente TO s3_pending_key;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 's3_key_procesado') THEN
        ALTER TABLE public.files RENAME COLUMN s3_key_procesado TO s3_processed_key;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'estado') THEN
        ALTER TABLE public.files RENAME COLUMN estado TO status;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'completado_at') THEN
        ALTER TABLE public.files RENAME COLUMN completado_at TO completed_at;
    END IF;

    -- Add extension column if not present
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'extension') THEN
        ALTER TABLE public.files ADD COLUMN extension VARCHAR(20);
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 6: Rename Columns in 'service_logs'
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'service_logs' AND column_name = 'accion') THEN
        ALTER TABLE public.service_logs RENAME COLUMN accion TO action;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'service_logs' AND column_name = 'estado') THEN
        ALTER TABLE public.service_logs RENAME COLUMN estado TO status;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'service_logs' AND column_name = 'archivo_nombre') THEN
        ALTER TABLE public.service_logs RENAME COLUMN archivo_nombre TO file_name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'service_logs' AND column_name = 'ip_origen') THEN
        ALTER TABLE public.service_logs RENAME COLUMN ip_origen TO ip_address;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'service_logs' AND column_name = 'detalles') THEN
        ALTER TABLE public.service_logs RENAME COLUMN detalles TO details;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- STEP 7: Convert Status column to TEXT to allow English values seamlessly
-- ------------------------------------------------------------------------------
ALTER TABLE public.files ALTER COLUMN status TYPE TEXT USING status::text;

-- ------------------------------------------------------------------------------
-- STEP 8: Translate Data Values in 'files' and 'users'
-- ------------------------------------------------------------------------------
-- Visibility
UPDATE public.files SET visibility = 'private' WHERE visibility IN ('privados', 'privado');
UPDATE public.files SET visibility = 'public' WHERE visibility IN ('publicos', 'publico');

-- Resource Type
UPDATE public.files SET resource_type = 'images' WHERE resource_type IN ('imagenes', 'imagen');
UPDATE public.files SET resource_type = 'documents' WHERE resource_type IN ('documentos', 'documento');
UPDATE public.files SET resource_type = 'videos' WHERE resource_type IN ('videos', 'video');

-- Extension (Extract suffix like .docx or .html from original_name)
UPDATE public.files 
SET extension = COALESCE('.' || LOWER(SUBSTRING(original_name FROM '\.([^\.]+)$')), '')
WHERE extension IS NULL OR extension = '';

ALTER TABLE public.files ALTER COLUMN extension SET DEFAULT '';

-- Status
UPDATE public.files SET status = 'pending_upload' WHERE status = 'pendiente_subida';
UPDATE public.files SET status = 'uploaded_pending_processing' WHERE status = 'subido_pendiente_proc';
UPDATE public.files SET status = 'processing' WHERE status = 'procesando';
UPDATE public.files SET status = 'completed' WHERE status = 'completado';
UPDATE public.files SET status = 'failed' WHERE status = 'error';
UPDATE public.files SET status = 'security_rejected' WHERE status = 'rechazado_seguridad';

-- Users Role
UPDATE public.users SET role = 'viewer' WHERE role IN ('visitante', 'miembro');

-- ------------------------------------------------------------------------------
-- STEP 9: Add New English Check Constraints
-- ------------------------------------------------------------------------------
ALTER TABLE public.files 
    ADD CONSTRAINT files_visibility_check 
    CHECK (visibility IN ('public', 'private'));

ALTER TABLE public.files 
    ADD CONSTRAINT files_resource_type_check 
    CHECK (resource_type IN ('images', 'documents', 'videos'));

ALTER TABLE public.files 
    ADD CONSTRAINT files_status_check 
    CHECK (status IN ('pending_upload', 'uploaded_pending_processing', 'processing', 'completed', 'failed', 'security_rejected'));

ALTER TABLE public.users 
    ADD CONSTRAINT users_role_check 
    CHECK (role IN ('admin', 'editor', 'viewer'));
