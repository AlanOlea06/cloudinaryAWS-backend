# Guía de Migraciones de Base de Datos (Supabase) — APLICADAS EN PRODUCCIÓN

> **Estado**: ✅ Las 4 migraciones han sido ejecutadas y verificadas en producción (27 de Octubre de 2026).
> **Instrucciones de Referencia**:
> 1. Aplicadas en Supabase SQL Editor en el **orden estricto** indicado a continuación (1 a 4).
> 2. Cada migración incluye su código `UP`, su código de reversión `DOWN`, y consultas SQL de verificación.
> 3. Ninguna de estas migraciones altera datos destructivamente (todas son aditivas y reversibles).

---

## Migración 1: Verificación de Integridad de Checksums SHA-256 (Aprobada)

- **Archivo**: `database/migration_section5_sha256_verified.sql`
- **Objetivo**: Añadir la columna booleana `sha256_verified` a la tabla `public.files` para reflejar si el archivo subido a S3 cuenta con verificación criptográfica SHA-256 garantizada por el cliente y confirmada en S3.

### Script UP (Aplicar)
```sql
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS sha256_verified BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.files.sha256_verified IS 'Indica si el archivo fue validado criptográficamente contra el checksum SHA-256 declarado por el cliente';
```

### Script DOWN (Revertir)
```sql
ALTER TABLE public.files DROP COLUMN IF EXISTS sha256_verified;
```

### Consulta de Verificación
```sql
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'sha256_verified';
-- Esperado: 1 fila con column_name = 'sha256_verified', data_type = 'boolean', column_default = 'false'.
```

---

## Migración 2: Delegación de API Keys (`can_manage_keys`) y Cupo Atómico

- **Archivo**: `database/migration_section3_api_keys_can_manage_keys.sql`
- **Objetivo**:
  1. Asegurar idempotentemente la columna `organizations.max_api_keys` con default 3.
  2. Añadir `can_manage_keys` (`DEFAULT false`) a `public.api_keys`.
  3. Restricción CHECK: solo llaves de organización (`user_id IS NULL`) pueden tener `can_manage_keys = true`. Las llaves vinculadas a un usuario jamás gestionan llaves.
  4. Trigger atómico con bloqueo de fila `FOR UPDATE` sobre `public.organizations`:
     - Se sale de inmediato sin verificar cupo cuando es `UPDATE` y la llave ya estaba activa en la misma organización (`OLD.is_active = true AND OLD.org_id = NEW.org_id`). Esto permite actualizar nombres, permisos o promover llaves existentes sin trabar organizaciones que ya alcancen o excedan su cupo.
     - Solo valida cupo en `INSERT`, al reactivar (`is_active` de false a true) o al cambiar de organización.
  5. Función con `SET search_path = public, pg_temp` y `REVOKE EXECUTE` de `PUBLIC`, `anon` y `authenticated`.

### Pre-verificación (Opcional, Informativa)
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'max_api_keys';
```

### Script UP (Aplicar)
```sql
BEGIN;

-- 1. Cupo por organización (idempotente si ya existe)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS max_api_keys INTEGER NOT NULL DEFAULT 3;

-- 2. Columna can_manage_keys
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS can_manage_keys BOOLEAN NOT NULL DEFAULT false;

-- 3. Solo llaves de organización pueden gestionar llaves
ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_manage_only_org_check
  CHECK (can_manage_keys = false OR user_id IS NULL);

-- 4. Función del cupo atómico con search_path fijo y salto de comprobación en updates activos
CREATE OR REPLACE FUNCTION public.check_api_keys_quota_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_max_keys     INTEGER;
    v_current_keys INTEGER;
BEGIN
    -- Llaves inactivas nunca consumen cupo
    IF NEW.is_active IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    -- UPDATE de una llave que ya estaba activa en la misma organización: no se valida
    IF TG_OP = 'UPDATE' AND OLD.is_active = true AND OLD.org_id = NEW.org_id THEN
        RETURN NEW;
    END IF;

    -- Serializa inserciones/reactivaciones concurrentes de la misma organización
    SELECT COALESCE(o.max_api_keys, 3) INTO v_max_keys
    FROM public.organizations o
    WHERE o.id = NEW.org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    -- Conteo atómico dentro de la transacción serializada
    SELECT COUNT(*) INTO v_current_keys
    FROM public.api_keys k
    WHERE k.org_id = NEW.org_id
      AND k.is_active = true
      AND k.id IS DISTINCT FROM NEW.id;

    IF v_current_keys >= v_max_keys THEN
        RAISE EXCEPTION 'MAX_API_KEYS_LIMIT_REACHED' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_api_keys_quota_before_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_api_keys_quota_before_insert() FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_api_keys_quota_before_insert() FROM authenticated;

DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
CREATE TRIGGER trigger_check_api_keys_quota
BEFORE INSERT OR UPDATE OF is_active, org_id ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION public.check_api_keys_quota_before_insert();

-- 5. Índice para búsquedas de llaves maestras activas
CREATE INDEX IF NOT EXISTS idx_api_keys_can_manage
  ON public.api_keys (org_id, can_manage_keys) WHERE is_active = true;

COMMIT;
```

### Script DOWN (Revertir)
```sql
BEGIN;
DROP INDEX IF EXISTS public.idx_api_keys_can_manage;
DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
DROP FUNCTION IF EXISTS public.check_api_keys_quota_before_insert();
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS can_manage_keys;
-- max_api_keys no se elimina a menos que se haya añadido exclusivamente en esta migración
COMMIT;
```

### Consulta de Verificación
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'can_manage_keys';

SELECT tgname 
FROM pg_trigger 
WHERE tgname = 'trigger_check_api_keys_quota';
```

---

## Migración 3: Entregas de Webhook Persistentes con Reclamo Atómico y Retención

- **Archivo**: `database/migration_sectionC_webhooks_persistent_retries.sql`
- **Objetivo**:
  1. Crear la tabla `public.webhook_deliveries` sin columnas sensibles de `payload` ni `target_url` (se leen dinámicamente de `organizations` y `files` al momento del envío, previniendo fuga de claves S3 o URLs caducadas y re-evaluando SSRF en cada despacho).
  2. Restricciones CHECK en `status` (`'pending'`, `'sending'`, `'delivered'`, `'failed'`) y `event_type` (`'file.uploaded'`, `'file.processed'`, `'file.failed'`).
  3. Columna `locked_until` para control de concurrencia y tolerancia a fallos.
  4. Función atómica `claim_webhook_deliveries(limit, lock_seconds)` con `FOR UPDATE SKIP LOCKED` para que ni el cron ni los disparos concurrentes reclamen la misma entrega dos veces, y recuperando automáticamente entregas `'sending'` con bloqueo vencido.
  5. `last_error` acotado a máximo 200 caracteres, sin cuerpos ni credenciales.
  6. RLS activado sin políticas y `REVOKE ALL` de `PUBLIC`, `anon` y `authenticated`. Permisos exclusivos para `service_role`.

### Script UP (Aplicar)
```sql
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

-- Reclamo atómico de entregas con FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(
    p_limit        INTEGER DEFAULT 20,
    p_lock_seconds INTEGER DEFAULT 60
)
RETURNS SETOF public.webhook_deliveries
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 1. Recuperar entregas 'sending' cuyo bloqueo venció por proceso caído
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
```

### Script DOWN (Revertir)
```sql
BEGIN;
DROP FUNCTION IF EXISTS public.claim_webhook_deliveries(INTEGER, INTEGER);
DROP TABLE IF EXISTS public.webhook_deliveries;
COMMIT;
```

### Consulta de Verificación
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'webhook_deliveries';

SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' AND routine_name = 'claim_webhook_deliveries';
```

---

## Migración 4: Rate Limiting con Estado Compartido en PostgreSQL

- **Archivo**: `database/migration_sectionC_shared_rate_limiting.sql`
- **Objetivo**:
  1. Crear la tabla `public.rate_limit_buckets` con RLS habilitado sin políticas y privilegios revocados para `PUBLIC`, `anon` y `authenticated`.
  2. Restricción CHECK de formato en la columna `key`: solo acepta claves estructuradas basadas en UUIDs (`<ámbito>:<tipo>:<uuid>`) o hashes SHA-256 directos (`<ámbito>:<tipo>:h:<sha256>`). Prohíbe llaves API o direcciones IP en claro.
  3. Función atómica `check_rate_limit_atomic(...)` con `SET search_path = public, pg_temp`, validación de parámetros de entrada, y permisos exclusivos para `service_role`.
  4. La limpieza de buckets inactivos (> 1 día) se realiza de forma oportunista en la aplicación y periódicamente desde el Cron de mantenimiento.

### Script UP (Aplicar)
```sql
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
```

### Script DOWN (Revertir)
```sql
BEGIN;
DROP FUNCTION IF EXISTS public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS public.rate_limit_buckets;
COMMIT;
```

### Consulta de Verificación
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'rate_limit_buckets';

SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' AND routine_name = 'check_rate_limit_atomic';
```
