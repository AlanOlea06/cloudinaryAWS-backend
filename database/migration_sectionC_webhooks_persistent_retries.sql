-- ==============================================================================
-- MIGRACIÓN: PERSISTENCIA Y REINTENTOS CON BACKOFF DE WEBHOOKS
-- ==============================================================================
-- Justificación técnica:
-- Registra de forma duradera cada intento de entrega de Webhook por evento
-- (file.uploaded, file.processed, file.failed) emitido hacia la URL configurada
-- en la organización, permitiendo que el Cron de mantenimiento procese reintentos
-- asíncronos con backoff exponencial real ante caídas temporales del receptor.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    target_url TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'delivered', 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_status_code INTEGER,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Índices de consulta eficiente
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending 
    ON public.webhook_deliveries (status, next_retry_at) 
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org 
    ON public.webhook_deliveries (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_file 
    ON public.webhook_deliveries (file_id);

COMMENT ON TABLE public.webhook_deliveries IS 'Registro transaccional de entregas de webhooks con control de reintentos y backoff exponencial';

-- ------------------------------------------------------------------------------
-- DOWN MIGRATION / ROLLBACK (REVERTIR EN CASO DE EMERGENCIA)
-- ------------------------------------------------------------------------------
/*
DROP INDEX IF EXISTS public.idx_webhook_deliveries_file;
DROP INDEX IF EXISTS public.idx_webhook_deliveries_org;
DROP INDEX IF EXISTS public.idx_webhook_deliveries_pending;
DROP TABLE IF EXISTS public.webhook_deliveries;
*/
