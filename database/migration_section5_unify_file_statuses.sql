-- ==============================================================================
-- MIGRACIÓN SECCIÓN 5: UNIFICACIÓN DE ESTADOS DE ARCHIVOS Y CICLO SIN PROCESAMIENTO
-- ==============================================================================
-- Justificación:
-- 1. Elimina el alias transitorio 'processed' y establece el estado canónico 'uploaded'
--    para archivos verificados en S3 directamente por el cliente sin procesamiento Vercel.
-- 2. Actualiza la restricción CHECK en public.files para admitir:
--    - Estados actuales: 'pending_upload', 'uploaded', 'failed', 'expired', 'quarantined', 'deleted'
--    - Estados futuros (cuando exista AWS Lambda): 'uploaded_pending_processing', 'processing', 'completed'
-- 3. Migración 100% aditiva y reversible.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR)
-- ------------------------------------------------------------------------------

-- 1. Actualizar restricción files_status_check en public.files
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'files_status_check'
    ) THEN
        ALTER TABLE public.files DROP CONSTRAINT files_status_check;
    END IF;

    ALTER TABLE public.files ADD CONSTRAINT files_status_check 
        CHECK (status IN (
            'pending_upload',
            'uploaded',
            'uploaded_pending_processing',
            'processing',
            'completed',
            'failed',
            'expired',
            'quarantined',
            'deleted'
        ));
END $$;

-- 2. Migrar registros históricos con status = 'processed' o 'completed' no procesados a 'uploaded'
UPDATE public.files
SET status = 'uploaded',
    scan_status = 'not_scanned',
    updated_at = timezone('utc'::text, now())
WHERE status IN ('processed', 'completed')
  AND (scan_status IS NULL OR scan_status = 'not_scanned');

-- 3. Índice para acelerar filtros de cuotas y búsquedas por estado
CREATE INDEX IF NOT EXISTS idx_files_status_uploaded ON public.files(status) WHERE status = 'uploaded';


-- ------------------------------------------------------------------------------
-- DOWN MIGRATION / ROLLBACK (REVERTIR EN CASO DE EMERGENCIA)
-- ------------------------------------------------------------------------------
/*
DROP INDEX IF EXISTS public.idx_files_status_uploaded;

UPDATE public.files
SET status = 'completed',
    updated_at = timezone('utc'::text, now())
WHERE status = 'uploaded';

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
*/
