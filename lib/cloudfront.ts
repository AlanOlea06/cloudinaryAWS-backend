import { requireEnv } from '@/lib/env';

/**
 * Obtiene y normaliza el dominio de CloudFront configurado obligatoriamente en AWS_CLOUDFRONT_DOMAIN,
 * eliminando cualquier protocolo (http/https) o barra diagonal final.
 * Lanza un error claro si AWS_CLOUDFRONT_DOMAIN no está definida (sin valores por defecto).
 */
export function getCloudFrontDomain(): string {
  const rawDomain = requireEnv('AWS_CLOUDFRONT_DOMAIN');
  const cleaned = rawDomain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  if (!cleaned) {
    throw new Error(
      "[ENV_INVALID] La variable 'AWS_CLOUDFRONT_DOMAIN' no contiene un dominio válido."
    );
  }

  return cleaned;
}

export function isCloudFrontConfigured(): boolean {
  return Boolean(process.env.AWS_CLOUDFRONT_DOMAIN?.trim());
}

/**
 * Normaliza una ruta S3 para garantizar que siempre comience con el prefijo 'static/'
 */
export function ensureStaticPrefix(s3Key: string): string {
  const cleanKey = (s3Key || '').trim().replace(/^\/+/, '');
  return cleanKey.startsWith('static/') ? cleanKey : `static/${cleanKey}`;
}

function encodeS3KeyForUrl(s3Key: string): string {
  const normalizedKey = ensureStaticPrefix(s3Key);
  return normalizedKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Construye la URL de CloudFront bajo el prefijo /static/* para almacenar en Supabase (cloudfront_url)
 * y entregar archivos públicos.
 */
export function getBaseCloudFrontUrl(s3Key: string): string | null {
  if (!s3Key || !s3Key.trim()) {
    return null;
  }
  const domain = getCloudFrontDomain();
  const encodedKey = encodeS3KeyForUrl(s3Key);
  return `https://${domain}/${encodedKey}`;
}

export function getCloudFrontUrl(s3Key: string): string {
  const domain = getCloudFrontDomain();
  const encodedKey = encodeS3KeyForUrl(s3Key);
  return `https://${domain}/${encodedKey}`;
}

export interface CloudFrontUrlResult {
  url: string;
  domain: string;
}

export function generateCloudFrontUrl(s3Key: string): CloudFrontUrlResult | null {
  if (!s3Key || !s3Key.trim()) {
    return null;
  }
  const domain = getCloudFrontDomain();
  const baseUrl = getBaseCloudFrontUrl(s3Key);
  if (!baseUrl) {
    return null;
  }
  return {
    url: baseUrl,
    domain,
  };
}

/**
 * Devuelve la URL de entrega según la visibilidad del archivo:
 * - 'public' -> URL de CloudFront CDN (solo para objetos públicos)
 * - 'private' -> null (los archivos privados requieren URL prefirmada de S3 de corta duración)
 */
export function getDeliveryUrlForVisibility(
  s3Key: string,
  visibility: string = 'private'
): string | null {
  if (visibility.toLowerCase() === 'public') {
    return getBaseCloudFrontUrl(s3Key);
  }
  return null;
}
