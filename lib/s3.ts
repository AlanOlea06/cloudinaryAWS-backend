import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const region = process.env.AWS_REGION || 'us-east-1';
const bucketName = process.env.AWS_S3_BUCKET_NAME || '';

export const PRIVATE_NO_STORE_CACHE_CONTROL =
  'private, no-store, no-cache, max-age=0, must-revalidate';

// Short TTL (5 minutes = 300s) for public files because IAM lacks cloudfront:CreateInvalidation
export const PUBLIC_SHORT_TTL_CACHE_CONTROL =
  'public, max-age=300, must-revalidate';

// Task A.5: Maximum file size for single PUT upload (25 MB). Larger files must use Multipart Upload (Task B.9).
export const MAX_SINGLE_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Task A.4: Strict whitelist of allowed extensions, coherent MIME types, resource categories,
 * and Content-Disposition policy.
 * - Blocks .html, .htm, .svg, .xml, .js, etc. to prevent stored XSS on the CloudFront domain.
 * - Blocks video/* temporarily per Architecture Decision 2-B.
 * - Forces Content-Disposition: attachment on .pdf documents.
 */
export interface AllowedFileTypeSpec {
  extension: string;
  mimeType: string;
  resourceType: 'images' | 'documents';
  contentDisposition: 'inline' | 'attachment';
}

export const ALLOWED_FILE_TYPES: Record<string, AllowedFileTypeSpec> = {
  '.jpg': {
    extension: '.jpg',
    mimeType: 'image/jpeg',
    resourceType: 'images',
    contentDisposition: 'inline',
  },
  '.jpeg': {
    extension: '.jpeg',
    mimeType: 'image/jpeg',
    resourceType: 'images',
    contentDisposition: 'inline',
  },
  '.png': {
    extension: '.png',
    mimeType: 'image/png',
    resourceType: 'images',
    contentDisposition: 'inline',
  },
  '.webp': {
    extension: '.webp',
    mimeType: 'image/webp',
    resourceType: 'images',
    contentDisposition: 'inline',
  },
  '.gif': {
    extension: '.gif',
    mimeType: 'image/gif',
    resourceType: 'images',
    contentDisposition: 'inline',
  },
  '.pdf': {
    extension: '.pdf',
    mimeType: 'application/pdf',
    resourceType: 'documents',
    contentDisposition: 'attachment',
  },
};

const XSS_BLOCKED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
  '.xml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.jsx',
  '.tsx',
  '.php',
  '.sh',
  '.bat',
  '.cmd',
  '.exe',
  '.dll',
  '.msi',
]);

const XSS_BLOCKED_MIMES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'application/javascript',
  'text/javascript',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.avi',
  '.mkv',
  '.flv',
  '.wmv',
  '.m4v',
]);

export interface FileTypeValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
  extension?: string;
  mimeType?: string;
  resourceType?: 'images' | 'documents';
  contentDisposition?: 'inline' | 'attachment';
}

/**
 * Task A.4: Validates extension + MIME coherence and blocks XSS-prone types (.html, .svg) and videos (Decision 2-B).
 */
