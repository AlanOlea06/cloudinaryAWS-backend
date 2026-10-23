import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';

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
 * Verifica si el dominio de CloudFront está disponible
 */
export function isCloudFrontConfigured(): boolean {
  return Boolean(getCloudFrontDomain());
}

/**
 * Verifica si las credenciales de firma criptográfica (Key Group / Key Pair) de CloudFront están configuradas
 */
export function isCloudFrontSigningConfigured(): boolean {
  const keyPairId = (
    process.env.AWS_CLOUDFRONT_KEY_PAIR_ID ||
    process.env.CLOUDFRONT_KEY_PAIR_ID ||
    ''
  ).trim();

  const privateKey = (
    process.env.AWS_CLOUDFRONT_PRIVATE_KEY ||
    process.env.CLOUDFRONT_PRIVATE_KEY ||
    ''
  ).trim();

  return Boolean(getCloudFrontDomain() && keyPairId && privateKey);
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
 * Construye la URL base de CloudFront para almacenar en Supabase (cloudfront_url) y servir archivos
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
  isSigned: boolean;
  expiresInSeconds: number | null;
  expiresAt: string | null;
  domain: string;
}

/**
 * Genera la URL de consumo a través de Amazon CloudFront (CDN) bajo el prefijo /static/.
 * - Si hay Key Pair ID y Private Key configurados, genera una URL Firmada (CloudFront Signed URL).
 * - Si está en modo OAC directo (/static/*), devuelve la URL de borde de CloudFront con caché.
 */
export function generateCloudFrontUrl(
  s3Key: string,
  options?: {
    expiresInSeconds?: number;
  }
): CloudFrontUrlResult | null {
  const domain = getCloudFrontDomain();
  const baseUrl = getBaseCloudFrontUrl(s3Key);

  if (!domain || !baseUrl) {
    return null;
  }

  const expiresInSeconds = options?.expiresInSeconds ?? 3600; // 1 hora por defecto

  if (isCloudFrontSigningConfigured()) {
    const keyPairId = (
      process.env.AWS_CLOUDFRONT_KEY_PAIR_ID ||
      process.env.CLOUDFRONT_KEY_PAIR_ID ||
      ''
    ).trim();

    const rawPrivateKey = (
      process.env.AWS_CLOUDFRONT_PRIVATE_KEY ||
      process.env.CLOUDFRONT_PRIVATE_KEY ||
      ''
    ).trim();
    const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

    const expirationDate = new Date(Date.now() + expiresInSeconds * 1000);

    const signedUrl = getCloudFrontSignedUrl({
      url: baseUrl,
      keyPairId,
      privateKey,
      dateLessThan: expirationDate.toISOString(),
    });

    return {
      url: signedUrl,
      isSigned: true,
      expiresInSeconds,
      expiresAt: expirationDate.toISOString(),
      domain,
    };
  }

  // Modo CloudFront OAC directo en /static/*
  return {
    url: baseUrl,
    isSigned: false,
    expiresInSeconds: null,
    expiresAt: null,
    domain,
  };
}
