-- ==============================================================================
-- MIGRATION: NORMALIZACIÓN PURA 3NF DE SERVICE_LOGS (ELIMINACIÓN DE JSON/JSONB)
-- No recrea la tabla ni borra datos existentes en otras columnas.
-- Solo elimina la columna 'details' y agrega columnas atómicas tipadas.
-- ==============================================================================

-- 1. Eliminar la columna JSONB 'details'
ALTER TABLE public.service_logs 
  DROP COLUMN IF EXISTS details;

-- 2. Agregar columnas relacionales atómicas útiles
ALTER TABLE public.service_logs 
  ADD COLUMN IF NOT EXISTS http_method VARCHAR(10),
  ADD COLUMN IF NOT EXISTS file_id UUID REFERENCES public.files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ticket_id UUID,
  ADD COLUMN IF NOT EXISTS message TEXT;

-- 3. Crear índices de búsqueda para optimizar consultas relacionales
CREATE INDEX IF NOT EXISTS idx_service_logs_file_id ON public.service_logs(file_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_ticket_id ON public.service_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_service_logs_http_method ON public.service_logs(http_method);
