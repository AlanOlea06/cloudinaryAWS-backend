-- ==============================================================================
-- MIGRACIÓN: ENDURECIMIENTO DE TICKETS Y TTL DE 5 MINUTOS (CLOUDINARY CLONE)
-- ==============================================================================
-- Esta migración agrega el soporte para expiración de tickets en 5 minutos,
-- estados de ticket expirado, e índices de alto rendimiento.

-- 1. Agregar columna expires_at a la tabla files (inglés)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'files') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'expires_at') THEN
            ALTER TABLE public.files ADD COLUMN expires_at TIMESTAMPTZ;
            COMMENT ON COLUMN public.files.expires_at IS 'Fecha y hora límite de validez del ticket (TTL de 5 minutos)';
        END IF;
    END IF;
END $$;

-- 2. Asegurar que el estado permita 'expired' en la tabla files
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'files_status_check'
    ) THEN
        ALTER TABLE public.files DROP CONSTRAINT files_status_check;
        ALTER TABLE public.files ADD CONSTRAINT files_status_check 
            CHECK (status IN ('pending_upload', 'completed', 'failed', 'expired', 'quarantined', 'deleted'));
    END IF;
END $$;

-- 3. Crear índices de búsqueda rápida por ticket_id y expires_at
CREATE INDEX IF NOT EXISTS idx_files_ticket_id ON public.files(ticket_id);
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON public.files(expires_at);

-- 4. Soporte para tabla legada archivos (español) en caso de que aún exista
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'archivos') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'archivos' AND column_name = 'expires_at') THEN
            ALTER TABLE public.archivos ADD COLUMN expires_at TIMESTAMPTZ;
        END IF;
    END IF;
END $$;
