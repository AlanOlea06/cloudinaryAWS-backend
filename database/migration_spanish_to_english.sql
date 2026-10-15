-- ==============================================================================
-- MIGRATION SCRIPT: SPANISH TO STANDARDIZED ENGLISH
-- Migrates existing Supabase tables, columns, and constraints safely
-- ==============================================================================

-- 1. Rename Tables
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

-- 2. Rename Columns in 'organizations'
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'nombre') THEN
        ALTER TABLE public.organizations RENAME COLUMN nombre TO name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'descripcion') THEN
        ALTER TABLE public.organizations RENAME COLUMN descripcion TO description;
    END IF;
END $$;

-- 3. Rename Columns & Standardize Values in 'users'
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

-- Update Spanish role names to English
UPDATE public.users SET role = 'viewer' WHERE role = 'visitante';

-- 4. Rename Columns & Standardize Values in 'files'
DO $$
BEGIN
    -- Drop obsolete redundant columns if still present
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'user_name') THEN
        ALTER TABLE public.files DROP COLUMN user_name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'metadata') THEN
        ALTER TABLE public.files DROP COLUMN metadata;
    END IF;

    -- Rename columns to English
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
        ALTER TABLE public.files RENAME COLUMN tamano_final_bytes TO final_size_bytes;
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
END $$;

-- Update Spanish visibility values to English
UPDATE public.files SET visibility = 'private' WHERE visibility IN ('privados', 'privado');
UPDATE public.files SET visibility = 'public' WHERE visibility IN ('publicos', 'publico');

-- 5. Rename Columns in 'service_logs'
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
