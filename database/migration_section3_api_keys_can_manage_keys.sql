-- ==============================================================================
-- MIGRACIÓN: DELEGACIÓN SEGURA DE API KEYS Y CONTROL ATÓMICO DE CUPOS
-- ==============================================================================
-- Justificación técnica:
-- 1. Agrega can_manage_keys a public.api_keys (DEFAULT false).
-- 2. Restricción CHECK: solo llaves de organización (user_id IS NULL) pueden
--    tener can_manage_keys = true. Una llave vinculada a usuario jamás gestiona llaves.
-- 3. Control atómico del cupo max_api_keys con Trigger BEFORE INSERT OR UPDATE y bloqueo
--    exclusivo FOR UPDATE sobre la tabla public.organizations. Esto elimina por
--    completo cualquier condición de carrera (race condition / TOCTOU) ante peticiones concurrentes.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR)
-- ------------------------------------------------------------------------------

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
    -- Solo aplica cuando se inserta o activa una llave
    IF NEW.is_active = true THEN
        -- Bloqueo exclusivo a nivel de fila sobre la organizacion
        -- Serializa cualquier inserción o activación concurrente para el mismo org_id
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

-- 5. Consulta opcional de transición para organizaciones existentes:
-- Por defecto, todas las llaves existentes quedan con can_manage_keys = false.
-- Para promover la primera llave de organización de cada organización existente a llave administradora:
-- UPDATE public.api_keys ak
-- SET can_manage_keys = true
-- WHERE ak.id IN (
--   SELECT DISTINCT ON (org_id) id
--   FROM public.api_keys
--   WHERE user_id IS NULL AND is_active = true
--   ORDER BY org_id, created_at ASC
-- );


-- ------------------------------------------------------------------------------
-- DOWN MIGRATION / ROLLBACK (REVERTIR EN CASO DE EMERGENCIA)
-- ------------------------------------------------------------------------------
/*
DROP INDEX IF EXISTS public.idx_api_keys_can_manage;
DROP TRIGGER IF EXISTS trigger_check_api_keys_quota ON public.api_keys;
DROP FUNCTION IF EXISTS check_api_keys_quota_before_insert();
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_manage_only_org_check;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS can_manage_keys;
*/