export function validateAllowedFileType(
  fileName: string,
  mimeType: string,
  explicitExtension?: string
): FileTypeValidationResult {
  const cleanFileName = String(fileName || '').trim();
  const cleanMime = String(mimeType || '').trim().toLowerCase();

  let extFromFileName = '';
  const lastDot = cleanFileName.lastIndexOf('.');
  if (lastDot > 0 && lastDot < cleanFileName.length - 1) {
    extFromFileName = cleanFileName.slice(lastDot).toLowerCase();
  }

  let normalizedExplicitExt = '';
  if (explicitExtension !== undefined && explicitExtension !== null && String(explicitExtension).trim() !== '') {
    normalizedExplicitExt = String(explicitExtension).trim().toLowerCase();
    if (!normalizedExplicitExt.startsWith('.')) {
      normalizedExplicitExt = `.${normalizedExplicitExt}`;
    }
  }

  // If both fileName extension and explicitExtension are provided, they must match
  if (extFromFileName && normalizedExplicitExt && extFromFileName !== normalizedExplicitExt) {
    return {
      valid: false,
      code: 'EXTENSION_MISMATCH',
      message: `La extensión declarada ('${normalizedExplicitExt}') no coincide con la extensión del nombre de archivo ('${extFromFileName}').`,
    };
  }

  const effectiveExt = normalizedExplicitExt || extFromFileName;

  // 1. Check XSS-prone extensions or MIME types (.html, .htm, .svg, etc.)
  if (XSS_BLOCKED_EXTENSIONS.has(effectiveExt) || XSS_BLOCKED_MIMES.has(cleanMime)) {
    return {
      valid: false,
      code: 'XSS_DANGEROUS_FILE_TYPE',
      message: `Seguridad XSS: El tipo de archivo '${effectiveExt || cleanMime}' (.html, .svg, scripts/ejecutables) está bloqueado permanentemente para prevenir ataques de Cross-Site Scripting (XSS) desde el dominio de CloudFront.`,
    };
  }

  // 2. Check Video policy (Decision 2-B: Videos temporarily out of scope)
  if (VIDEO_EXTENSIONS.has(effectiveExt) || cleanMime.startsWith('video/')) {
    return {
      valid: false,
      code: 'VIDEO_TEMPORARILY_DISABLED',
      message: `Decisión de Arquitectura (2-B): El soporte de archivos de video ('${effectiveExt || cleanMime}') se encuentra temporalmente fuera de alcance hasta contar con infraestructura dedicada.`,
    };
  }

  if (!effectiveExt) {
    return {
      valid: false,
      code: 'MISSING_FILE_EXTENSION',
      message: 'El nombre del archivo debe incluir una extensión válida (.jpg, .jpeg, .png, .webp, .gif, .pdf).',
    };
  }

  // 3. Check whitelist of allowed extensions
  const spec = ALLOWED_FILE_TYPES[effectiveExt];
  if (!spec) {
    return {
      valid: false,
      code: 'UNSUPPORTED_FILE_EXTENSION',
      message: `La extensión '${effectiveExt}' no está permitida. Extensiones permitidas: ${Object.keys(ALLOWED_FILE_TYPES).join(', ')}.`,
    };
  }

  // 4. Verify strict coherence between extension and declared MIME type
  if (cleanMime !== spec.mimeType) {
    return {
      valid: false,
      code: 'EXTENSION_MIME_MISMATCH',
      message: `Incoherencia entre extensión y tipo MIME: la extensión '${effectiveExt}' requiere el tipo MIME '${spec.mimeType}', pero se declaró '${cleanMime}'.`,
    };
  }

  return {
    valid: true,
    extension: spec.extension,
    mimeType: spec.mimeType,
    resourceType: spec.resourceType,
    contentDisposition: spec.contentDisposition,
  };
}

/**
 * Returns the appropriate Cache-Control directive based on file visibility and landing stage.
 * - Pending uploads and private files NEVER cache ('private, no-store, no-cache, max-age=0, must-revalidate').
 * - Public files use a short 5-minute Edge TTL ('public, max-age=300, must-revalidate').
 */
export function getCacheControlForVisibility(
  visibility: string = 'private',
  isPending: boolean = false
): string {
  if (isPending || visibility.toLowerCase() === 'private') {
    return PRIVATE_NO_STORE_CACHE_CONTROL;
  }
  return PUBLIC_SHORT_TTL_CACHE_CONTROL;
}

/**
 * Task A.1: Generates an unpredictable 128-bit (16-byte / 32 hex chars) opaque S3 key.
 * - Distinct from the database file ID and ticket ID.
 * - Never includes organization slug, visibility ('private'/'public'), or original filename.
 * - Always resides under 'static/' so CloudFront (/static/*) can reach public files when needed.
 */
export function generateOpaqueS3Key(
  prefix: 'static/pending' | 'static/files' = 'static/pending',
  extension: string = ''
): string {
  const random128Hex = crypto.randomBytes(16).toString('hex');
  let cleanExt = (extension || '').trim().toLowerCase();
  if (cleanExt && !cleanExt.startsWith('.')) {
    cleanExt = `.${cleanExt}`;
  }
  // Keep only safe alphanumeric extension characters
  cleanExt = cleanExt.replace(/[^a-z0-9.]/g, '');
  return `${prefix}/${random128Hex}${cleanExt}`;
}

