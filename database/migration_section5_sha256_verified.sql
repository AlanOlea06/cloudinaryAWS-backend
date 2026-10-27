-- ==============================================================================
-- MIGRACIÓN: INDICADOR ADITIVO DE VERIFICACIÓN DE CHECKSUM SHA-256 (SECCIÓN 5)
-- ==============================================================================
-- Justificación técnica:
-- Permite saber de forma determinista si el objeto en S3 fue verificado mediante
-- su cabecera x-amz-checksum-sha256 (HeadObject en modo ChecksumMode: 'ENABLED').
-- Totalmente aditiva, reversible y con DEFAULT false para registros históricos.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- UP MIGRATION (APLICAR)
-- ------------------------------------------------------------------------------

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS sha256_verified BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.files.sha256_verified IS
  'Indica si el checksum criptográfico SHA-256 de S3 fue validado exitosamente contra el hash provisto por el cliente.';

-- ------------------------------------------------------------------------------
-- DOWN MIGRATION / ROLLBACK (REVERTIR EN CASO DE EMERGENCIA)
-- ------------------------------------------------------------------------------
/*
ALTER TABLE public.files DROP COLUMN IF EXISTS sha256_verified;
*/
