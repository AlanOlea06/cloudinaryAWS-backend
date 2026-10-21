-- ==============================================================================
-- Tabla: api_keys
-- Descripción: Gestión de llaves de API Multi-Tenant con principio de menor privilegio
-- Motor: Supabase PostgreSQL
-- ==============================================================================

-- 1. Crear tabla api_keys si no existe
CREATE TABLE IF NOT EXISTS public.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    hashed_key TEXT UNIQUE NOT NULL,
    can_read BOOLEAN NOT NULL DEFAULT false,
    can_upload BOOLEAN NOT NULL DEFAULT false,
    can_delete BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Índice B-Tree de alta velocidad para búsquedas exactas del hash en el Edge Middleware
CREATE INDEX IF NOT EXISTS idx_api_keys_hashed_key ON public.api_keys(hashed_key);

-- 3. Índice secundario para optimizar la validación del límite de 3 llaves por organización
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id_active ON public.api_keys(org_id, is_active);

-- 4. Habilitar Row Level Security (RLS)
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- 5. Política para permitir acceso administrativo mediante service_role
CREATE POLICY "Permitir acceso completo a service_role" 
ON public.api_keys 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 6. Documentación de columnas
COMMENT ON TABLE public.api_keys IS 'Almacén de API Keys hasheadas con permisos RBAC por organización';
COMMENT ON COLUMN public.api_keys.hashed_key IS 'Hash SHA-256 de la API Key plana (sk_live_...). Nunca se almacena en texto plano.';
COMMENT ON COLUMN public.api_keys.can_upload IS 'Permiso para solicitar tickets y subir archivos (POST /api/upload)';
COMMENT ON COLUMN public.api_keys.can_read IS 'Permiso para consultar archivos y metadatos (GET /api/files)';
COMMENT ON COLUMN public.api_keys.can_delete IS 'Permiso para eliminar archivos de S3 y registros (DELETE)';
