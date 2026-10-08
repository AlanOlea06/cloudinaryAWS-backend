-- ==============================================================================
-- Esquema para Clon de Cloudinary con AWS y Supabase
-- Tabla: archivos
-- ==============================================================================

-- 1. Tipo ENUM para el ciclo de vida del archivo
DO $$ BEGIN
    CREATE TYPE estado_archivo AS ENUM (
        'pendiente_subida',      -- Ticket emitido, esperando que el cliente suba a S3
        'subido_pendiente_proc', -- Subido a /pendientes, esperando trigger de Lambda
        'procesando',            -- Lambda ejecutando optimización con Sharp
        'completado',            -- Procesado y movido a /procesados
        'error',                 -- Fallo en subida o procesamiento
        'rechazado_seguridad'    -- Detectado por GuardDuty/WAF como malicioso
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Tabla principal de archivos
CREATE TABLE IF NOT EXISTS public.archivos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- Compatible con auth.users de Supabase
    user_name TEXT,
    nombre_original TEXT NOT NULL,
    formato TEXT NOT NULL,           -- MIME type: 'image/jpeg', 'video/mp4', etc.
    tamano_bytes BIGINT NOT NULL,
    s3_key_pendiente TEXT NOT NULL,  -- pendientes/{userId}/{fileId}-{filename}
    s3_key_procesado TEXT,           -- procesados/{userId}/{fileId}.webp
    cloudfront_url TEXT,             -- https://cdn.tudominio.com/...
    estado estado_archivo NOT NULL DEFAULT 'pendiente_subida',
    metadata JSONB DEFAULT '{}'::jsonb, -- Dimensiones, EXIF, formato final, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Índices para consultas de alta concurrencia
CREATE INDEX IF NOT EXISTS idx_archivos_user_id ON public.archivos (user_id);
CREATE INDEX IF NOT EXISTS idx_archivos_ticket_id ON public.archivos (ticket_id);
CREATE INDEX IF NOT EXISTS idx_archivos_estado ON public.archivos (estado);

-- 4. Trigger automático para actualizar el campo updated_at
CREATE OR REPLACE FUNCTION actualizar_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_archivos_updated_at ON public.archivos;
CREATE TRIGGER trigger_archivos_updated_at
BEFORE UPDATE ON public.archivos
FOR EACH ROW
EXECUTE FUNCTION actualizar_timestamp_updated_at();

-- 5. Row Level Security (RLS)
ALTER TABLE public.archivos ENABLE ROW LEVEL SECURITY;

-- Política de lectura para usuarios autenticados
DROP POLICY IF EXISTS "Usuarios pueden leer sus propios archivos" ON public.archivos;
CREATE POLICY "Usuarios pueden leer sus propios archivos"
ON public.archivos
FOR SELECT
USING (auth.uid() = user_id);
