-- ==============================================================================
-- MIGRACIÓN 3: ENTREGAS DE WEBHOOK PERSISTENTES CON REINTENTOS
-- ==============================================================================
-- Diseño:
-- - La tabla NO guarda payload ni URL de destino. Al enviar, el backend:
--     1) lee webhook_url y webhook_secret ACTUALES de public.organizations,
--     2) revalida SSRF en ese momento,
--     3) construye el payload a partir de public.files (sin claves de S3).
-- - status: pending | sending | delivered | failed (CHECK).
-- - event_type: file.uploaded | file.processed | file.failed (CHECK).
-- - Reclamo atómico con claim_webhook_deliveries(): UPDATE ... FOR UPDATE SKIP LOCKED
--   pasa filas pending vencidas a 'sending' con locked_until. Dos ejecutores
--   concurrentes (cron y envío inmediato) nunca reclaman la misma fila.
--   Las filas 'sending' con locked_until vencido vuelven a 'pending'
--   (o a 'failed' si ya agotaron intentos).
-- - last_error guarda solo un código corto (máx. 200 caracteres), nunca cuerpos
--   de respuesta ni URLs.
-- - RLS activado sin políticas; sin privilegios para anon/authenticated.
--   Solo service_role (backend) opera la tabla.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP
-- ------------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    file_id          UUID NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 5,
    next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until     TIMESTAMPTZ,
    last_status_code INTEGER,
    last_error       TEXT,
    delivered_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_event_type_check
        CHECK (event_type IN ('file.uploaded', 'file.processed', 'file.failed')),
    CONSTRAINT webhook_deliveries_status_check
        CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    CONSTRAINT webhook_deliveries_attempts_check
        CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
    CONSTRAINT webhook_deliveries_sending_lock_check
        CHECK (status <> 'sending' OR locked_until IS NOT NULL),
    CONSTRAINT webhook_deliveries_last_error_check
        CHECK (last_error IS NULL OR char_length(last_error) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
    ON public.webhook_deliveries (next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sending
    ON public.webhook_deliveries (locked_until) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retention
    ON public.webhook_deliveries (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org
    ON public.webhook_deliveries (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_file
    ON public.webhook_deliveries (file_id);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_deliveries FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_deliveries FROM anon;
REVOKE ALL ON TABLE public.webhook_deliveries FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_deliveries TO service_role;

-- Reclamo atómico de entregas
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(
    p_limit        INTEGER DEFAULT 20,
    p_lock_seconds INTEGER DEFAULT 60
)
RETURNS SETOF public.webhook_deliveries
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 1. Recuperar entregas 'sending' cuyo bloqueo venció (proceso caído)
    UPDATE public.webhook_deliveries
       SET status       = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           locked_until = NULL,
           last_error   = 'LOCK_EXPIRED',
           updated_at   = now()
     WHERE status = 'sending'
       AND locked_until < now();

    -- 2. Reclamar pendientes vencidas sin bloquear a otros ejecutores
    RETURN QUERY
    UPDATE public.webhook_deliveries d
       SET status       = 'sending',
           locked_until = now() + make_interval(secs => GREATEST(10, LEAST(p_lock_seconds, 600))),
           attempts     = d.attempts + 1,
           updated_at   = now()
     WHERE d.id IN (
           SELECT w.id
             FROM public.webhook_deliveries w
            WHERE w.status = 'pending'
              AND w.next_retry_at <= now()
            ORDER BY w.next_retry_at
            LIMIT GREATEST(1, LEAST(p_limit, 100))
            FOR UPDATE SKIP LOCKED
     )
    RETURNING d.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER, INTEGER) TO service_role;

COMMIT;

-- ------------------------------------------------------------------------------
-- DOWN (revertir)
-- ------------------------------------------------------------------------------
/*
BEGIN;
DROP FUNCTION IF EXISTS public.claim_webhook_deliveries(INTEGER, INTEGER);
DROP TABLE IF EXISTS public.webhook_deliveries;  -- elimina también sus índices
COMMIT;
*/
