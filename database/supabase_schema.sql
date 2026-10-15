-- ==============================================================================
-- Esquema Normalizado (SQL Puro / 3NF) para Clon de Cloudinary con AWS y Supabase
-- Tablas: organizaciones, usuarios, archivos, logs_servicio
-- ==============================================================================

-- 1. Tipo ENUM para el estado de los archivos
DO $$ BEGIN
    CREATE TYPE estado_archivo AS ENUM (
        'pendiente_subida',      -- Ticket emitido, esperando subida directa a S3
        'subido_pendiente_proc', -- Subido a /pendientes, esperando procesamiento
        'procesando',            -- Lambda/Worker procesando archivo
        'completado',            -- Procesado exitosamente y disponible
        'error',                 -- Error durante subida o procesamiento
        'rechazado_seguridad'    -- Detectado como amenaza de seguridad
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Tabla de Organizaciones (Tenants)
CREATE TABLE IF NOT EXISTS public.organizaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    descripcion TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Tabla de Usuarios (RBAC y Aislamiento)
CREATE TABLE IF NOT EXISTS public.usuarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizaciones(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    rol TEXT NOT NULL DEFAULT 'editor',
    puede_subir BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Tabla de Archivos (Totalmente Normalizada - 0 JSON)
CREATE TABLE IF NOT EXISTS public.archivos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizaciones(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    nombre_original TEXT NOT NULL,
    formato TEXT NOT NULL,                          -- MIME type ('image/png', 'application/pdf', etc.)
    tamano_bytes BIGINT NOT NULL,                   -- Tamaño original recibido
    tamano_final_bytes BIGINT,                      -- Tamaño tras optimización/pipeline
    hash_sha256 VARCHAR(64) NOT NULL,              -- Huella digital SHA-256 (columna nativa)
    tipo_recurso TEXT NOT NULL CHECK (tipo_recurso IN ('imagenes', 'documentos', 'videos')),
    visibilidad TEXT NOT NULL DEFAULT 'privados' CHECK (visibilidad IN ('publicos', 'privados')),
    s3_key_pendiente TEXT NOT NULL,                 -- pendientes/{userId}/{fileName}
    s3_key_procesado TEXT,                          -- Organizaciones/{slug}/{tipo}/{visibilidad}/{ticketId}-{fileName}
    cloudfront_url TEXT,
    estado estado_archivo NOT NULL DEFAULT 'pendiente_subida',
    scan_status VARCHAR(20) DEFAULT 'PENDIENTE' CHECK (scan_status IN ('PENDIENTE', 'CLEAN', 'THREAT_DETECTED', 'NO_APLICA')),
    threat_detected BOOLEAN DEFAULT false,
    completado_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 5. Tabla de Logs de Auditoría
CREATE TABLE IF NOT EXISTS public.logs_servicio (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES public.organizaciones(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
    ticket_id UUID,
    accion TEXT NOT NULL,
    estado TEXT NOT NULL,
    archivo_nombre TEXT,
    detalles JSONB DEFAULT '{}'::jsonb,
    ip_origen TEXT DEFAULT '127.0.0.1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 6. Índices para Alto Rendimiento
CREATE INDEX IF NOT EXISTS idx_archivos_user_id ON public.archivos (user_id);
CREATE INDEX IF NOT EXISTS idx_archivos_org_id ON public.archivos (org_id);
CREATE INDEX IF NOT EXISTS idx_archivos_ticket_id ON public.archivos (ticket_id);
CREATE INDEX IF NOT EXISTS idx_archivos_hash_sha256 ON public.archivos (hash_sha256);
CREATE INDEX IF NOT EXISTS idx_archivos_estado ON public.archivos (estado);
CREATE INDEX IF NOT EXISTS idx_usuarios_org_id ON public.usuarios (org_id);
CREATE INDEX IF NOT EXISTS idx_logs_servicio_org_id ON public.logs_servicio (org_id);

-- 7. Trigger automático para actualizar updated_at
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
