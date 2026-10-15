-- ==============================================================================
-- MIGRACIÓN DE NORMALIZACIÓN DE BASE DE DATOS (SQL RELACIONAL PURO - 3NF)
-- Cloudinary Clone: Eliminación de redundancias y de campos JSON en Supabase
-- ==============================================================================

-- 1. Agregar columna hash_sha256 si no existe (rescatada del blob JSON)
ALTER TABLE public.archivos 
    ADD COLUMN IF NOT EXISTS hash_sha256 VARCHAR(64);

-- 2. Si ya existían registros con hash en metadata, migrar los datos a la columna nueva
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'archivos' 
          AND column_name = 'metadata'
    ) THEN
        UPDATE public.archivos 
        SET hash_sha256 = metadata->>'hash_sha256'
        WHERE hash_sha256 IS NULL AND metadata->>'hash_sha256' IS NOT NULL;
    END IF;
END $$;

-- 3. Agregar columnas nativas para pipeline y escaneo (reemplazando objetos JSON)
ALTER TABLE public.archivos 
    ADD COLUMN IF NOT EXISTS scan_status VARCHAR(20) DEFAULT 'PENDIENTE' 
        CHECK (scan_status IN ('PENDIENTE', 'CLEAN', 'THREAT_DETECTED', 'NO_APLICA')),
    ADD COLUMN IF NOT EXISTS threat_detected BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS tamano_final_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS completado_at TIMESTAMPTZ;

-- 4. ELIMINAR REDUNDANCIAS Y CAMPOS JSON EN ARCHIVOS
-- Se elimina user_name: ya no es necesario porque user_id referencia a la tabla usuarios
ALTER TABLE public.archivos 
    DROP COLUMN IF EXISTS user_name;

-- Se elimina metadata: la tabla pasa a ser puramente relacional (SQL estructurado)
ALTER TABLE public.archivos 
    DROP COLUMN IF EXISTS metadata;

-- 5. Asegurar Llaves Foráneas (Foreign Keys) estrictas
DO $$
BEGIN
    -- FK hacia usuarios
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_archivos_usuario'
    ) THEN
        ALTER TABLE public.archivos
            ADD CONSTRAINT fk_archivos_usuario 
            FOREIGN KEY (user_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
    END IF;

    -- FK hacia organizaciones
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_archivos_organizacion'
    ) THEN
        ALTER TABLE public.archivos
            ADD CONSTRAINT fk_archivos_organizacion 
            FOREIGN KEY (org_id) REFERENCES public.organizaciones(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 6. Índices para optimizar búsquedas relacionales y deduplicación
CREATE INDEX IF NOT EXISTS idx_archivos_hash_sha256 ON public.archivos(hash_sha256);
CREATE INDEX IF NOT EXISTS idx_archivos_user_id ON public.archivos(user_id);
CREATE INDEX IF NOT EXISTS idx_archivos_org_id ON public.archivos(org_id);
CREATE INDEX IF NOT EXISTS idx_archivos_ticket_id ON public.archivos(ticket_id);
CREATE INDEX IF NOT EXISTS idx_archivos_estado ON public.archivos(estado);

-- ==============================================================================
-- VISTA RELACIONAL RECOMENDADA (Para consultar archivos con datos de usuario y org)
-- ==============================================================================
CREATE OR REPLACE VIEW public.vista_archivos_completos AS
SELECT 
    a.id,
    a.ticket_id,
    a.nombre_original,
    a.formato,
    a.tamano_bytes,
    a.tamano_final_bytes,
    a.hash_sha256,
    a.tipo_recurso,
    a.visibilidad,
    a.s3_key_pendiente,
    a.s3_key_procesado,
    a.cloudfront_url,
    a.estado,
    a.scan_status,
    a.threat_detected,
    a.created_at,
    a.updated_at,
    a.completado_at,
    -- Datos del usuario obtenidos vía relación (sin duplicar en la tabla)
    u.id AS user_id,
    u.nombre AS user_name,
    u.email AS user_email,
    u.rol AS user_rol,
    -- Datos de la organización obtenidos vía relación (sin duplicar en la tabla)
    o.id AS org_id,
    o.nombre AS org_nombre,
    o.slug AS org_slug
FROM public.archivos a
INNER JOIN public.usuarios u ON a.user_id = u.id
INNER JOIN public.organizaciones o ON a.org_id = o.id;
