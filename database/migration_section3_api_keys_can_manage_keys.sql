-- ==============================================================================
-- MIGRACIÓN 2: DELEGACIÓN DE API KEYS (can_manage_keys) Y CUPO ATÓMICO
-- ==============================================================================
-- 1. organizations.max_api_keys: normalmente ya existe (la crea
--    migration_section3_api_keys_org_model.sql). Se añade de forma idempotente
--    con DEFAULT 3 solo si falta. Ejecuta antes la consulta de PRE-VERIFICACIÓN.
-- 2. api_keys.can_manage_keys BOOLEAN NOT NULL DEFAULT false.
-- 3. CHECK: solo llaves de organización (user_id IS NULL) pueden tener true.
-- 4. Trigger de cupo atómico: bloquea la fila de la organización (FOR UPDATE)
--    y cuenta llaves activas. Solo valida en:
--      - INSERT de una llave activa,
--      - UPDATE que reactiva (is_active false -> true),
--      - UPDATE que cambia de organización estando activa.
--    Un UPDATE sobre una llave que ya estaba activa en la misma organización
--    (renombrar, cambiar permisos, promover) NO comprueba el cupo, así que una
--    organización que ya excede su cupo puede seguir editando sus llaves.
-- 5. La función tiene search_path fijo y sin EXECUTE para PUBLIC/anon/authenticated.
--
-- Promoción de llaves existentes: NO se hace en SQL. Se hace con
-- PATCH /api/keys { "id": "<uuid>", "canManageKeys": true } y x-admin-secret.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- PRE-VERIFICACIÓN (solo lectura; ejecutar y guardar el resultado)
-- ------------------------------------------------------------------------------
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'max_api_keys';

-- ------------------------------------------------------------------------------
-- UP
-- ------------------------------------------------------------------------------
BEGIN;

-- 1. Cupo por organización (no-op si ya existe)
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

-- 4. Función del cupo atómico
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

    -- Nueva instantánea tras obtener el bloqueo (READ COMMITTED): ve las llaves
    -- confirmadas por la transacción que tenía el bloqueo antes.
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

-- 5. Índice para contar llaves maestras activas
CREATE INDEX IF NOT EXISTS idx_api_keys_can_manage
  ON public.api_keys (org_id, can_manage_keys) WHERE is_active = true;

COMMIT;

-- ------------------------------------------------------------------------------
-- DOWN (revertir)
-- ------------------------------------------------------------------------------
/*
BEGIN;
DROP INDEX IF EXISTS public.idx_api_keys_can_manage;
DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
DROP FUNCTION IF EXISTS public.check_api_keys_quota_before_insert();
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS can_manage_keys;
-- max_api_keys pertenece a migration_section3_api_keys_org_model.sql y NO se borra aquí.
-- Solo si la PRE-VERIFICACIÓN mostró que NO existía antes de esta migración:
-- ALTER TABLE public.organizations DROP COLUMN IF EXISTS max_api_keys;
COMMIT;
*/