/**
 * Checks if AWS S3 credentials and bucket name are configured in environment variables
 */
export function isAwsConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET_NAME
  );
}

/**
 * Returns an S3Client instance configured with environment credentials
 */
export function getS3Client(): S3Client | null {
  if (!isAwsConfigured()) {
    return null;
  }

  return new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
    },
  });
}

/**
 * Tasks A.3, A.4 & A.5: Generates an AWS S3 Presigned URL for direct client upload (PUT)
 * with Cache-Control, Content-Length, and optional Content-Disposition cryptographically
 * signed in X-Amz-SignedHeaders.
 *
 * @param key Destination path within the bucket (e.g. static/pending/<rand128>.<ext>)
 * @param contentType MIME type of the file (e.g. image/png)
 * @param expiresInSeconds Lifetime in seconds (default 300 = 5 minutes)
 * @param cacheControl Cache-Control header to sign (defaults to no-store for pending/private)
 * @param contentLength Exact file size in bytes to enforce at S3 level
 * @param contentDisposition Optional Content-Disposition header (e.g. 'attachment' for .pdf)
 */
export async function generatePresignedUploadUrl(
  key: string,
  contentType: string = 'application/octet-stream',
  expiresInSeconds: number = 300,
  cacheControl: string = PRIVATE_NO_STORE_CACHE_CONTROL,
  contentLength?: number,
  contentDisposition?: 'inline' | 'attachment'
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName) {
    return null;
  }

  const signable = new Set<string>(['host', 'content-type', 'cache-control']);
  const putParams: Record<string, any> = {
    Bucket: bucketName.trim(),
    Key: key,
    ContentType: contentType,
    CacheControl: cacheControl,
  };

  if (typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength > 0) {
    putParams.ContentLength = contentLength;
    signable.add('content-length');
  }

  if (contentDisposition === 'attachment') {
    putParams.ContentDisposition = 'attachment';
    signable.add('content-disposition');
  }

  const command = new PutObjectCommand(putParams as any);

  return await getSignedUrl(client, command, {
    expiresIn: expiresInSeconds,
    signableHeaders: signable,
  });
}

/**
 * Task A.5: Performs an S3 HeadObject request to inspect the actual uploaded object's
 * ContentLength, ContentType, CacheControl, and ContentDisposition without downloading it.
 */
export interface S3HeadMetadata {
  exists: boolean;
  contentLength: number | null;
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  eTag: string | null;
}

export async function headS3Object(key: string): Promise<S3HeadMetadata> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return {
      exists: false,
      contentLength: null,
      contentType: null,
      cacheControl: null,
      contentDisposition: null,
      eTag: null,
    };
  }

  try {
    const res = await client.send(
      new HeadObjectCommand({
        Bucket: bucketName.trim(),
        Key: key.replace(/^\/+/, ''),
      })
    );
    return {
      exists: true,
      contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
      contentType: res.ContentType || null,
      cacheControl: res.CacheControl || null,
      contentDisposition: res.ContentDisposition || null,
      eTag: res.ETag || null,
    };
  } catch (err: any) {
    if (
      err?.name === 'NotFound' ||
      err?.name === 'NoSuchKey' ||
      err?.$metadata?.httpStatusCode === 404
    ) {
      return {
        exists: false,
        contentLength: null,
        contentType: null,
        cacheControl: null,
        contentDisposition: null,
        eTag: null,
      };
    }
    throw err;
  }
}

/**
 * Task A.5: Deletes a single S3 object by key using DeleteObjectCommand.
 */
export async function deleteS3Object(key: string): Promise<boolean> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return false;
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName.trim(),
      Key: key.replace(/^\/+/, ''),
    })
  );
  return true;
}

/**
 * Task A.2: Generates a short-lived (5-minute) S3 Presigned GET URL for private files.
 * Private files are NEVER served or cached through CloudFront.
 */
