const DEFAULT_CLOUDFRONT_DOMAIN = 'd1nuawu3owad6c.cloudfront.net';

/**
 * Obtiene y normaliza el dominio de la distribución de Amazon CloudFront
 * Soporta tanto AWS_CLOUDFRONT_DOMAIN como CLOUDFRONT_DOMAIN.
 * Ejemplo: "https://d1nuawu3owad6c.cloudfront.net/" -> "d1nuawu3owad6c.cloudfront.net"
 */
export function getCloudFrontDomain(): string {
  const rawDomain = (
    process.env.AWS_CLOUDFRONT_DOMAIN ||
    process.env.CLOUDFRONT_DOMAIN ||
    DEFAULT_CLOUDFRONT_DOMAIN
  ).trim();

  return rawDomain
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Verifica si el dominio de CloudFront está configurado
 */
export function isCloudFrontConfigured(): boolean {
  return Boolean(getCloudFrontDomain());
}

/**
 * Normaliza la ruta de S3 para el Behavior `/static/*` de CloudFront
 * y codifica cada segmento preservando las barras diagonales '/'.
 */
export function ensureStaticPrefix(s3Key: string): string {
  const cleanKey = s3Key.replace(/^\/+/, '');
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
 * Construye la URL de CloudFront bajo el prefijo /static/* para almacenar en Supabase (cloudfront_url) y entregar archivos
 */
export function getBaseCloudFrontUrl(s3Key: string): string | null {
  const domain = getCloudFrontDomain();
  if (!domain || !s3Key) {
    return null;
  }

  const encodedKey = encodeS3KeyForUrl(s3Key);
  return `https://${domain}/${encodedKey}`;
}

export interface CloudFrontUrlResult {
  url: string;
  domain: string;
}

/**
 * Genera la URL de consumo a través de Amazon CloudFront (CDN) bajo el Behavior /static/*.
 */
export function generateCloudFrontUrl(s3Key: string): CloudFrontUrlResult | null {
  const domain = getCloudFrontDomain();
  const baseUrl = getBaseCloudFrontUrl(s3Key);

  if (!domain || !baseUrl) {
    return null;
  }

  return {
    url: baseUrl,
    domain,
  };
}
