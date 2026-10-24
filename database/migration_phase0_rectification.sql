-- ==============================================================================
-- MIGRACIÓN FASE 0 (RECTIFICACIÓN DE SEGURIDAD Y ARQUITECTURA)
-- Decisiones aprobadas: 1-A, 2-B, 3-A, 4-OK
-- 100% Aditiva y Reversible (incluye bloque ROLLBACK documentado al final)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR CAMBIOS)
-- ------------------------------------------------------------------------------

-- 1. Decisión 1-A: Vincular cada API Key a un usuario propietario (user_id)
-- Permite que el Edge Middleware inyecte x-validated-user-id desde la base de datos
-- y cierre el vector de suplantación de userId dentro de la misma organización.
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);

-- 2. Decisión 3-A y Bloque B (Tareas B.6, B.8, B.9): Columnas operativas en public.files
-- - s3_upload_id: rastrea el UploadId de S3 para Multipart Upload (ya que IAM no tiene s3:ListBucketMultipartUploads)
-- - retry_count y error_message: control de reintentos para el Cron de mantenimiento
-- - scan_status: valor por defecto 'not_scanned' hasta que se habilite AWS GuardDuty
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS s3_upload_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message TEXT NULL;

ALTER TABLE public.files
  ALTER COLUMN scan_status SET DEFAULT 'not_scanned';

UPDATE public.files
SET scan_status = 'not_scanned'
WHERE scan_status IS NULL OR scan_status = 'PENDIENTE';

CREATE INDEX IF NOT EXISTS idx_files_scan_status ON public.files(scan_status);
CREATE INDEX IF NOT EXISTS idx_files_status_created_at ON public.files(status, created_at);

-- 3. Tareas B.7 y B.13: Cuotas por organización y configuración de Webhooks
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS max_storage_bytes BIGINT NOT NULL DEFAULT 524288000, -- 500 MB por defecto
  ADD COLUMN IF NOT EXISTS max_pending_tickets INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS webhook_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT NULL;


-- ==============================================================================
-- DOWN MIGRATION / ROLLBACK (EJECUTAR SOLO SI SE DESEA REVERTIR)
-- ==============================================================================
/*
DROP INDEX IF EXISTS public.idx_api_keys_user_id;
ALTER TABLE public.api_keys
  DROP COLUMN IF EXISTS user_id;

DROP INDEX IF EXISTS public.idx_files_scan_status;
DROP INDEX IF EXISTS public.idx_files_status_created_at;
ALTER TABLE public.files
  DROP COLUMN IF EXISTS s3_upload_id,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS error_message;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS max_storage_bytes,
  DROP COLUMN IF EXISTS max_pending_tickets,
  DROP COLUMN IF EXISTS webhook_url,
  DROP COLUMN IF EXISTS webhook_secret;
*/
