import crypto from 'crypto';
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

export interface CloudFrontInvalidationResult {
  invalidated: boolean;
  invalidationId: string | null;
  paths: string[];
  error?: string;
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Crea una invalidación de caché en Amazon CloudFront (CreateInvalidation 2020-05-31)
 * para las rutas bajo /static/* cuando se eliminan archivos públicos.
 */
export async function invalidateCloudFrontPaths(
  s3KeysOrPaths: string[]
): Promise<CloudFrontInvalidationResult> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
  const distributionId =
    process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID?.trim() || 'ECM92CKF7EZPC';

  const normalizedPaths = Array.from(
    new Set(
      (s3KeysOrPaths || [])
        .map((k) => String(k || '').trim())
        .filter(Boolean)
        .map((k) => {
          const withStatic = ensureStaticPrefix(k);
          return `/${withStatic.replace(/^\/+/, '')}`;
        })
    )
  );

  if (normalizedPaths.length === 0) {
    return { invalidated: false, invalidationId: null, paths: [] };
  }

  if (!accessKeyId || !secretAccessKey || !distributionId) {
    return {
      invalidated: false,
      invalidationId: null,
      paths: normalizedPaths,
      error: 'AWS_CREDENTIALS_OR_DISTRIBUTION_MISSING',
    };
  }

  try {
    const callerReference = `del-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const itemsXml = normalizedPaths
      .map((p) => `<Path>${escapeXml(p)}</Path>`)
      .join('');
    const bodyXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">` +
      `<Paths><Quantity>${normalizedPaths.length}</Quantity><Items>${itemsXml}</Items></Paths>` +
      `<CallerReference>${callerReference}</CallerReference>` +
      `</InvalidationBatch>`;

    const host = 'cloudfront.amazonaws.com';
    const canonicalUri = `/2020-05-31/distribution/${encodeURIComponent(distributionId)}/invalidation`;
    const region = 'us-east-1';
    const service = 'cloudfront';

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(bodyXml);

    const headersToSign: Record<string, string> = {
      'content-type': 'application/xml',
      host,
      'x-amz-date': amzDate,
    };
    if (sessionToken) {
      headersToSign['x-amz-security-token'] = sessionToken;
    }

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k}:${headersToSign[k]}\n`)
      .join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      'POST',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorizationHeader =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/xml',
      'X-Amz-Date': amzDate,
      Authorization: authorizationHeader,
    };
    if (sessionToken) {
      requestHeaders['X-Amz-Security-Token'] = sessionToken;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyXml,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const responseText = await res.text();
    if (!res.ok) {
      const codeMatch = responseText.match(/<Code>([^<]+)<\/Code>/);
      const msgMatch = responseText.match(/<Message>([^<]+)<\/Message>/);
      const errDetail = codeMatch
        ? `${codeMatch[1]}: ${msgMatch?.[1] || res.statusText}`
        : `HTTP_${res.status}`;
      console.warn(`CloudFront invalidation warning (${errDetail})`);
      return {
        invalidated: false,
        invalidationId: null,
        paths: normalizedPaths,
        error: errDetail,
      };
    }

    const idMatch = responseText.match(/<Id>([^<]+)<\/Id>/);
    return {
      invalidated: true,
      invalidationId: idMatch ? idMatch[1] : null,
      paths: normalizedPaths,
    };
  } catch (err: any) {
    console.warn('Error executing CloudFront invalidation:', err?.message || err);
    return {
      invalidated: false,
      invalidationId: null,
      paths: normalizedPaths,
      error: err?.message || 'CLOUDFRONT_INVALIDATION_ERROR',
    };
  }
}
