// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B12-IMAGE-TRANSFORM]
// Búsqueda rápida para migrar/eliminar cuando exista AWS Lambda: "TEMPORARY-LAMBDA-FALLBACK"
// Propósito: Reemplazar AWS Serverless Image Handler / Lambda@Edge implementando
// transformación dinámica de imágenes con `sharp`, parámetros firmados con HMAC-SHA256,
// expiración obligatoria, límites de dimensiones (16..2000 px) y tope de respuesta
// de Vercel Serverless (4 MB).
// ============================================================================

import crypto from 'crypto';

export const MIN_TRANSFORM_DIMENSION = 16;
export const MAX_TRANSFORM_DIMENSION = 2000;
export const MAX_VERCEL_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB safety limit under Vercel's 4.5 MB limit

export const ALLOWED_TRANSFORM_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
export const ALLOWED_TRANSFORM_FORMATS = new Set(['webp', 'jpeg', 'jpg', 'png', 'avif']);

const DEFAULT_TRANSFORM_SECRET =
  process.env.IMAGE_TRANSFORM_HMAC_SECRET ||
  process.env.TICKET_HMAC_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'cloudinary-clone-transform-hmac-secret-2026';

export interface ImageTransformParams {
  fileId: string;
  w?: number | string | null;
  h?: number | string | null;
  fit?: string | null;
  format?: string | null;
  exp: number | string;
}

export function buildTransformCanonicalString(params: ImageTransformParams): string {
  const wStr = params.w !== undefined && params.w !== null && params.w !== '' ? String(params.w) : '';
  const hStr = params.h !== undefined && params.h !== null && params.h !== '' ? String(params.h) : '';
  const fitStr = params.fit ? String(params.fit).toLowerCase().trim() : 'cover';
  const fmtStr = params.format ? String(params.format).toLowerCase().trim() : 'webp';
  const expStr = String(params.exp);

  return `img:${params.fileId}:w=${wStr}:h=${hStr}:fit=${fitStr}:format=${fmtStr}:exp=${expStr}`;
}

export function signImageTransformParams(
  params: ImageTransformParams,
  secret?: string
): {
  sig: string;
  canonical: string;
  queryString: string;
} {
  const effectiveSecret = (secret || DEFAULT_TRANSFORM_SECRET).trim();
  const canonical = buildTransformCanonicalString(params);
  const sig = crypto.createHmac('sha256', effectiveSecret).update(canonical).digest('hex');

  const qs = new URLSearchParams();
  if (params.w !== undefined && params.w !== null && params.w !== '') {
    qs.set('w', String(params.w));
  }
  if (params.h !== undefined && params.h !== null && params.h !== '') {
    qs.set('h', String(params.h));
  }
  qs.set('fit', params.fit ? String(params.fit).toLowerCase().trim() : 'cover');
  qs.set('format', params.format ? String(params.format).toLowerCase().trim() : 'webp');
  qs.set('exp', String(params.exp));
  qs.set('sig', sig);

  return {
    sig,
    canonical,
    queryString: qs.toString(),
  };
}

export function verifyImageTransformSignature(
  params: ImageTransformParams & { sig?: string | null },
  secret?: string
): {
  valid: boolean;
  code?: string;
  message?: string;
} {
  if (!params.sig || !params.exp) {
    return {
      valid: false,
      code: 'MISSING_TRANSFORM_SIGNATURE',
      message: 'Se requieren los parámetros firmados exp y sig para transformar la imagen.',
    };
  }

  const expNum = Number(params.exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return {
      valid: false,
      code: 'INVALID_TRANSFORM_EXPIRATION',
      message: 'El parámetro exp debe ser un timestamp UNIX válido en segundos.',
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > expNum) {
    return {
      valid: false,
      code: 'TRANSFORM_URL_EXPIRED',
      message: `La URL de transformación expiró hace ${nowSec - expNum} segundos.`,
    };
  }

  const { sig: expectedSig } = signImageTransformParams(params, secret);
  const cleanProvided = String(params.sig).trim().toLowerCase();

  try {
    const a = Buffer.from(expectedSig, 'hex');
    const b = Buffer.from(cleanProvided, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return {
        valid: false,
        code: 'INVALID_TRANSFORM_SIGNATURE',
        message: 'La firma HMAC-SHA256 de los parámetros de transformación es inválida o fue alterada.',
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      code: 'INVALID_TRANSFORM_SIGNATURE',
      message: 'Formato de firma HMAC-SHA256 inválido.',
    };
  }
}
