-- ==============================================================================
-- Script de Migración Multi-Inquilino (Multi-Tenant) y Control de Acceso
-- Cloudinary Clone: Organizaciones, Usuarios, Permisos y Logs de Auditoría
-- ==============================================================================

-- 1. Tabla de Organizaciones (Tenants)
CREATE TABLE IF NOT EXISTS public.organizaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE, -- Ej: 'organizacion_1', 'organizacion_2'
    descripcion TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Tabla de Usuarios con roles y permisos específicos
CREATE TABLE IF NOT EXISTS public.usuarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizaciones(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    rol TEXT NOT NULL DEFAULT 'miembro', -- 'admin', 'editor', 'visitante'
    puede_subir BOOLEAN NOT NULL DEFAULT true, -- Permiso específico para subir archivos
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Tabla de Logs de Auditoría ("logs de servicio/")
CREATE TABLE IF NOT EXISTS public.logs_servicio (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES public.organizaciones(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
    accion TEXT NOT NULL, -- 'PETICION_SUBIDA', 'SUBIDA_EXITOSA', 'ACCESO_DENEGADO', 'DESCARGA'
    estado TEXT NOT NULL, -- 'PERMITIDO', 'DENEGADO_NO_REGISTRADO', 'DENEGADO_OTRA_ORG', 'DENEGADO_SIN_PERMISO'
    detalles JSONB DEFAULT '{}'::jsonb,
    ip_origen TEXT DEFAULT '127.0.0.1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Modificar la tabla 'archivos' para soportar Multi-Tenant y Clasificación S3
ALTER TABLE public.archivos 
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizaciones(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS visibilidad TEXT DEFAULT 'privados' CHECK (visibilidad IN ('publicos', 'privados')),
    ADD COLUMN IF NOT EXISTS tipo_recurso TEXT DEFAULT 'imagenes' CHECK (tipo_recurso IN ('imagenes', 'documentos', 'videos'));

-- 5. Índices de rendimiento
CREATE INDEX IF NOT EXISTS idx_usuarios_org_id ON public.usuarios (org_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON public.usuarios (email);
CREATE INDEX IF NOT EXISTS idx_archivos_org_id ON public.archivos (org_id);
CREATE INDEX IF NOT EXISTS idx_logs_servicio_org_id ON public.logs_servicio (org_id);

-- ==============================================================================
-- DATOS SEMILLA (SEED DATA): 2 Organizaciones, 10 Usuarios (Org 1) y 5 Usuarios (Org 2)
-- ==============================================================================

-- Insertar Organizaciones (IDs fijos para testing consistente)
INSERT INTO public.organizaciones (id, nombre, slug, descripcion)
VALUES 
    ('11111111-1111-1111-1111-111111111111', 'Organización 1', 'organizacion_1', 'Cuenta Corporativa Alpha'),
    ('22222222-2222-2222-2222-222222222222', 'Organización 2', 'organizacion_2', 'Cuenta Corporativa Beta')
ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, slug = EXCLUDED.slug;

-- Insertar 10 Usuarios en Organización 1
INSERT INTO public.usuarios (id, org_id, nombre, email, rol, puede_subir)
VALUES
    ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Carlos Mendoza', 'carlos.mendoza@org1.com', 'admin', true),
    ('a1111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Ana Beltrán', 'ana.beltran@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Roberto Morales', 'roberto.morales@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Lucía Vega', 'lucia.vega@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Diego Solís', 'diego.solis@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Elena Castillo', 'elena.castillo@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'Javier Ramos', 'javier.ramos@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'Sofía Pineda', 'sofia.pineda@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'Fernando Ortiz', 'fernando.ortiz@org1.com', 'editor', true),
    ('a1111111-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'Valeria Ruiz (Sin Permiso)', 'valeria.ruiz@org1.com', 'visitante', false)
ON CONFLICT (id) DO UPDATE SET puede_subir = EXCLUDED.puede_subir;

-- Insertar 5 Usuarios en Organización 2
INSERT INTO public.usuarios (id, org_id, nombre, email, rol, puede_subir)
VALUES
    ('b2222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Mateo Delgado', 'mateo.delgado@org2.com', 'admin', true),
    ('b2222222-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Camila Herrera', 'camila.herrera@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'Andrés Navarro', 'andres.navarro@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Paula Cárdenas', 'paula.cardenas@org2.com', 'editor', true),
    ('b2222222-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'Gabriel Fuentes (Sin Permiso)', 'gabriel.fuentes@org2.com', 'visitante', false)
ON CONFLICT (id) DO UPDATE SET puede_subir = EXCLUDED.puede_subir;
