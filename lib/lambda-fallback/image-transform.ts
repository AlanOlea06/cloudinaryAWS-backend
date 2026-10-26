// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B12-IMAGE-TRANSFORM-SIGNER]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Propósito: Firma y verificación HMAC-SHA256 con expiración para URLs de
//            transformación dinámica (/api/img/[id]?w=&h=&fit=&format=&exp=&sig=).
// Nota (Sección 2): Deshabilitado en producción hasta la etapa de transformaciones.
// Sin secretos por defecto ni reutilización de SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import crypto from 'crypto';
import { requireEnv } from '@/lib/env';

export const MIN_TRANSFORM_DIMENSION = 16;
export const MAX_TRANSFORM_DIMENSION = 2000;
export const MAX_VERCEL_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB safety limit under Vercel's 4.5 MB cap

export const ALLOWED_TRANSFORM_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
export const ALLOWED_TRANSFORM_FORMATS = new Set(['webp', 'jpeg', 'jpg', 'png', 'avif']);

function getTransformHmacSecret(): string {
  return requireEnv('IMAGE_TRANSFORM_HMAC_SECRET');
}

export interface TransformParamsToSign {
  fileId: string;
  w?: number | string | null;
  h?: number | string | null;
  fit?: string | null;
  format?: string | null;
  exp: number | string;
}

/**
 * Builds the canonical string for signing image transformation parameters.
 */
export function buildCanonicalTransformString(params: TransformParamsToSign): string {
  const fileId = String(params.fileId || '').trim();
  const w = params.w !== undefined && params.w !== null && params.w !== '' ? String(params.w).trim() : '';
  const h = params.h !== undefined && params.h !== null && params.h !== '' ? String(params.h).trim() : '';
  const fit = String(params.fit || 'cover').toLowerCase().trim();
  const format = String(params.format || 'webp').toLowerCase().trim();
  const exp = String(params.exp || '').trim();

  return `id=${fileId}&w=${w}&h=${h}&fit=${fit}&format=${format}&exp=${exp}`;
}

/**
 * Signs image transformation parameters using HMAC-SHA256.
 */
export function signImageTransformParams(params: TransformParamsToSign): {
  canonical: string;
  sig: string;
  queryString: string;
} {
  const canonical = buildCanonicalTransformString(params);
  const sig = crypto
    .createHmac('sha256', getTransformHmacSecret())
    .update(canonical, 'utf8')
    .digest('hex');

  const query = new URLSearchParams();
  if (params.w !== undefined && params.w !== null && params.w !== '') query.set('w', String(params.w));
  if (params.h !== undefined && params.h !== null && params.h !== '') query.set('h', String(params.h));
  query.set('fit', String(params.fit || 'cover').toLowerCase().trim());
  query.set('format', String(params.format || 'webp').toLowerCase().trim());
  query.set('exp', String(params.exp));
  query.set('sig', sig);

  return {
    canonical,
    sig,
    queryString: query.toString(),
  };
}

/**
 * Verifies the HMAC-SHA256 signature and expiration timestamp (`exp` in Unix seconds)
 * for `/api/img/[id]`.
 */
export function verifyImageTransformSignature(
  params: TransformParamsToSign & { sig?: string | null }
): { valid: boolean; code?: string; message?: string } {
  const sig = String(params.sig || '').trim().toLowerCase();
  if (!sig || !/^[a-f0-9]{64}$/.test(sig)) {
    return {
      valid: false,
      code: 'MISSING_TRANSFORM_SIGNATURE',
      message: 'El parámetro de firma criptográfica (sig) es obligatorio y debe ser un HMAC-SHA256 hexadecimal de 64 caracteres.',
    };
  }

  const expNum = Number(params.exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return {
      valid: false,
      code: 'MISSING_TRANSFORM_EXPIRATION',
      message: 'El parámetro de expiración (exp) es obligatorio y debe ser un timestamp Unix válido en segundos.',
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > expNum) {
    return {
      valid: false,
      code: 'TRANSFORM_URL_EXPIRED',
      message: `La URL de transformación ha expirado (exp=${expNum}, now=${nowSeconds}). Solicita una nueva URL firmada.`,
    };
  }

  const { sig: expectedSig } = signImageTransformParams(params);
  const aBuf = Buffer.from(sig, 'utf8');
  const bBuf = Buffer.from(expectedSig.toLowerCase(), 'utf8');

  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
    return {
      valid: false,
      code: 'INVALID_TRANSFORM_SIGNATURE',
      message: 'Firma HMAC-SHA256 (sig) inválida para los parámetros de transformación solicitados (w, h, fit, format, exp).',
    };
  }

  return { valid: true };
}