export async function generatePresignedReadUrl(
  key: string,
  expiresInSeconds: number = 300
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: bucketName.trim(),
    Key: key.replace(/^\/+/, ''),
    ResponseCacheControl: PRIVATE_NO_STORE_CACHE_CONTROL,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Updates the S3 object's Cache-Control metadata in-place after upload confirmation.
 * - For 'private' files: sets 'private, no-store, no-cache, max-age=0, must-revalidate'
 * - For 'public' files: sets 'public, max-age=300, must-revalidate' (short TTL since CloudFront invalidation is unavailable)
 */
export async function applyS3CacheControlMetadata(
  key: string,
  contentType: string = 'application/octet-stream',
  visibility: string = 'private',
  contentDisposition?: 'inline' | 'attachment'
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return null;
  }

  const cacheControl = getCacheControlForVisibility(visibility, false);

  const trimmedBucket = bucketName.trim();
  const cleanKey = key.replace(/^\/+/, '');
  const encodedCopySource = `${trimmedBucket}/${cleanKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;

  const copyParams: Record<string, any> = {
    Bucket: trimmedBucket,
    CopySource: encodedCopySource,
    Key: cleanKey,
    ContentType: contentType,
    CacheControl: cacheControl,
    MetadataDirective: 'REPLACE',
  };

  if (contentDisposition === 'attachment' || cleanKey.toLowerCase().endsWith('.pdf')) {
    copyParams.ContentDisposition = 'attachment';
  }

  const copyCommand = new CopyObjectCommand(copyParams as any);

  await client.send(copyCommand);
  return cacheControl;
}

/**
 * Deletes S3 objects matching a given prefix (e.g. pending/{userId}/)
 * 
 * @param prefix S3 Key prefix to search and delete
 * @returns Object with count and deleted keys
 */
export async function deleteS3ObjectsByPrefix(prefix: string): Promise<{ count: number; keys: string[] }> {
  const client = getS3Client();
  if (!client || !bucketName) {
    return { count: 0, keys: [] };
  }

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName.trim(),
      Prefix: prefix,
    });

    const listRes = await client.send(listCommand);
    if (!listRes.Contents || listRes.Contents.length === 0) {
      return { count: 0, keys: [] };
    }

    const objectsToDelete = listRes.Contents
      .map((item) => ({ Key: item.Key }))
      .filter((item): item is { Key: string } => Boolean(item.Key));

    if (objectsToDelete.length === 0) {
      return { count: 0, keys: [] };
    }

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName.trim(),
      Delete: {
        Objects: objectsToDelete,
        Quiet: false,
      },
    });

    const deleteRes = await client.send(deleteCommand);
    const deletedKeys = (deleteRes.Deleted || []).map((d) => d.Key || '').filter(Boolean);

    return {
      count: deletedKeys.length,
      keys: deletedKeys,
    };
  } catch (error) {
    console.error('Error deleting S3 objects by prefix:', error);
    throw error;
  }
}

/**
 * Deletes specific S3 objects by their exact keys
 * 
 * @param keys Array of S3 keys to delete
 * @returns Object with count and deleted keys
 */
export async function deleteS3ObjectsByKeys(keys: string[]): Promise<{ count: number; keys: string[] }> {
  const client = getS3Client();
  if (!client || !bucketName || keys.length === 0) {
    return { count: 0, keys: [] };
  }

  try {
    const validObjects = keys
      .filter((k) => typeof k === 'string' && k.trim().length > 0)
      .map((k) => ({ Key: k.trim() }));

    if (validObjects.length === 0) {
      return { count: 0, keys: [] };
    }

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName.trim(),
      Delete: {
        Objects: validObjects,
        Quiet: false,
      },
    });

    const deleteRes = await client.send(deleteCommand);
    const deletedKeys = (deleteRes.Deleted || []).map((d) => d.Key || '').filter(Boolean);

    return {
      count: deletedKeys.length,
      keys: deletedKeys,
    };
  } catch (error) {
    console.error('Error deleting S3 objects by keys:', error);
    throw error;
  }
}

