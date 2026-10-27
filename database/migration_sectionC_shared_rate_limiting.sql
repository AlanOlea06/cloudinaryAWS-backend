-- ==============================================================================
-- MIGRACIÓN: RATE LIMITING CON ESTADO COMPARTIDO (POSTGRESQL ATÓMICO)
-- ==============================================================================
-- Justificación técnica:
-- Implementa un limitador de tasa de peticiones con estado persistente y compartido
-- entre múltiples instancias serverless (Edge/Vercel) sin requerir Redis ni
-- servicios externos adicionales.
--
-- Análisis de latencia en el Edge:
-- Un roundtrip desde Edge (Vercel) hacia Supabase añade entre 40ms y 120ms por petición.
-- Por ello, la arquitectura recomendada es HÍBRIDA:
-- 1. Limitador en memoria ultra-rápido en Edge (0ms overhead) como primera barrera anti-DDoS.
-- 2. Limitador compartido atómico en PostgreSQL para rutas críticas de mutación
--    (/api/keys, /api/upload, /api/upload/multipart) donde la consistencia global
--    entre instancias es prioritaria sobre los milisegundos de latencia.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_request_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_request 
    ON public.rate_limit_buckets (last_request_at);

-- Función atómica de evaluación e incremento de tasa
CREATE OR REPLACE FUNCTION public.check_rate_limit_atomic(
    p_key TEXT,
    p_max_requests INTEGER,
    p_window_seconds INTEGER
)
RETURNS TABLE (
    allowed BOOLEAN,
    current_count INTEGER,
    limit_count INTEGER,
    remaining INTEGER,
    reset_seconds INTEGER
) AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_window_interval INTERVAL := (p_window_seconds || ' seconds')::INTERVAL;
    v_bucket RECORD;
BEGIN
    INSERT INTO public.rate_limit_buckets (key, count, window_start, last_request_at)
    VALUES (p_key, 1, v_now, v_now)
    ON CONFLICT (key) DO UPDATE
    SET
        count = CASE
            WHEN public.rate_limit_buckets.window_start + v_window_interval <= v_now THEN 1
            ELSE public.rate_limit_buckets.count + 1
        END,
        window_start = CASE
            WHEN public.rate_limit_buckets.window_start + v_window_interval <= v_now THEN v_now
            ELSE public.rate_limit_buckets.window_start
        END,
        last_request_at = v_now
    RETURNING * INTO v_bucket;

    RETURN QUERY SELECT
        (v_bucket.count <= p_max_requests) AS allowed,
        v_bucket.count AS current_count,
        p_max_requests AS limit_count,
        GREATEST(0, p_max_requests - v_bucket.count) AS remaining,
        GREATEST(1, EXTRACT(EPOCH FROM (v_bucket.window_start + v_window_interval - v_now))::INTEGER) AS reset_seconds;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------------------
-- DOWN MIGRATION / ROLLBACK (REVERTIR EN CASO DE EMERGENCIA)
-- ------------------------------------------------------------------------------
/*
DROP FUNCTION IF EXISTS public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER);
DROP INDEX IF EXISTS public.idx_rate_limit_buckets_last_request;
DROP TABLE IF EXISTS public.rate_limit_buckets;
*/
