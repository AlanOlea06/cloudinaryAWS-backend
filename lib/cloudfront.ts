import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';

/**
 * Obtiene y normaliza el dominio de la distribución de Amazon CloudFront
 * Soporta tanto AWS_CLOUDFRONT_DOMAIN como CLOUDFRONT_DOMAIN.
 * Ejemplo de entrada: "https://d111111abcdef8.cloudfront.net/" -> "d111111abcdef8.cloudfront.net"
 */
export function getCloudFrontDomain(): string | null {
  const rawDomain = (
    process.env.AWS_CLOUDFRONT_DOMAIN ||
    process.env.CLOUDFRONT_DOMAIN ||
    ''
  ).trim();

  if (!rawDomain) {
    return null;
  }

  return rawDomain
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Verifica si el dominio de CloudFront está configurado en las variables de entorno
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
 * Codifica cada segmento de la ruta S3 preservando las barras diagonales '/'
 */
function encodeS3KeyForUrl(s3Key: string): string {
  return s3Key
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Construye la URL base de CloudFront sin firma para almacenar como referencia o servir archivos públicos
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
 * Genera la URL de consumo a través de Amazon CloudFront (CDN).
 * - Si hay Key Pair ID y Private Key configurados (y el archivo es privado o se requiere firma),
 *   genera una URL Firmada (CloudFront Signed URL) con expiración temporal.
 * - Si solo está configurado el dominio de CloudFront (OAC directo), devuelve la URL de borde de CloudFront.
 */
export function generateCloudFrontUrl(
  s3Key: string,
  options?: {
    expiresInSeconds?: number;
    forceSigned?: boolean;
  }
): CloudFrontUrlResult | null {
  const domain = getCloudFrontDomain();
  const baseUrl = getBaseCloudFrontUrl(s3Key);

  if (!domain || !baseUrl) {
    return null;
  }

  const expiresInSeconds = options?.expiresInSeconds ?? 3600; // 1 hora por defecto

  // Verificar si se cuenta con par de claves para firmar la URL en CloudFront
  if (isCloudFrontSigningConfigured()) {
    const keyPairId = (
      process.env.AWS_CLOUDFRONT_KEY_PAIR_ID ||
      process.env.CLOUDFRONT_KEY_PAIR_ID ||
      ''
    ).trim();

    // Soportar saltos de línea escapados (\n) en variables de entorno (.env / Vercel)
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

  // Modo CloudFront OAC estándar (sin Key Group / sin firma adicional en URL)
  return {
    url: baseUrl,
    isSigned: false,
    expiresInSeconds: null,
    expiresAt: null,
    domain,
  };
}
