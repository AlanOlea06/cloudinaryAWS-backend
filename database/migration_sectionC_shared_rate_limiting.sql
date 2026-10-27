-- ==============================================================================
-- MIGRACIÓN 4: RATE LIMITING CON ESTADO COMPARTIDO (POSTGRESQL)
-- ==============================================================================
-- Composición de la clave del bucket (sin llaves API ni IP en claro):
--   <ámbito>:<tipo>:<uuid>        p. ej. keys:apikey:<api_keys.id>
--                                       keys:admin_org:<organizations.id>
--   <ámbito>:<tipo>:h:<sha256hex> reservado para identificadores sensibles
--                                 (IP, etc.) como HMAC-SHA256 con sal del servidor.
-- El CHECK de la columna key rechaza cualquier otro formato, así que una IP o
-- una llave sk_live_ en claro no puede llegar a guardarse.
--
-- Limpieza: el backend borra filas con last_request_at > 1 día desde el cron de
-- mantenimiento y de forma oportunista (1 de cada 100 llamadas). No sustituye
-- ningún servicio de AWS (sería pg_cron en Supabase), por eso no lleva la
-- etiqueta [TEMPORARY-LAMBDA-FALLBACK].
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP
-- ------------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    key             TEXT PRIMARY KEY,
    count           INTEGER NOT NULL DEFAULT 1,
    window_start    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_request_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rate_limit_buckets_key_format_check CHECK (
        key ~ '^[a-z_]+:[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR key ~ '^[a-z_]+:[a-z_]+:h:[0-9a-f]{64}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_request
    ON public.rate_limit_buckets (last_request_at);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM anon;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limit_buckets TO service_role;

CREATE OR REPLACE FUNCTION public.check_rate_limit_atomic(
    p_key            TEXT,
    p_max_requests   INTEGER,
    p_window_seconds INTEGER
)
RETURNS TABLE (
    allowed       BOOLEAN,
    current_count INTEGER,
    limit_count   INTEGER,
    remaining     INTEGER,
    reset_seconds INTEGER
)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now    TIMESTAMPTZ := clock_timestamp();
    v_window INTERVAL;
    v_count  INTEGER;
    v_start  TIMESTAMPTZ;
BEGIN
    IF p_max_requests IS NULL OR p_max_requests < 1
       OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
        RAISE EXCEPTION 'INVALID_RATE_LIMIT_PARAMS' USING ERRCODE = '22023';
    END IF;

    v_window := make_interval(secs => p_window_seconds);

    INSERT INTO public.rate_limit_buckets AS b (key, count, window_start, last_request_at)
    VALUES (p_key, 1, v_now, v_now)
    ON CONFLICT (key) DO UPDATE
    SET count           = CASE WHEN b.window_start + v_window <= v_now THEN 1 ELSE b.count + 1 END,
        window_start    = CASE WHEN b.window_start + v_window <= v_now THEN v_now ELSE b.window_start END,
        last_request_at = v_now
    RETURNING b.count, b.window_start INTO v_count, v_start;

    RETURN QUERY SELECT
        (v_count <= p_max_requests),
        v_count,
        p_max_requests,
        GREATEST(0, p_max_requests - v_count),
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_start + v_window - v_now)))::INTEGER);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER) TO service_role;

COMMIT;

-- ------------------------------------------------------------------------------
-- DOWN (revertir)
-- ------------------------------------------------------------------------------
/*
BEGIN;
DROP FUNCTION IF EXISTS public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS public.rate_limit_buckets;  -- elimina también su índice
COMMIT;
*/
