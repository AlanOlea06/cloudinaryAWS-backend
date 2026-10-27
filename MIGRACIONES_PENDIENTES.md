# Guía de Migraciones Pendientes de Base de Datos (Supabase)

> **Instrucciones de Ejecución**:
> 1. Aplicar en Supabase SQL Editor en el **orden estricto** indicado a continuación (1 a 4).
> 2. Cada migración incluye su código `UP`, su código de reversión `DOWN`, y una consulta SQL de verificación para confirmar que se aplicó exitosamente.
> 3. Ninguna de estas migraciones altera datos destructivamente (todas son aditivas y reversibles).

---

## Migración 1: Verificación de Integridad de Checksums SHA-256

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

## Migración 2: Delegación Segura de API Keys y Cupo Atómico

- **Archivo**: `database/migration_section3_api_keys_can_manage_keys.sql`
- **Objetivo**: 
  1. Añadir `can_manage_keys` (`DEFAULT false`) a `public.api_keys`.
  2. Restricción CHECK: solo llaves de organización (`user_id IS NULL`) pueden tener `can_manage_keys = true`. Las llaves vinculadas a un usuario jamás gestionan llaves.
  3. Control atómico del cupo `max_api_keys` mediante trigger `BEFORE INSERT OR UPDATE` con bloqueo de fila `FOR UPDATE` sobre `public.organizations`. Esto erradica condiciones de carrera ante peticiones concurrentes.

### Script UP (Aplicar)
```sql
-- 1. Columna can_manage_keys
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS can_manage_keys BOOLEAN NOT NULL DEFAULT false;

-- 2. Restricción: solo llaves de organización pueden gestionar llaves
ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_manage_only_org_check
  CHECK (can_manage_keys = false OR user_id IS NULL);

-- 3. Función y Trigger de Cupo Atómico con Bloqueo de Fila
CREATE OR REPLACE FUNCTION check_api_keys_quota_before_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_max_keys INTEGER;
    v_current_keys INTEGER;
BEGIN
    IF NEW.is_active = true THEN
        -- Bloqueo exclusivo a nivel de fila sobre la organizacion
        SELECT COALESCE(max_api_keys, 3) INTO v_max_keys
        FROM public.organizations
        WHERE id = NEW.org_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: La organización no existe.' USING ERRCODE = 'P0002';
        END IF;

        -- Conteo atómico dentro de la transacción serializada
        SELECT COUNT(*) INTO v_current_keys
        FROM public.api_keys
        WHERE org_id = NEW.org_id 
          AND is_active = true 
          AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

        IF v_current_keys >= v_max_keys THEN
            RAISE EXCEPTION 'MAX_API_KEYS_LIMIT_REACHED: Cupo de llaves activas alcanzado para la organización.' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
CREATE TRIGGER trigger_check_api_keys_quota
BEFORE INSERT OR UPDATE OF is_active, org_id ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION check_api_keys_quota_before_insert();

-- 4. Índice para búsquedas rápidas de llaves maestras
CREATE INDEX IF NOT EXISTS idx_api_keys_can_manage ON public.api_keys(org_id, can_manage_keys) WHERE is_active = true;
```

### Script DOWN (Revertir)
```sql
DROP INDEX IF EXISTS public.idx_api_keys_can_manage;
DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
DROP FUNCTION IF EXISTS check_api_keys_quota_before_insert();
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS can_manage_keys;
```

### Consulta de Verificación
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'can_manage_keys';

SELECT tgname 
FROM pg_trigger 
WHERE tgname = 'trigger_check_api_keys_quota';
-- Esperado: columna 'can_manage_keys' encontrada y trigger 'trigger_check_api_keys_quota' registrado.
```

---

## Migración 3: Persistencia y Reintentos con Backoff de Webhooks

- **Archivo**: `database/migration_sectionC_webhooks_persistent_retries.sql`
- **Objetivo**: Crear la tabla `public.webhook_deliveries` para registrar de forma duradera los eventos emitidos (`file.uploaded`, `file.processed`, `file.failed`) hacia el webhook configurado en la organización, permitiendo que el Cron procese reintentos con backoff exponencial.

### Script UP (Aplicar)
```sql
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

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending 
    ON public.webhook_deliveries (status, next_retry_at) 
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org 
    ON public.webhook_deliveries (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_file 
    ON public.webhook_deliveries (file_id);
```

### Script DOWN (Revertir)
```sql
DROP INDEX IF EXISTS public.idx_webhook_deliveries_file;
DROP INDEX IF EXISTS public.idx_webhook_deliveries_org;
DROP INDEX IF EXISTS public.idx_webhook_deliveries_pending;
DROP TABLE IF EXISTS public.webhook_deliveries;
```

### Consulta de Verificación
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'webhook_deliveries';
-- Esperado: 1 fila con table_name = 'webhook_deliveries'.
```

---

## Migración 4: Rate Limiting con Estado Compartido en PostgreSQL

- **Archivo**: `database/migration_sectionC_shared_rate_limiting.sql`
- **Objetivo**: Crear la tabla `public.rate_limit_buckets` y la función atómica `public.check_rate_limit_atomic(...)` para control de cuota compartido entre múltiples instancias serverless de Edge/Vercel sin requerir Redis.

### Script UP (Aplicar)
```sql
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_request_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_request 
    ON public.rate_limit_buckets (last_request_at);

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
```

### Script DOWN (Revertir)
```sql
DROP FUNCTION IF EXISTS public.check_rate_limit_atomic(TEXT, INTEGER, INTEGER);
DROP INDEX IF EXISTS public.idx_rate_limit_buckets_last_request;
DROP TABLE IF EXISTS public.rate_limit_buckets;
```

### Consulta de Verificación
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'rate_limit_buckets';

SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' AND routine_name = 'check_rate_limit_atomic';
-- Esperado: tabla 'rate_limit_buckets' y función 'check_rate_limit_atomic' registradas.
```
