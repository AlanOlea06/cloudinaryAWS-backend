-- ==============================================================================
-- MIGRACIÓN SECCIÓN 3: MODELO DE LLAVES A NIVEL DE ORGANIZACIÓN (OPCIÓN A)
-- Reversible (UP + DOWN / ROLLBACK documentado)
-- ==============================================================================
-- Decisiones aplicadas:
-- 1. La API Key se vincula a la organización (org_id) para uso exclusivo en el
--    backend del cliente (servidor a servidor; nunca en navegador).
-- 2. La columna user_id en public.api_keys es opcional (NULLABLE):
--    - Si user_id IS NULL (llave de organización): el backend del cliente envía
--      el usuario final por cabecera (x-user-id / x-end-user-id) y el servidor
--      valida que exista en public.users y pertenezca a la misma org_id.
--    - Si user_id IS NOT NULL (llave restringida a un usuario específico): la
--      llave solo puede operar en nombre de ese user_id.
-- 3. El máximo de llaves activas por organización pasa a ser configurable en BD
--    mediante la columna public.organizations.max_api_keys (por defecto 3).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR CAMBIOS)
-- ------------------------------------------------------------------------------

-- 1. Asegurar que public.api_keys.user_id exista y sea NULLABLE (opcional)
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.api_keys
  ALTER COLUMN user_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);

COMMENT ON COLUMN public.api_keys.user_id IS
  'Opcional (NULLABLE). Si es NULL, la llave es de organización (backend) y el usuario final se recibe y valida por cabecera x-user-id. Si tiene valor, restringe la llave a ese único usuario.';

-- 2. Límite configurable de API Keys activas por organización (default 3)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS max_api_keys INTEGER NOT NULL DEFAULT 3;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_max_api_keys_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_max_api_keys_check CHECK (max_api_keys >= 1 AND max_api_keys <= 1000);

COMMENT ON COLUMN public.organizations.max_api_keys IS
  'Número máximo de API Keys activas permitidas para esta organización (por defecto 3).';


-- ==============================================================================
-- DOWN MIGRATION / ROLLBACK (EJECUTAR SOLO SI SE DESEA REVERTIR)
-- ==============================================================================
/*
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_max_api_keys_check;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS max_api_keys;

-- Nota: Si se desea volver a atar llaves sin user_id al admin de su organización antes de imponer NOT NULL:
-- UPDATE public.api_keys ak
-- SET user_id = (
--   SELECT u.id FROM public.users u
--   WHERE u.org_id = ak.org_id
--   ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
--   LIMIT 1
-- )
-- WHERE ak.user_id IS NULL;
*/
